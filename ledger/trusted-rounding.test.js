import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { paymentPrincipalId as principalId, otherPaymentPrincipalId as otherPrincipalId, paymentDbNow as dbNow } from '../test-support/trusted-payments-fixture.js';
import { settleCommand, roundingCommand, seedPendingRounding, seedTrustedPayments, paymentOrder } from '../test-support/trusted-rounding-fixture.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { settleOrder, decideRounding, outstanding } from '../sales.js';

const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
function fixture({ permissions = ['payment.collect', 'payment.settle'], prepare = () => {}, execute = transact, bind = true, attributes = null } = {}) {
  const state = initialState(); state.user = 'unmapped-demo-user'; state.clock = 'invalid-demo-clock';
  state.permissions = { administrator: ['管理员'] }; state.capabilities = { administrator: ['*'] }; state.administrator = true;
  state.orders = [{ id: 'historical-retail', kind: 'retail', room: null,
    sales: [{ productNameSnapshot: null, pricePerSaleUnitCents: null, baseQuantityPerSaleUnit: 12, totalBaseQuantity: 24 }],
    payments: [{ method: '现金', amount: 10 }, { method: '微信', amount: 20 }] }];
  seedTrustedPayments(state); prepare(state);
  const memory = createMemoryLedgerStore(state, { ledgerId: 'rounding-unit' }), digest = Buffer.alloc(32, 23);
  const auth = { id: principalId, permissions, attributes, enabled: true, revoked: false, version: 1, sessionVersion: 1,
    idle: '2099-01-01T00:00:00.000000Z', absolute: '2099-01-02T00:00:00.000000Z' };
  const port = {
    locateSessionByDigest: async () => ({ principalId: auth.id, sessionId: 'synthetic-payments-session' }),
    lockAccount: async () => ({ principalId: auth.id, enabled: auth.enabled, credentialVersion: auth.version, policyAttributesConfigured: auth.attributes !== null }),
    lockSessionById: async () => ({ principalId: auth.id, sessionId: 'synthetic-payments-session', tokenDigest: digest,
      revoked: auth.revoked, credentialVersion: auth.sessionVersion, idleExpiresAt: auth.idle, absoluteExpiresAt: auth.absolute }),
    listGrants: async () => auth.permissions, listPolicyAttributes: async () => auth.attributes ?? [], readDbNow: async () => dbNow
  };
  let context, executions = 0;
  const store = { ledgerId: memory.ledgerId, runAtomic: work => memory.runAtomic(tx => {
    if (bind) tx.sessionRevalidation = { revalidateSessionInTransaction: async credential => {
      context = await revalidateSessionInTransaction({ port, ...credential }); return context;
    } };
    return work(tx);
  }) };
  const app = createTrustedLedgerApplication({ store, transactCommand: (...args) => { executions++; return execute(...args); } });
  return { state, memory, app, auth, credential: { tokenDigest: digest }, context: () => context, executions: () => executions };
}
async function noEffects(f) {
  const head = await f.memory.read(); assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0);
  assert.equal(head.operationResults.size, 0); assert.equal(head.audit.length, 0);
}
test('settle: session actor, frozen payment facts, pending review and occupied room commit atomically', async () => {
  const f=fixture(), result=await f.app.execute(settleCommand(),f.credential), head=await f.memory.read(), order=paymentOrder(head.state);
  assert.equal(result.status,'committed'); assert.equal(head.revision,1); assert.equal(result.actorId,principalId);
  assert.equal(order.payments.length,3); assert.equal(new Set(order.payments.slice(1).map(p=>p.paymentId)).size,2);
  for(const p of order.payments.slice(1)){assert.match(p.paymentId,/^[0-9a-f-]{36}$/);assert.equal(p.occurredAt,dbNow);assert.equal(p.recordedByPrincipalId,principalId);assert.equal(p.person,null);}
  assert.equal(order.rounding,1001); assert.equal(order.roundingReview.status,'待审核');
  assert.equal(order.roundingReview.submittedByPrincipalId,principalId); assert.equal(order.roundingReview.submittedAt,dbNow);
  assert.equal(order.status,'营业中'); assert.equal(head.state.rooms[0].status,'营业中'); assert.equal(head.state.rooms[0].order,order.id); assert.equal(outstanding(order),1001);
  assert.equal(head.operationResults.size,1); assert.equal(head.audit.length,1);
});

