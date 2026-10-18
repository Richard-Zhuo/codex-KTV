import test from 'node:test';
import assert from 'node:assert/strict';
import { financialFixture, financialCommand, financialOrder, ownerId } from './test-support/financial-adjustments-fixture.js';
import { cashOutBalance } from './financial-adjustments.js';
const handover=(key,rev,actualCash=10000)=>({action:'handover',operationKey:key,expectedRevision:rev,payload:{actualCash}});
const cashOut=(key,rev,amountCents=1000)=>({action:'cashOut',operationKey:key,expectedRevision:rev,payload:{amountCents,reason:'Confirmed drawer withdrawal'}});
function fixture(prepare=()=>{}){
  const f=financialFixture({prepare});f.accounts.get(ownerId).grants.push('handover','cash.out','payment.collect');return f;
}
const read=async f=>(await f.memory.read()).state;
async function committed(f,c,id=ownerId){const r=await f.execute(c,id);assert.equal(r.status,'committed',JSON.stringify(r));return r;}
test('C2-A: attributed current drawer refund and independent cashOut are counted once in handover',async()=>{
  const f=fixture();await committed(f,handover('baseline',0));
  const baseline=structuredClone((await read(f)).handovers[0]),payments=structuredClone(financialOrder(f.state).payments);
  await committed(f,financialCommand('refundPayment','refund',1,{amount:2000}));
  let s=await read(f);assert.equal(financialOrder(s).financialAdjustments[0].drawerHandoverId,baseline.handoverId);
  await committed(f,cashOut('cash-out',2));
  await committed(f,handover('close',3,7000));s=await read(f);
  const h=s.handovers.at(-1);
  assert.equal(h.expectedCash,7000);assert.equal(h.intervalCashOut,3000);
  assert.equal(h.intervalRefundCashOut,2000);assert.equal(h.intervalIndependentCashOut,1000);
  assert.equal(h.cashBoundary.version,'cash-fact-set-v2');
  assert.equal(h.cashBoundary.facts.filter(f=>f.kind==='REFUND').length,1);
  assert.equal(h.cashBoundary.facts.filter(f=>f.kind==='CASH_OUT').length,1);
  assert.deepEqual(s.handovers[0],baseline);assert.deepEqual(financialOrder(s).payments,payments);
  assert.equal(cashOutBalance(s).available,7000);
  await committed(f,handover('next',4,7000));
  assert.equal((await read(f)).handovers.at(-1).intervalCashOut,0);
});

