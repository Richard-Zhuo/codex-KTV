import test from 'node:test';
import assert from 'node:assert/strict';
import { financialFixture, financialDrawerFixture, financialCommand as cmd, financialOrder as order, orderId, paymentId, ownerId, applicantId, reviewerId } from './test-support/financial-adjustments-fixture.js';
import { orderPaymentCredit, netReceipts, adjustablePaymentBalance, validateOriginalPayment, creditRepaymentRemaining } from './financial-adjustments.js';
import { outstanding, collectableCharges, submitRepay, decideRepayment } from './sales.js';
import { transact } from './rules.js';
import { AuthorizationDenied } from './shared/identity.js';
import { createTrustedPrincipal, createTrustedReviewFacts, authorizeReviewCommand } from './ledger/command-policy.js';
import { isHttpCommand } from './http/registry.js';
const read = async f => (await f.memory.read()).state;
const denied = e => e instanceof AuthorizationDenied;
const execution = (action, key, revision, requestId) => ({ action, operationKey: key, expectedRevision: revision, payload: { order: orderId, requestId } });
const decision = (action, key, revision, requestId, decisionNote) => ({ action, operationKey: key, expectedRevision: revision, payload: { requestId, ...(decisionNote ? { decisionNote } : {}) } });

test('C1-A: full reversal preserves original facts and decreases billing credit/charge credit', async () => {
  const f = await financialDrawerFixture(), before = structuredClone(order(f.state).payments);
  assert.equal((await f.execute(cmd('reversePayment', 'r', 0))).status, 'committed');
  const s = await read(f), o = order(s);
  assert.deepEqual(o.payments, before); assert.equal(orderPaymentCredit(o), 0);
  assert.equal(outstanding(o), 10000); assert.equal(collectableCharges(o)[0].remaining, 10000);
  assert.equal(netReceipts(o), 0); assert.equal(adjustablePaymentBalance(s, orderId, paymentId).available, 0);
  assert.equal(o.financialAdjustments[0].kind, 'PAYMENT_REVERSAL');
  assert.deepEqual(s.rooms, f.state.rooms); assert.deepEqual(s.inventory, f.state.inventory);
  assert.equal((await f.execute(cmd('reversePayment', 'again', 1))).status, 'business-rejected');
});
test('C1-A: partial refunds reduce net receipts/adjustable balance, never billing credit/debt', async () => {
  const f = await financialDrawerFixture(), before = structuredClone(order(f.state));
  for (const [i, amount] of [3000, 4000, 3000].entries()) {
    assert.equal((await f.execute(cmd('refundPayment', 'f'+i, i, { amount }))).status, 'committed');
    const s = await read(f), o = order(s);
    assert.deepEqual(o.payments, before.payments); assert.equal(orderPaymentCredit(o), 10000);
    assert.equal(outstanding(o), 0); assert.deepEqual(collectableCharges(o), []);
    assert.equal(o.status, before.status); assert.equal(o.credit, null);
  }
  const s = await read(f); assert.equal(netReceipts(order(s)), 0);
  assert.equal((await f.execute(cmd('refundPayment', 'overflow', 3, { amount: 1 }))).status, 'business-rejected');
  assert.equal((await f.execute(cmd('reversePayment', 'reverse-refunded', 3))).status, 'business-rejected');
});
test('C1-A: direct execution replay preserves exact result and fingerprint/actor conflicts do not write', async () => {
  const f = await financialDrawerFixture(), c = cmd('refundPayment', 'same', 0), first = await f.execute(c);
  assert.deepEqual(await f.execute(c), first);
  assert.equal((await f.execute({ ...c, payload: { ...c.payload, amount: 1 } })).status, 'idempotency-conflict');
  assert.equal((await f.execute(c, applicantId)).status, 'idempotency-conflict');
  assert.equal(order(await read(f)).financialAdjustments.length, 1);
  f.accounts.get(ownerId).grants = [];
  assert.deepEqual(await f.execute(c), first);
  await assert.rejects(f.execute(cmd('refundPayment', 'new', 1)), denied);
});
for (const kind of ['refundPayment','reversePayment']) test('C1-A: '+kind+' request -> other approval -> original applicant execution exactly once', async () => {
  const f = await financialDrawerFixture();
  assert.equal((await f.execute(cmd(kind, 'submit', 0), applicantId)).status, 'committed');
  let s = await read(f), r = s.financialRequests[0];
  assert.equal(order(s).financialAdjustments, undefined);
  assert.equal(adjustablePaymentBalance(s, orderId, paymentId).reserved, r.amount);
  assert.equal((await f.execute(execution(kind, 'early', 1, r.requestId), applicantId)).status, 'business-rejected');
  await assert.rejects(f.execute(decision('approveFinancialAdjustment','self',1,r.requestId), applicantId), denied);
  assert.equal((await f.execute(decision('approveFinancialAdjustment','approve',1,r.requestId), reviewerId)).status, 'committed');
  s = await read(f); r = s.financialRequests[0]; assert.equal(r.status, '已批准');
  assert.equal(order(s).financialAdjustments, undefined);
  await assert.rejects(f.execute(execution(kind,'wrong-actor',2,r.requestId), reviewerId), denied);
  f.setTime('2026-10-15T22:00:00.123456Z');
  const c = execution(kind,'execute',2,r.requestId), result = await f.execute(c,applicantId);
  assert.equal(result.status, 'committed'); assert.deepEqual(await f.execute(c, applicantId), result);
  assert.equal((await f.execute(execution(kind,'new-key',3,r.requestId),applicantId)).status, 'business-rejected');
  s = await read(f); const a = order(s).financialAdjustments[0];
  assert.equal(a.actualActorPrincipalId, applicantId); assert.equal(a.occurredAt,'2026-10-15T22:00:00.123456Z');
  assert.equal(a.businessDate, '2026-10-16'); assert.equal(a.requestId, r.requestId);
  assert.equal(s.financialRequests[0].executedAdjustmentId, a.adjustmentId);
  assert.equal(s.financialRequests[0].decidedByPrincipalId, reviewerId);
});
test('C1-A: pending/approved requests reserve money, rejection releases it', async () => {
  const f = await financialDrawerFixture();
  await f.execute(cmd('refundPayment','submit',0,{amount:7000}),applicantId);
  const r = (await read(f)).financialRequests[0];
  assert.equal((await f.execute(cmd('refundPayment','too-much',1,{amount:4000}))).status,'business-rejected');
  assert.equal((await f.execute(cmd('reversePayment','conflict',1))).status,'business-rejected');
  await f.execute(decision('approveFinancialAdjustment','approve',1,r.requestId),reviewerId);
  assert.equal(adjustablePaymentBalance(await read(f),orderId,paymentId).available,3000);
  assert.equal((await f.execute(decision('approveFinancialAdjustment','again',2,r.requestId),reviewerId)).status,'business-rejected');
});
test('C1-A: rejection is audited without adjustment and frees the reservation', async () => {
  const f = await financialDrawerFixture();
  await f.execute(cmd('refundPayment','submit',0),applicantId);
  const r=(await read(f)).financialRequests[0];
  await f.execute(decision('rejectFinancialAdjustment','reject',1,r.requestId,'核对不符'),reviewerId);
  const s=await read(f); assert.equal(order(s).financialAdjustments,undefined);
  assert.equal(s.financialRequests[0].decisionNote,'核对不符');
  assert.equal(adjustablePaymentBalance(s,orderId,paymentId).available,10000);
  assert.equal((await f.execute(cmd('reversePayment','direct',2))).status,'committed');
});
test('C1-A: unqualified actor/approver and demo path cannot use financial authority', async () => {
  const f=await financialDrawerFixture(); f.accounts.get(ownerId).grants=['backend.view','payment.settle','review.self'];
  await assert.rejects(f.execute(cmd('refundPayment','denied',0)),denied);
  await f.execute(cmd('refundPayment','submit',0),applicantId);
  const r=(await read(f)).financialRequests[0];
  await assert.rejects(f.execute(decision('approveFinancialAdjustment','denied-review',1,r.requestId)),denied);
  assert.throws(()=>transact(f.state,'refundPayment',cmd('refundPayment','x',0).payload,'demo'),denied);
});
test('C1-A: review.self cannot bypass strict financial other-person policy', () => {
  const principal=createTrustedPrincipal({id:applicantId,permissionIds:['financial.approve','review.self']});
  for(const action of ['approveFinancialAdjustment','rejectFinancialAdjustment']) assert.equal(authorizeReviewCommand({principal,action,reviewFacts:createTrustedReviewFacts({submittedByPrincipalId:applicantId})}).allowed,false);
});
for(const field of ['paymentId','occurredAt','recordedByPrincipalId','chargeId']) test('C1-A: unsafe historical '+field+' fails closed without repair',async()=>{
  const f=await financialDrawerFixture({prepare:s=>{delete order(s).payments[0][field];}});
  const before=structuredClone(order(f.state).payments);
  assert.equal((await f.execute(cmd('refundPayment','unsafe',0))).status,'business-rejected');
  assert.deepEqual(order(await read(f)).payments,before);assert.equal(order(await read(f)).financialAdjustments,undefined);
});
for(const [refundChannel,refundFundingSource,expected]of [['现金','CURRENT_DRAWER',true],['现金','OUTSIDE_DRAWER',false],['微信','NON_CASH',false]]) test('C1-A: explicit refund funding '+refundFundingSource,async()=>{
  const f=await financialDrawerFixture();await f.execute(cmd('refundPayment','funding',0,{refundChannel,refundFundingSource}));
  assert.equal(order(await read(f)).financialAdjustments[0].affectsCurrentDrawer,expected);
});
test('C1-A: missing/contradictory funding or forged authority and intent mutation rejected',async()=>{
  for(const changes of [{refundFundingSource:undefined},{refundFundingSource:'NON_CASH'},{refundChannel:'微信'},{occurredAt:'1900-01-01'},{actualActorPrincipalId:reviewerId},{amount:0},{amount:-1},{amount:1.5},{reason:''}]){
    const f=await financialDrawerFixture(),c=cmd('refundPayment','bad',0,changes);
    if(c.payload.refundFundingSource===undefined)delete c.payload.refundFundingSource;
    assert.equal((await f.execute(c)).status,'business-rejected');
    assert.deepEqual(order(await read(f)).payments,order(f.state).payments);
  }
});
for(const [at,date]of [['2026-10-15T21:59:59.000000Z','2026-10-15'],['2026-10-15T22:00:00.000000Z','2026-10-16']]) test('C1-A: actual execution at '+at,async()=>{
  const f=await financialDrawerFixture();f.setTime(at);await f.execute(cmd('refundPayment','time',0));
  const o=order(await read(f)),a=o.financialAdjustments[0];
  assert.equal(a.occurredAt,at);assert.equal(a.businessDate,date);
  assert.equal(a.businessDayRuleVersion,'cutoff-0600-v1');assert.equal(a.businessTimeZone,'Asia/Shanghai');
  assert.equal(o.businessDayRuleVersion,'noon-v1');assert.equal(o.payments[0].occurredAt,'2026-01-01T12:00:00.000000Z');
});
test('C1-A: missing store time zone cannot create financial facts',async()=>{
  assert.throws(()=>financialFixture({businessTimeZone:''}),/时区/);
  assert.throws(()=>financialFixture({businessTimeZone:null}),/时区/);
});
for(const pair of [['refundPayment','refundPayment'],['refundPayment','reversePayment'],['reversePayment','refundPayment']]) test('C1-A: serialized concurrent '+pair.join(' / '),async()=>{
  const f=await financialDrawerFixture();
  const result=await Promise.all(pair.map((a,i)=>f.execute(cmd(a,'race'+i,0,{amount:a==='refundPayment'?7000:10000}))));
  assert.deepEqual(result.map(r=>r.status),['committed','revision-conflict']);
  assert.equal((await f.execute(cmd(pair[1],'fresh',1,{amount:pair[1]==='refundPayment'?7000:10000}))).status,'business-rejected');
  assert.equal(order(await read(f)).financialAdjustments.length,1);
});
test('C1-A: canonical repayment reversal restores only repayment debt; refund never restores debt',async()=>{
  for(const action of ['refundPayment','reversePayment']){
    const f=await financialDrawerFixture({prepare:s=>{const o=order(s);o.status='已回款';o.payments[0].chargeId='credit-repayment';
      o.credit={amount:10000,remaining:0,repayments:[structuredClone(o.payments[0])],repaymentRequests:[]};}});
    await f.execute(cmd(action,'adjust',0));const o=order(await read(f));
    assert.equal(creditRepaymentRemaining(o),action==='reversePayment'?10000:0);
    assert.equal(o.credit.remaining,action==='reversePayment'?10000:0);
    assert.equal(o.status,action==='reversePayment'?'已挂账':'已回款');
    assert.deepEqual(o.credit.repayments,order(f.state).credit.repayments);
  }
});
test('C1-A: corrected outstanding controls existing collect/pay eligibility without refund debt',async()=>{
  const f=await financialDrawerFixture();f.accounts.get(ownerId).grants.push('payment.collect');await f.execute(cmd('reversePayment','reverse',0));
  assert.equal((await f.execute({action:'collect',operationKey:'collect',expectedRevision:1,payload:{order:orderId,charge:'open',payments:[{method:'微信',amount:10000}]}})).status,'committed');
  assert.equal(outstanding(order(await read(f))),0);
});
test('C1-A: unknown transaction error rolls back adjustment and request consumption',async()=>{
  const f=await financialDrawerFixture({transactCommand:(...args)=>{transact(...args);throw Error('injected-rollback');}});
  await assert.rejects(f.execute(cmd('refundPayment','fault',0)),/injected-rollback/);
  assert.deepEqual((await f.memory.read()).state,f.state);assert.equal((await f.memory.read()).operationResults.size,0);
});
test('C1-A: malformed adjustment/request and duplicate payment identity fail closed',async()=>{
  for(const prepare of [s=>{order(s).financialAdjustments=null;},s=>{s.financialRequests=[{}];},s=>{s.orders.push({...structuredClone(order(s)),id:'duplicate'});}]) {
    const f=await financialDrawerFixture({prepare});assert.equal((await f.execute(cmd('refundPayment','bad',0))).status,'business-rejected');
  }
});
test('C3-A contract: approved payment actions have trusted employee HTTP exposure',()=>{
  for(const action of ['refundPayment','reversePayment','approveFinancialAdjustment','rejectFinancialAdjustment'])assert.equal(isHttpCommand(action),true);
});

