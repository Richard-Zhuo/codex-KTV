import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createKtvSkySafetyPolicy, parseKtvSkyValidationConfig, loadKtvSkyValidationConfig } from './ktvsky-safety.js';
import { createKtvSkyValidationBoundary, summarizeValidation } from './ktvsky-validation.js';
import { KtvSkyRoomControlGateway } from './ktvsky-gateway.js';
import { FakeKtvRoomControlGateway } from './fake-gateway.js';
import { providerFixture, deviceInput, syntheticCredentials } from '../test-support/ktvsky-provider-fixture.js';

const at=Date.parse('2026-10-08T02:00:00Z'),now=()=>at;
const config=()=>({schemaVersion:1,storeId:'123',mappings:[{internalRoomId:'safe-synthetic-room',
 provider:'ktvsky',externalDeviceId:'synthetic-device',enabled:true}],
 safeTarget:{internalRoomId:'safe-synthetic-room',externalDeviceId:'synthetic-device',storeId:'123',
  approved:true,unoccupied:true,approvalReference:'synthetic-human-approval',
  approvedAt:new Date(at-1000).toISOString(),expiresAt:new Date(at+60000).toISOString()}});
const env={KTVSKY_LIVE_CONTROL_ENABLED:'true'};
const command={action:'close',internalRoomId:'safe-synthetic-room'};
const input={...deviceInput,internalRoomId:'safe-synthetic-room'};
const controls=f=>f.requests.filter(r=>r.path==='/h5/mac_control');
async function directory(t) {
 const root=await mkdtemp(path.join(os.tmpdir(),'ktvsky-validation-test-'));
 t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
function boundary(f,root,options={}) {
 return createKtvSkyValidationBoundary({config:config(),env,httpClient:f.client,
  credentialProvider:async()=>syntheticCredentials,journalDirectory:root,now,...options});
}

for(const [name,change,code] of [
 ['live disabled',c=>({config:c,env:{}}),'LIVE_CONTROL_DISABLED'],
 ['live flag must be exact',c=>({config:c,env:{KTVSKY_LIVE_CONTROL_ENABLED:'1'}}),'LIVE_CONTROL_DISABLED'],
 ['no mapping',c=>{c.mappings=[];return {config:c};},'MAPPING_REQUIRED'],
 ['disabled mapping',c=>{c.mappings[0].enabled=false;return {config:c};},'MAPPING_REQUIRED'],
 ['no safe target',c=>{c.safeTarget=null;return {config:c};},'SAFE_TEST_TARGET_REQUIRED'],
 ['not approved',c=>{c.safeTarget.approved=false;return {config:c};},'SAFE_TEST_TARGET_REQUIRED'],
 ['occupied',c=>{c.safeTarget.unoccupied=false;return {config:c};},'SAFE_TEST_TARGET_REQUIRED'],
 ['wrong target',c=>{c.safeTarget.externalDeviceId='another-device';return {config:c};},'SAFE_TEST_TARGET_REQUIRED'],
 ['expired',c=>{c.safeTarget.expiresAt=new Date(at).toISOString();return {config:c};},'SAFE_APPROVAL_EXPIRED'],
 ['future approval',c=>{c.safeTarget.approvedAt=new Date(at+1000).toISOString();return {config:c};},'SAFE_APPROVAL_EXPIRED'],
 ['approval over fifteen minutes',c=>{c.safeTarget.expiresAt=new Date(at+900000).toISOString();return {config:c};},'SAFE_APPROVAL_EXPIRED']
])test('safe boundary rejects '+name+' before any HTTP',async t=>{
 const f=await providerFixture(t),root=await directory(t),options=change(config());
 await assert.rejects(boundary(f,root,options).run(command),{code});
 assert.equal(f.requests.length,0);assert.deepEqual(await readdir(root),[]);
});

test('mapping and store must be explicit; immutable policy cannot gain authority from caller mutation',()=>{
 const c=config(),policy=createKtvSkySafetyPolicy({config:c,liveEnabled:true,now});
 c.safeTarget.unoccupied=false;c.mappings[0].externalDeviceId='changed';
 assert.equal(policy(input),true);
 assert.throws(()=>policy({...input,externalDeviceId:'changed'}),{code:'MAPPING_REQUIRED'});
 const wrong=config();wrong.safeTarget.storeId='other';
 assert.throws(()=>parseKtvSkyValidationConfig(wrong),{code:'INVALID_CONFIG'});
 const absent=config();absent.storeId=null;absent.safeTarget.storeId=null;
 assert.throws(()=>parseKtvSkyValidationConfig(absent),{code:'INVALID_CONFIG'});
 const guessed=config();guessed.mappings[0].externalDeviceId='*';
 assert.throws(()=>createKtvSkySafetyPolicy({config:guessed,liveEnabled:true,now})(input),{code:'MAPPING_REQUIRED'});
});
test('production HTTP adapter cannot use an unbranded permissive callback as its safety boundary',async()=>{
 let requests=0;
 const gateway=new KtvSkyRoomControlGateway({enabled:true,mutationPolicy:()=>true,
  httpClient:{origin:'https://lknewcms.ktvsky.com',request:async()=>{requests++;throw Error('must not call');}}});
 await assert.rejects(gateway.closeRoom(input),{code:'SAFE_VALIDATION_REQUIRED'});
 assert.equal(requests,0);assert.equal(gateway.productionEnabled,false);
});
test('approval is revalidated after authentication, immediately before dispatch',async t=>{
 let clock=at;
 const f=await providerFixture(t,{handler:({entry})=>{if(entry.path==='/h5/login')clock=at+60001;return false;}});
 await assert.rejects(boundary(f,await directory(t),{now:()=>clock}).run(command),{code:'SAFE_APPROVAL_EXPIRED'});
 assert.equal(controls(f).length,0);
 clock=at;
 const direct=new KtvSkyRoomControlGateway({httpClient:f.client,credentialProvider:async()=>syntheticCredentials,
  enabled:true,now:()=>clock,mutationPolicy:createKtvSkySafetyPolicy({config:config(),liveEnabled:true,now:()=>clock})});
 assert.equal((await direct.closeRoom(input)).kind,'UNKNOWN');assert.equal(controls(f).length,0);
});
test('safe close persists UNKNOWN before dispatch, queries afterwards, and blocks a new open or workflow after restart',async t=>{
 const f=await providerFixture(t),root=await directory(t);
 const first=await boundary(f,root).run(command);
 assert.equal(first.pending,true);assert.equal(first.code,'DEVICE_UNKNOWN');assert.equal(controls(f).length,1);
 assert.deepEqual(controls(f)[0].body,{mac:'synthetic-device',status:0,telno:'synthetic-account'});
 const records=await readdir(root);assert.equal(records.length,1);
 const raw=await readFile(path.join(root,records[0]),'utf8'),record=JSON.parse(raw);
 assert.equal(record.workflowId,first.workflowId);assert.equal(record.status,'UNKNOWN');
 for(const secret of ['synthetic-account','synthetic-device','synthetic-password','synthetic-provider-token','synthetic-cookie','snapshot','csrf'])
  assert.equal(raw.includes(secret),false);
 const resumed=await boundary(f,root).run({...command,action:'open',countdownSeconds:60,targetEndAt:deviceInput.targetEndAt});
 assert.equal(resumed.pending,true);assert.equal(resumed.workflowId,first.workflowId);assert.equal(controls(f).length,1);
 assert.equal(f.requests.at(-1).path,'/h5/search');
 const summary=JSON.stringify(summarizeValidation(resumed));
 for(const value of ['synthetic-device','synthetic-account','synthetic-provider-token','private-detail'])assert.equal(summary.includes(value),false);
});
test('safe open maps exactly sixty seconds into one combined control and then query',async t=>{
 const f=await providerFixture(t),root=await directory(t);
 const result=await boundary(f,root).run({...command,action:'open',countdownSeconds:60,targetEndAt:deviceInput.targetEndAt});
 assert.equal(controls(f).length,1);
 assert.deepEqual(controls(f)[0].body,{mac:'synthetic-device',status:1,opentime:60,telno:'synthetic-account'});
 assert.equal(result.observation.room.open,true);assert.equal(result.observation.room.observedCountdownValue,60);
 assert.equal(result.observation.settled,false);assert.equal(result.observation.retrySafe,false);
});
test('validation duration and mandatory external journal reject before network',async t=>{
 const f=await providerFixture(t),root=await directory(t);
 for(const seconds of [0,1,59,61,3600,NaN])
  await assert.rejects(boundary(f,root).run({...command,action:'open',countdownSeconds:seconds,targetEndAt:deviceInput.targetEndAt}),{code:'SAFE_COUNTDOWN_REQUIRED'});
 await assert.rejects(boundary(f,undefined).run(command),{code:'EXTERNAL_JOURNAL_REQUIRED'});
 assert.equal(f.requests.length,0);
});
test('offline or missing device cannot receive a safe mutation',async t=>{
 const f=await providerFixture(t),root=await directory(t);f.state.alive=0;
 assert.equal((await boundary(f,root).run(command)).code,'DEVICE_OFFLINE');
 assert.equal(controls(f).length,0);assert.deepEqual(await readdir(root),[]);
 const missing=await providerFixture(t,{handler:({entry,res})=>{
  if(entry.path!=='/h5/search')return false;res.end(JSON.stringify({code:200,result:{store_id:123,list:[]}}));return true;
 }});
 assert.equal((await boundary(missing,root).run(command)).pending,false);assert.equal(controls(missing).length,0);
});
test('query is available with live control disabled and never claims missing credentials as a verified read',async t=>{
 const f=await providerFixture(t),root=await directory(t);
 assert.equal((await boundary(f,root,{env:{}}).run({...command,action:'query'})).code,'READ_OBSERVED');
 const noAuth=boundary(f,root,{credentialProvider:async()=>({})});
 assert.equal((await noAuth.run({...command,action:'query'})).code,'AUTH_REQUIRED');
 assert.equal(controls(f).length,0);
});
test('timeout after sent open remains durable UNKNOWN; restarted validation only queries',async t=>{
 const f=await providerFixture(t,{clientOptions:{requestTimeoutMs:80},handler:({entry,state})=>{
  if(entry.path!=='/h5/mac_control')return false;
  state.status=1;state.opentime=entry.body.opentime;return true;
 }}),root=await directory(t);
 const first=await boundary(f,root).run({...command,action:'open',countdownSeconds:60,targetEndAt:deviceInput.targetEndAt});
 assert.equal(first.pending,true);assert.equal(first.code,'DEVICE_UNKNOWN');assert.equal(first.observation.room.open,true);
 const resumed=await boundary(f,root).run(command);
 assert.equal(resumed.workflowId,first.workflowId);assert.equal(resumed.observation.retrySafe,false);
 assert.equal(controls(f).length,1);
});
test('definite auth rejection stays distinct and never replays the device request',async t=>{
 const f=await providerFixture(t,{handler:({entry,res})=>{
  if(entry.path!=='/h5/mac_control')return false;res.writeHead(401);res.end('provider secret detail');return true;
 }}),root=await directory(t);
 const first=await boundary(f,root).run(command);assert.equal(first.code,'AUTH_REQUIRED');assert.equal(first.pending,true);
 const resumed=await boundary(f,root).run(command);assert.equal(resumed.workflowId,first.workflowId);
 assert.equal(controls(f).length,1);
});
test('concurrent validation instances atomically claim at most one device mutation',async t=>{
 const f=await providerFixture(t),root=await directory(t);
 const results=await Promise.allSettled([boundary(f,root).run(command),boundary(f,root).run(command)]);
 assert.equal(controls(f).length,1);
 for(const r of results)if(r.status==='rejected')assert.equal(r.reason.code,'INVALID_PENDING_RECORD');
 assert.equal((await boundary(f,root).run(command)).pending,true);assert.equal(controls(f).length,1);
});
test('corrupt durable record fails closed before auth and no repository journal is allowed',async t=>{
 const f=await providerFixture(t),root=await directory(t);await boundary(f,root).run(command);
 const [name]=await readdir(root);await writeFile(path.join(root,name),'{"rawSecret":"synthetic-secret"}');
 const count=f.requests.length;
 await assert.rejects(boundary(f,root).run(command),{code:'INVALID_PENDING_RECORD'});
 assert.equal(f.requests.length,count);
 const repo=fileURLToPath(new URL('../',import.meta.url));
 await assert.rejects(boundary(f,repo).run(command),{code:'EXTERNAL_JOURNAL_REQUIRED'});
});
test('external config schema is bounded and cannot accidentally accept a provider secret',async t=>{
 const root=await directory(t),location=path.join(root,'config.json');
 await writeFile(location,JSON.stringify(config()));assert.equal((await loadKtvSkyValidationConfig(location)).safeTarget.approved,true);
 await writeFile(location,JSON.stringify({...config(),password:'do-not-return'}));
 await assert.rejects(loadKtvSkyValidationConfig(location),error=>error.code==='INVALID_CONFIG'&&!String(error).includes('do-not-return'));
 await writeFile(location,' '.repeat(33000));await assert.rejects(loadKtvSkyValidationConfig(location),{code:'INVALID_CONFIG'});
 const empty=await loadKtvSkyValidationConfig(fileURLToPath(new URL('./ktvsky-validation.example.json',import.meta.url)));
 assert.deepEqual(empty.mappings,[]);assert.equal(empty.safeTarget,null);
});
test('CLI rejects default live control without HTTP or dumping supplied values',async()=>{
 const tool=fileURLToPath(new URL('../tools/ktvsky-validate.js',import.meta.url));
 const example=fileURLToPath(new URL('./ktvsky-validation.example.json',import.meta.url));
 const run=args=>new Promise(resolve=>{
  const child=spawn(process.execPath,[tool,...args],{env:{...process.env,KTVSKY_LIVE_CONTROL_ENABLED:''},windowsHide:true});
  let stdout='',stderr='';child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);
  child.on('close',code=>resolve({code,stdout,stderr}));
 });
 const denied=await run(['--config',example,'--action','close','--room','V01']);
 assert.equal(denied.code,1);assert.equal(JSON.parse(denied.stdout).code,'MAPPING_REQUIRED');assert.equal(denied.stderr,'');
 const secret=await run(['--password','synthetic-secret']);assert.equal(secret.code,1);assert.equal(secret.stdout.includes('synthetic-secret'),false);
});

