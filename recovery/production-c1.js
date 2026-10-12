import mysql from 'mysql2/promise';
import {join} from 'node:path';
import {canonical,digest,fail,verifyArtifact} from '../backup/format.js';
import {readTables} from '../backup/mysql-backup.js';
import {validateSchema} from '../production/schema.js';
import {createOperationalStore} from '../operations/store.js';
import {hash} from '../operations/contract.js';
import {readProtectedRestorePlan,checkedPaths,planBinding} from './production-plan.js';
import {readExecutionState} from './production-journal.js';
import {withOwnedCandidateRead} from './production-candidate.js';
import {checkCutoverCandidate} from './c1-checks.js';
import {writeC1Evidence} from './c1-evidence.js';

const same=(facts,plan)=>Object.entries(planBinding(plan)).every(([k,v])=>facts?.[k]===v);
const parse=value=>{try{return typeof value==='string'?JSON.parse(value):value;}catch{return null;}};
const blocked=code=>({cutoverEligible:false,blockingFindings:[{code}],manualFollowups:[],
 external:{voucher:'NOT_VERIFIED',device:'NOT_VERIFIED',payment:'NOT_VERIFIED',alerts:'NOT_VERIFIED'}});
const control=async c=>{
 const [[row]]=await c.query('SELECT mode,store_id,ledger_id,environment,backup_digest,facts FROM recovery_control WHERE control_id=1');
 return row&&{...row,facts:parse(row.facts)};
};
export function requireControl(row,plan,mode,reason){
 if(row?.mode!==mode||row.store_id!==plan.storeId||row.ledger_id!==plan.ledgerId||
    row.environment!=='production'||row.backup_digest!==plan.backupSha256||
    row.facts?.reason!==reason||!same(row.facts,plan))
  throw fail('PRODUCTION_RESTORE_C1_IDENTITY_MISMATCH');
}
export async function server(c,database,plan){
 const [[r]]=await c.query('SELECT DATABASE() AS db,@@server_uuid AS uuid,@@port AS port');
 if(r.db!==database||r.uuid!==plan.targetServerUuid||Number(r.port)!==plan.targetPort)
  throw fail('PRODUCTION_RESTORE_C1_SERVER_MISMATCH');
}
export async function alerts(loaded){
 if(!loaded.logDirectory)return [];
 const scope=hash(loaded.config.storeId+':'+loaded.config.ledgerId);
 return (await createOperationalStore(loaded.logDirectory,scope)).read().outbox;
}
function alertFindings(outbox){
 const blocking=[],manual=[];
 for(const item of outbox){
  if(item.state==='DELIVERED'||item.state==='SUPERSEDED')continue;
  const uncertain=item.providerResult==='UNKNOWN'||item.uncertain===true||
   item.providerAcceptanceUncertain===true;
  if(uncertain&&['CRITICAL','ERROR'].includes(item.severity))
   blocking.push({code:'C1_CRITICAL_ALERT_DELIVERY_UNKNOWN',area:'alerts'});
  else manual.push({code:'C1_ALERT_DELIVERY_REVIEW',area:'alerts'});
 }
 return {blocking,manual,status:blocking.length?'BLOCKING_UNKNOWN':
  manual.length?'NON_BLOCKING_MANUAL_FOLLOWUP':'SAFE'};
}
export async function snapshot(source,candidate,spec){
 await source.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
 await source.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
 await candidate.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
 await candidate.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
 try{
  const [oldControl,candidateControl,oldTables,candidateTables]=await Promise.all([
   control(source),control(candidate),readTables(source,spec.tables),readTables(candidate,spec.tables)]);
  return {oldControl,candidateControl,candidateTables,
   oldDigest:digest(canonical(oldTables)),candidateDigest:digest(canonical(candidateTables))};
 }finally{await candidate.rollback();await source.rollback();}
}
export function artifactMatches(plan,artifact){
 const m=artifact.manifest;
 if(m.backupId!==plan.backupId||m.createdAt!==plan.backupCreatedAt||
    m.source.serverUuid!==plan.sourceServerUuid||m.source.database!==plan.sourceDatabase||
    m.applicationCommit!==plan.applicationCommit||m.migrationVersion!==plan.schemaMigration||
    digest(canonical(artifact.spec.manifest))!==plan.schemaDigest)
  throw fail('PRODUCTION_RESTORE_C1_BACKUP_MISMATCH');
}
export async function verifyPreparedCandidate({runtimeConfigFile,capability,
 readPlan=readProtectedRestorePlan,readState=readExecutionState,pathCheck=checkedPaths,
 verify=verifyArtifact,readAlerts=alerts,persist=writeC1Evidence,testHooks={},
 ...dependencies}){
 // The private WeakSet and owned-MySQL checks run before any plan or database read.
 return withOwnedCandidateRead(capability,async source=>{
  let candidate;
  try{
   const initial=await readPlan({runtimeConfigFile,pathCheck,...dependencies});
   const {plan,loaded,journal}=initial;
   if(plan.formatVersion!==2||plan.currentDatabase!==capability.database||
      plan.targetServerUuid!==capability.serverUuid||plan.targetPort!==capability.port)
    throw fail('PRODUCTION_RESTORE_C1_IDENTITY_MISMATCH');
   const active=new URL(loaded.apiEnv.KTV_MYSQL_URL);
   if(decodeURIComponent(active.pathname.slice(1))!==plan.currentDatabase||
      active.hostname!==plan.currentHost||Number(active.port||3306)!==plan.currentPort||
      loaded.config.storeId!==plan.storeId||loaded.config.ledgerId!==plan.ledgerId||
      loaded.config.applicationCommit!==plan.applicationCommit)
    throw fail('PRODUCTION_RESTORE_C1_CONFIG_MISMATCH');
   if((await readState(journal,plan))?.state!=='VERIFYING')
    throw fail('PRODUCTION_RESTORE_C1_JOURNAL_MISMATCH');
   const roots=await pathCheck(loaded,null,dependencies);
   const artifactDirectory=join(roots.backup,plan.backupLocator);
   await pathCheck(loaded,artifactDirectory,dependencies);
   const artifact=await verify(artifactDirectory,{expectedChecksum:plan.backupSha256,
    storeId:plan.storeId,ledgerId:plan.ledgerId});
   artifactMatches(plan,artifact);
   await server(source,plan.currentDatabase,plan);
   const target=new URL(capability.url);target.pathname='/'+plan.targetDatabase;
   candidate=await mysql.createConnection({uri:target.href,dateStrings:true,jsonStrings:true,
    supportBigNumbers:true,bigNumberStrings:true});
   await candidate.query('SET SESSION TRANSACTION READ ONLY');
   await server(candidate,plan.targetDatabase,plan);
   await validateSchema(candidate,plan.targetDatabase);
   const first=await snapshot(source,candidate,artifact.spec);
   requireControl(first.oldControl,plan,'FROZEN','plan-bound-recovery-freeze');
   requireControl(first.candidateControl,plan,'VERIFYING','plan-bound-candidate-restore');
   const result=checkCutoverCandidate({tables:first.candidateTables},artifact.manifest);
   const initialOutbox=await readAlerts(loaded);
   const alertDigest=digest(canonical({outbox:initialOutbox}));
   const alert=alertFindings(initialOutbox);
   result.blocking.push(...alert.blocking);result.manualFollowups.push(...alert.manual);
   result.external.alerts=alert.status;
   await testHooks.beforePersist?.();
   // The first read is never sufficient authority for a persisted PASS.
   const latest=await readPlan({runtimeConfigFile,pathCheck,...dependencies});
   if(latest.journal!==journal||canonical(latest.plan)!==canonical(plan)||
      (await readState(journal,plan))?.state!=='VERIFYING')
    throw fail('PRODUCTION_RESTORE_C1_STALE');
   const latestRoots=await pathCheck(latest.loaded,null,dependencies);
   if(join(latestRoots.backup,plan.backupLocator)!==artifactDirectory)
    throw fail('PRODUCTION_RESTORE_C1_STALE');
   await pathCheck(latest.loaded,artifactDirectory,dependencies);
   artifactMatches(plan,await verify(artifactDirectory,{expectedChecksum:plan.backupSha256,
    storeId:plan.storeId,ledgerId:plan.ledgerId}));
   await server(source,plan.currentDatabase,plan);
   await server(candidate,plan.targetDatabase,plan);
   const last=await snapshot(source,candidate,artifact.spec);
   requireControl(last.oldControl,plan,'FROZEN','plan-bound-recovery-freeze');
   requireControl(last.candidateControl,plan,'VERIFYING','plan-bound-candidate-restore');
   if(last.oldDigest!==first.oldDigest||last.candidateDigest!==first.candidateDigest||
      digest(canonical({outbox:await readAlerts(loaded)}))!==alertDigest)
    throw fail('PRODUCTION_RESTORE_C1_STALE');
   const evidence=await persist(journal,plan,{cutoverEligible:result.blocking.length===0,
    blocking:result.blocking,manualFollowups:result.manualFollowups,external:result.external,
    oldDigest:last.oldDigest,candidateDigest:last.candidateDigest,alertDigest});
   return {...evidence,candidateState:'VERIFYING',oldState:'FROZEN'};
  }catch(error){
   if(error?.code==='RESTORE_PRODUCTION_DISABLED')throw error;
   const result=blocked(/^PRODUCTION_RESTORE_C1_[A-Z_]+$/.test(error?.code??'')?
    error.code:'PRODUCTION_RESTORE_C1_FAILED');
   if(testHooks.onError)await testHooks.onError(error);
   return result;
  }finally{await candidate?.end();}
 });
}
