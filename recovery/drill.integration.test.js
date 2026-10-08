import test from 'node:test';import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';import { join } from 'node:path';import { writeFile } from 'node:fs/promises';
import { withBackupFixture } from '../test-support/backup-fixture.js';
import { backupDatabase,restoreDatabase,connect,readTables,rowsOf } from '../backup/mysql-backup.js';
import { canonical,digest,verifyArtifact } from '../backup/format.js';
import { freezeDatabase,verifyRecovery,resumeRecovery,inspectRecovery } from './operator.js';
import { bindRecoveryWriteGuard,recoveryApiGate,withRecoveryDispatch } from './gate.js';
import { checkRecoveryInvariants } from './invariants.js';
import { createMySqlLedgerStore } from '../ledger/mysql-store.js';import { createTrustedLedgerApplication } from '../ledger/application.js';
import { createMySqlEmployeeStore } from '../employees/mysql-store.js';import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createAuthService } from '../auth/service.js';import { createMemoryLoginRateLimiter } from '../auth/rate-limit.js';
import { digestSessionToken } from '../auth/session-token.js';import { decodeLedgerSnapshot,encodeLedgerSnapshot } from '../ledger/mysql-snapshot.js';
import { createRoomControlRuntime } from '../devices/runtime.js';import { FakeKtvRoomControlGateway } from '../devices/fake-gateway.js';
import { total,outstanding,nextCollectCharge } from '../sales.js';import { createHttpApiFromEnv } from '../http/bootstrap.js';import { createKtvServer } from '../server.js';
const cash='\u73b0\u91d1';const mutations=g=>g.calls.filter(c=>['openRoom','closeRoom'].includes(c.method)).length;
test('Stage 5B isolated real MySQL full recovery drill',{skip:!process.env.LEDGER_MYSQL_TEST_URL},async t=>withBackupFixture(async f=>{
 const marks={},mark=name=>marks[name]=new Date().toISOString();
 const [[clock]]=await f.pool.query('SELECT HOUR(UTC_TIMESTAMP()) AS hour');let offset=20-Number(clock.hour);if(offset>14)offset-=24;if(offset< -12)offset+=24;
 const businessTimeZone='Etc/GMT'+(offset===0?'':offset>0?'-'+offset:'+'+(-offset));
 const compose=(pool,database,mode='disabled')=>{
  const authStore=createMySqlAuthStore({pool,database,bindRecoveryGuard:bindRecoveryWriteGuard});
  const employeeStore=createMySqlEmployeeStore({pool,database,bindRecoveryGuard:bindRecoveryWriteGuard});
  const store=createMySqlLedgerStore({pool,database,ledgerId:f.ledgerId,deviceControlMode:mode,bindRecoveryGuard:bindRecoveryWriteGuard,bindSessionRevalidation:authStore.bindSessionRevalidation,bindEmployeeResolver:employeeStore.bindEmployeeResolver});
  return {authStore,store,app:createTrustedLedgerApplication({store,businessTimeZone}),auth:createAuthService({store:authStore,rateLimiter:createMemoryLoginRateLimiter()})};
 };
 const sourcePool=mysql.createPool({uri:f.raw,connectionLimit:8});let targetPool,server,api;
 try{
 const source=compose(sourcePool,'jbhh_ktv_test');let key=0;
 const execute=async(action,payload,{app=source.app,store=source.store,credential=f.credential,operationKey='drill-'+(++key),expectedRevision}={})=>{
  const command={operationKey,expectedRevision:expectedRevision??(await store.read()).revision,action,payload};const result=await app.execute(command,credential);assert.equal(result.status,'committed',canonical(result));return {command,result};
 };
 const order=async room=>(await source.store.read()).state.orders.findLast(o=>o.room===room);
 const open=async(room,opts={})=>{await execute('clean',{room});await execute('open',{room,beer:'bw',creditedEmployeeId:f.people[0].employeeId},opts);return order(room);};
 const first=await open('V01');const historical=await execute('sale',{order:first.id,creditedEmployeeId:f.people[0].employeeId,items:[{product:'bw',spec:'half',count:1}]},{operationKey:'historical-sale-K'});
 const charge=nextCollectCharge(await order('V01'),(await source.store.read()).state.catalog);
 await execute('collect',{order:first.id,charge:charge.id,payments:[{method:cash,amount:1000},{method:cash,amount:charge.remaining-1000}]});
 await execute('settle',{order:first.id,payments:[{method:cash,amount:outstanding(await order('V01'))-100}],differenceType:'\u514d\u96f6'});
 await open('V02');
 const credited=await open('V03');await execute('credit',{order:credited.id,name:'Synthetic Customer',phone:'13800000000',note:'Synthetic credit',signature:'data:image/png;base64,'+'s'.repeat(100)});
 await execute('approve',{order:credited.id});await execute('repay',{order:credited.id,amount:1000,method:cash});
 await execute('approveRepayment',{order:credited.id,request:(await order('V03')).credit.repaymentRequests.at(-1).id});
 const snapshot=(await source.store.read()).state,unit=snapshot.catalog.products.find(p=>p.id==='bw').saleOptions.find(o=>o.id==='half').priceCents;
 await execute('retailSale',{creditedEmployeeId:f.people[0].employeeId,items:[{product:'bw',spec:'half',count:1}],payments:[{method:cash,amount:unit}]});
 await execute('handover',{actualCash:10000});
 const required=compose(sourcePool,'jbhh_ktv_test','required'),work=[];
 for(const [room,kind]of [['V05','waiting'],['V06','ack'],['333','unknown'],['888','between']]){
  await f.pool.execute('INSERT INTO room_device_mappings(ledger_id,internal_room_id,provider,external_device_id,enabled) VALUES(?,?,?,?,1)',[f.ledgerId,room,'fake','synthetic-'+kind]);
  const o=await open(room,{app:required.app});
  const gateway=new FakeKtvRoomControlGateway({online:kind!=='waiting',open:kind==='between',outcomes:kind==='between'?{closeRoom:(i,g,normal)=>{normal();return g.evidence(i,{kind:'ACKNOWLEDGED',acknowledged:true,settled:false});}}:kind==='ack'?{openRoom:(i,g,normal)=>{normal();return g.evidence(i,{kind:'ACKNOWLEDGED',acknowledged:true,settled:false,sentAt:new Date().toISOString()});}}:kind==='unknown'?{openRoom:(i,g)=>g.evidence(i,{kind:'UNKNOWN'})}:{}});
  const runtime=createRoomControlRuntime({pool:sourcePool,database:'jbhh_ktv_test',ledgerId:f.ledgerId,authStore:source.authStore,gateway,testOnly:true,recoveryGuard:true});
  const [rows]=await f.pool.execute('SELECT * FROM room_control_workflows WHERE order_id=?',[o.id]);let r=decodeLedgerSnapshot(rows[0].state_json,rows[0].state_checksum);
  r=await runtime.application.advance(r.id);if(kind!=='waiting')r=await runtime.application.advance(r.id);if(kind==='between'){r=await runtime.application.advance(r.id);assert.equal(r.step,'OPEN');assert.equal(r.closeAcknowledged,true);assert.equal(r.openAcknowledged,false);}
  assert.equal(r.status,{waiting:'DEVICE_OFFLINE_WAIT',ack:'DEVICE_VERIFYING',unknown:'DEVICE_UNKNOWN',between:'DEVICE_OPENING'}[kind]);
  work.push({kind,id:r.id,orderId:o.id,gateway,runtime,before:mutations(gateway)});
 }
 const head=await source.store.read();assert.equal(head.state.inventory.qd.count,null);assert.ok(head.state.orders.length>=7);assert.ok(head.state.handovers.length);
 const beforeBusiness=canonical(head.state);mark('backupStart');const backup=await backupDatabase({...f.backupArgs,outputDirectory:join(f.dir,'drill')});mark('backupComplete');
 const verified=await verifyArtifact(backup.directory,{expectedChecksum:backup.checksum,storeId:f.storeId,ledgerId:f.ledgerId});
 await t.test('read-only checker accepts original facts and blocks broken relational/business facts',()=>{
  const good=checkRecoveryInvariants(verified.data,verified.manifest);assert.equal(good.ready,true,canonical(good));
  for(const mutate of [
   s=>{s.orders.push(structuredClone(s.orders.find(o=>o.room==='V02')));},
   s=>{s.inventory.qd.count=-1;},
   s=>{s.rooms.find(r=>r.id==='V02').order='missing-order';},
   s=>{const o=s.orders.find(o=>o.payments.length>1);o.payments[1].paymentId=o.payments[0].paymentId;}
  ]){const data=structuredClone(verified.data),h=rowsOf(data,'ledger_heads')[0],s=decodeLedgerSnapshot(h.state_json,h.state_checksum);mutate(s);const enc=encodeLedgerSnapshot(s),table=data.tables.ledger_heads;table.rows[0][table.columns.indexOf('state_json')]=enc.json;table.rows[0][table.columns.indexOf('state_checksum')]=enc.checksum;const m=structuredClone(verified.manifest);m.ledgerHeads[0].checksum=enc.checksum;assert.equal(checkRecoveryInvariants(data,m).ready,false);}
  const orphan=structuredClone(verified.data),table=orphan.tables.room_control_workflows;table.rows[0][table.columns.indexOf('order_id')]='missing';assert.equal(checkRecoveryInvariants(orphan,verified.manifest).ready,false);
 });
 const between=work.find(w=>w.kind==='between');await between.runtime.application.advance(between.id);assert.equal(mutations(between.gateway),2,'After snapshot, original worker completes OPEN once');
 await execute('clean',{room:'666'},{operationKey:'T2-not-in-backup'});assert.equal((await source.store.read()).revision,head.revision+1);
 mark('freezeStart');await freezeDatabase({...f.backupArgs,initiatedBy:'synthetic-drill'});mark('failureSimulatedAt');
 await t.test('source freeze blocks trusted writes and provider dispatch',async()=>{
  await assert.rejects(source.app.execute({operationKey:'frozen',expectedRevision:head.revision+1,action:'clean',payload:{room:'999'}},f.credential),{code:'RECOVERY_WRITE_FROZEN'});
  await assert.rejects(work[0].runtime.application.advance(work[0].id),{code:'RECOVERY_WORKER_PAUSED'});
 });
 const frozenSource=digest(canonical({tables:await readTables(f.setup,verified.spec.tables)}));
 await sourcePool.end();await assert.rejects(source.store.read()); // old application connection is now unavailable; inspection connection remains isolated.
 const target=f.targetArgs(backup,'drill'),database=new URL(target.databaseUrl).pathname.slice(1);
 mark('restoreStart');await restoreDatabase(target);mark('restoreComplete');
 targetPool=mysql.createPool({uri:target.databaseUrl,connectionLimit:8});const restored=compose(targetPool,database);
 const c=await connect(target.databaseUrl);try{assert.equal(canonical((await restored.store.read()).state),beforeBusiness);assert.equal((await restored.store.read()).revision,head.revision);assert.equal(Number((await c.query("SELECT COUNT(*) AS n FROM ledger_operations WHERE operation_key='T2-not-in-backup'"))[0][0].n),0);}finally{await c.end();}
 api=createHttpApiFromEnv({KTV_API_MODE:'enabled',KTV_HTTP_ENV:'development',KTV_INSECURE_COOKIE:'true',KTV_MYSQL_URL:target.databaseUrl,KTV_LEDGER_ID:f.ledgerId,KTV_STORE_ID:f.storeId,KTV_BUSINESS_TIME_ZONE:businessTimeZone,KTV_PUBLIC_ORIGIN:'http://127.0.0.1:4173'}, {error(){}});
 server=createKtvServer({api:{handle:api.handle}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 await t.test('restored formal application boots in recovery mode: API 503, static page available, worker paused',async()=>{
  assert.equal((await fetch(origin+'/')).status,200);
  for(const [path,method]of [['/api/v1/auth/session','GET'],['/api/v1/commands/clean','POST'],['/api/v1/auth/login','POST']]){const res=await fetch(origin+path,{method});assert.equal(res.status,503);assert.equal((await res.json()).error.code,'recovery_in_progress');}
  await assert.rejects(restored.app.execute(historical.command,f.credential),{code:'RECOVERY_WRITE_FROZEN'});
  await assert.rejects(withRecoveryDispatch(targetPool,database,()=>assert.fail('must not dispatch')),{code:'RECOVERY_WORKER_PAUSED'});
  await assert.rejects(resumeRecovery({...target,confirmation:target.confirmation+'/RESUME'}),{code:'RECOVERY_NOT_VERIFIED'});
  const pausedGateway=new FakeKtvRoomControlGateway();const pausedRuntime=createRoomControlRuntime({pool:targetPool,database,ledgerId:f.ledgerId,authStore:restored.authStore,gateway:pausedGateway,testOnly:true,recoveryGuard:true});
  await pausedRuntime.start();await pausedRuntime.worker.tick();await pausedRuntime.stop();assert.equal(pausedGateway.calls.length,0,'No provider calls before verification/operator resume');
  const w=work[0];await targetPool.execute('UPDATE room_control_workflows SET order_id=? WHERE workflow_id=?',['missing-order',w.id]);
  await assert.rejects(verifyRecovery(target),{code:'RECOVERY_RESTORED_DATA_MISMATCH'});
  assert.equal((await targetPool.query('SELECT mode FROM recovery_control'))[0][0].mode,'VERIFYING');
  await targetPool.execute('UPDATE room_control_workflows SET order_id=? WHERE workflow_id=?',[w.orderId,w.id]);
 });
 const inspected=await inspectRecovery(target);assert.equal(inspected.ready,true);assert.equal(inspected.mode,'VERIFYING');
 mark('verificationStart');const report=await verifyRecovery(target);mark('verificationComplete');assert.equal(report.report.ready,true);assert.ok(report.sessionsInvalidated>=1);assert.equal(report.workflowsFenced,4);marks.resumeReady=marks.verificationComplete;
 const [fencedRows]=await targetPool.query('SELECT state_json,state_checksum FROM room_control_workflows');
 for(const row of fencedRows){const r=decodeLedgerSnapshot(row.state_json,row.state_checksum);assert.equal(r.inFlight,null);if(r.id===between.id)assert.equal(r.uncertain,true,'Previous CLOSE ACK is not an ACK for OPEN');}
 await t.test('old sessions invalidated, no writes before explicit resume, changed verified data blocks resume',async()=>{
  const readAuth=createAuthService({store:createMySqlAuthStore({pool:targetPool,database}),rateLimiter:createMemoryLoginRateLimiter()});assert.equal(await readAuth.authenticateSession(f.login.token),null);
  await assert.rejects(restored.auth.login({loginIdentifier:f.people[0].loginIdentifier,password:f.secret}),{code:'RECOVERY_WRITE_FROZEN'});
  await targetPool.execute('UPDATE employees SET display_name=? WHERE employee_id=?',['Changed after verify',f.people[0].employeeId]);
  await assert.rejects(resumeRecovery({...target,confirmation:target.confirmation+'/RESUME'}),{code:'RECOVERY_CHANGED_AFTER_VERIFICATION'});
  await targetPool.execute('UPDATE employees SET display_name=? WHERE employee_id=?',[f.people[0].displayName,f.people[0].employeeId]);
 });
 await resumeRecovery({...target,confirmation:target.confirmation+'/RESUME'});mark('resumedAt');
 const signed=await restored.auth.login({loginIdentifier:f.people[0].loginIdentifier,password:f.secret});assert.equal(signed.ok,true);const credential={tokenDigest:digestSessionToken(signed.token)};
 await t.test('fresh session works, first new command is R+1, historical sale replays without side effects',async()=>{
  await execute('clean',{room:'999'},{...restored,credential,operationKey:'post-restore-R-plus-1'});assert.equal((await restored.store.read()).revision,head.revision+1);
  const before=canonical(await restored.store.read()),c=await connect(target.databaseUrl);try{const ops=digest(canonical({tables:await readTables(c,['ledger_operations','ledger_success_audit'])}));assert.deepEqual(await restored.app.execute(historical.command,credential),historical.result);assert.equal(canonical(await restored.store.read()),before);assert.equal(digest(canonical({tables:await readTables(c,['ledger_operations','ledger_success_audit'])})),ops);}finally{await c.end();}
 });
 await t.test('restored worker ticks query ACK/UNKNOWN only and resume the same offline order after proof',async()=>{
  for(const w of work)w.gateway.calls=[];
  const gateway={testOnly:true,ensureSession:async()=>({ready:true})};
  for(const method of ['getRoomStatus','queryRoomState','closeRoom','openRoom'])gateway[method]=input=>{
   const w=work.find(w=>input.externalDeviceId==='synthetic-'+w.kind);assert.ok(w);return w.gateway[method](input);
  };
  const runtime=createRoomControlRuntime({pool:targetPool,database,ledgerId:f.ledgerId,authStore:restored.authStore,gateway,testOnly:true,recoveryGuard:true,intervalMs:60000});
  const records=async()=>{const [rows]=await targetPool.query('SELECT state_json,state_checksum FROM room_control_workflows');return rows.map(w=>decodeLedgerSnapshot(w.state_json,w.state_checksum));};
  await runtime.start();try{
   await runtime.worker.tick();for(const w of work){assert.equal(mutations(w.gateway),0);assert.ok(w.gateway.calls.some(c=>c.method==='queryRoomState'));}
   await runtime.worker.tick();let rows=await records();for(const kind of ['ack','between'])assert.equal(rows.find(r=>r.id===work.find(w=>w.kind===kind).id).status,'ACTIVE');
   assert.equal(rows.find(r=>r.id===work.find(w=>w.kind==='unknown').id).status,'DEVICE_UNKNOWN');assert.equal(mutations(work.find(w=>w.kind==='unknown').gateway),0);
   const waiting=work.find(w=>w.kind==='waiting');assert.equal(rows.find(r=>r.id===waiting.id).status,'DEVICE_OFFLINE_WAIT');waiting.gateway.room.online=true;
   waiting.gateway.outcomes.queryRoomState=(i,g)=>g.evidence(i,{stepResult:'NOT_APPLIED',settled:true,retrySafe:true});
   await runtime.worker.tick();assert.equal(mutations(waiting.gateway),0);delete waiting.gateway.outcomes.queryRoomState;
   for(let n=0;n<5;n++){await runtime.worker.tick();rows=await records();if(rows.find(r=>r.id===waiting.id).status==='ACTIVE')break;}
   const done=rows.find(r=>r.id===waiting.id);assert.equal(done.status,'ACTIVE');assert.equal(done.orderId,waiting.orderId);assert.equal(mutations(waiting.gateway),1);
   for(const kind of ['ack','unknown','between'])assert.equal(mutations(work.find(w=>w.kind===kind).gateway),0);
  }finally{await runtime.stop();}
  assert.equal((await restored.store.read()).state.orders.length,head.state.orders.length);assert.equal((await restored.store.read()).revision,head.revision+1);
 });
 assert.equal(digest(canonical({tables:await readTables(f.setup,verified.spec.tables)})),frozenSource,'Restore/cutover must not modify frozen source');
 const evidence={result:'PASS',mysqlVersion:f.identity.version,source:'jbhh_ktv_test',target:database,backupRevision:head.revision,resumedRevision:(await restored.store.read()).revision,backupChecksum:backup.checksum,counts:report.report.counts,oldSessionsInvalidated:report.sessionsInvalidated,workflowsFenced:report.workflowsFenced,marks,backupCreatedAt:backup.createdAt,observedRpoMs:Date.parse(marks.failureSimulatedAt)-Date.parse(backup.createdAt),observedRtoMs:Date.parse(marks.resumeReady)-Date.parse(marks.freezeStart),deviceMutations:{ack:mutations(work.find(w=>w.kind==='ack').gateway),unknown:mutations(work.find(w=>w.kind==='unknown').gateway),waitingAfterSafeProof:mutations(work.find(w=>w.kind==='waiting').gateway),previousCloseAck:mutations(work.find(w=>w.kind==='between').gateway)},noLiveProvider:true};
 if(process.env.STAGE5B_DRILL_EVIDENCE)await writeFile(process.env.STAGE5B_DRILL_EVIDENCE,JSON.stringify(evidence,null,2));
 }finally{if(server)await new Promise(r=>server.close(r));await api?.close();await targetPool?.end();try{await sourcePool.end();}catch{}}
}));