for(const kind of ['fake','real'])test('shared combined-open contract: '+kind+' uses one open intent and no separate countdown',async t=>{
 const f=kind==='real'?await providerFixture(t,{gatewayOptions:{enabled:true,mutationPolicy:()=>true}}):null;
 const gateway=f?.gateway??new FakeKtvRoomControlGateway();
 assert.equal(typeof gateway.setCountdown,'undefined');
 await gateway.openRoom(deviceInput);const read=await gateway.queryRoomState(deviceInput);
 assert.equal(read.room.open,true);
 if(f){
  assert.equal(controls(f).length,1);assert.equal(controls(f)[0].body.opentime,deviceInput.countdownSeconds);
  assert.equal(read.stepResult,'UNKNOWN');assert.equal(read.settled,false);
 }else{
  assert.equal(gateway.calls.filter(c=>c.method==='openRoom').length,1);
  assert.equal(read.room.countdownTargetEndAt,deviceInput.targetEndAt);
  assert.equal(gateway.testOnly,true);assert.equal(read.stepResult,'APPLIED'); // Explicit simulator proof only.
 }
});
test('changing workflow or step identity cannot bypass unresolved device effect in one adapter instance',async t=>{
 const f=await providerFixture(t,{gatewayOptions:{enabled:true,mutationPolicy:()=>true}});
 await f.gateway.closeRoom(deviceInput);
 await f.gateway.openRoom({...deviceInput,workflowId:'new-workflow',stepId:'new-step'});
 assert.equal(controls(f).length,1);
});