for(const action of ['approveRounding','rejectRounding']) test(action+': locked applicant plus self-review, frozen decision actor/time, effective approval and unchanged payments',async()=>{
  const f=fixture({permissions:['rounding.approve','review.self'],attributes:action==='approveRounding'?['rounding.self.excess']:null,
    prepare:state=>seedPendingRounding(state)}),cmd=roundingCommand(action,'decide',0,{submittedByPrincipalId:otherPrincipalId,selfReview:false,approver:'fake'});
  const result=await f.app.execute(cmd,f.credential),head=await f.memory.read(),order=paymentOrder(head.state);
  assert.equal(result.status,'committed');assert.equal(order.roundingReview.status,action==='approveRounding'?'已批准':'已驳回');
  assert.equal(order.roundingReview.decidedByPrincipalId,principalId);assert.equal(order.roundingReview.decidedBy,null);
  assert.equal(order.roundingReview.decidedAt,dbNow);assert.equal(order.roundingReview.selfReviewAuthorized,true);
  assert.deepEqual(order.payments,paymentOrder(f.state).payments);
  if(action==='approveRounding') {
    assert.equal(order.status,'已结账');assert.equal(outstanding(order),0);
    assert.equal(head.state.rooms[0].status,'待清洁');assert.equal(head.state.rooms[0].order,null);
  } else {
    assert.equal(order.status,'营业中');assert.equal(outstanding(order),1001);
    assert.deepEqual(head.state.rooms,f.state.rooms);assert.equal(Object.hasOwn(order,'closedAt'),false);
  }
});

