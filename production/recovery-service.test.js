import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecoveryServiceAdapter} from './recovery-service.js';
const expected={serviceName:'JbhhKtv',hostExecutable:'C:\\owned\\service-host.exe',
 nodeExecutable:'C:\\owned\\node.exe',entryFile:'C:\\owned\\production\\start.js',
 configFile:'C:\\owned\\runtime.json',serviceSid:'S-1-5-80-111'};
const command=[expected.hostExecutable,'--node',expected.nodeExecutable,'--entry',expected.entryFile,'--config',expected.configFile];
const host={pid:100,ppid:4,createdAt:'2026-10-13T00:00:00.000Z',executable:expected.hostExecutable,argv:command,sid:expected.serviceSid};
const node={pid:101,ppid:100,createdAt:'2026-10-13T00:00:01.000Z',executable:expected.nodeExecutable,argv:[expected.nodeExecutable,expected.entryFile,'--config-file',expected.configFile],sid:expected.serviceSid};
const stopped=()=>({name:'JbhhKtv',state:'Stopped',pid:0,serviceSid:expected.serviceSid,argv:command,processes:[]});
test('SCM stopped proof requires registered identity AND absence of managed processes',async()=>{
 let snapshot=stopped(),commands=[];
 const adapter=createRecoveryServiceAdapter(expected,{snapshot:async()=>snapshot,command:async a=>{commands.push(a);},pause:async()=>{}});
 assert.equal((await adapter.status()).phase,'STOPPED');
 snapshot={...stopped(),processes:[node]};
 await assert.rejects(()=>adapter.status(),{code:'RECOVERY_SERVICE_PROCESS_CONFLICT'});
 snapshot={...stopped(),serviceSid:'S-1-5-80-999'};
 await assert.rejects(()=>adapter.shutdown(),{code:'RECOVERY_SERVICE_IDENTITY_MISMATCH'});
 assert.deepEqual(commands,[]);
});
test('SCM adapter stops only the validated host/tree and awaits asynchronous absence',async()=>{
 let snapshot={...stopped(),state:'Running',pid:100,processes:[host,node]},stops=0;
 const adapter=createRecoveryServiceAdapter(expected,{snapshot:async()=>snapshot,command:async action=>{assert.equal(action,'stop');stops++;snapshot=stopped();},pause:async()=>{}});
 assert.equal((await adapter.status()).phase,'RUNNING');
 assert.equal(await adapter.shutdown(),true);assert.equal(stops,1);
 assert.equal((await adapter.status()).phase,'STOPPED');
});
test('SCM proof rejects PID reuse, missing process identity and unexpected descendant',async()=>{
 let snapshot={...stopped(),state:'Running',pid:100,processes:[host,node]};
 const adapter=createRecoveryServiceAdapter(expected,{snapshot:async()=>snapshot,command:async()=>{},pause:async()=>{}});
 await adapter.status();
 for(const bad of [{...host,createdAt:'2026-10-13T00:01:00.000Z'}, {...host,createdAt:null}, {...node,executable:'C:\\untrusted.exe'}]){
  snapshot={...stopped(),state:'Running',pid:100,processes:bad.pid===100?[bad,node]:[host,bad]};
  await assert.rejects(()=>adapter.status());
 }
});

test('SCM process existence carries no application activation or writer assertion',async()=>{
 const adapter=createRecoveryServiceAdapter(expected,{snapshot:async()=>({...stopped(),state:"Running",pid:100,processes:[host,node]}),command:async()=>{},pause:async()=>{}});
 const state=await adapter.status();assert.equal(state.phase,'RUNNING');
 assert.equal(Object.hasOwn(state,'normalWriterCount'),false);
 assert.equal(Object.hasOwn(state,'workerStopped'),false);
 assert.ok(state.nodeProcess?.pid);assert.ok(state.nodeProcess?.createdAt);
});
