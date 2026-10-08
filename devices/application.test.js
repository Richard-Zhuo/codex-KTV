import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../rules.js';
import { businessSessionFor } from '../shared/business-session.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createRoomControlApplication } from './application.js';
import { FakeKtvRoomControlGateway } from './fake-gateway.js';
import { KtvSkyRoomControlGateway } from './gateway.js';
import { createRoomDeviceMappings } from './mapping.js';
function fixture({online=true,open=true,outcomes={}}={}) {
 let clock='2026-10-08T07:00:00.000000Z',active=false,failWrite=false;
 const head={revision:1,state:initialState()},records=new Map();
 head.state.rooms[0].order='order-1';head.state.rooms[0].status='营业中';
 head.state.orders=[{id:'order-1',kind:'room',room:'V01',status:'营业中',businessSession:businessSessionFor(clock,{timeZone:'Asia/Shanghai'})}];
 const digest=Buffer.alloc(32,10),auth={enabled:true,revoked:false,version:1,sessionVersion:1,grants:['room.open'],actor:'synthetic-device-actor'};
 const port={locateSessionByDigest:async()=>({principalId:auth.actor,sessionId:'device-session'}),
  lockAccount:async()=>({principalId:auth.actor,enabled:auth.enabled,credentialVersion:auth.version,policyAttributesConfigured:false}),
  lockSessionById:async()=>({principalId:auth.actor,sessionId:'device-session',tokenDigest:digest,revoked:auth.revoked,
   credentialVersion:auth.sessionVersion,idleExpiresAt:'2099-01-01T00:00:00.000000Z',absoluteExpiresAt:'2099-01-02T00:00:00.000000Z'}),
  listGrants:async()=>auth.grants,listPolicyAttributes:async()=>[],readDbNow:async()=>clock};
 let tail=Promise.resolve();
 const store={ledgerId:'device-unit',testOnly:true,runAtomic(work){
  const run=tail.then(async()=>{
   active=true;const before=structuredClone(records);
   try{return await work({readHead:async()=>structuredClone(head),readDbNow:async()=>clock,
    sessionRevalidation:{revalidateSessionInTransaction:credential=>revalidateSessionInTransaction({port,...credential})},
    get:async id=>structuredClone(records.get(id)??null),
    findByOrder:async id=>structuredClone([...records.values()].find(r=>r.orderId===id)??null),
    findByOperation:async key=>structuredClone([...records.values()].find(r=>r.operationKey===key)??null),
    write:async(record,version)=>{if(failWrite){failWrite=false;throw Error('synthetic SQL failure');}
      assert.equal(records.get(record.id)?.version,version);records.set(record.id,structuredClone(record));}});
   }catch(e){records.clear();for(const [id,row]of before)records.set(id,row);throw e;}finally{active=false;}
  });tail=run.catch(()=>{});return run;
 }};
 const gateway=new FakeKtvRoomControlGateway({online,open,outcomes});
 const invoke=gateway.invoke.bind(gateway);gateway.invoke=(...args)=>{assert.equal(active,false,'external call must not hold a transaction');return invoke(...args);};
 const mappings=[{internalRoomId:'V01',provider:'fake',externalDeviceId:'synthetic-device-1',enabled:true}];
 const app=createRoomControlApplication({store,gateway,mappings,allowTestGateway:true,timeoutMs:20,leaseMs:1000});
 const command={operationKey:'device-open',expectedRevision:1,payload:{orderId:'order-1'}},credential={tokenDigest:digest};
 return {app,store,gateway,mappings,head,records,auth,command,credential,setClock:value=>{clock=value;},failNextWrite:()=>{failWrite=true;}};
}
const start=f=>f.app.start(f.command,f.credential);
const advance=(f,r)=>f.app.advance(r.id,f.credential);
async function finish(f,r){for(let n=0;n<7&&r.status!=='ACTIVE';n++)r=await advance(f,r);return r;}
const mutations=f=>f.gateway.calls.filter(c=>['closeRoom','openRoom'].includes(c.method));