for(const difference of [0,500,999,1000,1001]) test('settle ordinary boundary '+difference+' cents keeps the original threshold and only effective rounding settles the order',async()=>{
  const f=fixture(),cmd=settleCommand('boundary',0,difference);await f.app.execute(cmd,f.credential);
  const head=await f.memory.read(),order=paymentOrder(head.state);
  assert.equal(order.rounding,difference);assert.equal(Boolean(order.roundingReview),difference>1000);
  assert.equal(order.status,difference>1000?'营业中':'已结账');
  assert.equal(head.state.rooms[0].status,difference>1000?'营业中':'待清洁');
  assert.equal(outstanding(order),difference>1000?difference:0);
  assert.deepEqual(order.sales,paymentOrder(f.state).sales);assert.equal(head.state.inventory.qd.count,null);assert.equal(head.state.inventory.bw.count,0);
});
for(const difference of [999,1000,1001]) test('settle special difference '+difference+' cents still requires note and review',async()=>{
  const f=fixture(),cmd=settleCommand('special',0,difference,{differenceType:'特殊情况',differenceNote:' Synthetic special reason '});
  await f.app.execute(cmd,f.credential);const order=paymentOrder((await f.memory.read()).state);
  assert.equal(order.roundingReview.status,'待审核');assert.equal(order.roundingReview.note,'Synthetic special reason');assert.equal(order.roundingReview.submittedByPrincipalId,principalId);
});
const decisions=[
  ['approveRounding','approve alone cannot self review',['rounding.approve'],['rounding.self.excess'],principalId,1001,false],
  ['approveRounding','attribute cannot replace approve',['review.self'],['rounding.self.excess'],principalId,1001,false],
  ['approveRounding','unconfigured excess fails closed',['rounding.approve','review.self'],null,principalId,1001,false],
  ['approveRounding','configured empty excess denies',['rounding.approve','review.self'],[],principalId,1001,false],
  ['approveRounding','all three conditions approve excess',['rounding.approve','review.self'],['rounding.self.excess'],principalId,1001,true],
  ['approveRounding','foreign excess needs no self attribute',['rounding.approve'],null,otherPrincipalId,1001,true],
  ['approveRounding','self special 9.99 needs no excess attribute',['rounding.approve','review.self'],null,principalId,999,true],
  ['approveRounding','self special 10.00 needs no excess attribute',['rounding.approve','review.self'],[],principalId,1000,true],
  ['rejectRounding','approve alone cannot self reject',['rounding.approve'],['rounding.self.excess'],principalId,1001,false],
  ['rejectRounding','review.self cannot replace approve',['review.self'],['rounding.self.excess'],principalId,1001,false],
  ['rejectRounding','self excess rejection needs no configured attributes',['rounding.approve','review.self'],null,principalId,1001,true],
  ['rejectRounding','self excess rejection accepts configured empty attributes',['rounding.approve','review.self'],[],principalId,1001,true],
  ['rejectRounding','foreign excess rejection only needs approve',['rounding.approve'],null,otherPrincipalId,1001,true]
];
for(const [action,label,permissions,attributes,applicant,amount,allowed] of decisions) test(action+': '+label,async()=>{
  const f=fixture({permissions,attributes,prepare:s=>seedPendingRounding(s,applicant,amount,amount<=1000?'特殊情况':'免零')});
  const cmd=roundingCommand(action,label,0,{submittedByPrincipalId:otherPrincipalId,applicant:otherPrincipalId,selfReview:false,
    approver:'administrator',actorId:otherPrincipalId,principalId:otherPrincipalId,role:'老板',permissions:['*'],
    policyAttributes:['rounding.self.excess'],attributes:['rounding.self.excess'],amount:1,rounding:1,clock:'1900-01-01'});
  if(!allowed){await assert.rejects(f.app.execute(cmd,f.credential),denied);await noEffects(f);return;}
  assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');
  const review=paymentOrder((await f.memory.read()).state).roundingReview;
  assert.equal(review.decidedByPrincipalId,principalId);assert.equal(review.decidedAt,dbNow);assert.equal(review.selfReviewAuthorized,applicant===principalId);
});
for(const action of ['approveRounding','rejectRounding']){
  test(action+': legacy/ambiguous applicant and unknown/inconsistent waiver fail closed without a key',async()=>{
    for(const mutation of [r=>delete r.submittedByPrincipalId,r=>r.submittedByPrincipalId='',r=>r.submittedByPrincipalId=' '+principalId,
      r=>r.amount=null,r=>r.amount=1.5,r=>r.amount=1000]){
      const f=fixture({permissions:['rounding.approve','review.self'],attributes:['rounding.self.excess'],prepare:s=>{seedPendingRounding(s);mutation(paymentOrder(s).roundingReview);}});
      await assert.rejects(f.app.execute(roundingCommand(action),f.credential),denied);await noEffects(f);
    }
  });
}
const actions=['settle','approveRounding','rejectRounding'];
const make=(action,key='operation',revision=0,changes={})=>action==='settle'?settleCommand(key,revision,1001,changes):roundingCommand(action,key,revision,changes);
const prepared=action=>action==='settle'?()=>{}:s=>seedPendingRounding(s);
const grants=action=>action==='settle'?['payment.settle']:['rounding.approve','review.self'];
for(const action of actions){
  test(action+': denied key can be reused after real grant/attribute configuration',async()=>{
    const f=fixture({permissions:['backend.view'],prepare:prepared(action)}),cmd=make(action,'retry-denied');
    await assert.rejects(f.app.execute(cmd,f.credential),denied);await noEffects(f);
    f.auth.permissions=grants(action);
    if(action==='approveRounding'){await assert.rejects(f.app.execute(cmd,f.credential),denied);await noEffects(f);f.auth.attributes=['rounding.self.excess'];}
    assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');
  });
  test(action+': revoked permission/attribute preserves old terminal and UUIDs, new key denied, actor/fingerprint conflicts unchanged',async()=>{
    const f=fixture({permissions:grants(action),attributes:['rounding.self.excess'],prepare:prepared(action)}),cmd=make(action),first=await f.app.execute(cmd,f.credential);
    const before=await f.memory.read();f.auth.permissions=[];f.auth.attributes=[];
    assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.equal(f.executions(),1);
    await assert.rejects(f.app.execute(make(action,'new',1),f.credential),denied);
    f.auth.id=otherPrincipalId;const actor=await f.app.execute(cmd,f.credential);assert.equal(actor.reason,'actor-mismatch');f.auth.id=principalId;
    for(const changed of [{...cmd,expectedRevision:1},{...cmd,payload:{...cmd.payload,amount:1}},{...cmd,action:action==='settle'?'pay':'settle'}]){
      const conflict=await f.app.execute(changed,f.credential);assert.equal(conflict.status,'idempotency-conflict');assert.equal(conflict.reason,'request-mismatch');
    }
    assert.deepEqual(await f.memory.read(),before);
  });
  test(action+': disabled/revoked/expired/credential-changed sessions cannot read saved terminal',async()=>{
    for(const mutate of [a=>a.enabled=false,a=>a.revoked=true,a=>a.idle=dbNow,a=>{a.absolute=dbNow;a.idle=dbNow;},a=>a.version++]){
      const f=fixture({permissions:grants(action),attributes:['rounding.self.excess'],prepare:prepared(action)}),cmd=make(action);
      await f.app.execute(cmd,f.credential);const before=await f.memory.read();mutate(f.auth);
      await assert.rejects(f.app.execute(cmd,f.credential),e=>e.code==='AUTHENTICATION_REQUIRED');assert.deepEqual(await f.memory.read(),before);
    }
  });
  test(action+': stale revision is terminal with no domain effect even after head advances',async()=>{
    const f=fixture({permissions:grants(action),attributes:['rounding.self.excess'],prepare:prepared(action)}),cmd=make(action,'stale',1);
    const terminal=await f.app.execute(cmd,f.credential);assert.equal(terminal.status,'revision-conflict');assert.equal(f.executions(),0);
    await f.app.execute(make(action,'advance'),f.credential);const before=await f.memory.read();f.auth.permissions=[];
    assert.deepEqual(await f.app.execute(cmd,f.credential),terminal);assert.deepEqual(await f.memory.read(),before);
  });
  test(action+': unknown failure after all domain effects rolls back and original key remains usable',async()=>{
    let broken=true;const f=fixture({permissions:grants(action),attributes:['rounding.self.excess'],prepare:prepared(action),execute:(...args)=>{const next=transact(...args);if(broken)throw Error('synthetic rounding failure');return next;}}),cmd=make(action);
    await assert.rejects(f.app.execute(cmd,f.credential),/synthetic rounding failure/);await noEffects(f);
    broken=false;assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');
  });
}
test('settle: client payment/review identity and clock are ignored, original snapshots stay untouched',async()=>{
  const f=fixture(),cmd=settleCommand('forged',0,1001,{person:'Fake',principalId:'fake',actorId:'fake',permissions:['*'],role:'administrator',clock:'1900-01-01',
    roundingReview:{submittedByPrincipalId:'fake'},submittedByPrincipalId:'fake'});
  cmd.payload.payments=cmd.payload.payments.map(p=>({...p,paymentId:'fake',occurredAt:'1900',recordedByPrincipalId:'fake',person:'Fake',time:'1900'}));
  await f.app.execute(cmd,f.credential);const head=await f.memory.read(),order=paymentOrder(head.state);
  for(const p of order.payments.slice(1)){assert.notEqual(p.paymentId,'fake');assert.equal(p.recordedByPrincipalId,principalId);assert.equal(p.occurredAt,dbNow);}
  assert.equal(order.roundingReview.submittedByPrincipalId,principalId);assert.equal(order.roundingReview.submittedById,'');assert.equal(order.roundingReview.submittedBy,null);
  assert.deepEqual(head.state.orders[0],f.state.orders[0]);assert.deepEqual(order.sales,paymentOrder(f.state).sales);
});
test('settle: original amount/channel/note/pending gift/state rejections remain terminal with no partial payment',async()=>{
  const cases=[{payments:[]},{payments:[{method:'现金',amount:21201}]},{payments:[{method:'银行卡',amount:20200}]},
    {differenceType:'特殊情况',differenceNote:''},{differenceType:'invalid'}];
  for(const changes of cases){const f=fixture(),result=await f.app.execute(settleCommand('bad',0,1001,changes),f.credential);assert.equal(result.status,'business-rejected');
    const head=await f.memory.read();assert.deepEqual(head.state,f.state);assert.equal(head.revision,0);assert.equal(head.audit.length,0);assert.equal(head.operationResults.size,1);
    f.auth.permissions=[];assert.deepEqual(await f.app.execute(settleCommand('bad',0,1001,changes),f.credential),result);
  }
  for(const mutation of [s=>paymentOrder(s).giftRequests.push({status:'待确认'}),s=>paymentOrder(s).status='已结账']){
    const f=fixture({prepare:mutation});assert.equal((await f.app.execute(settleCommand(),f.credential)).status,'business-rejected');assert.deepEqual((await f.memory.read()).state,f.state);
  }
});
test('rejectRounding: original rejection note remains required and business rejection stays terminal',async()=>{
  const f=fixture({permissions:['rounding.approve','review.self'],prepare:s=>seedPendingRounding(s)}),cmd=roundingCommand('rejectRounding','missing-note',0,{decisionNote:''});
  const result=await f.app.execute(cmd,f.credential);assert.equal(result.status,'business-rejected');assert.deepEqual((await f.memory.read()).state,f.state);
  f.auth.permissions=[];assert.deepEqual(await f.app.execute(cmd,f.credential),result);
});
test('settle: fully paid/zero due preserves original zero-rounding and creates no new payment',async()=>{
  const f=fixture({prepare:s=>paymentOrder(s).payments.push({method:'现金',amount:21200})});
  await f.app.execute(settleCommand('zero',0,1001,{payments:[]}),f.credential);const order=paymentOrder((await f.memory.read()).state);
  assert.equal(order.payments.length,2);assert.equal(order.rounding,0);assert.equal(order.roundingReview,null);assert.equal(order.status,'已结账');
});
test('rounding: missing revalidation/context and untrusted context copies fail closed; open stays disabled',async()=>{
  const f=fixture({bind:false});await assert.rejects(f.app.execute(settleCommand(),f.credential),/revalidation port/);await noEffects(f);
  for(const action of actions){assert.throws(()=>transact(f.state,action,make(action).payload,'no-context',{mode:'trusted'}),TypeError);}
  const valid=fixture();await valid.app.execute(settleCommand(),valid.credential);
  assert.throws(()=>settleOrder(valid.state,paymentOrder(valid.state),settleCommand().payload,'fake','1900',{mode:'trusted',context:{...valid.context()}}),TypeError);
  assert.throws(()=>decideRounding(valid.state,paymentOrder(valid.state),'approveRounding',{},'fake','1900',()=>true,{mode:'trusted'}),TypeError);
  const all=fixture({permissions:['handover','room.open']});for(const action of ['open'])await assert.rejects(all.app.execute({...settleCommand(action),action},all.credential),e=>denied(e)&&e.reason===(action==='open'?'missing-permission':'trusted-action-not-enabled'));await noEffects(all);
});

test('approveRounding: revoked excess attribute denies new key before handled-state terminal, old key replays; recovered key never redecides',async()=>{
  const f=fixture({permissions:['rounding.approve','review.self'],attributes:['rounding.self.excess'],prepare:s=>seedPendingRounding(s)});
  const original=roundingCommand(),first=await f.app.execute(original,f.credential),before=await f.memory.read();f.auth.attributes=[];
  assert.deepEqual(await f.app.execute(original,f.credential),first);
  const retry=roundingCommand('approveRounding','after-revoke',1);await assert.rejects(f.app.execute(retry,f.credential),e=>denied(e)&&e.reason==='missing-policy-attribute');
  assert.deepEqual(await f.memory.read(),before);f.auth.attributes=['rounding.self.excess'];
  const terminal=await f.app.execute(retry,f.credential);assert.equal(terminal.status,'business-rejected');
  const head=await f.memory.read();assert.deepEqual(head.state,before.state);assert.equal(head.revision,1);assert.equal(head.audit.length,1);assert.equal(head.operationResults.size,2);
});
