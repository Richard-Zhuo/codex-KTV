import mysql from 'mysql2/promise';
import {resolve,join} from 'node:path';
import {assertFixtureEnvironment} from '../test-support/destructive-safety.js';
import {assertOwnedRoot} from '../rehearsal/scope.js';
import {canonical,digest,fail,verifyArtifact} from '../backup/format.js';
import {readTables,createOfficialRestoreSchema,importStructuredBackupRows} from '../backup/mysql-backup.js';
import {validateSchema} from '../production/schema.js';
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

async function targetExists(c,name){
 const [rows]=await c.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[name]);
 return rows.length!==0;
}
function verifiedArtifact(execution,artifact){
 const {plan}=execution,{manifest}=artifact;
 if(manifest.backupId!==plan.backupId||manifest.createdAt!==plan.backupCreatedAt||
   manifest.source.serverUuid!==plan.sourceServerUuid||
   manifest.source.database!==plan.sourceDatabase||
   manifest.applicationCommit!==plan.applicationCommit||
   manifest.migrationVersion!==plan.schemaMigration||
   manifest.ledgerHeads.find(h=>h.ledgerId===plan.ledgerId)?.revision!==plan.backupRevision)
  throw fail('PRODUCTION_RESTORE_PLAN_PRECONDITION_CHANGED');
 return artifact;
}
async function verifyImportedStructure(c,plan,artifact){
 await validateSchema(c,plan.targetDatabase);
 const [[fk]]=await c.query('SELECT @@foreign_key_checks AS enabled');
 if(Number(fk.enabled)!==1)throw fail('PRODUCTION_RESTORE_FK_CHECKS_DISABLED');
 const imported=await readTables(c,artifact.spec.tables);
 for(const name of artifact.spec.tables){
  if(name==='recovery_control')continue;
  const expected=artifact.data.tables[name],actual=imported[name];
  if(actual.rows.length!==expected.rows.length||
    JSON.stringify(actual.columns)!==JSON.stringify(expected.columns)||
    digest(canonical(actual))!==digest(canonical(expected)))
   throw fail('PRODUCTION_RESTORE_IMPORT_MISMATCH');
 }
 const [[control]]=await c.query('SELECT mode,store_id,ledger_id,environment,backup_digest,facts FROM recovery_control WHERE control_id=1');
 let facts;try{facts=JSON.parse(control?.facts);}catch{}
 if(control?.mode!=='RESTORING'||control.store_id!==plan.storeId||
   control.ledger_id!==plan.ledgerId||control.environment!=='production'||
   control.backup_digest!==plan.backupSha256||!sameBinding(facts,plan))
  throw fail('PRODUCTION_RESTORE_CANDIDATE_IDENTITY_MISMATCH');
}
async function revokeRestoredSessions(c){
 const [sessions]=await c.query('SELECT session_id,principal_id FROM auth_sessions WHERE revoked_at IS NULL FOR UPDATE');
 await c.query('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP(6) WHERE revoked_at IS NULL');
 for(const session of sessions)await c.execute("INSERT INTO auth_events(principal_id,session_id,event_type,reason_code) VALUES(?,?,'session-revoked','recovery-candidate')",[session.principal_id,session.session_id]);
 const [[left]]=await c.query('SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL');
 if(Number(left.n)!==0)throw fail('PRODUCTION_RESTORE_SESSION_INVALIDATION_FAILED');
 return sessions.length;
}
/**
 * Only an owned, isolated fixture capability can enter this core. The ordinary
 * production CLI has no route here. There is deliberately no target or artifact
 * argument: both come exclusively from the protected PREPARED plan.
 */