test('online close/open-with-countdown/verify becomes ACTIVE, uses trusted DAY target, never changes ledger',async()=>{
 const f=fixture(),before=structuredClone(f.head);let r=await start(f);assert.equal(r.roomReadiness,'OPENING');
 r=await finish(f,r);assert.equal(r.status,'ACTIVE');assert.equal(r.roomReadiness,'ACTIVE');
 assert.deepEqual(mutations(f).map(c=>c.method),['closeRoom','openRoom']);
 assert.equal(mutations(f).at(-1).targetEndAt,'2026-10-08T10:00:00.000Z');assert.equal(mutations(f).at(-1).durationMinutes,180);assert.equal(mutations(f).at(-1).countdownSeconds,10800);
 assert.deepEqual(f.head,before);assert.equal(f.records.size,1);
 const beforeCalls=f.gateway.calls.length;await advance(f,r);assert.equal(f.gateway.calls.length,beforeCalls);
});
test('offline waits, comes online and continues same workflow without a new local opening',async()=>{
 const f=fixture({online:false});let r=await start(f);r=await advance(f,r);
 assert.equal(r.status,'DEVICE_OFFLINE_WAIT');assert.equal(r.roomReadiness,'WAITING_DEVICE');assert.equal(mutations(f).length,0);
 const original=r.id;f.gateway.room.online=true;r=await finish(f,r);
 assert.equal(r.id,original);assert.equal(r.status,'ACTIVE');assert.equal(f.records.size,1);assert.equal(f.head.revision,1);
});
for(const method of ['closeRoom','openRoom'])test(method+' timeout after applied requires query, recovers without repeating mutation',async()=>{
 const f=fixture({outcomes:{[method]:async(input,gateway,normal)=>{normal();throw Error('synthetic timeout after effect');}}});
 let r=await start(f);for(let n=0;n<5&&r.status!=='DEVICE_UNKNOWN';n++)r=await advance(f,r);
 assert.equal(r.status,'DEVICE_UNKNOWN');const calls=mutations(f).length;r=await advance(f,r);
 assert.ok(f.gateway.calls.some(c=>c.method==='queryRoomState'));assert.equal(mutations(f).length,calls);
 r=await finish(f,r);assert.equal(r.status,'ACTIVE');assert.equal(mutations(f).filter(c=>c.method===method).length,1);
});
test('ambiguous timeout without provider proof stays UNKNOWN; no blind close/open retry',async()=>{
 const f=fixture({outcomes:{closeRoom:()=>new Promise(()=>{})}});let r=await start(f);r=await advance(f,r);r=await advance(f,r);
 assert.equal(r.status,'DEVICE_UNKNOWN');for(let n=0;n<3;n++)r=await advance(f,r);
 assert.equal(r.status,'DEVICE_UNKNOWN');assert.equal(mutations(f).length,1);
});
test('definitive settled NOT_APPLIED permits safe continuation only after query',async()=>{
 const f=fixture({outcomes:{closeRoom:[Error('timeout')],queryRoomState:(input,g)=>g.evidence(input,{stepResult:'NOT_APPLIED',settled:true,retrySafe:true})}});
 let r=await start(f);r=await advance(f,r);r=await advance(f,r);assert.equal(r.status,'DEVICE_UNKNOWN');
 r=await advance(f,r);assert.equal(r.status,'DEVICE_CLOSING');assert.equal(mutations(f).length,1);
 delete f.gateway.outcomes.queryRoomState;r=await finish(f,r);assert.equal(r.status,'ACTIVE');
 assert.equal(mutations(f).filter(c=>c.method==='closeRoom').length,2);
});
test('same key returns same workflow; different request/actor/key for same order conflicts',async()=>{
 const f=fixture(),r=await start(f);assert.equal((await start(f)).id,r.id);
 assert.equal((await f.app.start({...f.command,expectedRevision:0},f.credential)).status,'idempotency-conflict');
 assert.equal((await f.app.start({...f.command,operationKey:'different'},f.credential)).status,'idempotency-conflict');
 f.auth.actor='other-actor';assert.equal((await start(f)).status,'idempotency-conflict');
 assert.equal(f.records.size,1);assert.equal(mutations(f).length,0);
});
test('client countdown, room, plan or identity fields are not accepted; stale revision does not claim',async()=>{
 const f=fixture();for(const key of ['room','durationMinutes','targetEndAt','sessionType','pricePlanId','principal'])
 await assert.rejects(f.app.start({...f.command,payload:{...f.command.payload,[key]:'forged'}},f.credential));
 assert.equal((await f.app.start({...f.command,expectedRevision:0},f.credential)).status,'revision-conflict');assert.equal(f.records.size,0);
});
test('every claim reloads existing auth; revoke/disable/credential invalidation/removal cannot dispatch',async()=>{
 for(const mutate of [f=>f.auth.revoked=true,f=>f.auth.enabled=false,f=>f.auth.version++,f=>f.auth.grants=[]]){
  const f=fixture(),r=await start(f);mutate(f);await assert.rejects(advance(f,r));assert.equal(f.gateway.calls.length,0);
 }
});
test('in-flight concurrent advance sends one request; expired crash claim queries before moving on',async()=>{
 let release;const wait=new Promise(resolve=>release=resolve);
 const f=fixture({outcomes:{getRoomStatus:async(input,g,normal)=>{await wait;return normal();}}});
 let r=await start(f);const running=advance(f,r);await new Promise(resolve=>setTimeout(resolve,1));
 await advance(f,r);release();r=await running;assert.equal(f.gateway.calls.filter(c=>c.method==='getRoomStatus').length,1);
 delete f.gateway.outcomes.getRoomStatus;
 f.gateway.outcomes.closeRoom=(input,g,normal)=>{const result=normal();f.failNextWrite();return result;};
 await assert.rejects(advance(f,r),/SQL/);const count=mutations(f).length;await advance(f,r);assert.equal(mutations(f).length,count);
 f.setClock('2026-10-08T07:00:02.000000Z');r=await advance(f,r);
 assert.equal(r.status,'DEVICE_OPENING');assert.equal(mutations(f).length,count);
});
test('definitive failure, scoped evidence, verification mismatch and expired session fail safely',async()=>{
 const f=fixture({outcomes:{closeRoom:(input,g)=>g.evidence(input,{kind:'FAILED',settled:true})}});let r=await start(f);r=await advance(f,r);r=await advance(f,r);assert.equal(r.status,'DEVICE_FAILED');
 const other=fixture({outcomes:{closeRoom:(input,g)=>({...g.evidence(input,{kind:'APPLIED',settled:true}),externalDeviceId:'wrong-device'})}});
 r=await start(other);r=await advance(other,r);r=await advance(other,r);assert.equal(r.status,'DEVICE_UNKNOWN');
 const expired=fixture();r=await start(expired);expired.setClock('2026-10-08T10:00:00.000000Z');r=await advance(expired,r);assert.equal(r.status,'DEVICE_FAILED');assert.equal(expired.gateway.calls.length,0);
 const verify=fixture();r=await start(verify);for(let n=0;n<3;n++)r=await advance(verify,r);verify.gateway.room.countdownTargetEndAt=null;r=await advance(verify,r);assert.equal(r.status,'DEVICE_UNKNOWN');
});
test('provider diagnostics/secrets are not persisted; mapping is stable and production adapter disabled',async()=>{
 const f=fixture({outcomes:{closeRoom:(input,g)=>g.evidence(input,{kind:'UNKNOWN',password:'do-not-save',cookie:'do-not-save',stack:'do-not-save'})}});
 let r=await start(f);r=await advance(f,r);r=await advance(f,r);assert.equal(JSON.stringify(r).includes('do-not-save'),false);
 assert.throws(()=>createRoomDeviceMappings([...f.mappings,{...f.mappings[0],internalRoomId:'V02'}]));
 assert.throws(()=>createRoomDeviceMappings([{...f.mappings[0],enabled:'true'}]));
 assert.throws(()=>createRoomControlApplication({store:f.store,gateway:f.gateway,mappings:f.mappings}),/test mode/);
 const disabled=createRoomControlApplication({store:f.store,gateway:new KtvSkyRoomControlGateway(),mappings:f.mappings});
 await assert.rejects(disabled.start(f.command,f.credential),/not enabled/);
});

