import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {syntheticTls,protectSyntheticFile} from '../test-support/runtime-tls.js';
import {createProductionRuntime} from './runtime.js';

test('C2 cutover journal blocks normal runtime before readiness, workers and operations',async()=>{
 const root=await mkdtemp(join(tmpdir(),'c2-startup-'));
 try{
  const tls=await syntheticTls();
  const journal=join(root,'cutover-state.json');
  await writeFile(journal,JSON.stringify({version:1,
   recoveryOperationId:'12345678-1234-4123-8123-123456789abc',
   planDigest:'a'.repeat(64),backupSha256:'b'.repeat(64),
   sourceDatabase:'jbhh_ktv_test',targetDatabase:'jbhh_ktv_recovery_12345678123441238123123456789abc',
   serverUuid:'synthetic-server',state:'CUTOVER_INTENT'}));
  await protectSyntheticFile(journal,tls.sid);
  const calls=[];
  const loaded={config:{applicationCommit:'a'.repeat(40),
   publicOrigin:'https://ktv-smoke.127.0.0.1.sslip.io:8443',
   port:0,listenHost:'127.0.0.1',backupPolicyConfigured:true,
   recovery:{journalDirectory:root}},configFingerprint:'b'.repeat(64),
   tls:{cert:tls.certificate,key:tls.privateKey},redactionSecrets:[]};
  const services={readiness:async()=>{calls.push('readiness');return {ready:true,blockers:[]};},
   stopWorker:async()=>{calls.push('stopWorker');},close:async()=>{calls.push('close');},
   startWorker:async()=>{calls.push('startWorker');}};
  const operations={readyBlockers:()=>[],observeReadiness:async()=>{},
   start:async()=>{calls.push('operationsStart');},stop:async()=>{calls.push('operationsStop');}};
  const logger={info:()=>{},error:()=>{}};
  const blocked=createProductionRuntime(loaded,{logger,services,operations});
  await assert.rejects(blocked.start(),{code:'PRODUCTION_CUTOVER_STARTUP_BLOCKED'});
  assert.deepEqual(calls,[]);
  assert.equal(blocked.server.listening,false);
  await rm(journal);
  const noJournal=createProductionRuntime(loaded,{logger,services,operations});
  await assert.rejects(noJournal.start(),{code:'PRODUCTION_C3_STARTUP_BLOCKED'});
  assert.deepEqual(calls,[]);
  assert.equal(noJournal.server.listening,false);
 }finally{await rm(root,{recursive:true,force:true});}
});