export async function restorePreparedCandidate({runtimeConfigFile,capability,
 preflight=preflightPreparedRestore,readPlan=readProtectedRestorePlan,
 readState=readExecutionState,transition=transitionExecutionState,
 verify=verifyArtifact,schema=createOfficialRestoreSchema,
 importRows=importStructuredBackupRows,testHooks={},
 ...dependencies}){
 return withOwnedLock(capability,async c=>{
  const initial=await readPlan({runtimeConfigFile,...dependencies});
  checkPlanSource(initial.plan,capability);
  const state=await readState(initial.journal,initial.plan);
  if(!state||!['FROZEN','RESTORING'].includes(state.state))
   throw fail('PRODUCTION_RESTORE_JOURNAL_CONFLICT');
  const checked=async()=> {
   const execution=verifiedExecution(initial,
    await preflight({runtimeConfigFile,requiredMode:'FROZEN',...dependencies}));
   checkPlanSource(execution.plan,capability);
   return execution;
  };
  let execution;
  try{execution=await checked();}
  catch(error){
   if(state.state==='RESTORING'&&await targetExists(c,initial.plan.targetDatabase))
    await transition(initial.journal,initial.plan,'RESTORING','FAILED_AMBIGUOUS');
   throw error;
  }
  const {plan,journal,artifactDirectory}=execution;
  if(await targetExists(c,plan.targetDatabase)){
   if(state.state==='RESTORING')await transition(journal,plan,'RESTORING','FAILED_AMBIGUOUS');
   throw fail('PRODUCTION_RESTORE_TARGET_EXISTS');
  }
  if(state.state==='FROZEN')await transition(journal,plan,'FROZEN','RESTORING');
  // Repeat the complete preflight immediately before CREATE. A persisted intent
  // alone never licenses a database mutation.
  execution=await checked();
  const artifact=verifiedArtifact(execution,await verify(artifactDirectory,{
   expectedChecksum:plan.backupSha256,storeId:plan.storeId,ledgerId:plan.ledgerId}));
  let createAttempted=false,created=false,begun=false;
  try{
   if(await targetExists(c,plan.targetDatabase))throw fail('PRODUCTION_RESTORE_TARGET_EXISTS');
   createAttempted=true;
   await c.query('CREATE DATABASE '+plan.targetDatabase+' CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
   created=true;
   await testHooks.afterCreate?.();
   await c.query('USE '+plan.targetDatabase);
   await schema(c,artifact.spec,plan.targetDatabase,async()=>{
    await c.execute('INSERT INTO recovery_control(control_id,mode,store_id,ledger_id,environment,backup_digest,initiated_by,facts) VALUES(1,?,?,?,?,?,?,?)',
     ['RESTORING',plan.storeId,plan.ledgerId,'production',plan.backupSha256,plan.operatorSid,
      canonical({reason:'plan-bound-candidate-restore',...planBinding(plan)})]);
   });
   await testHooks.afterSchema?.();
   await c.beginTransaction();begun=true;
   await importRows(c,artifact);
   await testHooks.afterImport?.();
   await verifyImportedStructure(c,plan,artifact);
   const sessionsInvalidated=await revokeRestoredSessions(c);
   await c.execute('INSERT INTO recovery_events(event_type,initiated_by,reason,facts) VALUES(?,?,?,?)',
    ['restored',plan.operatorSid,'plan-bound-candidate-restore',
     canonical({...planBinding(plan),sessionsInvalidated})]);
   const [updated]=await c.execute("UPDATE recovery_control SET mode='VERIFYING',updated_at=UTC_TIMESTAMP(6) WHERE control_id=1 AND mode='RESTORING'");
   if(updated.affectedRows!==1)throw fail('PRODUCTION_RESTORE_CANDIDATE_IDENTITY_MISMATCH');
   await c.commit();begun=false;
   await transition(journal,plan,'RESTORING','VERIFYING');
   return {state:'VERIFYING',targetDatabase:plan.targetDatabase,
    recoveryOperationId:plan.recoveryOperationId,planDigest:plan.planDigest,
    sessionsInvalidated};
  }catch(error){
   if(begun)try{await c.rollback();}catch{}
   if(createAttempted){
    // Only proven absence permits the same operation to retry. If visibility
    // is lost, preserve the ambiguous journal instead of assuming no DB exists.
    let exists=true;
    if(!created)try{exists=await targetExists(c,plan.targetDatabase);}catch{}
    if(created||exists)try{await transition(journal,plan,'RESTORING','FAILED_AMBIGUOUS');}catch{}
   }
   throw error;
  }
 });
}

// Reuses the private owned-fixture capability; ordinary production configuration cannot enter C1.
export async function withOwnedCandidateRead(capability,work){
 return withOwnedLock(capability,async c=>{await c.query('SET SESSION TRANSACTION READ ONLY');return work(c);});
}
