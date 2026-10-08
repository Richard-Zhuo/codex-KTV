import { isProductionEnvironment } from '../shared/deployment-environment.js';
import { connect,serverIdentity,readTables,rowsOf } from '../backup/mysql-backup.js';
import { canonical,digest,fail,verifyArtifact,schemaSpec } from '../backup/format.js';
import { validateSchema } from '../production/schema.js';
import { decodeLedgerSnapshot,decodeLedgerJson,encodeLedgerSnapshot } from '../ledger/mysql-snapshot.js';
import { changeWorkflow } from '../devices/domain.js';
import { dispatchLock } from './gate.js';
import { checkRecoveryInvariants } from './invariants.js';
const preserved=spec=>spec.tables.filter(n=>!['recovery_control','recovery_events'].includes(n));
const audit=(c,type,actor,reason,facts)=>c.execute('INSERT INTO recovery_events(event_type,initiated_by,reason,facts) VALUES(?,?,?,?)',[type,actor,reason,canonical(facts)]);
async function checkedConnection(args,suffix='') {
 isProductionEnvironment(args.env??process.env);if(!['production','test'].includes(args.environment))throw fail('RECOVERY_ENVIRONMENT_INVALID');
 const database=decodeURIComponent(new URL(args.databaseUrl).pathname.slice(1));
 if(typeof args.initiatedBy!=='string'||!args.initiatedBy.trim()||args.confirmation!==args.serverUuid+'/'+database+'/'+args.storeId+'/'+args.ledgerId+suffix)throw fail('RECOVERY_CONFIRMATION_REQUIRED');
 const c=await connect(args.databaseUrl);try{const id=await serverIdentity(c);if(id.server_uuid!==args.serverUuid)throw fail('RECOVERY_SERVER_MISMATCH');await validateSchema(c,database);return c;}catch(e){await c.end();throw e;}
}
export async function freezeDatabase(args) {
 let c,locked=false;
 try {
  c=await checkedConnection(args);const database=decodeURIComponent(new URL(args.databaseUrl).pathname.slice(1));
  const [[lock]]=await c.execute('SELECT GET_LOCK(?,10) AS acquired',[dispatchLock(database)]);if(Number(lock.acquired)!==1)throw fail('RECOVERY_DISPATCH_BUSY');locked=true;
  await c.beginTransaction();
  const [receipts]=await c.query('SELECT store_id,ledger_id,environment FROM production_bootstrap_events');
  if(!receipts.length||receipts.some(r=>r.store_id!==args.storeId||r.ledger_id!==args.ledgerId||r.environment!==args.environment))throw fail('RECOVERY_STORE_MISMATCH');
  const [[control]]=await c.query('SELECT mode FROM recovery_control WHERE control_id=1 FOR UPDATE');if(control&&control.mode!=='NORMAL')throw fail('RECOVERY_ALREADY_PAUSED');
  await c.execute("INSERT INTO recovery_control(control_id,mode,store_id,ledger_id,environment,initiated_by,facts) VALUES(1,'FROZEN',?,?,?,?,?) ON DUPLICATE KEY UPDATE mode='FROZEN',initiated_by=VALUES(initiated_by),facts=VALUES(facts),updated_at=UTC_TIMESTAMP(6)",[args.storeId,args.ledgerId,args.environment,args.initiatedBy,canonical({reason:'operator-write-freeze',at:new Date().toISOString()})]);
  await audit(c,'frozen',args.initiatedBy,'operator-write-freeze',{});await c.commit();return {code:'RECOVERY_FROZEN',mode:'FROZEN'};
 }catch(e){try{await c?.rollback();}catch{}throw fail(/^RECOVERY_[A-Z_]+$/.test(e.code??'')?e.code:'RECOVERY_FREEZE_FAILED');}finally{if(c&&locked)await c.execute('SELECT RELEASE_LOCK(?)',[dispatchLock(decodeURIComponent(new URL(args.databaseUrl).pathname.slice(1)))]);await c?.end();}
}
export async function inspectRecovery(args) {
 const backup=await verifyArtifact(args.directory,{expectedChecksum:args.expectedChecksum,storeId:args.storeId,ledgerId:args.ledgerId});
 const c=await checkedConnection(args,'/'+args.expectedChecksum);
 try{await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  const [[control]]=await c.query('SELECT mode,store_id,ledger_id,environment FROM recovery_control WHERE control_id=1');
  if(!control||control.store_id!==args.storeId||control.ledger_id!==args.ledgerId||control.environment!==args.environment)throw fail('RECOVERY_STATE_MISMATCH');
  const report=checkRecoveryInvariants({tables:await readTables(c,backup.spec.tables)},backup.manifest);return {code:'RECOVERY_INSPECTED',mode:control.mode,...report};
 }finally{try{await c.rollback();}finally{await c.end();}}
}
export async function verifyRecovery(args) {
 let c,begun=false;
 try {
  const backup=await verifyArtifact(args.directory,{expectedChecksum:args.expectedChecksum,storeId:args.storeId,ledgerId:args.ledgerId});
  c=await checkedConnection(args,'/'+args.expectedChecksum);await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await c.beginTransaction();begun=true;
  const [[control]]=await c.query('SELECT * FROM recovery_control WHERE control_id=1 FOR UPDATE');
  if(!control||control.mode!=='VERIFYING'||control.backup_digest!==args.expectedChecksum||control.store_id!==args.storeId||control.ledger_id!==args.ledgerId||control.environment!==args.environment)throw fail('RECOVERY_STATE_MISMATCH');
  const data={tables:await readTables(c,backup.spec.tables,{lock:true})};
  for(const name of preserved(backup.spec))if(digest(canonical(data.tables[name]))!==digest(canonical(backup.data.tables[name])))throw fail('RECOVERY_RESTORED_DATA_MISMATCH');
  const report=checkRecoveryInvariants(data,backup.manifest);if(!report.ready)throw fail('RECOVERY_INVARIANT_FAILED');
  const [sessions]=await c.query('SELECT session_id,principal_id FROM auth_sessions WHERE revoked_at IS NULL FOR UPDATE');
  await c.query('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP(6) WHERE revoked_at IS NULL');
  for(const s of sessions)await c.execute("INSERT INTO auth_events(principal_id,session_id,event_type,reason_code) VALUES(?,?,'session-revoked','recovery-cutover')",[s.principal_id,s.session_id]);
  const [[clock]]=await c.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS now");
  let workflowsFenced=0;
  for(const w of rowsOf(data,'room_control_workflows')) {
   const r=decodeLedgerSnapshot(w.state_json,w.state_checksum);if(['ACTIVE','DEVICE_FAILED'].includes(r.status))continue;
   const currentStepAcknowledged=(r.step==='CLOSE'&&r.closeAcknowledged===true)||(r.step==='OPEN'&&r.openAcknowledged===true);
   const next=changeWorkflow(r,{uncertain:r.uncertain===true||!currentStepAcknowledged,inFlight:null},clock.now,'recovery-query-required');
   const encoded=encodeLedgerSnapshot(next);await c.execute('UPDATE room_control_workflows SET version=?,state_json=?,state_checksum=?,updated_at=UTC_TIMESTAMP(6) WHERE ledger_id=? AND workflow_id=? AND version=?',[next.version,encoded.json,encoded.checksum,w.ledger_id,w.workflow_id,w.version]);workflowsFenced++;
  }
  const preparedDigest=digest(canonical({tables:await readTables(c,preserved(backup.spec),{lock:true})}));
  const facts={...decodeLedgerJson(control.facts),verifiedAt:clock.now,preparedDigest,sessionsInvalidated:sessions.length,workflowsFenced,report};
  await c.execute("UPDATE recovery_control SET mode='READY_FOR_RESUME',facts=?,updated_at=UTC_TIMESTAMP(6) WHERE control_id=1",[canonical(facts)]);
  await audit(c,'verified',args.initiatedBy,'recovery-session-invalidation',facts);await c.commit();begun=false;
  return {code:'RECOVERY_READY_FOR_RESUME',mode:'READY_FOR_RESUME',verifiedAt:clock.now,sessionsInvalidated:sessions.length,workflowsFenced,report};
 }catch(e){if(c&&begun)try{await c.rollback();}catch{}throw fail(/^(RECOVERY|BACKUP)_[A-Z_]+$/.test(e.code??'')?e.code:'RECOVERY_VERIFICATION_FAILED');}finally{await c?.end();}
}
export async function resumeRecovery(args) {
 let c;
 try{
  c=await checkedConnection(args,'/'+args.expectedChecksum+'/RESUME');await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await c.beginTransaction();
  const [[control]]=await c.query('SELECT * FROM recovery_control WHERE control_id=1 FOR UPDATE');
  if(!control||!['READY_FOR_RESUME','NORMAL'].includes(control.mode)||control.backup_digest!==args.expectedChecksum||control.store_id!==args.storeId||control.ledger_id!==args.ledgerId||control.environment!==args.environment)throw fail('RECOVERY_NOT_VERIFIED');
  const facts=decodeLedgerJson(control.facts),spec=await schemaSpec();
  if(control.mode==='NORMAL'){
   if(!facts.preparedDigest||!facts.verifiedAt)throw fail('RECOVERY_NOT_VERIFIED');
   await c.rollback();return {code:'RECOVERY_ALREADY_NORMAL',mode:'NORMAL'};
  }
  // Current locking reads fence rows, empty ranges and metadata until NORMAL commits.
  const tables=await readTables(c,preserved(spec),{lock:true});
  await validateSchema(c,decodeURIComponent(new URL(args.databaseUrl).pathname.slice(1)));
  if(facts.preparedDigest!==digest(canonical({tables})))throw fail('RECOVERY_CHANGED_AFTER_VERIFICATION');
  await c.query("UPDATE recovery_control SET mode='NORMAL',updated_at=UTC_TIMESTAMP(6) WHERE control_id=1");await audit(c,'resumed',args.initiatedBy,'explicit-operator-resume',{checksum:args.expectedChecksum});await c.commit();return {code:'RECOVERY_RESUMED',mode:'NORMAL'};
 }catch(e){try{await c?.rollback();}catch{}throw fail(/^RECOVERY_[A-Z_]+$/.test(e.code??'')?e.code:'RECOVERY_RESUME_FAILED');}finally{await c?.end();}
}
