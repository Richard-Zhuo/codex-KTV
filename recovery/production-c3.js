import mysql from 'mysql2/promise';
import {join} from 'node:path';
import {canonical,digest,fail,verifyArtifact} from '../backup/format.js';
import {readTables} from '../backup/mysql-backup.js';
import {validateSchema} from '../production/schema.js';
import {readProtectedRestorePlan,checkedPaths} from './production-plan.js';
import {readExecutionState} from './production-journal.js';
import {readCutoverState} from './production-cutover-journal.js';
import {readC1Evidence} from './c1-evidence.js';
import {readC3State,transitionC3State} from './production-c3-journal.js';
import {withOwnedCandidateRead} from './production-candidate.js';
import {readC2CutoverFacts} from './production-c2.js';
import {requireControl,server,alerts,artifactMatches} from './production-c1.js';

const targetUrl=(base,name)=>{const url=new URL(base);url.pathname='/'+name;return url.href;};
const stopped=status=>status?.phase==='STOPPED'&&status.workerStopped===true&&
 status.operationalStopped===true&&status.connectionsClosed===true&&status.normalWriterCount===0;
const proofOf=f=>({c1EvidenceDigest:digest(canonical(f.evidence)),
 oldDigest:f.oldDigest,c1CandidateDigest:f.candidateDigest,
 candidateBusinessDigest:f.candidateBusinessDigest,alertDigest:f.alertDigest});
const same=(a,b)=>canonical(a)===canonical(b);
const dataTables=spec=>spec.tables.filter(name=>
 !['recovery_control','recovery_events'].includes(name));
const control=async c=>{
 const [[row]]=await c.query('SELECT mode,store_id,ledger_id,environment,backup_digest,facts FROM recovery_control WHERE control_id=1');
 let facts;try{facts=typeof row?.facts==='string'?JSON.parse(row.facts):row?.facts;}catch{}
 return row&&{...row,facts};
};
const stableDigest=async(c,spec)=>digest(canonical(await readTables(c,dataTables(spec))));
const assertStopped=runtime=>{if(!runtime||typeof runtime.status!=='function'||
 !stopped(runtime.status()))throw fail('PRODUCTION_C3_RUNTIME_NOT_STOPPED');};
const assertSwitched=f=>{
 if(f.cutover?.state!=='CUTOVER_SWITCHED'||f.pointer!==f.plan.targetDatabase)
  throw fail('PRODUCTION_C3_CUTOVER_NOT_COMPLETE');
};
const c2Args=args=>({runtimeConfigFile:args.runtimeConfigFile,
 readPlan:args.readPlan??readProtectedRestorePlan,readState:args.readState??readExecutionState,
 readCutover:args.readCutover??readCutoverState,
 readEvidence:args.readEvidence??readC1Evidence,
 pathCheck:args.pathCheck??checkedPaths,verify:args.verify??verifyArtifact,
 readAlerts:args.readAlerts??alerts,journalOptions:args.journalOptions??{},
 evidenceOptions:args.evidenceOptions??{},...args.dependencies});

