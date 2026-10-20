import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import mysql from 'mysql2/promise';
import {syntheticTls} from '../test-support/runtime-tls.js';
import {createProductionRuntime} from './runtime.js';
import {createBackupScheduler} from './backup-schedule.js';

const until=async predicate=>{
 for(let n=0;n<80;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}
 throw Error('STARTUP_ACTIVATION_TIMEOUT');
};
async function outageScenario(t,{code='ECONNREFUSED',candidate=false,readinessBlocker=false,backup=false,schedule=false,remainDown=false,scheduleFail=false,readyAtStart=false,realSchedule=false}={}){
 let available=readyAtStart,readinessCleared=!readinessBlocker;const calls=[];
 t.mock.method(mysql,'createConnection',async()=>{
  calls.push('trustedDbRead');
  if(!available)throw Object.assign(Error('synthetic unavailable'),{code});
  return {query:async sql=>sql.startsWith('SELECT mode,facts')?
   [[{mode:'NORMAL',facts:{reason:candidate?'plan-bound-candidate-restore':'ordinary'}}]]:[[]],
   end:async()=>{}};
 });
 const tls=await syntheticTls();
 const loaded={config:{applicationCommit:'a'.repeat(40),
  publicOrigin:'https://ktv-smoke.127.0.0.1.sslip.io:8443',port:0,
  listenHost:'127.0.0.1',backupPolicyConfigured:true,monitoring:{intervalMs:25}},
  configFingerprint:'b'.repeat(64),tls:{cert:tls.certificate,key:tls.privateKey},
  redactionSecrets:[],apiEnv:{KTV_MYSQL_URL:'mysql://synthetic@localhost/owned_runtime_test'}};
 const services={readiness:async()=>{calls.push('readiness');return {ready:available&&readinessCleared,blockers:!available?[{code:'DATABASE_OR_SCHEMA_UNAVAILABLE'}]:!readinessCleared?[{code:'LEDGER_NOT_INITIALIZED'}]:[]};},
  startWorker:async()=>{calls.push('worker');},stopWorker:async()=>{calls.push('stopWorker');},
  close:async()=>{calls.push('close');}};
 const operations={readyBlockers:()=>[],observeReadiness:async()=>{},
  start:async()=>{calls.push('operations');},stop:async()=>{calls.push('stopOperations');}};
 const logger={info:()=>{},error:()=>{}};
 const backupExecution=backup?{runOnce:async()=>{calls.push('backupRun');return {code:'BACKUP_EXECUTION_FAILED'};},stop:async()=>{calls.push('stopBackup');}}:undefined;
 let real,now=Date.parse('2026-10-20T00:00:00+08:00'),due;
 if(realSchedule)real=createBackupScheduler({config:{backupSchedule:{enabled:true}},execution:backupExecution,observations:{async open(){},async save(){}},logger},
  {now:()=>now,setTimeout:fn=>{due=fn;return 1;},clearTimeout:()=>{due=null;}});
 const backupScheduler=schedule?{start:async()=>{calls.push('startSchedule');await real?.start();if(scheduleFail)throw Error('synthetic schedule unavailable');},stop:async()=>{calls.push('stopSchedule');await real?.stop();}}:undefined;
 if(schedule)operations.ownsWriter=()=>true;
 const runtime=createProductionRuntime(loaded,{services,operations,logger,backupExecution,backupScheduler});
 const request=path=>new Promise((resolve,reject)=>{
  const req=https.request({host:'127.0.0.1',port:runtime.server.address().port,path,
   ca:tls.certificate,servername:'ktv-smoke.127.0.0.1.sslip.io',
   headers:{Host:'ktv-smoke.127.0.0.1.sslip.io:8443'}},res=>{
    res.resume();res.on('end',()=>resolve(res.statusCode));});
  req.on('error',reject);req.end();
 });
 try{
  if(scheduleFail){await assert.rejects(runtime.start(),/synthetic schedule unavailable/);assert.ok(calls.includes('stopSchedule'));assert.ok(calls.includes('stopOperations'));assert.equal(runtime.server.listening,false);if(readyAtStart){assert.ok(calls.includes('stopWorker'));assert.ok(calls.indexOf('stopWorker')<calls.indexOf('close'));}return;}
  await runtime.start();
  if(schedule)assert.ok(calls.includes('startSchedule'));
  assert.equal(runtime.status().phase,'LIVENESS_ONLY');
  assert.equal(await request('/health/live'),200);
  assert.equal(await request('/health/ready'),503);
  assert.equal(await request('/api/v1/auth/session'),503);
  assert.equal(calls.includes('operations'),false);
  assert.equal(calls.includes('worker'),false);
  if(realSchedule){now+=900000;due();await until(()=>calls.includes('backupRun'));assert.equal(runtime.status().phase,'LIVENESS_ONLY');assert.equal(calls.includes('worker'),false);}
  if(remainDown)return;
  available=true;
  if(readinessBlocker){
   await until(()=>calls.includes('readiness'));
   assert.equal(runtime.status().phase,'LIVENESS_ONLY');
   assert.equal(calls.includes('operations'),false);
   assert.equal(calls.includes('worker'),false);
   assert.equal(await request('/health/ready'),503);
   readinessCleared=true;
  }
  if(candidate){
   await until(()=>calls.filter(v=>v==='trustedDbRead').length>=2);
   assert.equal(runtime.status().phase,'LIVENESS_ONLY');
   assert.equal(await request('/health/ready'),503);
   assert.equal(calls.includes('operations'),false);
   assert.equal(calls.includes('worker'),false);
  }else{
   await until(()=>runtime.status().phase==='RUNNING');
   assert.equal(await request('/health/ready'),200);
   assert.ok(calls.indexOf('trustedDbRead')<calls.indexOf('readiness'));
   assert.ok(calls.lastIndexOf('trustedDbRead')<calls.indexOf('operations'));
   assert.ok(calls.indexOf('operations')<calls.indexOf('worker'));
  }
 }finally{await runtime.shutdown();if(schedule){assert.ok(calls.indexOf('stopSchedule')<calls.indexOf('close'));assert.ok(calls.includes('stopOperations'));}}
 if(backup)assert.ok(calls.indexOf('stopBackup')>=0&&calls.indexOf('stopBackup')<calls.indexOf('close'));
}
test('DB port outage starts liveness only and activates ordinary runtime after trusted DB recovery',
 t=>outageScenario(t));
test('locked DB account starts liveness only and activates after trusted DB recovery',
 t=>outageScenario(t,{code:'ER_ACCOUNT_HAS_BEEN_LOCKED'}));
test('incomplete plan-bound candidate remains liveness only after DB connectivity recovers',
 t=>outageScenario(t,{candidate:true}));

test('trusted DB alone cannot activate workers until service readiness passes',
 t=>outageScenario(t,{readinessBlocker:true}));

test('B2-A runtime shutdown awaits internal backup stop before closing service resources',
 t=>outageScenario(t,{backup:true}));


test('B2-B scheduler starts and stops in liveness-only mode without HTTP readiness or worker activation',
 t=>outageScenario(t,{schedule:true,backup:true,remainDown:true}));
test('B2-B scheduler startup failure closes the runtime and releases its reserved writer',
 t=>outageScenario(t,{schedule:true,scheduleFail:true}));

test('B2-B scheduler startup failure after readiness also stops already-started workers',
 t=>outageScenario(t,{schedule:true,scheduleFail:true,backup:true,readyAtStart:true}));

test('B2-B real scheduler reaches the internal executor during a DB outage without HTTP readiness',
 t=>outageScenario(t,{schedule:true,backup:true,realSchedule:true,remainDown:true}));