test('the durable UNKNOWN record exists before provider side effect; a fresh process can only query it',async t=>{
 const root=await directory(t);let journalBeforeEffect=false;
 const f=await providerFixture(t,{handler:async({entry})=>{
  if(entry.path==='/h5/mac_control'){
   const names=await readdir(root);
   journalBeforeEffect=names.length===1&&JSON.parse(await readFile(path.join(root,names[0]),'utf8')).status==='UNKNOWN';
  }
  return false;
 }});
 const first=await boundary(f,root).run(command);assert.equal(journalBeforeEffect,true);
 const validationUrl=new URL('./ktvsky-validation.js',import.meta.url).href;
 const clientUrl=new URL('./ktvsky-http-client.js',import.meta.url).href;
 const source=[
  'import { createKtvSkyValidationBoundary, summarizeValidation } from '+JSON.stringify(validationUrl)+';',
  'import { createKtvSkyHttpClient } from '+JSON.stringify(clientUrl)+';',
  'const [root,raw,url,clock]=process.argv.slice(1);',
  'const boundary=createKtvSkyValidationBoundary({config:JSON.parse(raw),env:{KTVSKY_LIVE_CONTROL_ENABLED:"true"},',
  'httpClient:createKtvSkyHttpClient({baseUrl:url,testOnly:true}),journalDirectory:root,now:()=>Number(clock),',
  'credentialProvider:async()=>({telno:"synthetic-account",password:"synthetic-password"})});',
  'console.log(JSON.stringify(summarizeValidation(await boundary.run({action:"close",internalRoomId:"safe-synthetic-room"}))));'
 ].join('\n');
 const result=await new Promise(resolve=>{
  const child=spawn(process.execPath,['--input-type=module','-e',source,root,JSON.stringify(config()),f.client.origin,String(at)],{windowsHide:true});
  let stdout='',stderr='';child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);
  child.on('close',code=>resolve({code,stdout,stderr}));
 });
 assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).workflowId,first.workflowId);
 assert.equal(JSON.parse(result.stdout).pending,true);assert.equal(controls(f).length,1);
});
test('connection loss after accepted close cannot turn into automatic replay',async t=>{
 const f=await providerFixture(t,{handler:({entry,state,req})=>{
  if(entry.path!=='/h5/mac_control')return false;state.status=0;req.socket.destroy();return true;
 }}),root=await directory(t);
 const result=await boundary(f,root).run(command);assert.equal(result.code,'DEVICE_UNKNOWN');assert.equal(result.pending,true);
 await boundary(f,root).run(command);assert.equal(controls(f).length,1);
});