async function eligible(source,capability,args){
 const f=await readC2CutoverFacts(source,capability,c2Args(args));
 assertSwitched(f);assertStopped(args.managedRuntime);return f;
}
async function stable(source,capability,args,expected){
 const readPlan=args.readPlan??readProtectedRestorePlan,
  pathCheck=args.pathCheck??checkedPaths,verify=args.verify??verifyArtifact,
  readState=args.readState??readExecutionState,
  readCutover=args.readCutover??readCutoverState,
  readEvidence=args.readEvidence??readC1Evidence,
  readC3=args.readC3??readC3State,readAlerts=args.readAlerts??alerts;
 const {loaded,plan,journal}=await readPlan({runtimeConfigFile:args.runtimeConfigFile,
  pathCheck,...args.dependencies});
 if(plan.formatVersion!==2||plan.currentDatabase!==capability.database||
    plan.targetServerUuid!==capability.serverUuid||plan.targetPort!==capability.port||
    loaded.config.storeId!==plan.storeId||loaded.config.ledgerId!==plan.ledgerId||
    loaded.config.applicationCommit!==plan.applicationCommit)
  throw fail('PRODUCTION_C3_IDENTITY_MISMATCH');
 const url=new URL(loaded.apiEnv.KTV_MYSQL_URL);
 if(url.hostname!==plan.targetHost||Number(url.port||3306)!==plan.targetPort||
    decodeURIComponent(url.pathname.slice(1))!==plan.targetDatabase)
  throw fail('PRODUCTION_C3_POINTER_MISMATCH');
 if((await readState(journal,plan))?.state!=='VERIFYING')
  throw fail('PRODUCTION_C3_EXECUTION_MISMATCH');
 if((await readCutover(journal,plan,args.journalOptions))?.state!=='CUTOVER_SWITCHED')
  throw fail('PRODUCTION_C3_CUTOVER_NOT_COMPLETE');
 const c3=await readC3(journal,plan,args.journalOptions);
 if(!c3||!expected.includes(c3.state))throw fail('PRODUCTION_C3_JOURNAL_CONFLICT');
 const roots=await pathCheck(loaded,null,args.dependencies);
 const artifactDirectory=join(roots.backup,plan.backupLocator);
 await pathCheck(loaded,artifactDirectory,args.dependencies);
 const artifact=await verify(artifactDirectory,{expectedChecksum:plan.backupSha256,
  storeId:plan.storeId,ledgerId:plan.ledgerId});
 artifactMatches(plan,artifact);
 await server(source,plan.currentDatabase,plan);
 let candidate;
 try{
  candidate=await mysql.createConnection({uri:targetUrl(capability.url,plan.targetDatabase),
   dateStrings:true,jsonStrings:true,supportBigNumbers:true,bigNumberStrings:true});
  await candidate.query('SET SESSION TRANSACTION READ ONLY');
  await server(candidate,plan.targetDatabase,plan);
  await validateSchema(candidate,plan.targetDatabase);
  const oldControl=await control(source),targetControl=await control(candidate);
  requireControl(oldControl,plan,'FROZEN','plan-bound-recovery-freeze');
  const mode=c3.state==='READY_INTENT'?'READY_FOR_RESUME':
   c3.state==='READY_FOR_RESUME'||c3.state==='RESUME_INTENT'?'READY_FOR_RESUME':'NORMAL';
  // RESUME_INTENT may be either side of the database commit.
  if(c3.state==='RESUME_INTENT'&&targetControl?.mode==='NORMAL')
   requireControl(targetControl,plan,'NORMAL','plan-bound-candidate-restore');
  else requireControl(targetControl,plan,mode,'plan-bound-candidate-restore');
  if(targetControl.mode==='NORMAL'&&
     (targetControl.facts?.c3Status!=='RESUMED'||
      targetControl.facts?.preparedDigest!==c3.candidateBusinessDigest||
      !targetControl.facts?.verifiedAt||
      targetControl.facts?.source?.database!==plan.currentDatabase||
      targetControl.facts?.source?.serverUuid!==plan.targetServerUuid))
   throw fail('PRODUCTION_C3_IDENTITY_MISMATCH');
  // Completed operations may have legitimate new business writes and sessions.
  // The terminal journal and bound controls, rather than the old snapshot,
  // determine whether a later same-operation call is an idempotent replay.
  if(c3.state==='RESUMED')return {loaded,plan,journal,c3,artifact,targetControl};
  if(targetControl.mode==='READY_FOR_RESUME'&&
     (targetControl.facts?.c3Status!=='READY_FOR_RESUME'||
      targetControl.facts?.preparedDigest!==c3.candidateBusinessDigest||
      typeof targetControl.facts?.verifiedAt!=='string'))
   throw fail('PRODUCTION_C3_IDENTITY_MISMATCH');
  const [[sessions]]=await candidate.query(
   'SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL');
  if(Number(sessions.n)!==0)throw fail('PRODUCTION_C3_SESSION_ACTIVE');
  await source.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await source.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  await candidate.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await candidate.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  let oldDigest,businessDigest;
  try{
   oldDigest=digest(canonical(await readTables(source,artifact.spec.tables)));
   businessDigest=await stableDigest(candidate,artifact.spec);
  }finally{await candidate.rollback();await source.rollback();}
  if(oldDigest!==c3.oldDigest||businessDigest!==c3.candidateBusinessDigest)
   throw fail('PRODUCTION_C3_DATA_CHANGED');
  const alertDigest=digest(canonical({outbox:await readAlerts(loaded)}));
  if(alertDigest!==c3.alertDigest)throw fail('PRODUCTION_C3_EXTERNAL_CHANGED');
  const evidence=await readEvidence(journal,plan,{
   oldDigest:c3.oldDigest,candidateDigest:c3.c1CandidateDigest,
   alertDigest:c3.alertDigest,journalState:'VERIFYING'},args.evidenceOptions);
  if(!evidence?.cutoverEligible||digest(canonical(evidence))!==c3.c1EvidenceDigest)
   throw fail('PRODUCTION_C3_C1_EVIDENCE_STALE');
  assertStopped(args.managedRuntime);
  return {loaded,plan,journal,c3,artifact,targetControl};
 }finally{await candidate?.end();}
}
async function mutateCandidate(capability,plan,work){
 const c=await mysql.createConnection({uri:targetUrl(capability.url,plan.targetDatabase),
  dateStrings:true,jsonStrings:true,supportBigNumbers:true,bigNumberStrings:true});
 try{await c.beginTransaction();try{
  const result=await work(c);await c.commit();return result;
 }catch(error){await c.rollback();throw error;}}finally{await c.end();}
}
function checkedControl(row,plan,mode){
 let facts;try{facts=typeof row?.facts==='string'?JSON.parse(row.facts):row?.facts;}catch{}
 requireControl(row&&{...row,facts},plan,mode,'plan-bound-candidate-restore');
 return facts;
}

