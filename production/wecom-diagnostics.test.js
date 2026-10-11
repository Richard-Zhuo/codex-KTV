import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runWeComSmoke,parseSmokeArgs} from './wecom-smoke-cli.js';
import {createOperationalStore} from '../operations/store.js';
import {createIncidentLifecycle} from '../operations/incidents.js';
import {createAlertDispatcher} from '../operations/alerts.js';
import {createWeComAlertTransport} from '../operations/wecom.js';

const config={corpId:'synthetic-corp',agentId:123,secret:'synthetic-secret',storeLabel:'Synthetic KTV',
  criticalRecipients:['owner'],warnRecipients:['owner']};
const reply=value=>new Response(JSON.stringify(value),{status:200});
async function fixture(work){
  const root=await mkdtemp(join(tmpdir(),'wecom-diagnosis-'));
  try{
    const file=join(root,'wecom-smoke.json'),dir=join(root,'wecom-smoke-state');
    await mkdir(dir);
    const deps={loadConfig:async()=>config,checkDirectory:async()=>dir,
      checkStateFile:async()=>{},hardenTemp:async()=>{}};
    await work({file,dir,deps});
  }finally{await rm(root,{recursive:true,force:true});}
}
const state=async dir=>JSON.parse(JSON.parse(await readFile(join(dir,'operational-state.json'),'utf8')).data);
const open=async(file,deps,mode='--send-open')=>runWeComSmoke({configFile:file,mode},deps);

test('token explicit rejection persists only safe diagnosis and never calls message/send',()=>fixture(async({file,dir,deps})=>{
  let tokens=0,messages=0;
  deps.fetchImpl=async url=>String(url).includes('/gettoken')
    ?(tokens++,reply({errcode:40013,errmsg:'synthetic-secret synthetic-token owner'}))
    :(messages++,reply({errcode:0}));
  const result=await open(file,deps);
  assert.equal(result.OPEN_PROVIDER_RESULT,'REJECTED');
  assert.equal(result.MESSAGE_ACCEPTED,'NO');
  assert.equal(messages,0);
  const before=await readFile(join(dir,'operational-state.json'),'utf8');
  const delivery=(await state(dir)).outbox[0];
  assert.deepEqual([delivery.failureStage,delivery.providerResult,delivery.providerErrcode,
    delivery.providerErrorClass,delivery.uncertain],['TOKEN','REJECTED',40013,'TOKEN_REJECTED',false]);
  const inspected=await open(file,{...deps,loadConfig:async()=>{throw Error('secret read forbidden');},
    fetchImpl:async()=>{throw Error('network forbidden');}},'--inspect-existing');
  assert.equal(inspected.failureStage,'TOKEN');
  assert.equal(inspected.providerErrcode,40013);
  assert.equal(inspected.recipientCount,1);
  assert.equal(await readFile(join(dir,'operational-state.json'),'utf8'),before);
  await assert.rejects(open(file,deps),{code:'SMOKE_EXPLICIT_RETRY_REQUIRED'});
  await assert.rejects(open(file,deps,'--send-resolved'),{code:'SMOKE_RESOLVE_REQUIRES_CONFIRMED_OPEN'});
  assert.equal(tokens,1);assert.equal(messages,0);
  assert.doesNotMatch(JSON.stringify({result,inspected}),/synthetic-secret|synthetic-token|synthetic-corp|owner|errmsg|qyapi/);
  assert.doesNotMatch(JSON.stringify(delivery),/synthetic-secret|synthetic-token|synthetic-corp|errmsg|qyapi/);
}));

