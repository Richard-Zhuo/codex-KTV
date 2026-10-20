import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {createOperationalRuntime} from '../operations/runtime.js';
import {acquireOperationalWriter} from '../operations/writer-lock.js';
import {hash} from '../operations/contract.js';
import {reportBackup} from '../operations/backup-report.js';
import {createBackupScheduler} from './backup-schedule.js';
import {syntheticTls} from '../test-support/runtime-tls.js';
const P=900000,BASE=Date.parse('2026-10-20T00:00:00+08:00'),scope=hash('synthetic:synthetic');
async function fixture(t,{enabled=true}={}){
  const root=await mkdtemp(join(tmpdir(),'ktv-b2b-ops-')),tls=await syntheticTls();let now=BASE,callback,calls=0;
  const loaded={logDirectory:root,redactionSecrets:[],tls:{cert:tls.certificate},config:{storeId:'synthetic',ledgerId:'synthetic',
    publicOrigin:'https://ktv-smoke.127.0.0.1.sslip.io:8443',backupPolicyConfigured:true,backupSchedule:{enabled},
    monitoring:{intervalMs:60000,minFreeBytes:1,backupDirectory:root}}};
  const ops=await createOperationalRuntime({loaded,logger:{log(){}},now:()=>now});
  const schedule=createBackupScheduler({config:loaded.config,observations:ops.backupSchedule,execution:{async runOnce(){calls++;return {code:'BACKUP_VERIFIED'};},async stop(){}},logger:{info(){}}},
    {now:()=>now,setTimeout:fn=>{callback=fn;return 1;},clearTimeout:()=>{callback=null;}});
  t.after(async()=>{await schedule.stop();if(ops.ownsWriter())await ops.stop();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('ktv-b2b-ops-'));await rm(root,{recursive:true,force:true});});
  const services={readiness:async()=>({ready:false,blockers:[{code:'DATABASE_OR_SCHEMA_UNAVAILABLE'}]})};
  return {root,loaded,ops,schedule,services,get calls(){return calls;},
    async due(){now+=P;const fn=callback;callback=null;fn();for(let i=0;i<200;i++){if(ops.store.read().observations.backupSchedule?.state==='VERIFIED')return;await new Promise(r=>setTimeout(r,2));}throw Error('SCHEDULE_TEST_TIMEOUT');}};
}
test('B2-B reserves the existing writer without readiness; monitoring later reuses it without losing the schedule cursor',async t=>{
  const f=await fixture(t);await f.schedule.start();assert.equal(f.ops.ownsWriter(),true);assert.equal(f.ops.snapshot().runtime,'STARTING');
  await assert.rejects(acquireOperationalWriter(f.root,scope),/ALREADY_RUNNING/);
  await f.due();assert.equal(f.calls,1);const before=f.ops.store.read().observations.backupSchedule;
  assert.equal(f.ops.snapshot().backup.lastSuccessAt,null);assert.equal(f.ops.snapshot().backup.lastResult,'NOT_OBSERVED');
  await f.ops.start(f.services);assert.deepEqual(f.ops.store.read().observations.backupSchedule,before);
  assert.equal(f.ops.snapshot().backup.schedule.state,'VERIFIED');assert.equal(f.ops.snapshot().backup.lastSuccessAt,null);
  assert.deepEqual((await readdir(f.root)).filter(n=>n.includes('schedule')),[]);
});
test('B2-B restart cursor uses the same persisted operational store; local outcome never writes a separate success receipt',async t=>{
  const f=await fixture(t);await f.schedule.start();await f.due();await f.schedule.stop();await f.ops.stop();
  const next=await createOperationalRuntime({loaded:f.loaded,logger:{log(){}}});
  t.after(async()=>{if(next.ownsWriter())await next.stop();});
  const state=await next.backupSchedule.open();assert.equal(state.state,'STOPPED');assert.equal(state.nextDueAt,BASE+2*P);
  assert.equal(next.snapshot().backup.lastSuccessAt,null);await next.stop();
  const release=await acquireOperationalWriter(f.root,scope);await release();
});
test('B2-B schedule observation cannot overwrite original mailbox backup success/failure facts',async t=>{
  const f=await fixture(t);await f.schedule.start();await reportBackup(f.root,{success:true,createdAt:new Date(BASE).toISOString()});
  await f.ops.start(f.services);const success=f.ops.snapshot().backup.lastSuccessAt;assert.equal(success,new Date(BASE).toISOString());
  await f.due();assert.equal(f.ops.snapshot().backup.lastSuccessAt,success);assert.equal(f.ops.snapshot().backup.lastResult,'SUCCESS');
  await reportBackup(f.root,{success:false});await f.ops.tick();assert.equal(f.ops.snapshot().backup.lastSuccessAt,success);assert.equal(f.ops.snapshot().backup.lastResult,'FAILURE');
});
test('B2-B disabled projection hides old enabled cursor and save requires existing writer ownership',async t=>{
  const f=await fixture(t,{enabled:false});await f.schedule.start();assert.equal(f.ops.ownsWriter(),false);
  await assert.rejects(f.ops.backupSchedule.save({}),/WRITER_REQUIRED/);
  await f.ops.backupSchedule.open();await f.ops.backupSchedule.save({version:1,state:'RUNNING',nextDueAt:BASE+P,observedAt:BASE,lastSlotAt:BASE,runningSlotAt:BASE,missedCount:0,missedFrom:null,missedThrough:null});
  assert.equal(f.ops.snapshot().backup.schedule.state,'DISABLED');await f.ops.stop();
  await assert.rejects(f.ops.backupSchedule.save({}),/WRITER_REQUIRED/);
});
