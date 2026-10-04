import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { decideRepayment, collected } from '../sales.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { REPAYMENT_REVIEW_ACTIONS, repaymentReviewCommand, seedRepaymentReview, repayOrder, repaymentRequest } from '../test-support/trusted-repayment-review-fixture.js';

const dbNow = '2026-10-05T12:00:00.123456Z';
const denied = e => e instanceof AuthorizationDenied && e.status === 'authorization-denied';
function fixture({ permissions = ['credit.repay.approve'], applicant='synthetic-repayment-applicant', amount=15000, prepare = () => {}, execute = transact, bind = true } = {}) {
  const state = initialState(); state.user = 'unmapped-demo-user'; state.clock = 'invalid-demo-clock';
  state.permissions = { administrator: ['管理员'] }; state.capabilities = { administrator: ['*'] }; state.administrator = true;
  state.orders = [{ id: 'historical-retail', kind: 'retail', room: null,
    sales: [{ productNameSnapshot: null, pricePerSaleUnitCents: null, baseQuantityPerSaleUnit: 12, totalBaseQuantity: 24 }],
    payments: [{ method: '现金', amount: 10 }, { method: '微信', amount: 20 }] }];
  seedRepaymentReview(state,applicant,amount); prepare(state);
  const memory = createMemoryLedgerStore(state, { ledgerId: 'repayment-review-unit' }), events = [], digest = Buffer.alloc(32, 19);
  const auth = { id: 'synthetic-repayment-reviewer', permissions, enabled: true, revoked: false, version: 1, sessionVersion: 1,
    idle: '2099-01-01T00:00:00.000000Z', absolute: '2099-01-02T00:00:00.000000Z' };
  const port = {
    locateSessionByDigest: async () => ({ principalId: auth.id, sessionId: 'synthetic-repayment-review-session' }),
    lockAccount: async () => { events.push('account'); return { principalId: auth.id, enabled: auth.enabled, credentialVersion: auth.version, policyAttributesConfigured: false }; },
    lockSessionById: async () => { events.push('session'); return { principalId: auth.id, sessionId: 'synthetic-repayment-review-session', tokenDigest: digest,
      revoked: auth.revoked, credentialVersion: auth.sessionVersion, idleExpiresAt: auth.idle, absoluteExpiresAt: auth.absolute }; },
    listGrants: async () => { events.push('grants'); return auth.permissions; }, listPolicyAttributes: async () => [],
    readDbNow: async () => { events.push('db-now'); return dbNow; }
  };
  let executions = 0, context;
  const store = { ledgerId: memory.ledgerId, runAtomic: work => memory.runAtomic(tx => {
    events.push('head'); const find = tx.findOperationResult; tx.findOperationResult = key => { events.push('operation'); return find(key); };
    if (bind) tx.sessionRevalidation = { revalidateSessionInTransaction: async credential => {
      context = await revalidateSessionInTransaction({ port, ...credential }); return context;
    } };
    return work(tx); // Repayment review has no employee attribution.
  }) };
  const app = createTrustedLedgerApplication({ store, transactCommand: (...args) => {
    executions++; context = args[4].context; events.push('transact'); return execute(...args);
  } });
  return { state, memory, app, auth, events, credential: { tokenDigest: digest }, executions: () => executions, context: () => context };
}
async function assertNoEffects(f) {
  const head = await f.memory.read(); assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0);
  assert.equal(head.operationResults.size, 0); assert.equal(head.audit.length, 0);
}

