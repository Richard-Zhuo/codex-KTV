// Simulator provisioning only. Never marks a generated device as human-confirmed.
import {createHash} from 'node:crypto';
import {validateMappingPlan} from '../production/mapping.js';
import {validateSchema} from '../production/schema.js';
import {decodeLedgerSnapshot} from '../ledger/mysql-snapshot.js';
import {isProductionEnvironment} from '../shared/deployment-environment.js';
import {assertOwnedDatabase} from './scope.js';
export async function bootstrapRehearsalMappings(f,{pool,plan,dryRun=true}){
 if(process.env.STAGE5E_RUN!=='synthetic-only'||isProductionEnvironment(process.env)||plan.environment!=='test'||plan.database!==f.names.database||plan.storeId!==f.names.storeId||plan.ledgerId!==f.names.ledgerId)throw Error('REHEARSAL_MAPPING_SCOPE_REQUIRED');
 assertOwnedDatabase(plan.database,f.names,f.registered);await f.serverGuard();
 // Reuse formal input shape validation, but never persist its production provenance value.
 validateMappingPlan({...plan,mappings:plan.mappings.map(m=>({...m,source:'human-confirmed'}))});
 if(!plan.approved||typeof dryRun!=='boolean'||plan.mappings.some(m=>m.source!=='rehearsal-confirmed'||m.internalRoomId==='V06'||!m.externalDeviceId.startsWith('REHEARSAL-FAKE-'+f.names.id+'-')))throw Error('REHEARSAL_MAPPING_INVALID');
 const c=await pool.getConnection();let begun=false;
 try{
  const [[identity]]=await c.query('SELECT DATABASE() AS name,@@server_uuid AS uuid');if(identity.name!==plan.database||identity.uuid!==f.identity.server_uuid)throw Error('REHEARSAL_MAPPING_SERVER_REQUIRED');
  await validateSchema(c,plan.database);await c.beginTransaction();begun=true;
  const [[head]]=await c.execute('SELECT state_json,state_checksum FROM ledger_heads WHERE ledger_id=? FOR UPDATE',[plan.ledgerId]);const state=decodeLedgerSnapshot(head.state_json,head.state_checksum);
  const [receipts]=await c.query('SELECT environment,store_id,ledger_id FROM production_bootstrap_events');if(receipts.some(r=>r.environment!=='test'||r.store_id!==plan.storeId||r.ledger_id!==plan.ledgerId))throw Error('REHEARSAL_MAPPING_STORE_REQUIRED');
  const [rows]=await c.execute('SELECT internal_room_id,provider,external_device_id,enabled FROM room_device_mappings WHERE ledger_id=?',[plan.ledgerId]);const additions=[];
  for(const m of plan.mappings){
   if(!state.rooms.some(r=>r.id===m.internalRoomId))throw Error('REHEARSAL_MAPPING_UNKNOWN_ROOM');
   const old=rows.find(r=>r.internal_room_id===m.internalRoomId),collision=rows.some(r=>r.internal_room_id!==m.internalRoomId&&r.provider===m.provider&&r.external_device_id===m.externalDeviceId);
   if(collision||old&&(old.provider!==m.provider||old.external_device_id!==m.externalDeviceId||Boolean(old.enabled)!==m.enabled))throw Error('REHEARSAL_MAPPING_CONFLICT');
   if(!old)additions.push(m);
  }
  const result={status:dryRun?'planned':additions.length?'applied':'already_satisfied',source:'rehearsal-confirmed',gateway:'FakeGateway',realMapping:false,mappingsCreated:additions.length,mappings:plan.mappings};
  if(dryRun)await c.rollback();else{
   for(const m of additions)await c.execute('INSERT INTO room_device_mappings(ledger_id,internal_room_id,provider,external_device_id,enabled) VALUES(?,?,?,?,?)',[plan.ledgerId,m.internalRoomId,m.provider,m.externalDeviceId,m.enabled?1:0]);
   await c.execute('INSERT INTO production_bootstrap_events(store_id,ledger_id,environment,initiated_by,config_version,plan_digest,facts) VALUES(?,?,?,?,?,?,?)',[plan.storeId,plan.ledgerId,'test','REHEARSAL-SIMULATOR-'+f.names.id,plan.configVersion,createHash('sha256').update(JSON.stringify(plan)).digest('hex'),JSON.stringify(result)]);await c.commit();
  }begun=false;return result;
 }finally{if(begun)await c.rollback();c.release();}
}