test('C1-A: pre-credit payment reversal restores debt without rewriting approved principal',async()=>{
  const f=await financialDrawerFixture({prepare:s=>{const o=order(s);o.packageBaseCents=20000;o.status='已挂账';o.credit={amount:10000,remaining:10000,repayments:[],repaymentRequests:[]};}});
  await f.execute(cmd('reversePayment','r',0));const o=order(await read(f));
  assert.equal(o.credit.amount,10000);assert.equal(o.credit.remaining,20000);assert.equal(outstanding(o),20000);
});
test('C1-A: reversal already included in credit opening is not counted twice',async()=>{
  const f=await financialDrawerFixture();await f.execute(cmd('reversePayment','r',0));
  let s=await read(f),o=order(s);
  o.credit={amount:10000,remaining:10000,repayments:[],repaymentRequests:[],paymentReversalBaselineIds:[o.financialAdjustments[0].adjustmentId]};
  assert.equal(creditRepaymentRemaining(o),10000);
});
test('C1-A: active credit repayment after reversal uses effective balance and unchanged mirrors',async()=>{
  const f=await financialDrawerFixture({prepare:s=>{const o=order(s);o.status='已回款';o.payments[0].chargeId='credit-repayment';o.credit={amount:10000,remaining:0,repayments:[structuredClone(o.payments[0])],repaymentRequests:[]};}});
  await f.execute(cmd('reversePayment','r',0));f.accounts.get(ownerId).grants.push('credit.repay','credit.repay.approve');
  assert.equal((await f.execute({action:'repay',operationKey:'repay',expectedRevision:1,payload:{order:orderId,amount:4000,method:'微信'}})).status,'committed');
  f.accounts.get(reviewerId).grants.push('credit.repay.approve');
  let s=await read(f),request=order(s).credit.repaymentRequests[0];
  assert.equal((await f.execute({action:'approveRepayment',operationKey:'decide',expectedRevision:2,payload:{order:orderId,request:request.id}},reviewerId)).status,'committed');
  const o=order(await read(f));assert.equal(o.credit.remaining,6000);assert.equal(creditRepaymentRemaining(o),6000);
  assert.deepEqual(o.payments[0],order(f.state).payments[0]);assert.equal(o.credit.repayments.length,2);
});