test('repayment review: non-applicant approval commits one payment, remaining balance and stable session decider together',async()=>{
 const f=fixture(),before=repayOrder(f.state),result=await f.app.execute(repaymentReviewCommand(),f.credential),head=await f.memory.read();
 const order=repayOrder(head.state),request=repaymentRequest(head.state),payment=order.payments.at(-1);
 assert.equal(result.status,'committed');assert.equal(result.actorId,f.auth.id);assert.equal(head.revision,1);
 assert.equal(request.status,'已批准');assert.equal(request.decidedByPrincipalId,f.auth.id);assert.equal(request.decidedBy,null);
 assert.equal(request.decidedAt,dbNow);assert.equal(request.selfReviewAuthorized,false);assert.equal(request.decisionNote,'Synthetic decision note');
 assert.equal(order.payments.length,before.payments.length+1);assert.equal(order.credit.repayments.length,before.credit.repayments.length+1);
 assert.deepEqual(payment,{amount:15000,method:'现金',chargeId:'credit-repayment',time:dbNow,person:'Historical applicant',approvedBy:null,repaymentRequestId:991,approvedByPrincipalId:f.auth.id});
 assert.deepEqual(order.credit.repayments.at(-1),payment);assert.equal(order.credit.remaining,54500);assert.equal(order.status,'已挂账');
 assert.equal(head.operationResults.size,1);assert.equal(head.audit.length,1);assert.equal(head.audit[0].actorId,f.auth.id);
});

