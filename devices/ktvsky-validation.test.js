import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
async function initiallyOpenFixture(t,options) {
 const f=await providerFixture(t,options);f.state.status=1;return f;
}
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
 const f=await initiallyOpenFixture(t),root=await directory(t),options=change(config());
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
 const f=await initiallyOpenFixture(t,{handler:({entry})=>{if(entry.path==='/h5/login')clock=at+60001;return false;}});
 await assert.rejects(boundary(f,await directory(t),{now:()=>clock}).run(command),{code:'SAFE_APPROVAL_EXPIRED'});
 assert.equal(controls(f).length,0);
 clock=at;
 const direct=new KtvSkyRoomControlGateway({httpClient:f.client,credentialProvider:async()=>syntheticCredentials,
  enabled:true,now:()=>clock,mutationPolicy:createKtvSkySafetyPolicy({config:config(),liveEnabled:true,now:()=>clock})});
 assert.equal((await direct.closeRoom(input)).kind,'UNKNOWN');assert.equal(controls(f).length,0);
});
test('safe close ACK still OPEN waits for state and blocks a new open after restart',async t=>{
 const f=await initiallyOpenFixture(t,{handler:({entry,res})=>{if(entry.path!=='/h5/mac_control')return false;res.end(JSON.stringify({code:200}));return true;}}),root=await directory(t);
 const first=await boundary(f,root).run(command);
 assert.equal(first.pending,true);assert.equal(first.code,'ACKNOWLEDGED');assert.equal(controls(f).length,1);
 assert.deepEqual(controls(f)[0].body,{mac:'synthetic-device',status:0,telno:'synthetic-account'});
 const records=await readdir(root);assert.equal(records.length,1);
 const raw=await readFile(path.join(root,records[0]),'utf8'),record=JSON.parse(raw);
 assert.equal(record.workflowId,first.workflowId);assert.equal(record.status,'ACKNOWLEDGED');
 for(const secret of ['synthetic-account','synthetic-device','synthetic-password','synthetic-provider-token','synthetic-cookie','snapshot','csrf'])
  assert.equal(raw.includes(secret),false);
 const resumed=await boundary(f,root).run({...command,action:'open',countdownSeconds:60,targetEndAt:deviceInput.targetEndAt});
 assert.equal(resumed.pending,true);assert.equal(resumed.workflowId,first.workflowId);assert.equal(controls(f).length,1);
 assert.equal(f.requests.at(-1).path,'/h5/search');
 const summary=JSON.stringify(summarizeValidation(resumed));
 for(const value of ['synthetic-device','synthetic-account','synthetic-provider-token','private-detail'])assert.equal(summary.includes(value),false);
});
test('safe open maps exactly sixty seconds into one combined control and then query',async t=>{
 const f=await initiallyOpenFixture(t),root=await directory(t);
 f.state.status=0;
 const result=await boundary(f,root).run({...command,action:'open',countdownSeconds:60,targetEndAt:deviceInput.targetEndAt});
 assert.equal(controls(f).length,1);
 assert.deepEqual(controls(f)[0].body,{mac:'synthetic-device',status:1,opentime:60,telno:'synthetic-account'});
 assert.equal(result.observation.room.open,true);assert.equal(result.observation.room.observedCountdownValue,60);
 assert.equal(result.observation.settled,false);assert.equal(result.observation.retrySafe,false);
});
test('validation duration and mandatory external journal reject before network',async t=>{
 const f=await initiallyOpenFixture(t),root=await directory(t);
 for(const seconds of [0,1,59,61,3600,NaN])
  await assert.rejects(boundary(f,root).run({...command,action:'open',countdownSeconds:seconds,targetEndAt:deviceInput.targetEndAt}),{code:'SAFE_COUNTDOWN_REQUIRED'});
 await assert.rejects(boundary(f,undefined).run(command),{code:'EXTERNAL_JOURNAL_REQUIRED'});
 assert.equal(f.requests.length,0);
});
test('offline or missing device cannot receive a safe mutation',async t=>{
 const f=await initiallyOpenFixture(t),root=await directory(t);f.state.alive=0;
 assert.equal((await boundary(f,root).run(command)).code,'DEVICE_OFFLINE');
 assert.equal(controls(f).length,0);assert.deepEqual(await readdir(root),[]);
 const missing=await initiallyOpenFixture(t,{handler:({entry,res})=>{
  if(entry.path!=='/h5/search')return false;res.end(JSON.stringify({code:200,result:{store_id:123,list:[]}}));return true;
 }});
 assert.equal((await boundary(missing,root).run(command)).pending,false);assert.equal(controls(missing).length,0);
});
test('query is available with live control disabled and never claims missing credentials as a verified read',async t=>{
 const f=await initiallyOpenFixture(t),root=await directory(t);
 assert.equal((await boundary(f,root,{env:{}}).run({...command,action:'query'})).code,'READ_OBSERVED');
 const noAuth=boundary(f,root,{credentialProvider:async()=>({})});
 assert.equal((await noAuth.run({...command,action:'query'})).code,'AUTH_REQUIRED');
 assert.equal(controls(f).length,0);
});
test('timeout after sent open remains durable UNKNOWN; restarted validation only queries',async t=>{
 const f=await initiallyOpenFixture(t,{clientOptions:{requestTimeoutMs:80},handler:({entry,state})=>{
  if(entry.path!=='/h5/mac_control')return false;
  state.status=1;state.opentime=entry.body.opentime;return true;
 }}),root=await directory(t);
 f.state.status=0;
 const first=await boundary(f,root).run({...command,action:'open',countdownSeconds:60,targetEndAt:deviceInput.targetEndAt});
 assert.equal(first.pending,true);assert.equal(first.code,'DEVICE_UNKNOWN');assert.equal(first.observation.room.open,true);
 const resumed=await boundary(f,root).run(command);
 assert.equal(resumed.workflowId,first.workflowId);assert.equal(resumed.observation.retrySafe,false);
 assert.equal(controls(f).length,1);
});
test('definite auth rejection stays distinct and never replays the device request',async t=>{
 const f=await initiallyOpenFixture(t,{handler:({entry,res})=>{
  if(entry.path!=='/h5/mac_control')return false;res.writeHead(401);res.end('provider secret detail');return true;
 }}),root=await directory(t);
 const first=await boundary(f,root).run(command);assert.equal(first.code,'AUTH_REQUIRED');assert.equal(first.pending,true);
 const resumed=await boundary(f,root).run(command);assert.equal(resumed.workflowId,first.workflowId);
 assert.equal(controls(f).length,1);
});
test('concurrent validation instances atomically claim at most one device mutation',async t=>{
 const f=await initiallyOpenFixture(t),root=await directory(t);
 const results=await Promise.allSettled([boundary(f,root).run(command),boundary(f,root).run(command)]);
 assert.equal(controls(f).length,1);
 for(const r of results)if(r.status==='rejected')assert.ok(['INVALID_PENDING_RECORD','JOURNAL_BUSY'].includes(r.reason.code));
 assert.equal((await boundary(f,root).run(command)).pending,false);assert.equal(controls(f).length,1);
});
test('corrupt durable record fails closed before auth and no repository journal is allowed',async t=>{
 const f=await initiallyOpenFixture(t),root=await directory(t);await boundary(f,root).run(command);
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
 const f=kind==='real'?await initiallyOpenFixture(t,{gatewayOptions:{enabled:true,mutationPolicy:()=>true}}):null;
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
 const f=await initiallyOpenFixture(t,{clientOptions:{requestTimeoutMs:80},gatewayOptions:{enabled:true,mutationPolicy:()=>true},handler:({entry,req})=>{if(entry.path!=='/h5/mac_control')return false;req.socket.destroy();return true;}});
 await f.gateway.closeRoom(deviceInput);
 await f.gateway.openRoom({...deviceInput,workflowId:'new-workflow',stepId:'new-step'});
 assert.equal(controls(f).length,1);
});