test('C1-A: partial reversal rejects and approved intent cannot be changed at execution',async()=>{
  const f=await financialDrawerFixture();
  assert.equal((await f.execute(cmd('reversePayment','partial',0,{amount:1}))).status,'business-rejected');
  await f.execute(cmd('refundPayment','submit',0),applicantId);
  const r=(await read(f)).financialRequests[0];
  await f.execute(decision('approveFinancialAdjustment','approve',1,r.requestId),reviewerId);
  const bad=execution('refundPayment','mutated',2,r.requestId);bad.payload.amount=1;
  assert.equal((await f.execute(bad,applicantId)).status,'business-rejected');
  assert.equal((await read(f)).financialRequests[0].status,'已批准');
});
test('C1-A: concurrent applications cannot reserve the same remaining money twice',async()=>{
  const f=await financialDrawerFixture();
  const results=await Promise.all([
    f.execute(cmd('refundPayment','a',0,{amount:7000}),applicantId),
    f.execute(cmd('refundPayment','b',0,{amount:7000}),reviewerId)
  ]);
  assert.deepEqual(results.map(r=>r.status),['committed','revision-conflict']);
  assert.equal((await f.execute(cmd('refundPayment','fresh',1,{amount:7000}),reviewerId)).status,'business-rejected');
  assert.equal((await read(f)).financialRequests.length,1);
});
test('C1-A: concurrent executions consume the same approved request once',async()=>{
  const f=await financialDrawerFixture();await f.execute(cmd('refundPayment','submit',0),applicantId);
  const r=(await read(f)).financialRequests[0];
  await f.execute(decision('approveFinancialAdjustment','approve',1,r.requestId),reviewerId);
  const results=await Promise.all(['x','y'].map(key=>f.execute(execution('refundPayment',key,2,r.requestId),applicantId)));
  assert.deepEqual(results.map(r=>r.status),['committed','revision-conflict']);
  assert.equal(order(await read(f)).financialAdjustments.length,1);
});
test('C1-A: existing settle uses reversed billing credit, while refund does not create another amount to settle',async()=>{
  const f=await financialDrawerFixture();f.accounts.get(ownerId).grants.push('payment.settle');
  await f.execute(cmd('reversePayment','r',0));
  assert.equal((await f.execute({action:'settle',operationKey:'settle',expectedRevision:1,payload:{order:orderId,payments:[{method:'现金',amount:10000}],differenceType:'',differenceNote:''}})).status,'committed');
  assert.equal(outstanding(order(await read(f))),0);
  const g=await financialDrawerFixture();g.accounts.get(ownerId).grants.push('payment.settle');
  await g.execute(cmd('refundPayment','refund',0));
  assert.equal((await g.execute({action:'pay',operationKey:'wrong-extra-money',expectedRevision:1,payload:{order:orderId,payments:[{method:'现金',amount:3000}]}})).status,'business-rejected');
});
test('C1-A: omitted store timezone rejects before creating a request or adjustment',async()=>{
  const f=await financialDrawerFixture();const {createTrustedLedgerApplication}=await import('./ledger/application.js');
  const app=createTrustedLedgerApplication({store:f.store});
  await assert.rejects(app.execute(cmd('refundPayment','no-zone',0),f.credentials.get(ownerId)),/timeZone/);
  assert.deepEqual((await f.memory.read()).state,f.state);assert.equal((await f.memory.read()).operationResults.size,0);
});
test('C1-A: pending credit approval cannot be silently changed by a payment reversal',async()=>{
  const f=await financialDrawerFixture({prepare:s=>{order(s).status='待审批挂账';order(s).credit={amount:10000,remaining:10000,repayments:[]};}});
  assert.equal((await f.execute(cmd('reversePayment','pending-credit',0))).status,'business-rejected');
  assert.deepEqual(order(await read(f)),order(f.state));
});
