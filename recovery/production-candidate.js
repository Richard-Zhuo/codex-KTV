import mysql from 'mysql2/promise';
import {resolve,join} from 'node:path';
import {assertFixtureEnvironment} from '../test-support/destructive-safety.js';
import {assertOwnedRoot} from '../rehearsal/scope.js';
import {canonical,fail} from '../backup/format.js';
import {dispatchLock} from './gate.js';
import {readProtectedRestorePlan,preflightPreparedRestore,planBinding} from './production-plan.js';
import {readExecutionState,transitionExecutionState} from './production-journal.js';

const capabilities=new WeakSet();
const lockName='s3b-production-candidate-restore';
const sameBinding=(facts,plan)=>Object.entries(planBinding(plan)).every(([key,value])=>facts?.[key]===value);
const frozenFacts=plan=>({reason:'plan-bound-recovery-freeze',...planBinding(plan)});

export async function issueOwnedCandidateCapability(f){
 assertFixtureEnvironment();
 const root=await assertOwnedRoot(f.root,f.names.id);
 if(![33313,33315].includes(f.port)||f.names.database!=='jbhh_ktv_test')throw fail('RESTORE_FIXTURE_DENIED');
 const url=f.dbUrl(f.names.database);
 const c=await mysql.createConnection({uri:url});
 try{
  const [[r]]=await c.query('SELECT @@port AS port,@@datadir AS datadir,@@server_uuid AS uuid,DATABASE() AS db');
  if(Number(r.port)!==f.port||resolve(r.datadir)!==join(root,'data')||
    r.uuid!==f.identity.server_uuid||r.db!==f.names.database)
   throw fail('RESTORE_FIXTURE_DENIED');
 }finally{await c.end();}
 const capability=Object.freeze({root,id:f.names.id,url,port:f.port,
  serverUuid:f.identity.server_uuid,database:f.names.database});
 capabilities.add(capability);
 return capability;
}
async function ownedConnection(capability){
 if(!capabilities.has(capability))throw fail('RESTORE_PRODUCTION_DISABLED');
 assertFixtureEnvironment();
 const root=await assertOwnedRoot(capability.root,capability.id);
 const c=await mysql.createConnection({uri:capability.url,dateStrings:true,jsonStrings:true,
  supportBigNumbers:true,bigNumberStrings:true});
 try{
  const [[r]]=await c.query('SELECT @@port AS port,@@datadir AS datadir,@@server_uuid AS uuid,DATABASE() AS db');
  if(Number(r.port)!==capability.port||resolve(r.datadir)!==join(root,'data')||
   r.uuid!==capability.serverUuid||r.db!==capability.database)
   throw fail('RESTORE_FIXTURE_DENIED');
  return c;
 }catch(error){await c.end();throw error;}
}
async function withOwnedLock(capability,work){
 const c=await ownedConnection(capability);let locked=false;
 try{
  const [[claim]]=await c.execute('SELECT GET_LOCK(?,10) AS acquired',[lockName]);
  if(Number(claim.acquired)!==1)throw fail('PRODUCTION_RESTORE_BUSY');
  locked=true;
  return await work(c);
 }finally{
  if(locked)try{await c.execute('SELECT RELEASE_LOCK(?)',[lockName]);}catch{}
  await c.end();
 }
}
function checkPlanSource(plan,capability){
 if(plan.currentDatabase!==capability.database||plan.targetServerUuid!==capability.serverUuid||
  plan.currentPort!==capability.port)
  throw fail('RESTORE_FIXTURE_DENIED');
}
async function freezeActive(c,plan){
 const db=plan.currentDatabase;
 const [[claim]]=await c.execute('SELECT GET_LOCK(?,10) AS acquired',[dispatchLock(db)]);
 if(Number(claim.acquired)!==1)throw fail('PRODUCTION_RESTORE_DISPATCH_BUSY');
 let transaction=false;
 try{
  await c.beginTransaction();transaction=true;
  const [[row]]=await c.query('SELECT mode,store_id,ledger_id,environment,facts FROM recovery_control WHERE control_id=1 FOR UPDATE');
  if(row?.mode==='FROZEN'){
   let facts;try{facts=JSON.parse(row.facts);}catch{}
   if(!sameBinding(facts,plan)||row.store_id!==plan.storeId||
     row.ledger_id!==plan.ledgerId||row.environment!=='production')
    throw fail('PRODUCTION_RESTORE_FREEZE_CONFLICT');
   await c.rollback();transaction=false;return 'REPLAY';
  }
  if(row&&row.mode!=='NORMAL')throw fail('PRODUCTION_RESTORE_FREEZE_CONFLICT');
  const [[head]]=await c.execute('SELECT revision FROM ledger_heads WHERE ledger_id=? FOR UPDATE',[plan.ledgerId]);
  if(!head||Number(head.revision)!==plan.currentRevision)
   throw fail('PRODUCTION_RESTORE_PLAN_PRECONDITION_CHANGED');
  const [receipts]=await c.query('SELECT store_id,ledger_id,environment FROM production_bootstrap_events');
  if(!receipts.length||receipts.some(r=>r.store_id!==plan.storeId||
    r.ledger_id!==plan.ledgerId||r.environment!=='production'))
   throw fail('PRODUCTION_RESTORE_SOURCE_IDENTITY_MISMATCH');
  await c.execute("INSERT INTO recovery_control(control_id,mode,store_id,ledger_id,environment,backup_digest,initiated_by,facts) VALUES(1,'FROZEN',?,?,?,?,?,?) ON DUPLICATE KEY UPDATE mode='FROZEN',backup_digest=VALUES(backup_digest),initiated_by=VALUES(initiated_by),facts=VALUES(facts),updated_at=UTC_TIMESTAMP(6)",
   [plan.storeId,plan.ledgerId,'production',plan.backupSha256,plan.operatorSid,canonical(frozenFacts(plan))]);
  await c.execute('INSERT INTO recovery_events(event_type,initiated_by,reason,facts) VALUES(?,?,?,?)',
   ['frozen',plan.operatorSid,'plan-bound-freeze',canonical(planBinding(plan))]);
  await c.commit();transaction=false;return 'FROZEN';
 }catch(error){if(transaction)try{await c.rollback();}catch{}throw error;}
 finally{try{await c.execute('SELECT RELEASE_LOCK(?)',[dispatchLock(db)]);}catch{}}
}
function verifiedExecution(initial,validated){
 if(initial.journal!==validated.journal||
  canonical(initial.plan)!==canonical(validated.plan))
  throw fail('PRODUCTION_RESTORE_PLAN_PRECONDITION_CHANGED');
 return validated;
}
export async function freezePreparedCandidate({runtimeConfigFile,capability,
 preflight=preflightPreparedRestore,readPlan=readProtectedRestorePlan,
 readState=readExecutionState,transition=transitionExecutionState,
 ...dependencies}){
 return withOwnedLock(capability,async c=>{
  // The first read selects only a journal phase. It never authorizes a DB mutation.
  const initial=await readPlan({runtimeConfigFile,...dependencies});
  const state=await readState(initial.journal,initial.plan);
  if(state&&!['FREEZE_INTENT','FROZEN'].includes(state.state))
   throw fail('PRODUCTION_RESTORE_JOURNAL_CONFLICT');
  const checked=async requiredMode=>{
   const validated=verifiedExecution(initial,
    await preflight({runtimeConfigFile,requiredMode,...dependencies}));
   checkPlanSource(validated.plan,capability);
   return validated;
  };
  if(state?.state==='FROZEN'){
   await checked('FROZEN');
   return {state:'FROZEN',replay:true};
  }
  let execution;
  try{execution=await checked('NORMAL');}
  catch(error){
   if(state?.state!=='FREEZE_INTENT')throw error;
   execution=await checked('FROZEN');
   await transition(execution.journal,execution.plan,'FREEZE_INTENT','FROZEN');
   return {state:'FROZEN',replay:true};
  }
  const {plan,journal}=execution;
  if(!state)await transition(journal,plan,null,'FREEZE_INTENT');
  await freezeActive(c,plan);
  await transition(journal,plan,'FREEZE_INTENT','FROZEN');
  return {state:'FROZEN',replay:false};
 });
}