function addSecond(state) {
 const copy=structuredClone(repaymentRequest(state));copy.id=1111;copy.amount=10000;
 repayOrder(state).credit.repaymentRequests.push(copy);
}
for(const action of REPAYMENT_REVIEW_ACTIONS){
 test('repayment '+action+': preserves original decision, money, historical snapshots and unrelated requests',async()=>{
  const f=fixture(),cmd=repaymentReviewCommand(action),before=repayOrder(f.state);await f.app.execute(cmd,f.credential);
  const head=await f.memory.read(),order=repayOrder(head.state),request=repaymentRequest(head.state);
  const demo=transact({...f.state,user:'boss',clock:dbNow},action,cmd.payload,'demo');const demoOrder=repayOrder(demo);
  for(const field of ['status','decidedAt','decisionNote','selfReviewAuthorized'])assert.deepEqual(request[field],repaymentRequest(demo)[field]);
  assert.equal(request.decidedByPrincipalId,f.auth.id);assert.equal(request.decidedBy,null);
  assert.equal(order.credit.remaining,demoOrder.credit.remaining);assert.equal(order.status,demoOrder.status);
  for(const [field,value]of Object.entries(repaymentRequest(f.state)))if(!['status','decidedBy','decidedAt','decisionNote'].includes(field))assert.deepEqual(request[field],value);
  assert.deepEqual(order.credit.repaymentRequests.filter(r=>r.id!==991),before.credit.repaymentRequests.filter(r=>r.id!==991));
  for(const field of ['amount','phone','name','note','person','submittedByPrincipalId','approver','submittedAt','due','decidedByPrincipalId','decisionAt','decisionBy'])assert.deepEqual(order.credit[field],before.credit[field]);
  assert.deepEqual(order.sales,before.sales);assert.deepEqual(order.creditHistory,before.creditHistory);
  for(const field of ['rooms','inventory','consumables','ledger','user','permissions','clock','capabilities','administrator'])assert.deepEqual(head.state[field],f.state[field]);
  assert.deepEqual(head.state.orders[0],f.state.orders[0]);assert.equal(head.state.orders[0].room,null);
  assert.equal(head.state.inventory.qd.count,null);assert.equal(head.state.inventory.bw.count,0);
  if(action==='approveRepayment'){
   assert.deepEqual(order.payments.slice(0,-1),before.payments);assert.deepEqual(order.credit.repayments.slice(0,-1),before.credit.repayments);
   assert.equal(order.payments.length,before.payments.length+1);assert.equal(order.credit.repayments.length,before.credit.repayments.length+1);
   const {approvedByPrincipalId,approvedBy,...payment}=order.payments.at(-1),{approvedBy:demoName,...originalPayment}=demoOrder.payments.at(-1);
   assert.deepEqual(payment,originalPayment);assert.equal(approvedByPrincipalId,f.auth.id);assert.equal(collected(head.state)-collected(f.state),15000);
  }else{
   assert.deepEqual(order.payments,before.payments);assert.deepEqual(order.credit.repayments,before.credit.repayments);
   assert.equal(order.credit.remaining,69500);assert.equal(collected(head.state),collected(f.state));
  }
 });

 test('repayment '+action+': request applicant needs approve plus review.self; unrelated permissions cannot substitute',async()=>{
  const blocked=fixture({applicant:'synthetic-repayment-reviewer'});
  await assert.rejects(blocked.app.execute(repaymentReviewCommand(action),blocked.credential),e=>denied(e)&&e.reason==='missing-permission');await assertNoEffects(blocked);
  blocked.auth.permissions.push('review.self');await blocked.app.execute(repaymentReviewCommand(action),blocked.credential);
  assert.equal(repaymentRequest((await blocked.memory.read()).state).selfReviewAuthorized,true);
  for(const permissions of [['review.self'],['backend.view'],['credit.approve'],['credit.repay'],['payment.collect','payment.settle']]){
   const f=fixture({permissions,applicant:'synthetic-repayment-reviewer'});
   await assert.rejects(f.app.execute(repaymentReviewCommand(action),f.credential),denied);await assertNoEffects(f);
  }
 });

 test('repayment '+action+': self-review uses this request, never credit creator, another request, name or demo ID',async()=>{
  const other=fixture({prepare:s=>{
   const order=repayOrder(s);order.credit.submittedByPrincipalId='synthetic-repayment-reviewer';order.credit.person='Historical applicant';
   order.credit.repaymentRequests[0].submittedByPrincipalId='synthetic-repayment-reviewer';
   repaymentRequest(s).submittedById='synthetic-repayment-reviewer';
  }});await other.app.execute(repaymentReviewCommand(action),other.credential);
  assert.equal(repaymentRequest((await other.memory.read()).state).selfReviewAuthorized,false);
  const self=fixture({applicant:'synthetic-repayment-reviewer',prepare:s=>{
   repayOrder(s).credit.submittedByPrincipalId='some-other-creator';repaymentRequest(s).submittedById='another-demo-id';
  }});await assert.rejects(self.app.execute(repaymentReviewCommand(action),self.credential),denied);await assertNoEffects(self);
 });

 test('repayment '+action+': payload identities, permission, amount, method and clock cannot override locked facts',async()=>{
  const f=fixture(),cmd=repaymentReviewCommand(action,'forged',0,{actorId:'fake',principalId:'fake',actualActorPrincipalId:'fake',submittedByPrincipalId:'fake',
   submittedBy:'Fake',applicant:'fake',selfReview:true,approver:'fake',approvedBy:'Fake',approvedByPrincipalId:'fake',decidedByPrincipalId:'fake',
   role:'老板',permissions:['*'],policyAttributeIds:['credit.approval.boss'],clock:'1900-01-01',time:'1900-01-01',amount:999999,method:'invalid'});
  await f.app.execute(cmd,f.credential);const head=await f.memory.read(),request=repaymentRequest(head.state);
  assert.equal(request.submittedByPrincipalId,'synthetic-repayment-applicant');assert.equal(request.decidedByPrincipalId,f.auth.id);assert.equal(request.decidedAt,dbNow);
  assert.equal(request.decidedBy,null);assert.equal(request.selfReviewAuthorized,false);assert.equal(request.amount,15000);assert.equal(request.method,'现金');
  if(action==='approveRepayment'){const payment=repayOrder(head.state).payments.at(-1);assert.equal(payment.approvedByPrincipalId,f.auth.id);assert.equal(payment.time,dbNow);assert.equal(payment.amount,15000);assert.equal(payment.method,'现金');}
  const noGrant=fixture({permissions:[]});await assert.rejects(noGrant.app.execute(cmd,noGrant.credential),denied);await assertNoEffects(noGrant);
 });

 test('repayment '+action+': missing or invalid legacy request principal fails closed without consuming key',async()=>{
  for(const applicant of [undefined,null,'',' whitespace ','x'.repeat(192),123,{}]){
   const f=fixture({applicant,permissions:['credit.repay.approve','review.self'],prepare:s=>{repaymentRequest(s).submittedByPrincipalId=applicant;}});
   const cmd=repaymentReviewCommand(action,'legacy',0,{submittedByPrincipalId:'trusted-looking',applicant:'trusted-looking',selfReview:false});
   await assert.rejects(f.app.execute(cmd,f.credential),e=>denied(e)&&e.reason==='untrusted-repayment-applicant');await assertNoEffects(f);
  }
 });

 test('repayment '+action+': denied key is reusable after current grant, with no partial request or payment',async()=>{
  const f=fixture({permissions:[]}),cmd=repaymentReviewCommand(action,'denied');
  await assert.rejects(f.app.execute(cmd,f.credential),denied);await assertNoEffects(f);
  f.auth.permissions.push('credit.repay.approve');assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');
  const head=await f.memory.read();assert.equal(head.revision,1);assert.equal(head.audit.length,1);
 });

 test('repayment '+action+': revoke replays original terminal before current permission; new key denied then reusable',async()=>{
  const f=fixture({prepare:addSecond}),cmd=repaymentReviewCommand(action),first=await f.app.execute(cmd,f.credential);f.auth.permissions=[];const before=await f.memory.read();
  assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.deepEqual(await f.memory.read(),before);assert.equal(f.executions(),1);
  const next=repaymentReviewCommand(action,'new',1,{request:1111});await assert.rejects(f.app.execute(next,f.credential),denied);assert.deepEqual(await f.memory.read(),before);
  f.auth.permissions.push('credit.repay.approve');assert.equal((await f.app.execute(next,f.credential)).status,'committed');
  const head=await f.memory.read();assert.equal(head.revision,2);assert.equal(head.audit.length,2);
  assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.equal(f.executions(),2);
 });

 test('repayment '+action+': trusted domain needs branded context and never reads demo facts or calls demo reviewer',async()=>{
  const f=fixture();await f.app.execute(repaymentReviewCommand(action),f.credential);const state={};
  for(const field of ['user','permissions','clock','capabilities','administrator'])Object.defineProperty(state,field,{get(){assert.fail('trusted review read demo '+field);}});
  const order=structuredClone(repayOrder(f.state));decideRepayment(state,order,action,repaymentReviewCommand(action).payload,'fake','1900-01-01',()=>assert.fail('demo reviewer'),{mode:'trusted',context:f.context()});
  assert.equal(order.credit.repaymentRequests[1].decidedByPrincipalId,f.auth.id);assert.equal(order.credit.repaymentRequests[1].decidedAt,dbNow);
  for(const context of [undefined,{...f.context()}])assert.throws(()=>decideRepayment(f.state,repayOrder(f.state),action,repaymentReviewCommand(action).payload,undefined,undefined,undefined,{mode:'trusted',context}),/可信认证上下文/);
  assert.throws(()=>decideRepayment(f.state,repayOrder(f.state),action,repaymentReviewCommand(action).payload,undefined,undefined,undefined,{mode:'unknown'}),/执行模式/);
  const unbound=fixture({bind:false});await assert.rejects(unbound.app.execute(repaymentReviewCommand(action),unbound.credential),/revalidation port/);await assertNoEffects(unbound);
 });

 test('repayment '+action+': unknown failure after financial decision rolls back every fact and original key can retry',async()=>{
  let broken=true;const f=fixture({execute:(...args)=>{const next=transact(...args);if(broken)throw Error('synthetic repayment decision fault');return next;}}),cmd=repaymentReviewCommand(action);
  await assert.rejects(f.app.execute(cmd,f.credential),/synthetic repayment decision fault/);await assertNoEffects(f);
  broken=false;assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');const head=await f.memory.read();
  assert.equal(head.revision,1);assert.equal(head.audit.length,1);assert.equal(head.operationResults.size,1);
  assert.equal(repayOrder(head.state).payments.length,repayOrder(f.state).payments.length+(action==='approveRepayment'?1:0));
 });
}

