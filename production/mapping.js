import { decodeLedgerSnapshot } from '../ledger/mysql-snapshot.js';
import { createHash } from 'node:crypto';
import { validateTarget, exact, text, refused } from './plan.js';
import { validateSchema } from './schema.js';
export function validateMappingPlan(input) {
  const plan=JSON.parse(JSON.stringify(input));
  exact(plan,['configVersion','environment','database','storeId','ledgerId','approved','mappings']);
  text(plan.configVersion,64);text(plan.storeId);text(plan.ledgerId,64);
  if(!/^[a-z][a-z0-9_]{0,63}$/.test(plan.database)||!['production','test'].includes(plan.environment)||typeof plan.approved!=='boolean'||!Array.isArray(plan.mappings))throw refused('BOOTSTRAP_INVALID_INPUT');
  const rooms=new Set(),targets=new Set();
  for(const m of plan.mappings) {
    exact(m,['internalRoomId','provider','externalDeviceId','enabled','source','confirmedAt','confirmedBy']);
    text(m.internalRoomId);text(m.externalDeviceId);text(m.confirmedBy);
    if(m.provider!=='ktvsky'||typeof m.enabled!=='boolean'||m.source!=='human-confirmed'||typeof m.confirmedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(m.confirmedAt)||!Number.isFinite(Date.parse(m.confirmedAt)))throw refused('BOOTSTRAP_INVALID_MAPPING');
    if(rooms.has(m.internalRoomId)||targets.has(m.externalDeviceId))throw refused('BOOTSTRAP_MAPPING_CONFLICT');
    rooms.add(m.internalRoomId);targets.add(m.externalDeviceId);
  }
  plan.mappings.sort((a,b)=>a.internalRoomId.localeCompare(b.internalRoomId));return plan;
}
export async function bootstrapMappings({pool,plan:input,databaseUrl,confirmation,initiatedBy,dryRun=true,env=process.env}) {
  const plan=validateMappingPlan(input);validateTarget(plan,databaseUrl,confirmation,env);text(initiatedBy);
  if(typeof dryRun!=='boolean'||(!dryRun&&!plan.approved))throw refused('BOOTSTRAP_NOT_APPROVED');
  let c;let locked=false,begun=false,committing=false,destroy=false;
  try{
    c=await pool.getConnection();
    await validateSchema(c,plan.database);
    if(!dryRun){const [[lock]]=await c.execute('SELECT GET_LOCK(?,10) AS acquired',[plan.database+'.production-bootstrap']);if(Number(lock.acquired)!==1)throw refused('BOOTSTRAP_BUSY');locked=true;}
    if(dryRun)await c.query('START TRANSACTION READ ONLY');else await c.beginTransaction();begun=true;
    const [[start]]=await c.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS timestamp");
    const [events]=await c.query('SELECT DISTINCT store_id,ledger_id,environment FROM production_bootstrap_events');
    if(events.some(e=>e.store_id!==plan.storeId||e.ledger_id!==plan.ledgerId||e.environment!==plan.environment))throw refused('BOOTSTRAP_STORE_MISMATCH');
    const [[head]]=await c.execute('SELECT state_json,state_checksum FROM ledger_heads WHERE ledger_id=?'+(dryRun?'':' FOR UPDATE'),[plan.ledgerId]);
    if(!head)throw refused('BOOTSTRAP_LEDGER_REQUIRED');
    const state=decodeLedgerSnapshot(head.state_json,head.state_checksum);
    const [rows]=await c.execute('SELECT internal_room_id,provider,external_device_id,enabled FROM room_device_mappings WHERE ledger_id=?',[plan.ledgerId]);
    const create=[];
    for(const m of plan.mappings) {
      if(!state.rooms?.some(r=>r.id===m.internalRoomId))throw refused('BOOTSTRAP_UNKNOWN_ROOM');
      const old=rows.find(r=>r.internal_room_id===m.internalRoomId),other=rows.find(r=>r.provider===m.provider&&r.external_device_id===m.externalDeviceId&&r.internal_room_id!==m.internalRoomId);
      if(other||(old&&(old.provider!==m.provider||old.external_device_id!==m.externalDeviceId||Boolean(old.enabled)!==m.enabled)))throw refused('BOOTSTRAP_MAPPING_CONFLICT');
      if(!old)create.push(m);
    }
    const result={environment:plan.environment,database:plan.database,storeId:plan.storeId,ledgerId:plan.ledgerId,
      configVersion:plan.configVersion,dryRun,status:dryRun?'planned':create.length?'applied':'already_satisfied',source:'mapping-bootstrap',startedAt:start.timestamp,mappingsCreated:create.length,
      mappings:plan.mappings.map(m=>({internalRoomId:m.internalRoomId,provider:m.provider,deviceSuffix:m.externalDeviceId.slice(-4),enabled:m.enabled,source:m.source,confirmedAt:m.confirmedAt,confirmedBy:m.confirmedBy}))};
    if(!dryRun) {
      for(const m of create)await c.execute('INSERT INTO room_device_mappings(ledger_id,internal_room_id,provider,external_device_id,enabled) VALUES(?,?,?,?,?)',[plan.ledgerId,m.internalRoomId,m.provider,m.externalDeviceId,m.enabled?1:0]);
      const [[end]]=await c.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS timestamp");
      result.completedAt=end.timestamp;
      await c.execute('INSERT INTO production_bootstrap_events(store_id,ledger_id,environment,initiated_by,config_version,plan_digest,facts) VALUES(?,?,?,?,?,?,?)',[plan.storeId,plan.ledgerId,plan.environment,initiatedBy,plan.configVersion,createHash('sha256').update(JSON.stringify(plan)).digest('hex'),JSON.stringify({...result,mappings:plan.mappings})]);
    }
    if(dryRun)await c.rollback();else{committing=true;await c.commit();}begun=false;return result;
  }catch(error){
    if(committing){destroy=true;throw refused('BOOTSTRAP_COMMIT_UNKNOWN');}
    if(begun)try{await c.rollback();}catch{destroy=true;}
    throw refused(/^BOOTSTRAP_[A-Z_]+$/.test(error?.code??'')?error.code:'BOOTSTRAP_FAILED');
  }finally{
    if(locked&&!destroy)try{await c.execute('SELECT RELEASE_LOCK(?)',[plan.database+'.production-bootstrap']);}catch{destroy=true;}
    if(c){if(destroy)c.destroy();else c.release();}
  }
}
