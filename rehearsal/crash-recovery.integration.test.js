import {expireCrashedQueryLeases} from './crash-recovery.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepare} from './prepare.js';
import {launcher,sleep} from './launcher.js';
import {eventually} from './scenarios.js';
import {decodeLedgerSnapshot} from '../ledger/mysql-snapshot.js';

test('Stage5E post-crash query recovery: live lease fences new process and expiry reconciles once',
 {skip:process.env.STAGE5E_RUN!=='synthetic-only',timeout:120000},async t=>{
 const started=performance.now();let f,app;
 const note=(checkpoint,facts={})=>t.diagnostic(JSON.stringify({checkpoint,elapsedMs:Math.round(performance.now()-started),...facts}));
 try{
  f=await prepare(fileURLToPath(new URL('../',import.meta.url)));
  const [[engine]]=await f.setup.query('SELECT VERSION() AS version, ENGINE AS engine FROM information_schema.tables WHERE table_schema=? AND table_name=?',[f.active.database,'room_control_workflows']);
  assert.equal(engine.version,'8.4.11');assert.equal(engine.engine,'InnoDB');
  app=await launcher(f);
  await app.controls({clock:'2026-10-10T12:00:00.000Z',openUnknown:true,queryUnknown:true,holdQuery:true});
  const oldChild=app.start();note('spawn',{pid:oldChild.pid,port:app.port,mysqlPort:f.port});
  await app.wait();assert.match(app.output,/"event":"runtime_started"/);note('ready');
  const session=await app.login(f.source.people[2]);
  const head=async()=>{const [[r]]=await f.setup.execute('SELECT revision,state_json,state_checksum FROM '+f.active.database+'.ledger_heads WHERE ledger_id=?',[f.names.ledgerId]);return {revision:Number(r.revision),state:decodeLedgerSnapshot(r.state_json,r.state_checksum)};};
  const workflows=async()=>{const [rows]=await f.setup.execute('SELECT state_json,state_checksum FROM '+f.active.database+'.room_control_workflows WHERE ledger_id=?',[f.names.ledgerId]);return rows.map(r=>decodeLedgerSnapshot(r.state_json,r.state_checksum));};
  const calls=async()=>{try{return (await readFile(join(f.root,'fake-device-calls.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
  const marker=async()=>{try{return JSON.parse(await readFile(join(f.root,'query-held.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
  assert.equal((await app.command(session,'open',{room:'666',beer:'bw',creditedEmployeeId:f.source.people[5].employeeId})).status,200);
  const held=await eventually(marker,x=>Boolean(x),'query claim barrier');
  const [claim]=await workflows();assert.equal(claim.id,held.workflowId);assert.equal(claim.status,'DEVICE_UNKNOWN');assert.ok(claim.inFlight);
  const before=await head(),beforeCalls=await calls();
  const mutations=rows=>rows.filter(x=>['openRoom','closeRoom'].includes(x.method));
  assert.equal(beforeCalls.filter(x=>x.method==='openRoom').length,1);
  const alertOutbox=async()=>{
   const envelope=JSON.parse(await readFile(join(app.logs,'operational-state.json'),'utf8'));
   return JSON.parse(envelope.data).outbox;
  };
  await eventually(alertOutbox,rows=>rows.length>0&&rows.every(row=>row.state==='DELIVERED'),
   'pre-crash synthetic alert delivery');
  note('alerts-drained');
  await assert.rejects(expireCrashedQueryLeases(f,app,oldChild,[claim]),/REHEARSAL_CRASH_NOT_CONFIRMED/);
  await app.crash();note('crash-awaited',{pid:oldChild.pid,exitCode:oldChild.exitCode,signal:oldChild.signalCode});
  const crashed=await workflows();assert.deepEqual(crashed,[claim]);
  app.start();note('restart',{pid:app.child.pid});assert.notEqual(app.child.pid,oldChild.pid);
  await app.wait();assert.match(app.output,/"event":"runtime_started"/);note('restart-ready');
  assert.equal((await app.call(session,'/api/v1/auth/session')).status,200);
  await app.controls({queryUnknown:false,holdQuery:false});
  await sleep(650);
  assert.deepEqual(await workflows(),crashed,'unexpired claim cannot be stolen');
  assert.deepEqual(await calls(),beforeCalls,'restart cannot query or mutate before lease expiry');
  note('lease-fenced',{until:claim.inFlight.until,revision:(await head()).revision});
  const leaseRecovery=await expireCrashedQueryLeases(f,app,oldChild,crashed);
  assert.ok(leaseRecovery.clockAdvancedMs>0);note('lease-boundary',leaseRecovery);
  const recoveryStart=performance.now();
  await eventually(workflows,rows=>rows.every(w=>w.status==='ACTIVE'),'post-crash query recovery');
  note('recovered',{recoveryMs:Math.round(performance.now()-recoveryStart)});
  const after=await head(),[recovered]=await workflows(),afterCalls=await calls();
  assert.equal(recovered.id,claim.id);assert.equal(recovered.orderId,claim.orderId);assert.equal(recovered.actorId,claim.actorId);assert.equal(recovered.operationKey,claim.operationKey);assert.equal(recovered.fingerprint,claim.fingerprint);
  assert.equal(after.revision,before.revision);
  assert.deepEqual(after.state,before.state,'query recovery cannot change order/payment/inventory');
  assert.deepEqual(mutations(afterCalls),mutations(beforeCalls),'no duplicate mutation or historical ACK resend');
  assert.equal(afterCalls[beforeCalls.length].method,'ensureSession');
  assert.equal(afterCalls[beforeCalls.length+1].method,'queryRoomState','first post-crash provider operation is read only');
  assert.ok(recovered.events.some(e=>e.outcome==='queried-applied'));
  note('safety',{revision:after.revision,orders:after.state.orders.length,payments:after.state.orders[0].payments.length,mutationRetries:0,sameWorkflow:true,sameActor:true,inventoryUnchanged:true});
 }finally{if(f)note('cleanup',await f.cleanup());}
});
