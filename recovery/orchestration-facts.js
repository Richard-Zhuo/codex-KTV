// Read-only admission facts for D2. Stage transitions remain in the existing S3 cores.
import mysql from 'mysql2/promise';
import {join,relative,isAbsolute} from 'node:path';
import {canonical,digest,fail,verifyArtifact} from '../backup/format.js';
import {readTables} from '../backup/mysql-backup.js';
import {validateSchema} from '../production/schema.js';
import {readProtectedRestorePlan} from './production-plan.js';
import {readExecutionState} from './production-journal.js';
import {readCutoverState} from './production-cutover-journal.js';
import {readC3State} from './production-c3-journal.js';
import {readC1Evidence} from './c1-evidence.js';
import {artifactMatches,requireControl,server} from './production-c1.js';
import {validateRecoveryPointer,parseRecoveryDatabaseCredential} from './runtime-boundary.js';
import {canonicalProtectedPath,validateRecoveryAcl} from './production-authorization-context.js';
import {loadRecoveryDeployment} from './runtime-boundary.js';
import {windowsFileAcl} from '../production/runtime-config.js';
import {windowsDirectoryAcl} from '../production/wecom-smoke-config.js';
import {checkedPaths} from './production-plan.js';
import {observeOwnedCandidate} from './production-candidate.js';
const parse=row=>row&&({...row,facts:typeof row.facts==='string'?JSON.parse(row.facts):row.facts});
const readControl=async c=>parse((await c.query('SELECT mode,store_id,ledger_id,environment,backup_digest,facts FROM recovery_control WHERE control_id=1'))[0][0]);
const safeScope=async(cap,path,directory=false)=>{
 const actual=await canonicalProtectedPath(path,{directory}),rel=relative(cap.root,actual);
 if(!rel||rel.startsWith('..')||isAbsolute(rel))throw fail('AUTHORIZATION_TEST_SCOPE_DENIED');return actual;
};
export function startupReadContext(loaded,plan){
 return {...loaded,logDirectory:loaded.config.logDirectory,productionConfig:{environment:'production',
  database:plan.targetDatabase,storeId:plan.storeId,ledgerId:plan.ledgerId,
  timeZone:loaded.config.timeZone,businessCutoff:loaded.config.businessDateCutoff,
  sessionRuleVersion:loaded.config.sessionRuleVersion,deviceControlMode:loaded.config.deviceControlMode,liveControlEnabled:false}};
}
async function readFacts(capability,deps,observe,scope){
 const {runtimeConfigFile,load,pathCheck,fileAcl,journalOptions={}}=deps;
 await scope(runtimeConfigFile);
 const current=await readProtectedRestorePlan({runtimeConfigFile,load,pathCheck,fileAcl});
 const {loaded,plan,journal}=current;
 if(plan.formatVersion!==2||plan.currentDatabase!==capability.database||plan.targetDatabase===plan.currentDatabase||
  plan.targetServerUuid!==capability.serverUuid||plan.currentPort!==capability.port||
  loaded.config.storeId!==plan.storeId||loaded.config.ledgerId!==plan.ledgerId||
  loaded.config.applicationCommit!==plan.applicationCommit||loaded.config.serviceAccountSid!==plan.operatorSid)
  throw fail('PRODUCTION_ORCHESTRATION_BINDING_MISMATCH');
 for(const path of [journal,loaded.config.monitoring.backupDirectory,loaded.config.logDirectory])await scope(path,true);
 for(const path of [loaded.config.secretsFile,loaded.config.recovery.operatorDbSecretsFile])await scope(path);
 const pointer=loaded.pointer??(()=>{const u=new URL(loaded.apiEnv.KTV_MYSQL_URL);return {host:u.hostname,port:Number(u.port||3306),name:decodeURIComponent(u.pathname.slice(1))};})();
 parseRecoveryDatabaseCredential({databaseUrl:loaded.operatorUrl},pointer,plan);
 const roots=await pathCheck(loaded,null,deps),artifactDirectory=join(roots.backup,plan.backupLocator);
 await pathCheck(loaded,artifactDirectory,deps);await scope(artifactDirectory,true);
 const artifact=await verifyArtifact(artifactDirectory,{expectedChecksum:plan.backupSha256,storeId:plan.storeId,ledgerId:plan.ledgerId});artifactMatches(plan,artifact);
 const execution=await readExecutionState(journal,plan,journalOptions),cutover=await readCutoverState(journal,plan,journalOptions),c3=await readC3State(journal,plan,journalOptions);
 const pointerStage=validateRecoveryPointer(pointer,plan,{execution,cutover,c3});
 return observe(async source=>{
  await server(source,plan.currentDatabase,plan);await validateSchema(source,plan.currentDatabase);
  const [heads]=await source.query('SELECT ledger_id FROM ledger_heads');
  const [receipts]=await source.query('SELECT store_id,ledger_id,environment,facts FROM production_bootstrap_events');
  if(heads.length!==1||heads[0].ledger_id!==plan.ledgerId||!receipts.length||receipts.some(r=>r.store_id!==plan.storeId||r.ledger_id!==plan.ledgerId||r.environment!=='production'))throw fail('PRODUCTION_ORCHESTRATION_BINDING_MISMATCH');
  const sourceControl=await readControl(source),sourceMode=sourceControl?.mode??'NORMAL';
  if(!execution){if(sourceMode!=='NORMAL')throw fail('PRODUCTION_ORCHESTRATION_STATE_CONFLICT');}
  else if(execution.state==='FREEZE_INTENT'&&sourceMode==='NORMAL'){}
  else requireControl(sourceControl,plan,'FROZEN','plan-bound-recovery-freeze');
  const [existing]=await source.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[plan.targetDatabase]);
  const targetExists=existing.length>0;
  let candidateControl=null,candidateDigest=null,oldDigest=null,sessions=null,c1=null;
  if(!execution&&targetExists||execution?.state==='FROZEN'&&targetExists||execution?.state==='VERIFYING'&&!targetExists)throw fail('PRODUCTION_ORCHESTRATION_STATE_CONFLICT');
  if(targetExists){
   const u=new URL(loaded.operatorUrl);u.pathname='/'+plan.targetDatabase;
   const candidate=await mysql.createConnection({uri:u.href,ssl:loaded.mysqlSsl,dateStrings:true,jsonStrings:true,supportBigNumbers:true,bigNumberStrings:true});
   try{
    await candidate.query('SET SESSION TRANSACTION READ ONLY');await server(candidate,plan.targetDatabase,plan);
    try{candidateControl=await readControl(candidate);}catch(error){if(execution?.state!=='RESTORING')throw error;}
    if(execution?.state==='VERIFYING'){
     await validateSchema(candidate,plan.targetDatabase);
     const allowed=!c3?['VERIFYING']:c3.state==='READY_INTENT'?['VERIFYING','READY_FOR_RESUME']:c3.state==='READY_FOR_RESUME'?['READY_FOR_RESUME']:c3.state==='RESUME_INTENT'?['READY_FOR_RESUME','NORMAL']:['NORMAL'];
     if(!allowed.includes(candidateControl?.mode))throw fail('PRODUCTION_ORCHESTRATION_STATE_CONFLICT');
     requireControl(candidateControl,plan,candidateControl.mode,'plan-bound-candidate-restore');
     if(c3?.state==='RESUMED'&&candidateControl.facts?.c3Status!=='RESUMED')throw fail('PRODUCTION_ORCHESTRATION_STATE_CONFLICT');
     const [[r]]=await candidate.query('SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL');sessions=Number(r.n);
     if(c3?.state!=='RESUMED'&&sessions!==0)throw fail('PRODUCTION_C3_SESSION_ACTIVE');
     if(!c3){
      oldDigest=digest(canonical(await readTables(source,artifact.spec.tables)));
      candidateDigest=digest(canonical(await readTables(candidate,artifact.spec.tables)));
     }
     c1=await readC1Evidence(journal,plan,{oldDigest:c3?.oldDigest??oldDigest,candidateDigest:c3?.c1CandidateDigest??candidateDigest,alertDigest:c3?.alertDigest??digest(canonical({outbox:await deps.readAlerts(loaded)})),journalState:'VERIFYING'},deps.evidenceOptions);
    }
   }finally{await candidate.end();}
  }
  return {...current,pointer,pointerStage,execution,cutover,c3,sourceMode,candidateMode:candidateControl?.mode??(targetExists?'UNKNOWN':'ABSENT'),targetExists,sessions,c1,artifactDirectory,
   observationDigest:digest(canonical({planDigest:plan.planDigest,pointer,execution,cutover,c3,sourceMode,candidateMode:candidateControl?.mode??null,targetExists,c1Digest:c1?digest(canonical(c1)):null}))};
 });
}