// Both public functions require the private owned-fixture capability before file or DB access.
// They deliberately have no production CLI entry or operator-selected target.
export async function prepareOwnedCandidateResume({capability,managedRuntime,
 readC3=readC3State,transition=transitionC3State,journalOptions={},testHooks={},
 ...dependencies}){
 return withOwnedCandidateRead(capability,async source=>{
  const args={...dependencies,managedRuntime,readC3,journalOptions,
   dependencies};
  assertStopped(managedRuntime);
  const initial=await (dependencies.readPlan??readProtectedRestorePlan)({
   runtimeConfigFile:dependencies.runtimeConfigFile,
   pathCheck:dependencies.pathCheck??checkedPaths,...dependencies});
  let state=await readC3(initial.journal,initial.plan,journalOptions);
  if(!state){
   const f=await eligible(source,capability,args),proof=proofOf(f);
   state={state:'READY_INTENT',...proof};
   await transition(f.journal,f.plan,proof,null,'READY_INTENT',journalOptions);
   await testHooks.afterReadyIntent?.();
  }
  if(state.state==='READY_FOR_RESUME'){
   await stable(source,capability,args,['READY_FOR_RESUME']);
   return {state:'READY_FOR_RESUME',replay:true};
  }
  if(state.state!=='READY_INTENT')throw fail('PRODUCTION_C3_JOURNAL_CONFLICT');
  // If the DB already committed READY, only reconcile the filesystem state.
  let candidateMode;
  const probe=await mysql.createConnection({uri:targetUrl(capability.url,initial.plan.targetDatabase)});
  try{candidateMode=(await control(probe))?.mode;}finally{await probe.end();}
  if(candidateMode==='READY_FOR_RESUME'){
   const f=await stable(source,capability,args,['READY_INTENT']);
   await transition(f.journal,f.plan,f.c3,'READY_INTENT','READY_FOR_RESUME',journalOptions);
   return {state:'READY_FOR_RESUME',replay:true};
  }
  if(candidateMode!=='VERIFYING')throw fail('PRODUCTION_C3_IDENTITY_MISMATCH');
  const f=await eligible(source,capability,args),proof=proofOf(f);
  if(Object.entries(proof).some(([key,value])=>state[key]!==value))
   throw fail('PRODUCTION_C3_JOURNAL_CONFLICT');
  await mutateCandidate(capability,f.plan,async c=>{
   const [[row]]=await c.query('SELECT * FROM recovery_control WHERE control_id=1 FOR UPDATE');
   const facts=checkedControl(row,f.plan,'VERIFYING');
   const [[sessions]]=await c.query('SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL');
   if(Number(sessions.n)!==0)throw fail('PRODUCTION_C3_SESSION_ACTIVE');
   const actual=await stableDigest(c,f.artifact?.spec??(await verifyArtifact(
    join((await (dependencies.pathCheck??checkedPaths)(f.loaded,null,dependencies)).backup,
     f.plan.backupLocator),{expectedChecksum:f.plan.backupSha256,
      storeId:f.plan.storeId,ledgerId:f.plan.ledgerId})).spec);
   if(actual!==proof.candidateBusinessDigest)throw fail('PRODUCTION_C3_DATA_CHANGED');
   const [[clock]]=await c.query(
    "SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS now");
   const next={...facts,preparedDigest:actual,verifiedAt:clock.now,
    source:{database:f.plan.currentDatabase,serverUuid:f.plan.targetServerUuid},
    c3Status:'READY_FOR_RESUME'};
   const [changed]=await c.execute(
    "UPDATE recovery_control SET mode='READY_FOR_RESUME',facts=?,updated_at=UTC_TIMESTAMP(6) WHERE control_id=1 AND mode='VERIFYING'",
    [canonical(next)]);
   if(changed.affectedRows!==1)throw fail('PRODUCTION_C3_IDENTITY_MISMATCH');
   await c.execute('INSERT INTO recovery_events(event_type,initiated_by,reason,facts) VALUES(?,?,?,?)',
    ['verified',f.plan.operatorSid,'s3c-ready',canonical({recoveryOperationId:f.plan.recoveryOperationId,
     planDigest:f.plan.planDigest})]);
  });
  await testHooks.afterReadyCommit?.();
  const checked=await stable(source,capability,args,['READY_INTENT']);
  await transition(checked.journal,checked.plan,checked.c3,
   'READY_INTENT','READY_FOR_RESUME',journalOptions);
  return {state:'READY_FOR_RESUME',replay:false};
 });
}
export async function resumeOwnedCandidate({capability,managedRuntime,
 readC3=readC3State,transition=transitionC3State,journalOptions={},testHooks={},
 ...dependencies}){
 return withOwnedCandidateRead(capability,async source=>{
  const args={...dependencies,managedRuntime,readC3,journalOptions,dependencies};
  assertStopped(managedRuntime);
  const first=await stable(source,capability,args,
   ['READY_FOR_RESUME','RESUME_INTENT','RESUMED']);
  if(first.c3.state==='RESUMED'){
   if(first.targetControl.mode!=='NORMAL')throw fail('PRODUCTION_C3_JOURNAL_CONFLICT');
   return {state:'RESUMED',replay:true};
  }
  if(first.c3.state==='READY_FOR_RESUME')
   await transition(first.journal,first.plan,first.c3,
    'READY_FOR_RESUME','RESUME_INTENT',journalOptions);
  await testHooks.afterResumeIntent?.();
  const current=await stable(source,capability,args,['RESUME_INTENT']);
  if(current.targetControl.mode==='NORMAL'){
   await transition(current.journal,current.plan,current.c3,
    'RESUME_INTENT','RESUMED',journalOptions);
   return {state:'RESUMED',replay:true};
  }
  if(current.targetControl.mode!=='READY_FOR_RESUME')
   throw fail('PRODUCTION_C3_IDENTITY_MISMATCH');
  await mutateCandidate(capability,current.plan,async c=>{
   const [[row]]=await c.query('SELECT * FROM recovery_control WHERE control_id=1 FOR UPDATE');
   const facts=checkedControl(row,current.plan,'READY_FOR_RESUME');
   if(facts.c3Status!=='READY_FOR_RESUME'||
      facts.preparedDigest!==current.c3.candidateBusinessDigest)
    throw fail('PRODUCTION_C3_IDENTITY_MISMATCH');
   const [[sessions]]=await c.query('SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL');
   if(Number(sessions.n)!==0)throw fail('PRODUCTION_C3_SESSION_ACTIVE');
   const actual=await stableDigest(c,current.artifact.spec);
   if(actual!==current.c3.candidateBusinessDigest)
    throw fail('PRODUCTION_C3_DATA_CHANGED');
   const [changed]=await c.execute(
    "UPDATE recovery_control SET mode='NORMAL',facts=?,updated_at=UTC_TIMESTAMP(6) WHERE control_id=1 AND mode='READY_FOR_RESUME'",
    [canonical({...facts,c3Status:'RESUMED'})]);
   if(changed.affectedRows!==1)throw fail('PRODUCTION_C3_IDENTITY_MISMATCH');
   await c.execute('INSERT INTO recovery_events(event_type,initiated_by,reason,facts) VALUES(?,?,?,?)',
    ['resumed',current.plan.operatorSid,'s3c-resume',
     canonical({recoveryOperationId:current.plan.recoveryOperationId,
      planDigest:current.plan.planDigest})]);
  });
  await testHooks.afterResumeCommit?.();
  const checked=await stable(source,capability,args,['RESUME_INTENT']);
  if(checked.targetControl.mode!=='NORMAL')throw fail('PRODUCTION_C3_IDENTITY_MISMATCH');
  await transition(checked.journal,checked.plan,checked.c3,
   'RESUME_INTENT','RESUMED',journalOptions);
  return {state:'RESUMED',replay:false};
 });
}