test('repayment approval: exact remaining closes credit once; numeric request selection and payment method semantics remain unchanged',async()=>{
 for(const method of ['现金','微信','支付宝','美团','抖音']){
  const f=fixture({amount:69500,prepare:s=>{repaymentRequest(s).method=method;}}),cmd=repaymentReviewCommand('approveRepayment','full',0,{request:'991'}),first=await f.app.execute(cmd,f.credential);
  const head=await f.memory.read(),order=repayOrder(head.state);assert.equal(order.credit.remaining,0);assert.equal(order.status,'已回款');
  assert.equal(order.payments.length,repayOrder(f.state).payments.length+1);assert.equal(order.payments.at(-1).method,method);assert.equal(collected(head.state)-collected(f.state),69500);
  assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.deepEqual(await f.memory.read(),head);
 }
});

test('repayment rejection: changed balance or paid-off credit still permits original rejection; reason remains required and truncated',async()=>{
 const f=fixture({prepare:s=>{repayOrder(s).status='已回款';repayOrder(s).credit.remaining=0;}});
 await f.app.execute(repaymentReviewCommand('rejectRepayment','reject',0,{decisionNote:'  '+'n'.repeat(350)+'  '}),f.credential);
 const head=await f.memory.read(),order=repayOrder(head.state);assert.equal(repaymentRequest(head.state).decisionNote.length,300);
 assert.equal(order.credit.remaining,0);assert.equal(order.status,'已回款');assert.deepEqual(order.payments,repayOrder(f.state).payments);assert.deepEqual(order.credit.repayments,repayOrder(f.state).credit.repayments);
});