test('late preflight response after timeout cannot dispatch an unclaimed mutation',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);
 const f=fixture();let r=await start(f);r=await advance(f,r);assert.equal(r.step,'CLOSE');
 f.gateway.outcomes.getRoomStatus=async(input,g,normal)=>{await pending;return normal();};
 r=await advance(f,r);assert.equal(r.status,'DEVICE_UNKNOWN');release();await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(mutations(f).length,0);
});

test('OPEN is a combined capability; the gateway has no independent timer requirement',async()=>{
 const f=fixture();assert.equal(typeof f.gateway.setCountdown,'undefined');
 const r=await finish(f,await start(f));assert.equal(r.status,'ACTIVE');
 assert.equal(r.events.some(e=>e.step==='TIMER' || e.status==='DEVICE_TIMER_SETTING'),false);
 assert.equal(f.gateway.room.countdownTargetEndAt,r.businessSession.targetEndAt);
});
test('open acknowledgement without the desired countdown remains UNKNOWN',async()=>{
 const f=fixture({outcomes:{openRoom:(input,g)=>{g.room.open=true;return g.evidence(input,{kind:'APPLIED',settled:true});}}});
 let r=await start(f);for(let n=0;n<3;n++)r=await advance(f,r);
 assert.equal(r.status,'DEVICE_UNKNOWN');assert.equal(r.step,'OPEN');
 r=await advance(f,r);assert.equal(r.status,'DEVICE_UNKNOWN');
 assert.equal(mutations(f).filter(c=>c.method==='openRoom').length,1);
});
test('open timeout and matching current state without settled step proof never replays',async()=>{
 const f=fixture({outcomes:{openRoom:()=>new Promise(()=>{})}});
 let r=await start(f);for(let n=0;n<3;n++)r=await advance(f,r);
 f.gateway.room.open=true;f.gateway.room.countdownTargetEndAt=r.businessSession.targetEndAt;
 for(let n=0;n<3;n++)r=await advance(f,r);
 assert.equal(r.status,'DEVICE_UNKNOWN');assert.equal(r.step,'OPEN');
 assert.equal(mutations(f).filter(c=>c.method==='openRoom').length,1);
});
test('open retries only after scoped settled NOT_APPLIED and explicit retrySafe',async()=>{
 const f=fixture({outcomes:{openRoom:[Error('timeout')]}});
 let r=await start(f);for(let n=0;n<3;n++)r=await advance(f,r);
 f.gateway.outcomes.queryRoomState=(input,g)=>g.evidence(input,{stepResult:'NOT_APPLIED',settled:true});
 r=await advance(f,r);assert.equal(r.status,'DEVICE_UNKNOWN');
 f.gateway.outcomes.queryRoomState=(input,g)=>g.evidence(input,{stepResult:'NOT_APPLIED',settled:true,retrySafe:true});
 r=await advance(f,r);assert.equal(r.status,'DEVICE_OPENING');
 assert.equal(mutations(f).filter(c=>c.method==='openRoom').length,1);
 delete f.gateway.outcomes.queryRoomState;r=await finish(f,r);
 assert.equal(r.status,'ACTIVE');assert.equal(mutations(f).filter(c=>c.method==='openRoom').length,2);
});
test('expired open lease queries without re-dispatch; late completion is fenced',async()=>{
 let release;const wait=new Promise(resolve=>release=resolve);
 const f=fixture({outcomes:{openRoom:async(input,g,normal)=>{await wait;return normal();}}});
 let r=await start(f);r=await advance(f,r);r=await advance(f,r);
 const pending=advance(f,r);await new Promise(resolve=>setTimeout(resolve,1));
 await advance(f,r);assert.equal(mutations(f).filter(c=>c.method==='openRoom').length,1);
 f.setClock('2026-10-08T07:00:02.000000Z');
 const queried=await advance(f,r);assert.equal(queried.status,'DEVICE_UNKNOWN');
 release();await pending;
 const current=await f.app.get(r.id,f.credential);
 assert.equal(current.version,queried.version);assert.equal(current.status,'DEVICE_UNKNOWN');
 r=await advance(f,current);assert.equal(r.status,'DEVICE_VERIFYING');
 r=await advance(f,r);assert.equal(r.status,'ACTIVE');
 assert.equal(mutations(f).filter(c=>c.method==='openRoom').length,1);
 assert.equal(f.head.revision,1);assert.equal(f.head.state.orders.length,1);
});

