import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {once} from 'node:events';
import {withProductionRuntimeFixture} from '../test-support/production-runtime-fixture.js';
import {withBackupFixture} from '../test-support/backup-fixture.js';
import {createOperationalRuntime} from './runtime.js';import {FakeAlertTransport} from './alerts.js';import {syntheticTls} from '../test-support/runtime-tls.js';
import {reportBackup} from './backup-report.js';import {backupDatabase} from '../backup/mysql-backup.js';
import {createMySqlLedgerStore} from '../ledger/mysql-store.js';import {createMySqlEmployeeStore} from '../employees/mysql-store.js';import {createTrustedLedgerApplication} from '../ledger/application.js';
import {createRoomControlRuntime} from '../devices/runtime.js';import {FakeKtvRoomControlGateway} from '../devices/fake-gateway.js';
import {encodeLedgerSnapshot,decodeLedgerSnapshot} from '../ledger/mysql-snapshot.js';
const entry=fileURLToPath(new URL('../test-support/operations-runtime-child.js',import.meta.url));
const waitFor=async work=>{for(let n=0;n<120;n++){try{const r=await work();if(r)return r;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('INCIDENT_DRILL_TIMEOUT');};
test('Stage5D A/C: real MySQL disconnect, dedup, forced native-host restart, original incident resolution',{skip:!process.env.LEDGER_MYSQL_TEST_URL,timeout:120000},()=>withProductionRuntimeFixture(async f=>{
 f.start(entry);await f.wait();
 const login=await f.request('/api/v1/auth/login',{method:'POST',headers:{Origin:f.config.publicOrigin,'Content-Type':'application/json'},body:{loginIdentifier:f.people[0].loginIdentifier,password:f.secret}});
 assert.equal(login.status,200);const cookie=login.headers['set-cookie'][0].split(';')[0],csrf=login.json().csrfToken,headers={Cookie:cookie};
 const before=(await f.request('/api/v1/store/snapshot',{headers})).json(),beforeHead=(await f.connection.query('SELECT revision,state_checksum FROM ledger_heads'))[0];const state=async()=>JSON.parse(JSON.parse(await readFile(join(f.logs,'operational-state.json'),'utf8')).data);
 const user=f.runtimeSecrets.database.user;
 let locked=false;
 try{
  await f.setup.query('ALTER USER ?@? ACCOUNT LOCK',[user,'127.0.0.1']);locked=true;
  const [connections]=await f.setup.execute('SELECT ID FROM information_schema.PROCESSLIST WHERE USER=? AND DB=?',[user,f.database]);
  for(const row of connections){assert.ok(Number.isSafeInteger(Number(row.ID)));await f.setup.query('KILL CONNECTION '+Number(row.ID));}
  assert.equal((await f.request('/health/ready')).status,503);
  assert.equal((await f.request('/api/v1/commands/clean',{method:'POST',headers:{...headers,Origin:f.config.publicOrigin,'Content-Type':'application/json','X-CSRF-Token':csrf},body:{operationKey:'stage5d-db-unavailable',expectedRevision:before.revision,payload:{room:'V01'}}})).status,503);
  const opened=await waitFor(async()=>{const s=await state();return s.incidents.find(i=>i.type==='DATABASE_UNAVAILABLE'&&i.state==='OPEN');});
  for(let n=0;n<5;n++)assert.equal((await f.request('/health/ready')).status,503);
  assert.equal((await state()).incidents.filter(i=>i.type==='DATABASE_UNAVAILABLE').length,1);
  await waitFor(async()=>{const text=await readFile(join(f.logs,'synthetic-alerts.jsonl'),'utf8');return text.includes(opened.incidentId);});
  const dead=once(f.child,'exit');f.child.kill('SIGKILL');await dead;
  f.start(entry);await f.wait(false);
  assert.equal((await f.request('/health/ready')).status,503);
  await waitFor(async()=> (await state()).incidents.find(i=>i.incidentId===opened.incidentId&&i.state==='OPEN'));
  assert.equal((await state()).incidents.filter(i=>i.type==='DATABASE_UNAVAILABLE').length,1);
  await f.setup.query('ALTER USER ?@? ACCOUNT UNLOCK',[user,'127.0.0.1']);locked=false;await f.wait();
  await waitFor(async()=> (await state()).incidents.find(i=>i.incidentId===opened.incidentId&&i.state==='RESOLVED'));
  const after=(await f.request('/api/v1/store/snapshot',{headers})).json();assert.equal(after.revision,before.revision);
  assert.deepEqual((await f.connection.query('SELECT revision,state_checksum FROM ledger_heads'))[0],beforeHead);
  assert.ok((await state()).incidents.some(i=>i.type==='PROCESS_FAILURE'));
  const alerts=(await readFile(join(f.logs,'synthetic-alerts.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  await waitFor(async()=>{const a=(await readFile(join(f.logs,'synthetic-alerts.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);return a.some(e=>e.incidentId===opened.incidentId&&e.transition==='RESOLVED');});
  assert.equal(alerts.filter(a=>a.incidentId===opened.incidentId&&a.transition==='OPEN').length,1);
  const admin=(await f.request('/api/v1/admin/snapshot',{headers})).json();assert.ok(admin.view.operations.incidents.some(i=>i.incidentId===opened.incidentId&&i.state==='RESOLVED'));assert.equal(before.view.operations,undefined);
  await f.connection.execute('DELETE FROM auth_grants WHERE principal_id=? AND permission_id=?',[f.people[0].principalId,'backend.view']);assert.equal((await f.request('/api/v1/admin/snapshot',{headers})).status,403);assert.equal((await f.request('/api/v1/store/snapshot',{headers})).json().view.operations,undefined);
 }finally{if(locked)await f.setup.query('ALTER USER ?@? ACCOUNT UNLOCK',[user,'127.0.0.1']);}
}));
test('Stage5D B/D/E: trusted UNKNOWN query recovery, backup destination failure and isolated certificate thresholds',{skip:!process.env.LEDGER_MYSQL_TEST_URL,timeout:120000},()=>withBackupFixture(async f=>{
 const tls=await syntheticTls(),transport=new FakeAlertTransport(),loaded={logDirectory:f.dir,tls:{cert:tls.certificate},redactionSecrets:[f.secret],config:{storeId:f.storeId,ledgerId:f.ledgerId,publicOrigin:'https://ktv-smoke.127.0.0.1.sslip.io:8443',backupPolicyConfigured:true,monitoring:{intervalMs:1000,minFreeBytes:1}}};
 let ops=await createOperationalRuntime({loaded,logger:{log(){}},transport});let databaseDown=false;
 const services={readiness:async()=>{if(databaseDown)throw Error('synthetic application connection outage');return {ready:true,blockers:[]};}};
 await ops.start(services);
 try{
  const initial=await f.store.read(),state=initial.state;state.rooms[0].status='空闲';const encoded=encodeLedgerSnapshot(state);
  await f.pool.execute('UPDATE ledger_heads SET state_json=?,state_checksum=? WHERE ledger_id=?',[encoded.json,encoded.checksum,f.ledgerId]);
  await f.pool.execute('INSERT INTO room_device_mappings(ledger_id,internal_room_id,provider,external_device_id,enabled)VALUES(?,?,?,?,1)',[f.ledgerId,'V01','fake','synthetic-stage5d-device']);
  const [[clock]]=await f.pool.query('SELECT HOUR(UTC_TIMESTAMP()) AS hour');let offset=15-Number(clock.hour);if(offset>14)offset-=24;if(offset< -12)offset+=24;
  const zone='Etc/GMT'+(offset===0?'':offset>0?'-'+offset:'+'+(-offset));
  const store=createMySqlLedgerStore({pool:f.pool,database:'jbhh_ktv_test',ledgerId:f.ledgerId,deviceControlMode:'required',bindSessionRevalidation:f.authStore.bindSessionRevalidation,bindEmployeeResolver:createMySqlEmployeeStore({pool:f.pool,database:'jbhh_ktv_test'}).bindEmployeeResolver});
  const app=createTrustedLedgerApplication({store,businessTimeZone:zone}),command={action:'open',operationKey:'stage5d-unknown',expectedRevision:0,payload:{room:'V01',beer:'bw',creditedEmployeeId:f.people[0].employeeId}};
  assert.equal((await app.execute(command,f.credential)).status,'committed');
  const once=await store.read(),gateway=new FakeKtvRoomControlGateway({outcomes:{openRoom:(input,g,normal)=>{normal();throw Error('synthetic lost response');}}}),device=createRoomControlRuntime({pool:f.pool,database:'jbhh_ktv_test',ledgerId:f.ledgerId,authStore:f.authStore,gateway,testOnly:true});
  await device.worker.tick();await device.worker.tick();
  const records=async()=>{const [rows]=await f.pool.execute('SELECT state_json,state_checksum FROM room_control_workflows WHERE ledger_id=?',[f.ledgerId]);return rows.map(r=>decodeLedgerSnapshot(r.state_json,r.state_checksum));};
  let record=(await records())[0];assert.equal(record.status,'DEVICE_UNKNOWN');
  const {observeWorkflow}=await import('./monitors.js');await observeWorkflow(ops.lifecycle,record,ops.config);await ops.dispatcher.tick();
  const incident=ops.store.read().incidents.find(i=>i.type==='DEVICE_UNKNOWN');assert.ok(transport.messages.some(m=>m.incidentId===incident.incidentId));
  const mutationCount=gateway.calls.filter(c=>['openRoom','closeRoom'].includes(c.method)).length;
  await device.worker.tick();await device.worker.tick();record=(await records())[0];assert.equal(record.status,'ACTIVE');
  await observeWorkflow(ops.lifecycle,record,ops.config);await ops.dispatcher.tick();assert.equal(gateway.calls.filter(c=>['openRoom','closeRoom'].includes(c.method)).length,mutationCount);assert.ok(gateway.calls.some(c=>c.method==='queryRoomState'));
  assert.deepEqual(await store.read(),once);await device.stop();
  const good=await backupDatabase({...f.backupArgs,outputDirectory:join(f.dir,'verified-backup')});await reportBackup(f.dir,{success:true,createdAt:good.createdAt});await ops.tick();const lastSuccess=ops.snapshot().backup.lastSuccessAt;
  await assert.rejects(backupDatabase({...f.backupArgs,outputDirectory:join(f.dir,'missing-parent','destination')}));
  await reportBackup(f.dir,{success:false});await ops.tick();assert.equal(ops.snapshot().backup.lastSuccessAt,lastSuccess);assert.equal(ops.snapshot().backup.lastResult,'FAILURE');assert.ok(ops.snapshot().incidents.some(i=>i.code==='BACKUP_FAILURE'&&i.state==='OPEN'));
  assert.ok(ops.snapshot().incidents.some(i=>i.code==='TLS_EXPIRING'&&i.severity==='CRITICAL'));
  databaseDown=true;await ops.tick();const original=ops.store.read().incidents.find(i=>i.type==='DATABASE_UNAVAILABLE');await ops.stop();
  ops=await createOperationalRuntime({loaded,logger:{log(){}},transport});await ops.start(services);assert.equal(ops.store.read().incidents.filter(i=>i.type==='DATABASE_UNAVAILABLE').length,1);assert.equal(ops.store.read().incidents.find(i=>i.type==='DATABASE_UNAVAILABLE').incidentId,original.incidentId);
  databaseDown=false;await ops.tick();assert.equal(ops.store.read().incidents.find(i=>i.incidentId===original.incidentId).state,'RESOLVED');assert.deepEqual(await store.read(),once);
 }finally{await ops.stop();}
}));