test('token network failure remains UNKNOWN but message acceptance is definitely NO',()=>fixture(async({file,dir,deps})=>{
  let tokens=0,messages=0;
  deps.fetchImpl=async url=>{
    if(String(url).includes('/gettoken')){tokens++;throw Error('synthetic-secret synthetic-token');}
    messages++;return reply({errcode:0});
  };
  const result=await open(file,deps);
  assert.equal(result.SMOKE,'INCONCLUSIVE');
  assert.equal(result.OPEN_PROVIDER_RESULT,'UNKNOWN');
  assert.equal(result.PROVIDER_ACCEPTANCE_UNCERTAIN,'NO');
  assert.equal(result.MESSAGE_ACCEPTED,'NO');
  const delivery=(await state(dir)).outbox[0];
  assert.deepEqual([delivery.failureStage,delivery.providerResult,delivery.providerErrcode,
    delivery.providerErrorClass,delivery.uncertain],['TOKEN','UNKNOWN',null,'NETWORK_UNKNOWN',false]);
  await assert.rejects(open(file,deps,'--retry-rejected'),{code:'SMOKE_RETRY_REQUIRES_REJECTED_OPEN'});
  assert.equal((await open(file,deps)).OPEN_PROVIDER_RESULT,'UNKNOWN');
  assert.equal(tokens,1);assert.equal(messages,0);
}));

test('message explicit reject persists errcode; explicit retry reuses exact logical delivery',()=>fixture(async({file,dir,deps})=>{
  let clock=1000000,tokens=0;const bodies=[];
  deps.now=()=>clock;
  deps.fetchImpl=async(url,options)=>{
    if(String(url).includes('/gettoken')){tokens++;return reply({errcode:0,access_token:'synthetic-token',expires_in:7200});}
    bodies.push(options.body);
    return reply({errcode:bodies.length===1?45009:0,errmsg:'synthetic-secret owner'});
  };
  const first=await open(file,deps);
  assert.equal(first.OPEN_PROVIDER_RESULT,'REJECTED');
  const before=(await state(dir)).outbox[0];
  assert.deepEqual([before.failureStage,before.providerResult,before.providerErrcode,
    before.providerErrorClass,before.uncertain],['MESSAGE_SEND','REJECTED',45009,'PROVIDER_REJECTED_OTHER',false]);
  await assert.rejects(open(file,deps),{code:'SMOKE_EXPLICIT_RETRY_REQUIRED'});
  await assert.rejects(open(file,deps,'--retry-rejected'),{code:'SMOKE_RETRY_NOT_DUE'});
  assert.equal(bodies.length,1);
  clock+=31000;
  const second=await open(file,deps,'--retry-rejected');
  const after=(await state(dir)).outbox[0];
  assert.equal(second.OPEN_PROVIDER_RESULT,'ACCEPTED');
  assert.equal(second.incidentId,first.incidentId);
  assert.equal(second.deliveryId,first.deliveryId);
  assert.equal(second.sequence,first.sequence);
  assert.deepEqual(after.recipients,before.recipients);
  assert.equal(after.content,before.content);
  assert.equal(after.attempts,2);
  assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);
  assert.equal(tokens,2);
}));

test('message disconnect persists UNKNOWN and both retry modes avoid another call',()=>fixture(async({file,dir,deps})=>{
  let sends=0;
  deps.fetchImpl=async url=>{
    if(String(url).includes('/gettoken'))return reply({errcode:0,access_token:'synthetic-token',expires_in:7200});
    sends++;throw Error('synthetic-secret synthetic-token raw URL');
  };
  const result=await open(file,deps);
  assert.equal(result.OPEN_PROVIDER_RESULT,'UNKNOWN');
  assert.equal(result.PROVIDER_ACCEPTANCE_UNCERTAIN,'YES');
  const delivery=(await state(dir)).outbox[0];
  assert.deepEqual([delivery.failureStage,delivery.providerResult,delivery.providerErrcode,
    delivery.providerErrorClass,delivery.uncertain],['MESSAGE_SEND','UNKNOWN',null,'NETWORK_UNKNOWN',true]);
  await assert.rejects(open(file,deps,'--retry-rejected'),{code:'SMOKE_RETRY_REQUIRES_REJECTED_OPEN'});
  assert.equal((await open(file,deps)).OPEN_PROVIDER_RESULT,'UNKNOWN');
  assert.equal(sends,1);
}));