test('initial CLOSED satisfies close prerequisite without a provider mutation',async()=>{
 const f=fixture({open:false});let r=await start(f);r=await advance(f,r);
 assert.equal(r.step,'OPEN');assert.equal(r.status,'DEVICE_OPENING');assert.equal(mutations(f).length,0);
 assert.deepEqual(r.closePrerequisite,{kind:'PRECONDITION_SATISFIED',mutationDispatched:false,settled:false});
 assert.equal(r.lastEvidence.stepResult,'UNKNOWN');assert.equal(r.lastEvidence.kind,'STATE');
 r=await finish(f,r);assert.equal(r.status,'ACTIVE');assert.deepEqual(mutations(f).map(c=>c.method),['openRoom']);
});
test('CLOSE preflight rechecks CLOSED and skips a redundant mutation after STATUS',async()=>{
 const f=fixture();let r=await start(f);r=await advance(f,r);assert.equal(r.step,'CLOSE');
 f.gateway.room.open=false;r=await advance(f,r);
 assert.equal(r.step,'OPEN');assert.equal(r.lastEvidence.kind,'PRECONDITION_SATISFIED');assert.equal(mutations(f).length,0);
});
test('OPEN then close ACK requires a fresh CLOSED query, not ACK as APPLIED',async()=>{
 const f=fixture({outcomes:{closeRoom:(input,g)=>{g.room.open=false;return g.evidence(input,{kind:'ACKNOWLEDGED',acknowledged:true,settled:false});}}});
 let r=await start(f);r=await advance(f,r);r=await advance(f,r);
 assert.equal(r.step,'CLOSE');assert.equal(r.status,'DEVICE_VERIFYING');assert.equal(r.uncertain,false);assert.equal(r.closeAcknowledged,true);
 assert.equal(r.closePrerequisite,null);assert.equal(mutations(f).length,1);
 r=await advance(f,r);assert.equal(r.step,'OPEN');
 assert.deepEqual(r.closePrerequisite,{kind:'DESIRED_STATE_CONFIRMED',mutationDispatched:true,acknowledged:true,settled:false,causalEffect:'UNVERIFIED'});
 assert.equal(mutations(f).length,1);assert.equal(f.gateway.calls.at(-1).method,'queryRoomState');
});
test('OPEN then close ACK with OPEN, offline or invalid reads stays query-only across lease recovery',async()=>{
 const f=fixture({outcomes:{closeRoom:(input,g)=>g.evidence(input,{kind:'ACKNOWLEDGED',acknowledged:true,settled:false})}});
 let r=await start(f);r=await advance(f,r);r=await advance(f,r);
 for(let n=0;n<2;n++)r=await advance(f,r);
 assert.equal(r.status,'DEVICE_VERIFYING');assert.equal(r.step,'CLOSE');assert.equal(r.uncertain,false);
 f.gateway.room.online=false;r=await advance(f,r);assert.equal(r.status,'DEVICE_OFFLINE_WAIT');assert.equal(r.closeAcknowledged,true);
 f.gateway.room.online=true;
 f.gateway.outcomes.queryRoomState=()=>({kind:'UNKNOWN'});
 r=await advance(f,r);assert.equal(r.status,'DEVICE_VERIFYING');
 f.records.get(r.id).inFlight={attemptId:'abandoned-query',until:'2026-10-08T06:00:00Z'};
 r=await advance(f,r);assert.equal(r.status,'DEVICE_VERIFYING');
 assert.equal(mutations(f).length,1);assert.equal(mutations(f)[0].method,'closeRoom');
 delete f.gateway.outcomes.queryRoomState;f.gateway.room.open=false;r=await advance(f,r);assert.equal(r.step,'OPEN');
 assert.equal(mutations(f).length,1);
});
test('close response lost and plain CLOSED read remains UNKNOWN without ACK or settled proof',async()=>{
 const f=fixture({outcomes:{closeRoom:()=>{f.gateway.room.open=false;throw Error('connection reset');}}});
 let r=await start(f);r=await advance(f,r);r=await advance(f,r);assert.equal(r.status,'DEVICE_UNKNOWN');
 for(let n=0;n<3;n++)r=await advance(f,r);
 assert.equal(r.status,'DEVICE_UNKNOWN');assert.equal(r.uncertain,true);assert.equal(r.closeAcknowledged,false);
 assert.equal(r.step,'CLOSE');assert.equal(mutations(f).length,1);assert.equal(r.closePrerequisite,null);
});

test('open ACK remains verifying until matching countdown state, without repeating the mutation',async()=>{
 const f=fixture({open:false,outcomes:{openRoom:(input,g)=>{g.room.open=true;return g.evidence(input,{kind:'ACKNOWLEDGED',acknowledged:true,settled:false});}}});
 let r=await start(f);r=await advance(f,r);r=await advance(f,r);
 assert.equal(r.status,'DEVICE_VERIFYING');assert.equal(r.step,'OPEN');assert.equal(r.openAcknowledged,true);assert.equal(r.uncertain,false);
 r=await advance(f,r);assert.equal(r.step,'OPEN');assert.equal(r.status,'DEVICE_VERIFYING');
 f.gateway.room.countdownTargetEndAt=r.businessSession.targetEndAt;
 r=await advance(f,r);assert.equal(r.step,'VERIFY');r=await advance(f,r);assert.equal(r.status,'ACTIVE');
 assert.deepEqual(mutations(f).map(c=>c.method),['openRoom']);
});