test('repayment decisions: original invalid-order, handled-request, rejection-reason and changed-balance business failures stay terminal without partial effects',async()=>{
 for(const c of [{order:'missing'},{request:9999},{handled:true},{creditMissing:true},{action:'rejectRepayment',decisionNote:''},
  {balance:10000},{status:'营业中'},{status:'已回款'}]){
  const action=c.action??'approveRepayment',f=fixture({prepare:s=>{const order=repayOrder(s);if(c.handled)repaymentRequest(s).status='已批准';if(c.balance!==undefined)order.credit.remaining=c.balance;if(c.status)order.status=c.status;if(c.creditMissing)order.credit=null;}}),cmd=repaymentReviewCommand(action,'business',0,c);
  const first=await f.app.execute(cmd,f.credential),head=await f.memory.read();assert.equal(first.status,'business-rejected');assert.deepEqual(head.state,f.state);
  assert.equal(head.revision,0);assert.equal(head.audit.length,0);assert.equal(head.operationResults.size,1);f.auth.permissions=[];
  assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.deepEqual(await f.memory.read(),head);
 }
});

test('repayment approval: unexpected failure between repayment/payment writes leaves no partial state or terminal',async()=>{
 const f=fixture({prepare:s=>{delete repayOrder(s).payments;}});await assert.rejects(f.app.execute(repaymentReviewCommand(),f.credential),TypeError);await assertNoEffects(f);
});

test('repayment decisions: invalid auth blocks original result lookup, including self-review authorization replays',async()=>{
 for(const action of REPAYMENT_REVIEW_ACTIONS)for(const invalid of ['disabled','revoked','idle','absolute','version']){
  const f=fixture({applicant:'synthetic-repayment-reviewer',permissions:['credit.repay.approve','review.self']}),cmd=repaymentReviewCommand(action);await f.app.execute(cmd,f.credential);const before=await f.memory.read();f.auth.permissions=[];
  if(invalid==='disabled')f.auth.enabled=false;else if(invalid==='revoked')f.auth.revoked=true;else if(invalid==='version')f.auth.version++;
  else if(invalid==='idle')f.auth.idle=dbNow;else{f.auth.idle=dbNow;f.auth.absolute=dbNow;}
  f.events.length=0;await assert.rejects(f.app.execute(cmd,f.credential),e=>e.code==='AUTHENTICATION_REQUIRED');assert.equal(f.events.includes('operation'),false);assert.deepEqual(await f.memory.read(),before);
 }
});