export async function readOwnedOrchestrationFacts(capability,deps){
 return readFacts(capability,deps,work=>observeOwnedCandidate(capability,work),(path,directory)=>safeScope(capability,path,directory));
}
export async function readProductionOrchestrationFacts(runtimeConfigFile){
 const loaded=await loadRecoveryDeployment(runtimeConfigFile),access={identity:loaded.actor,runtimeServiceSid:loaded.config.serviceAccountSid};
 const checkFile=async path=>{await canonicalProtectedPath(path);validateRecoveryAcl(await windowsFileAcl(path),{...access,shared:true});};
 const checkDir=async path=>{await canonicalProtectedPath(path,{directory:true});validateRecoveryAcl(await windowsDirectoryAcl(path),{...access,shared:true,directory:true});};
 const pathCheck=(l,a)=>checkedPaths(l,a,{backupAcl:checkDir,journalAcl:checkDir,fileAcl:checkFile});
 const deps={runtimeConfigFile,load:()=>loadRecoveryDeployment(runtimeConfigFile),pathCheck,fileAcl:checkFile,journalOptions:{checkAcl:checkFile},evidenceOptions:{checkAcl:checkFile},readAlerts:async value=>{const {alerts}=await import('./production-c1.js');return alerts({...value,logDirectory:value.config.logDirectory});}};
 const initial=await readProtectedRestorePlan(deps),plan=initial.plan;
 const expected={database:plan.currentDatabase,serverUuid:plan.targetServerUuid,port:plan.targetPort};
 const observe=async work=>{const u=new URL(loaded.operatorUrl);u.pathname='/'+plan.currentDatabase;const c=await mysql.createConnection({uri:u.href,ssl:loaded.mysqlSsl,dateStrings:true,jsonStrings:true,supportBigNumbers:true,bigNumberStrings:true});try{await c.query('SET SESSION TRANSACTION READ ONLY');return await work(c);}finally{await c.end();}};
 return readFacts(expected,deps,observe,(path,directory)=>canonicalProtectedPath(path,{directory}));
}
export async function productionAuthorizationObservationContext(f){
 const access={identity:f.loaded.actor,runtimeServiceSid:f.loaded.config.serviceAccountSid},authorizationDirectory=join(f.journal,'authorization');
 const checkDirectory=async path=>{await canonicalProtectedPath(path,{directory:true});validateRecoveryAcl(await windowsDirectoryAcl(path),{...access,directory:true});};
 const checkFile=async path=>{await canonicalProtectedPath(path);validateRecoveryAcl(await windowsFileAcl(path),access);};
 await checkDirectory(authorizationDirectory);
 return {plan:f.plan,actorSid:f.loaded.actor.sid,runtimeServiceSid:f.loaded.config.serviceAccountSid,deploymentConfigFingerprint:f.loaded.configFingerprint,environment:'production',authorizationDirectory,checkDirectory,checkFile};
}