test('legacy rejection remains readable but neither retry command can infer a rejection',()=>fixture(async({file,dir,deps})=>{
  let sends=0;
  deps.fetchImpl=async url=>String(url).includes('/gettoken')
    ?reply({errcode:0,access_token:'synthetic-token',expires_in:7200})
    :(sends++,reply({errcode:45009}));
  await open(file,deps);
  const store=await createOperationalStore(dir,'wecom-smoke-v1');
  await store.update(s=>{for(const key of ['failureStage','providerResult','providerErrcode','providerErrorClass'])
    delete s.outbox[0][key];});
  const bytes=await readFile(join(dir,'operational-state.json'),'utf8');
  const result=await open(file,{...deps,loadConfig:async()=>{throw Error('secret read forbidden');},
    fetchImpl:async()=>{throw Error('network forbidden');}},'--inspect-existing');
  assert.deepEqual([result.failureStage,result.providerErrcode,result.providerErrorClass],
    ['LEGACY_UNKNOWN','NOT_AVAILABLE','LEGACY_DIAGNOSTIC_UNAVAILABLE']);
  assert.equal(result.incidentId,(await state(dir)).incidents[0].incidentId);
  assert.equal(await readFile(join(dir,'operational-state.json'),'utf8'),bytes);
  await assert.rejects(open(file,deps),{code:'SMOKE_LEGACY_DIAGNOSTIC_UNAVAILABLE'});
  await assert.rejects(open(file,deps,'--retry-rejected'),{code:'SMOKE_RETRY_REQUIRES_REJECTED_OPEN'});
  assert.equal(sends,1);
}));

test('inspect and retry argument shape is explicit',()=>{
  assert.equal(parseSmokeArgs(['--config-file','wecom-smoke.json','--inspect-existing']).mode,'--inspect-existing');
  assert.equal(parseSmokeArgs(['--config-file','wecom-smoke.json','--retry-rejected']).mode,'--retry-rejected');
  assert.throws(()=>parseSmokeArgs(['--config-file','wecom-smoke.json','--retry-rejected',
    '--open-phone-confirmed']),{code:'SMOKE_ARGUMENTS_INVALID'});
});


test('token AbortSignal timeout keeps message definitely unsent',()=>fixture(async({file,dir,deps})=>{
  let messages=0;
  deps.fetchImpl=async(url,options)=>{
    if(String(url).includes('/gettoken'))return new Promise((_,reject)=>
      options.signal.addEventListener('abort',()=>reject(Error('synthetic-secret synthetic-token')),{once:true}));
    messages++;return reply({errcode:0});
  };
  const result=await open(file,deps);
  assert.equal(result.OPEN_PROVIDER_RESULT,'UNKNOWN');
  assert.equal(result.PROVIDER_ACCEPTANCE_UNCERTAIN,'NO');
  assert.equal(result.MESSAGE_ACCEPTED,'NO');
  const delivery=(await state(dir)).outbox[0];
  assert.equal(delivery.failureStage,'TOKEN');
  assert.equal(delivery.uncertain,false);
  assert.equal(messages,0);
}));

test('confirmed invalid token refresh records the terminal message result',()=>fixture(async({file,dir,deps})=>{
  let tokens=0,messages=0;const bodies=[];
  deps.fetchImpl=async(url,options)=>{
    if(String(url).includes('/gettoken'))return reply({errcode:0,access_token:'synthetic-token-'+ ++tokens,expires_in:7200});
    messages++;bodies.push(options.body);
    return reply({errcode:messages===1?42001:45009});
  };
  const result=await open(file,deps);
  assert.equal(result.OPEN_PROVIDER_RESULT,'REJECTED');
  const delivery=(await state(dir)).outbox[0];
  assert.equal(delivery.failureStage,'MESSAGE_SEND');
  assert.equal(delivery.providerErrcode,45009);
  assert.equal(tokens,2);assert.equal(messages,2);assert.equal(bodies[0],bodies[1]);
}));