test('repayment decisions: actor/action/request/note/expectedRevision fingerprint conflicts remain before current authorization',async()=>{
 for(const action of REPAYMENT_REVIEW_ACTIONS){
  const f=fixture(),cmd=repaymentReviewCommand(action);await f.app.execute(cmd,f.credential);f.auth.permissions=[];const before=await f.memory.read(),id=f.auth.id;
  f.auth.id='different-synthetic-reviewer';const actor=await f.app.execute(cmd,f.credential);assert.equal(actor.status,'idempotency-conflict');assert.equal(actor.reason,'actor-mismatch');f.auth.id=id;
  for(const next of [{...cmd,expectedRevision:1},{...cmd,action:action==='approveRepayment'?'rejectRepayment':'approveRepayment'},
   {...cmd,payload:{...cmd.payload,request:992}},{...cmd,payload:{...cmd.payload,decisionNote:'new note'}},{...cmd,payload:{...cmd.payload,submittedByPrincipalId:'fake'}}]){
   const result=await f.app.execute(next,f.credential);assert.equal(result.status,'idempotency-conflict');assert.equal(result.reason,'request-mismatch');
  }assert.deepEqual(await f.memory.read(),before);assert.equal(f.executions(),1);
 }
});

test('repayment decisions: stale revision remains terminal after a later successful decision and revoke',async()=>{
 for(const action of REPAYMENT_REVIEW_ACTIONS){const f=fixture(),cmd=repaymentReviewCommand(action,'stale',9),first=await f.app.execute(cmd,f.credential);assert.equal(first.status,'revision-conflict');assert.equal(f.executions(),0);
  await f.app.execute(repaymentReviewCommand(action,'valid'),f.credential);f.auth.permissions=[];const before=await f.memory.read();assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.deepEqual(await f.memory.read(),before);
 }
});

test('repayment decisions: same key retries and competing approve/reject decide once per old revision',async()=>{
 for(const action of REPAYMENT_REVIEW_ACTIONS)for(const sameKey of [false,true]){
  const f=fixture(),a=repaymentReviewCommand(action,'a'),b=sameKey?a:repaymentReviewCommand(action==='approveRepayment'?'rejectRepayment':'approveRepayment','b');
  const results=await Promise.all([f.app.execute(a,f.credential),f.app.execute(b,f.credential)]);if(sameKey)assert.deepEqual(results[0],results[1]);else assert.deepEqual(results.map(r=>r.status).sort(),['committed','revision-conflict']);
  const head=await f.memory.read();assert.equal(head.revision,1);assert.equal(head.audit.length,1);assert.equal(f.executions(),1);const order=repayOrder(head.state),approved=repaymentRequest(head.state).status==='已批准';
  assert.equal(order.payments.length,repayOrder(f.state).payments.length+(approved?1:0));assert.equal(order.credit.remaining,approved?54500:69500);
 }
});

test('repayment decisions: review permission does not enable rounding, payments or other remaining unmigrated actions',async()=>{
 const f=fixture({permissions:['credit.repay.approve','review.self','rounding.approve','payment.collect','payment.settle',
  'incident.create','incident.resolve','incident.resolve.approve','procurement.create','handover','room.open']});
 for(const action of ['approveRounding','rejectRounding','collect','settle','pay','procurement','handover','open']){
  await assert.rejects(f.app.execute({...repaymentReviewCommand(action),action},f.credential),e=>denied(e)&&e.reason==='trusted-action-not-enabled');await assertNoEffects(f);
 }
});