import { applicantId, reviewerId, paymentId, orderId } from './test-support/financial-adjustments-fixture.js';
import { readTrustedDrawer } from './handover.js';
const CASH='\u73b0\u91d1', WECHAT='\u5fae\u4fe1';
const rejected=async(f,c,id=ownerId)=>{const r=await f.execute(c,id);assert.equal(r.status,'business-rejected',JSON.stringify(r));return r;};
const collect=(key,rev,method=CASH)=>({action:'collect',operationKey:key,expectedRevision:rev,payload:{order:orderId,charge:'open',payments:[{method,amount:10000}]}});
const approve=(key,rev,requestId)=>({action:'approveFinancialAdjustment',operationKey:key,expectedRevision:rev,payload:{requestId}});
const executeCash=(key,rev,requestId)=>({action:'cashOut',operationKey:key,expectedRevision:rev,payload:{requestId}});
function legacyHandover(s,id='90000000-0000-4000-8000-000000000001',actualCash=10000,previous=null){
  const p=financialOrder(s).payments[0];
  return {id:1,trustedHandoverVersion:'drawer-v1',handoverId:id,occurredAt:'2026-10-15T12:00:00.000000Z',
    submittedByPrincipalId:ownerId,actualCash,expectedCash:previous?previous.actualCash:actualCash,
    difference:previous?actualCash-previous.actualCash:0,previousHandoverId:previous?.handoverId??null,bootstrap:!previous,
    cashBoundary:{version:'payment-set-v1',payments:[{paymentId:p.paymentId,signature:JSON.stringify([orderId,CASH,10000,p.occurredAt,ownerId,null,null])}],legacyPayments:[]},
    intervalCashIn:0,intervalCashOut:0,intervalByChannel:{},expected:actualCash,actual:actualCash,drawerCash:actualCash};
}
function historicalRefund(){
  return {adjustmentId:'90000000-0000-4000-8000-000000000010',kind:'REFUND',originalPaymentId:paymentId,amount:3000,
    reason:'Historical confirmed cash refund without a drawer cursor',actualActorPrincipalId:ownerId,occurredAt:'2026-10-15T12:00:00.000000Z',
    businessDate:'2026-10-15',businessDayRuleVersion:'cutoff-0600-v1',businessTimeZone:'Asia/Shanghai',requestId:null,
    refundChannel:CASH,refundFundingSource:'CURRENT_DRAWER',affectsCurrentDrawer:true};
}
function historicalCashOut(handoverId){
  return {cashOutId:'90000000-0000-4000-8000-000000000011',amountCents:3000,reason:'Historical independent drawer cash withdrawal',
    actualActorPrincipalId:ownerId,occurredAt:'2026-10-15T12:00:00.000000Z',
    businessDate:'2026-10-15',businessDayRuleVersion:'cutoff-0600-v1',businessTimeZone:'Asia/Shanghai',requestId:null,drawerHandoverId:handoverId};
}
for(const method of [CASH,WECHAT])test('C2-A: baseline and new '+method+' receipt have the correct cash effect',async()=>{
  const f=fixture(s=>financialOrder(s).payments=[]);await committed(f,handover('baseline',0,1000));
  await committed(f,collect('payment',1,method));await committed(f,handover('close',2,method===CASH?11000:1000));
  const h=(await read(f)).handovers.at(-1);
  assert.equal(h.intervalCashIn,method===CASH?10000:0);assert.equal(h.expectedCash,method===CASH?11000:1000);
  assert.equal(h.intervalCashOut,0);assert.equal(h.intervalByChannel[method],10000);
});
for(const [channel,source] of [[CASH,'OUTSIDE_DRAWER'],[WECHAT,'NON_CASH']])
test('C2-A: '+source+' refund is not a current drawer movement',async()=>{
  const f=fixture();await committed(f,handover('baseline',0));
  await committed(f,financialCommand('refundPayment','refund',1,{refundChannel:channel,refundFundingSource:source}));
  await committed(f,handover('close',2));
  const h=(await read(f)).handovers.at(-1);assert.equal(h.expectedCash,10000);assert.equal(h.intervalCashOut,0);
  assert.equal(h.cashBoundary.facts.length,0);
});
test('C2-A: reversing an erroneous new receipt removes cashIn, never creates cashOut',async()=>{
  const f=fixture(s=>financialOrder(s).payments=[]);await committed(f,handover('baseline',0,1000));
  await committed(f,collect('payment',1));const p=financialOrder(await read(f)).payments[0];
  await committed(f,financialCommand('reversePayment','correct',2,{originalPaymentId:p.paymentId}));
  await committed(f,handover('close',3,1000));const s=await read(f),h=s.handovers.at(-1);
  assert.equal(h.intervalCashIn,0);assert.equal(h.intervalCashOut,0);assert.equal(h.expectedCash,1000);
  assert.equal(h.cashBoundary.facts[0].kind,'PAYMENT_REVERSAL');assert.deepEqual(financialOrder(s).payments,[p]);
});
test('C2-A: reversal of a counted payment does not debit actual cash or rewrite the previous interval',async()=>{
  const f=fixture(s=>financialOrder(s).payments=[]);await committed(f,handover('baseline',0,0));
  await committed(f,collect('payment',1));await committed(f,handover('paid-count',2,10000));
  const previous=structuredClone((await read(f)).handovers),p=financialOrder(await read(f)).payments[0];
  await committed(f,financialCommand('reversePayment','late-correction',3,{originalPaymentId:p.paymentId}));
  await committed(f,handover('after-correction',4,10000));
  const s=await read(f),h=s.handovers.at(-1);assert.deepEqual(s.handovers.slice(0,2),previous);
  assert.equal(previous[1].intervalCashIn,10000);assert.equal(h.intervalCashIn,0);assert.equal(h.intervalCashOut,0);
  assert.equal(h.expectedCash,10000);assert.equal(h.cashBoundary.facts[0].kind,'PAYMENT_REVERSAL');
});
test('C2-A: approved cashOut is only a reservation, and an older request executes against the current count',async()=>{
  const f=fixture();f.accounts.get(applicantId).grants.push('cash.out');
  await committed(f,handover('baseline',0));await committed(f,cashOut('request',1,7000),applicantId);
  const requestId=(await read(f)).financialRequests[0].requestId;
  await committed(f,approve('approve',2,requestId),reviewerId);
  await committed(f,handover('before-execution',3));
  let s=await read(f),h=s.handovers.at(-1);assert.equal(h.intervalCashOut,0);assert.equal(h.expectedCash,10000);
  const latestId=h.handoverId;await committed(f,executeCash('execute',4,requestId),applicantId);
  s=await read(f);assert.equal(s.cashOutflows[0].drawerHandoverId,latestId);
  await committed(f,handover('after-execution',5,3000));h=(await read(f)).handovers.at(-1);
  assert.equal(h.intervalCashOut,7000);assert.equal(h.expectedCash,3000);
});
test('C2-A: old approved intent cannot use an old larger balance after a new physical count',async()=>{
  const f=fixture();f.accounts.get(applicantId).grants.push('cash.out');
  await committed(f,handover('baseline',0));await committed(f,cashOut('request',1,7000),applicantId);
  const requestId=(await read(f)).financialRequests[0].requestId;
  await committed(f,approve('approve',2,requestId),reviewerId);await committed(f,handover('short-count',3,2000));
  const before=await read(f);await rejected(f,executeCash('execute',4,requestId),applicantId);
  const s=await read(f);assert.deepEqual(s,before);assert.equal(s.handovers.at(-1).difference,-8000);
  assert.equal(s.cashOutflows,undefined);assert.equal(s.financialRequests[0].executedAdjustmentId,null);
});
test('C2-A: approved refund is not paid until execution and binds the execution-time handover',async()=>{
  const f=fixture();await committed(f,handover('baseline',0));
  await committed(f,financialCommand('refundPayment','request',1,{amount:3000}),applicantId);
  const requestId=(await read(f)).financialRequests[0].requestId;
  await committed(f,approve('approve',2,requestId),reviewerId);await committed(f,handover('new-count',3));
  let s=await read(f),latest=s.handovers.at(-1);
  assert.equal(latest.intervalCashOut,0);assert.equal(financialOrder(s).financialAdjustments,undefined);
  await committed(f,{action:'refundPayment',operationKey:'execute',expectedRevision:4,payload:{order:orderId,requestId}},applicantId);
  s=await read(f);assert.equal(financialOrder(s).financialAdjustments[0].drawerHandoverId,latest.handoverId);
  await committed(f,handover('close',5,7000));assert.equal((await read(f)).handovers.at(-1).intervalRefundCashOut,3000);
});
test('C2-A: missing physical baseline rejects a new CURRENT_DRAWER execution without manufacturing attribution',async()=>{
  const f=fixture(),before=await read(f);
  await rejected(f,financialCommand('refundPayment','no-baseline',0));
  assert.deepEqual(await read(f),before);
});
for(const withPrevious of [false,true])test('C2-A: unbound historical refund stays blocked even at a new count; previous='+withPrevious,async()=>{
  const f=fixture(s=>{financialOrder(s).financialAdjustments=[historicalRefund()];if(withPrevious)s.handovers.push(legacyHandover(s));});
  const before=await read(f);
  await rejected(f,handover('cannot-launder',0,7000));await rejected(f,cashOut('cannot-spend',0,1));
  assert.deepEqual(await read(f),before);
});
test('C2-A: v1 physical count upgrades without mutating history; current-cursor C1-B cashOut is counted once',async()=>{
  const f=fixture(s=>s.handovers.push(legacyHandover(s))),old=structuredClone(f.state.handovers);
  await committed(f,cashOut('old-cursor-out',0,1000));await committed(f,handover('upgrade',1,9000));
  let s=await read(f),h=s.handovers.at(-1);
  assert.deepEqual(s.handovers.slice(0,1),old);assert.equal(h.trustedHandoverVersion,'drawer-v2');
  assert.equal(h.intervalCashOut,1000);assert.equal(h.expectedCash,9000);
  await committed(f,handover('next',2,9000));s=await read(f);assert.equal(s.handovers.at(-1).intervalCashOut,0);
});
test('C2-A: C1-B cashOut absorbed by a later v1 count is not deducted again; discrepancy history stays intact',async()=>{
  const f=fixture(s=>{
    const first=legacyHandover(s),second=legacyHandover(s,'90000000-0000-4000-8000-000000000002',7000,first);
    s.handovers.push(first,second);s.cashOutflows=[historicalCashOut(first.handoverId)];
  }),old=structuredClone(f.state.handovers);
  await committed(f,handover('upgrade',0,7000));
  const s=await read(f),h=s.handovers.at(-1);assert.deepEqual(s.handovers.slice(0,2),old);
  assert.equal(old[1].difference,-3000);assert.equal(h.intervalCashOut,0);assert.equal(h.expectedCash,7000);
  assert.equal(h.cashBoundary.facts.length,1);
});
test('C2-A: completed movement snapshots reject changed, removed or reparented refund facts',async()=>{
  const f=fixture();await committed(f,handover('baseline',0));await committed(f,financialCommand('refundPayment','refund',1));
  await committed(f,handover('close',2,7000));const original=await read(f);
  for(const mutate of [
    s=>financialOrder(s).financialAdjustments[0].amount=1000,
    s=>financialOrder(s).financialAdjustments=[],
    s=>financialOrder(s).financialAdjustments[0].drawerHandoverId=s.handovers.at(-1).handoverId,
    s=>s.handovers.at(-1).cashBoundary.facts=[]
  ]){
    const state=structuredClone(original);mutate(state);assert.throws(()=>readTrustedDrawer(state));
  }
});
test('C2-A: handover replay after a later cashOut never advances the old boundary twice',async()=>{
  const f=fixture();await committed(f,handover('baseline',0));await committed(f,cashOut('first',1,1000));
  const close=handover('close',2,9000),result=await committed(f,close);
  await committed(f,cashOut('second',3,1000));const before=await f.memory.read();
  assert.deepEqual(await f.execute(close),result);assert.deepEqual(await f.memory.read(),before);
  await committed(f,handover('next',4,8000));const h=(await read(f)).handovers.at(-1);
  assert.equal(h.intervalCashOut,1000);assert.equal(h.expectedCash,8000);
});
for(const [instant,date] of [['2026-10-15T21:59:59.000000Z','2026-10-15'],['2026-10-15T22:00:00.000000Z','2026-10-16']])
test('C2-A: same-instant cash refund / withdrawal / handover preserve 06:00 facts at '+instant,async()=>{
  const f=fixture();await committed(f,handover('baseline',0));f.setTime(instant);
  await committed(f,financialCommand('refundPayment','refund',1,{amount:2000}));await committed(f,cashOut('cash-out',2));
  await committed(f,handover('close',3,7000));
  const s=await read(f),refund=financialOrder(s).financialAdjustments[0],withdrawal=s.cashOutflows[0],h=s.handovers.at(-1);
  for(const fact of [refund,withdrawal]){
    assert.equal(fact.occurredAt,instant);assert.equal(fact.businessDate,date);
    assert.equal(fact.businessDayRuleVersion,'cutoff-0600-v1');assert.equal(fact.businessTimeZone,'Asia/Shanghai');
  }
  assert.equal(h.occurredAt,instant);assert.equal(h.expectedCash,7000);assert.equal(h.intervalCashOut,3000);
});
test('C2-A: cash refund and cashOut requests reserve the same actual drawer authority',async()=>{
  const f=fixture();f.accounts.get(applicantId).grants.push('cash.out');
  await committed(f,handover('baseline',0));await committed(f,cashOut('request',1,7000),applicantId);
  await rejected(f,financialCommand('refundPayment','excess-refund',2,{amount:4000}));
  await committed(f,financialCommand('refundPayment','safe-refund',2,{amount:3000}));
  const s=await read(f);assert.equal(s.cashOutflows,undefined);assert.equal(cashOutBalance(s).available,0);
  await committed(f,handover('count',3,7000));
  const requestId=(await read(f)).financialRequests[0].requestId;
  await committed(f,approve('approve',4,requestId),reviewerId);
  await committed(f,executeCash('execute',5,requestId),applicantId);
  await committed(f,handover('empty',6,0));assert.equal((await read(f)).handovers.at(-1).expectedCash,0);
});

test('C2-A: a newly executed refund can bind an existing v1 count and enter the first v2 interval',async()=>{
  const f=fixture(s=>s.handovers.push(legacyHandover(s))),old=structuredClone(f.state.handovers[0]);
  await committed(f,financialCommand('refundPayment','refund',0,{amount:2000}));
  const refund=financialOrder(await read(f)).financialAdjustments[0];assert.equal(refund.drawerHandoverId,old.handoverId);
  await committed(f,handover('upgrade',1,8000));const s=await read(f);
  assert.equal(s.handovers.at(-1).intervalRefundCashOut,2000);assert.deepEqual(s.handovers[0],old);
});
test('C2-A: v1 boundary cannot acquire v2 fact authority by adding a facts property',async()=>{
  const f=fixture(s=>{const h=legacyHandover(s);h.cashBoundary.facts=[];s.handovers.push(h);});
  await rejected(f,handover('invalid-version-boundary',0));await rejected(f,cashOut('invalid-cash',0,1));
});