test('the durable UNKNOWN record exists before provider side effect; a fresh process can only query it',async t=>{
 const root=await directory(t);let journalBeforeEffect=false;
 const f=await initiallyOpenFixture(t,{clientOptions:{requestTimeoutMs:80},handler:async({entry})=>{
  if(entry.path==='/h5/mac_control'){
   const names=await readdir(root);
   journalBeforeEffect=names.length===1&&JSON.parse(await readFile(path.join(root,names[0]),'utf8')).status==='UNKNOWN';
   return true;
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
 const f=await initiallyOpenFixture(t,{handler:({entry,state,req})=>{
  if(entry.path!=='/h5/mac_control')return false;state.status=0;req.socket.destroy();return true;
 }}),root=await directory(t);
 const result=await boundary(f,root).run(command);assert.equal(result.code,'DEVICE_UNKNOWN');assert.equal(result.pending,true);
 await boundary(f,root).run(command);assert.equal(controls(f).length,1);
});

test('validation CLOSED skips close; explicit 300-second open then close uses only two controls',async t=>{
 const f=await providerFixture(t),root=await directory(t),b=boundary(f,root);
 const skipped=await b.run(command);
 assert.equal(skipped.code,'PRECONDITION_SATISFIED');assert.equal(skipped.mutationDispatched,false);assert.equal(skipped.settled,false);
 assert.equal(controls(f).length,0);
 const opened=await b.run({...command,action:'open',countdownSeconds:300,targetEndAt:deviceInput.targetEndAt});
 assert.equal(opened.code,'DESIRED_STATE_CONFIRMED');assert.equal(opened.pending,false);
 assert.equal(opened.evidence.kind,'ACKNOWLEDGED');assert.equal(opened.evidence.settled,false);
 assert.equal(opened.observation.room.observedCountdownValue,300);assert.equal(opened.observation.room.countdownUnit,'SECONDS');
 const closed=await b.run(command);assert.equal(closed.code,'DESIRED_STATE_CONFIRMED');assert.equal(closed.pending,false);
 assert.notEqual(opened.workflowId,closed.workflowId);
 assert.deepEqual(controls(f).map(c=>[c.body.status,c.body.opentime]),[[1,300],[0,undefined]]);
 const [name]=await readdir(root),journal=JSON.parse(await readFile(path.join(root,name),'utf8'));
 assert.ok(journal.history.some(r=>r.status==='PRECONDITION_SATISFIED'));
 assert.equal(JSON.stringify(journal).includes('APPLIED'),false);
});
test('close ACK with fresh CLOSED satisfies prerequisite; ACK alone with OPEN never repeats close',async t=>{
 const f=await initiallyOpenFixture(t,{handler:({entry,res})=>{
  if(entry.path!=='/h5/mac_control')return false;res.end(JSON.stringify({code:200}));return true;
 }}),root=await directory(t);
 const first=await boundary(f,root).run(command);assert.equal(first.code,'ACKNOWLEDGED');assert.equal(first.pending,true);
 for(let n=0;n<2;n++){
  const waiting=await boundary(f,root).run({...command,action:'open',countdownSeconds:300,targetEndAt:deviceInput.targetEndAt});
  assert.equal(waiting.code,'ACKNOWLEDGED');assert.equal(waiting.workflowId,first.workflowId);
 }
 assert.equal(controls(f).length,1);
 f.state.status=0;
 const confirmed=await boundary(f,root,{env:{}}).run({...command,action:'query'});
 assert.equal(confirmed.code,'DESIRED_STATE_CONFIRMED');assert.equal(confirmed.pending,false);
 assert.equal(confirmed.observation.settled,false);assert.equal(controls(f).length,1);
});
test('already OPEN validation cannot reset countdown by issuing another explicit open',async t=>{
 const f=await initiallyOpenFixture(t),root=await directory(t);
 const result=await boundary(f,root).run({...command,action:'open',countdownSeconds:300,targetEndAt:deviceInput.targetEndAt});
 assert.equal(result.code,'OPEN_PRECONDITION_NOT_SATISFIED');assert.equal(controls(f).length,0);
 assert.deepEqual(await readdir(root),[]);
});
test('ACK with failed read persists waiting state and recovers by query after restart',async t=>{
 let after=false;
 const f=await initiallyOpenFixture(t,{handler:({entry,res})=>{
  if(entry.path==='/h5/mac_control'){after=true;return false;}
  if(after&&entry.path==='/h5/search'){res.writeHead(500);res.end('{}');return true;}
  return false;
 }}),root=await directory(t);
 const first=await boundary(f,root).run(command);assert.equal(first.code,'ACKNOWLEDGED');assert.equal(first.pending,true);
 after=false;
 const resolved=await boundary(f,root).run({...command,action:'query'});
 assert.equal(resolved.code,'DESIRED_STATE_CONFIRMED');assert.equal(controls(f).length,1);
});
async function legacyArchive(t,{mutate=()=>{}}={}) {
 const root=await directory(t),workflowId=randomUUID();
 const key=createHash('sha256').update(JSON.stringify(['123','ktvsky','synthetic-device'])).digest('hex');
 const original={schemaVersion:1,scopeKey:key,workflowId,stepId:workflowId+':close',action:'close',status:'UNKNOWN'};
 const file=path.join(root,key+'.json');await writeFile(file,JSON.stringify(original));
 const archive={phase:'ONE_V06_CLOSE_THEN_QUERY',controlRequests:1,openExecuted:false,automaticMutationRetries:0,
  result:{workflowId},controlEvidence:{acknowledged:true,settled:false},
  events:[
   {category:'search',at:'2026-10-08T01:00:00Z',httpStatus:200,providerCode:200,targetMatches:1,observed:{alive:1,status:0}},
   {category:'control',at:'2026-10-08T01:00:01Z',httpStatus:200,providerCode:200,intent:{status:0,deviceSuffix:'vice'}},
   {category:'search',at:'2026-10-08T01:00:02Z',httpStatus:200,providerCode:200,targetMatches:1,observed:{alive:1,status:0}}
  ]};
 mutate(archive);
 const evidenceFile=path.join(root,'archive.json'),bytes=JSON.stringify(archive);
 await writeFile(evidenceFile,bytes);
 return {root,file,original,workflowId,evidenceFile,evidenceSha256:createHash('sha256').update(bytes).digest('hex')};
}
test('legacy UNKNOWN is query-only; formal archived ACK recovery preserves original and unverified causality',async t=>{
 const f=await providerFixture(t),a=await legacyArchive(t),b=boundary(f,a.root);
 const before=await readFile(a.file,'utf8');
 const blocked=await b.run({...command,action:'open',countdownSeconds:300,targetEndAt:deviceInput.targetEndAt});
 assert.equal(blocked.code,'DEVICE_UNKNOWN');assert.equal(controls(f).length,0);assert.equal(await readFile(a.file,'utf8'),before);
 const requests=f.requests.length;
 const result=await b.recoverAcknowledgedClose({...a,internalRoomId:command.internalRoomId});
 assert.equal(f.requests.length,requests,'offline recovery must make no provider requests');
 assert.equal(result.acknowledged,true);assert.equal(result.preExistingDesiredState,true);
 assert.equal(result.causalEffect,'UNVERIFIED');assert.equal(result.settled,false);
 const recovered=JSON.parse(await readFile(a.file,'utf8'));
 assert.deepEqual(recovered.history,[a.original]);assert.equal(recovered.evidenceSha256,a.evidenceSha256);
 const opened=await b.run({...command,action:'open',countdownSeconds:300,targetEndAt:deviceInput.targetEndAt});
 assert.notEqual(opened.workflowId,a.workflowId);assert.equal(controls(f).length,1);
 assert.equal(JSON.stringify(JSON.parse(await readFile(a.file,'utf8'))).includes('APPLIED'),false);
});
for(const [name,mutate]of [
 ['no ACK',a=>a.controlEvidence.acknowledged=false],
 ['control timeout',a=>a.events[1].timeout=true],
 ['connection loss',a=>a.events[1].disconnect=true],
 ['provider rejection',a=>a.events[1].providerCode=500],
 ['wrong workflow',a=>a.result.workflowId=randomUUID()],
 ['wrong device',a=>a.events[1].intent.deviceSuffix='else'],
 ['not pre-existing CLOSED',a=>a.events[0].observed.status=1],
 ['additional control',a=>a.events.push({...a.events[1]})],
 ['post read not CLOSED',a=>a.events[2].observed.status=1]
])test('legacy recovery rejects '+name+' and cannot bypass unresolved mutation',async t=>{
 const f=await providerFixture(t),a=await legacyArchive(t,{mutate}),b=boundary(f,a.root),before=await readFile(a.file,'utf8');
 await assert.rejects(b.recoverAcknowledgedClose({...a,internalRoomId:command.internalRoomId}),{code:'INVALID_RECOVERY_EVIDENCE'});
 assert.equal(await readFile(a.file,'utf8'),before);assert.equal(f.requests.length,0);
 const blocked=await b.run({...command,action:'open',countdownSeconds:300,targetEndAt:deviceInput.targetEndAt});
 assert.equal(blocked.code,'DEVICE_UNKNOWN');assert.equal(controls(f).length,0);
});
test('legacy recovery rejects hash mismatch and cannot reclassify new-schema genuine UNKNOWN',async t=>{
 const f=await providerFixture(t),a=await legacyArchive(t),b=boundary(f,a.root),before=await readFile(a.file,'utf8');
 await assert.rejects(b.recoverAcknowledgedClose({...a,internalRoomId:command.internalRoomId,evidenceSha256:'0'.repeat(64)}),{code:'INVALID_RECOVERY_EVIDENCE'});
 assert.equal(await readFile(a.file,'utf8'),before);
 await writeFile(a.file,JSON.stringify({...a.original,schemaVersion:2,history:[]}));
 await assert.rejects(b.recoverAcknowledgedClose({...a,internalRoomId:command.internalRoomId}),{code:'INVALID_RECOVERY_EVIDENCE'});
 assert.equal(f.requests.length,0);
});
test('abandoned journal write lock fails closed rather than expiring into a fresh mutation',async t=>{
 const f=await initiallyOpenFixture(t),root=await directory(t);
 const key=createHash('sha256').update(JSON.stringify(['123','ktvsky','synthetic-device'])).digest('hex');
 await writeFile(path.join(root,key+'.json.lock'),'');
 await assert.rejects(boundary(f,root).run(command),{code:'JOURNAL_BUSY'});
 assert.equal(controls(f).length,0);
});

test('partial terminal journal without ACK cannot authorize a new workflow',async t=>{
 const f=await providerFixture(t),a=await legacyArchive(t);
 await writeFile(a.file,JSON.stringify({...a.original,schemaVersion:2,status:'DESIRED_STATE_CONFIRMED',history:[a.original]}));
 await assert.rejects(boundary(f,a.root).run({...command,action:'open',countdownSeconds:300,targetEndAt:deviceInput.targetEndAt}),{code:'INVALID_PENDING_RECORD'});
 assert.equal(f.requests.length,0);
});


test('remaining countdown: 300 requested and 254 after 46 seconds confirms open',async t=>{
 let clock=at,dispatched=false;
 const f=await providerFixture(t,{handler:({entry,state})=>{
  if(entry.path==='/h5/mac_control')dispatched=true;
  if(entry.path==='/h5/search'&&dispatched){clock=at+46000;state.opentime=254;}
  return false;
 }});
 const result=await boundary(f,await directory(t),{now:()=>clock}).run({
  ...command,action:'open',countdownSeconds:300,targetEndAt:new Date(at+300000).toISOString()});
 assert.equal(result.code,'DESIRED_STATE_CONFIRMED');
 assert.equal(result.pending,false);assert.equal(controls(f).length,1);
});

async function remainingFixture(t,{elapsed=46,remaining=254,failRead=false}={}) {
 let clock=at,dispatched=false,unavailable=failRead;
 const f=await providerFixture(t,{handler:({entry,req})=>{
  if(entry.path==='/h5/mac_control')dispatched=true;
  if(dispatched&&entry.path==='/h5/search'){
   if(unavailable){req.socket.destroy();return true;}
   clock=at+elapsed*1000;f.state.opentime=remaining;
  }
  return false;
 }});
 const root=await directory(t),b=boundary(f,root,{now:()=>clock});
 const opened=await b.run({...command,action:'open',countdownSeconds:300,targetEndAt:new Date(at+300000).toISOString()});
 return {f,root,b,opened,set:(seconds,value)=>{elapsed=seconds;remaining=value;unavailable=false;},
  restart:()=>boundary(f,root,{now:()=>clock,env:{}}),
  record:async()=>JSON.parse(await readFile(path.join(root,(await readdir(root))[0]),'utf8'))};
}
test('valid remaining seconds settle the durable ACK and survive restart with original timing',async t=>{
 const a=await remainingFixture(t),j=await a.record();
 assert.equal(a.opened.code,'DESIRED_STATE_CONFIRMED');assert.equal(a.opened.pending,false);
 assert.equal(a.opened.mutationUnknown,false);assert.equal(a.opened.verificationPending,false);
 assert.equal(j.requestedCountdownSeconds,300);assert.equal(j.openObservation.remainingCountdownSeconds,254);
 assert.equal(j.sentAt,new Date(at).toISOString());assert.equal(j.openObservation.observedAt,new Date(at+46000).toISOString());
 assert.ok(j.history.some(r=>r.status==='ACKNOWLEDGED'));
 a.set(156.23,144);
 const next=await a.restart().run({...command,action:'query'});
 assert.equal(next.pending,false);assert.equal(next.workflowId,a.opened.workflowId);
 assert.equal(next.observation.room.remainingCountdownSeconds,144);
 assert.equal(next.openVerification.remainingCountdownSeconds,254,'historical confirmation is immutable');
 assert.equal(controls(a.f).length,1);
});
test('implausible twenty seconds immediately after 300-second ACK stays pending and blocks close',async t=>{
 const a=await remainingFixture(t,{elapsed:1,remaining:20});
 assert.equal(a.opened.code,'ACKNOWLEDGED');assert.equal(a.opened.verificationPending,true);
 assert.equal(a.opened.verificationStatus,'COUNTDOWN_INCONSISTENT');
 assert.equal((await a.record()).status,'ACKNOWLEDGED');
 const blocked=await a.b.run(command);assert.equal(blocked.pending,true);
 assert.equal(controls(a.f).length,1);
});
test('open ACK then query failure is verification pending, not mutation UNKNOWN; recovery is query only',async t=>{
 const a=await remainingFixture(t,{failRead:true});
 assert.equal(a.opened.code,'ACKNOWLEDGED');assert.equal(a.opened.mutationUnknown,false);
 assert.equal(a.opened.verificationPending,true);assert.equal(a.opened.verificationStatus,'QUERY_UNAVAILABLE');
 assert.equal(a.opened.observation.kind,'UNKNOWN');assert.equal(controls(a.f).length,1);
 a.set(46,254);
 // Even a close request resumes the old pending query, never dispatches close.
 const recovered=await a.restart().run(command);
 assert.equal(recovered.workflowId,a.opened.workflowId);assert.equal(recovered.code,'DESIRED_STATE_CONFIRMED');
 assert.equal(recovered.pending,false);assert.equal(controls(a.f).length,1);
});
test('expiry read CLOSED cannot erase a previously confirmed open',async t=>{
 const a=await remainingFixture(t),before=await a.record();
 a.set(464,0);a.f.state.status=0;
 const after=await a.restart().run({...command,action:'query'});
 assert.equal(after.observation.room.open,false);assert.equal(after.observation.room.remainingCountdownSeconds,0);
 assert.equal(after.pending,false);assert.equal(after.mutationUnknown,false);
 assert.equal(after.verificationStatus,'DESIRED_STATE_CONFIRMED');
 assert.deepEqual(await a.record(),before);assert.deepEqual(after.openVerification,a.opened.openVerification);
 assert.equal(controls(a.f).length,1);
});
test('expiry CLOSED without earlier valid open evidence never confirms the open',async t=>{
 const a=await remainingFixture(t,{elapsed:1,remaining:20});
 a.set(464,0);a.f.state.status=0;
 const after=await a.restart().run({...command,action:'query'});
 assert.equal(after.pending,true);assert.equal(after.code,'ACKNOWLEDGED');
 assert.equal(after.openVerification,undefined);assert.equal(controls(a.f).length,1);
});
test('legacy ACK without send timing stays query-only instead of guessing a verification timestamp',async t=>{
 const a=await remainingFixture(t,{elapsed:1,remaining:20}),files=await readdir(a.root);
 const j=await a.record();delete j.sentAt;delete j.acknowledgedAt;delete j.requestedCountdownSeconds;
 await writeFile(path.join(a.root,files[0]),JSON.stringify(j));
 a.set(46,254);
 const next=await a.restart().run(command);
 assert.equal(next.verificationStatus,'TIMING_EVIDENCE_REQUIRED');assert.equal(next.pending,true);
 assert.equal(controls(a.f).length,1);
});


async function archivedRemaining(t,mutate=()=>{}) {
 const a=await remainingFixture(t,{elapsed:1,remaining:20}),files=await readdir(a.root),file=path.join(a.root,files[0]);
 const original=await a.record();delete original.sentAt;delete original.acknowledgedAt;delete original.requestedCountdownSeconds;
 await writeFile(file,JSON.stringify(original));
 const atSeconds=n=>new Date(at+n*1000).toISOString();
 const read=(n,value)=>({controlRequests:0,result:{workflowId:original.workflowId},events:[{
  category:'search',at:atSeconds(n),elapsedMs:0,httpStatus:200,providerCode:200,storeMatches:true,targetMatches:1,
  observed:{alive:1,status:1,opentime:value}}]});
 const report={safeTarget:{internalRoomId:command.internalRoomId},live:{phase:'V06_SECOND_SAFE_LIVE_VALIDATION',
  initiallyClosed:true,controlRequests:1,automaticMutationRetries:0,steps:[{label:'open-with-countdown',workflowId:original.workflowId,
   controlEvidence:{kind:'ACKNOWLEDGED',acknowledged:true}}],events:[
   {category:'search',at:atSeconds(-1),elapsedMs:0,httpStatus:200,providerCode:200,storeMatches:true,targetMatches:1,observed:{alive:1,status:0,opentime:0}},
   {category:'control',at:atSeconds(0),elapsedMs:0,httpStatus:200,providerCode:200,
    intent:{status:1,internalRoomId:command.internalRoomId,deviceSuffix:'vice',countdownSeconds:300,opentime:300}}
  ]},recoveryQuery:read(46,254),countdownQuery:read(156.23,144)};
 mutate(report);
 const evidenceFile=path.join(a.root,'reviewed-archive.json'),bytes=JSON.stringify(report);await writeFile(evidenceFile,bytes);
 const c=config();c.safeTarget.approvedAt=atSeconds(199);c.safeTarget.expiresAt=atSeconds(260);
 const b=boundary(a.f,a.root,{config:c,now:()=>at+200000});
 return {...a,b,file,original,evidenceFile,evidenceSha256:createHash('sha256').update(bytes).digest('hex')};
}
test('offline archived remaining-countdown recovery preserves the old ACK and never calls provider',async t=>{
 const a=await archivedRemaining(t),beforeRequests=a.f.requests.length;
 const result=await a.b.recoverAcknowledgedOpen({...a,internalRoomId:command.internalRoomId,workflowId:a.original.workflowId});
 assert.equal(result.code,'DESIRED_STATE_CONFIRMED');assert.equal(result.pending,false);
 const journal=JSON.parse(await readFile(a.file,'utf8'));
 assert.deepEqual(journal.history.at(-1),Object.fromEntries(Object.entries(a.original).filter(([k])=>k!=='history')));
 assert.equal(journal.openObservation.remainingCountdownSeconds,144);assert.equal(journal.evidenceSha256,a.evidenceSha256);
 assert.equal(a.f.requests.length,beforeRequests);assert.equal(controls(a.f).length,1);
});
for(const [name,mutate] of [
 ['no ACK',r=>r.live.steps[0].controlEvidence.acknowledged=false],
 ['mutation timeout',r=>r.live.events[1].failure='REQUEST_TIMEOUT'],
 ['wrong workflow',r=>r.countdownQuery.result.workflowId=randomUUID()],
 ['wrong room',r=>r.live.events[1].intent.internalRoomId='other-room'],
 ['wrong device',r=>r.live.events[1].intent.deviceSuffix='else'],
 ['duplicate control',r=>r.live.events.push({...r.live.events[1]})],
 ['not originally closed',r=>r.live.events[0].observed.status=1],
 ['inconsistent remaining',r=>r.recoveryQuery.events[0].observed.opentime=20],
 ['increasing remaining',r=>r.countdownQuery.events[0].observed.opentime=255],
 ['query not scoped',r=>r.countdownQuery.events[0].storeMatches=false],
 ['future observation',r=>{r.countdownQuery.events[0].at=new Date(at+210000).toISOString();r.countdownQuery.events[0].observed.opentime=90;}],
 ['invalid control time',r=>r.live.events[1].at='invalid'],
 ['malformed step list',r=>r.live.steps={}],
 ['malformed read list',r=>r.recoveryQuery.events={}]
])test('archived open recovery rejects '+name+' without HTTP or journal changes',async t=>{
 const a=await archivedRemaining(t,mutate),before=await readFile(a.file,'utf8'),requests=a.f.requests.length;
 await assert.rejects(a.b.recoverAcknowledgedOpen({...a,internalRoomId:command.internalRoomId,workflowId:a.original.workflowId}),{code:'INVALID_RECOVERY_EVIDENCE'});
 assert.equal(await readFile(a.file,'utf8'),before);assert.equal(a.f.requests.length,requests);
});
test('archived open recovery cannot clear true mutation UNKNOWN or a different digest',async t=>{
 const a=await archivedRemaining(t),requests=a.f.requests.length;
 await assert.rejects(a.b.recoverAcknowledgedOpen({...a,internalRoomId:command.internalRoomId,workflowId:a.original.workflowId,
  evidenceSha256:'0'.repeat(64)}),{code:'INVALID_RECOVERY_EVIDENCE'});
 const unknown={...a.original,status:'UNKNOWN'};delete unknown.acknowledged;
 await writeFile(a.file,JSON.stringify(unknown));
 await assert.rejects(a.b.recoverAcknowledgedOpen({...a,internalRoomId:command.internalRoomId,workflowId:a.original.workflowId}),{code:'INVALID_RECOVERY_EVIDENCE'});
 assert.deepEqual(JSON.parse(await readFile(a.file,'utf8')),unknown);assert.equal(a.f.requests.length,requests);
});
test('a new timed terminal record missing its open observation fails closed',async t=>{
 const a=await remainingFixture(t),files=await readdir(a.root),journal=await a.record();delete journal.openObservation;
 await writeFile(path.join(a.root,files[0]),JSON.stringify(journal));
 await assert.rejects(a.restart().run(command),{code:'INVALID_PENDING_RECORD'});
 assert.equal(controls(a.f).length,1);
});
