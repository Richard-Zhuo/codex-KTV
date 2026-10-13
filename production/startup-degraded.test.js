import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import mysql from 'mysql2/promise';
import {syntheticTls} from '../test-support/runtime-tls.js';
import {createProductionRuntime} from './runtime.js';

const until=async predicate=>{
 for(let n=0;n<80;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}
 throw Error('STARTUP_ACTIVATION_TIMEOUT');
};
async function outageScenario(t,{code='ECONNREFUSED',candidate=false,readinessBlocker=false}={}){
 let available=false,readinessCleared=!readinessBlocker;const calls=[];
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
 const runtime=createProductionRuntime(loaded,{services,operations,logger});
 const request=path=>new Promise((resolve,reject)=>{
  const req=https.request({host:'127.0.0.1',port:runtime.server.address().port,path,
   ca:tls.certificate,servername:'ktv-smoke.127.0.0.1.sslip.io',
   headers:{Host:'ktv-smoke.127.0.0.1.sslip.io:8443'}},res=>{
    res.resume();res.on('end',()=>resolve(res.statusCode));});
  req.on('error',reject);req.end();
 });
 try{
  await runtime.start();
  assert.equal(runtime.status().phase,'LIVENESS_ONLY');
  assert.equal(await request('/health/live'),200);
  assert.equal(await request('/health/ready'),503);
  assert.equal(await request('/api/v1/auth/session'),503);
  assert.equal(calls.includes('operations'),false);
  assert.equal(calls.includes('worker'),false);
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
 }finally{await runtime.shutdown();}
}
test('DB port outage starts liveness only and activates ordinary runtime after trusted DB recovery',
 t=>outageScenario(t));
test('locked DB account starts liveness only and activates after trusted DB recovery',
 t=>outageScenario(t,{code:'ER_ACCOUNT_HAS_BEEN_LOCKED'}));
test('incomplete plan-bound candidate remains liveness only after DB connectivity recovers',
 t=>outageScenario(t,{candidate:true}));

test('trusted DB alone cannot activate workers until service readiness passes',
 t=>outageScenario(t,{readinessBlocker:true}));