test('inspect refuses malformed persisted diagnosis without printing it',()=>fixture(async({file,dir,deps})=>{
  deps.fetchImpl=async url=>String(url).includes('/gettoken')
    ?reply({errcode:0,access_token:'synthetic-token',expires_in:7200})
    :reply({errcode:45009});
  await open(file,deps);
  const store=await createOperationalStore(dir,'wecom-smoke-v1');
  await store.update(s=>{s.outbox[0].providerErrorClass='synthetic-secret';});
  const bytes=await readFile(join(dir,'operational-state.json'),'utf8');
  await assert.rejects(open(file,{...deps,loadConfig:async()=>{throw Error('secret read forbidden');},
    fetchImpl:async()=>{throw Error('network forbidden');}},'--inspect-existing'),
    {code:'SMOKE_STATE_INVALID'});
  await assert.rejects(open(file,{...deps,fetchImpl:async()=>{throw Error('network forbidden');}},
    '--retry-rejected'),{code:'SMOKE_STATE_INVALID'});
  assert.equal(await readFile(join(dir,'operational-state.json'),'utf8'),bytes);
}));


test('crash during explicit retry clears the earlier rejection before network outcome',()=>fixture(async({file,dir,deps})=>{
  let clock=1000000,sends=0;
  deps.now=()=>clock;
  deps.fetchImpl=async url=>String(url).includes('/gettoken')
    ?reply({errcode:0,access_token:'synthetic-token',expires_in:7200})
    :(sends++,reply({errcode:45009}));
  await open(file,deps);
  clock+=31000;
  const persisted=await createOperationalStore(dir,'wecom-smoke-v1');
  let updates=0;
  const crashStore={read:()=>persisted.read(),update:work=>{
    if(++updates===2)throw Error('SYNTHETIC_PROCESS_CRASH');
    return persisted.update(work);
  }};
  const retryDeps={...deps,storeFactory:async()=>crashStore,
    fetchImpl:async url=>String(url).includes('/gettoken')
      ?reply({errcode:0,access_token:'synthetic-token',expires_in:7200})
      :(sends++,reply({errcode:0}))};
  await assert.rejects(open(file,retryDeps,'--retry-rejected'),/SYNTHETIC_PROCESS_CRASH/);
  const delivery=(await state(dir)).outbox[0];
  assert.equal(delivery.providerResult,'UNKNOWN');
  assert.equal(delivery.failureStage,null);
  assert.equal(delivery.uncertain,true);
  const view=await open(file,deps,'--inspect-existing');
  assert.equal(view.providerResult,'UNKNOWN');
  await assert.rejects(open(file,deps,'--retry-rejected'),{code:'SMOKE_RETRY_REQUIRES_REJECTED_OPEN'});
  assert.equal(sends,2);
}));


test('bounded negative numeric provider errcode remains an explicit rejection',()=>fixture(async({file,dir,deps})=>{
  let messages=0;
  deps.fetchImpl=async url=>String(url).includes('/gettoken')
    ?reply({errcode:-1})
    :(messages++,reply({errcode:0}));
  const result=await open(file,deps);
  assert.equal(result.OPEN_PROVIDER_RESULT,'REJECTED');
  const delivery=(await state(dir)).outbox[0];
  assert.equal(delivery.providerErrcode,-1);
  assert.equal(delivery.failureStage,'TOKEN');
  assert.equal(messages,0);
}));


test('formal alert log records safe token-stage code without raw provider text',()=>fixture(async({dir})=>{
  const store=await createOperationalStore(dir,'synthetic');
  const logs=[];const logger={log:item=>logs.push(item)};
  const lifecycle=createIncidentLifecycle({store,scope:'synthetic',logger});
  const transport=createWeComAlertTransport({...config,fetchImpl:async url=>
    String(url).includes('/gettoken')
      ?reply({errcode:40013,errmsg:'synthetic-secret synthetic-token owner'})
      :reply({errcode:0})});
  await lifecycle.condition('DATABASE_UNAVAILABLE',true,{component:'database'});
  await createAlertDispatcher({store,transport,logger,timeoutMs:transport.maxDeliveryMs}).tick();
  const log=logs.find(item=>item.event==='alert_delivery');
  assert.equal(log.code,'WECOM_TOKEN_REJECTED');
  assert.equal(log.operation,'get-token');
  assert.equal(log.providerCode,40013);
  assert.doesNotMatch(JSON.stringify(logs),/synthetic-secret|synthetic-token|synthetic-corp|owner|errmsg|qyapi/);
}));
