import test from 'node:test';
import assert from 'node:assert/strict';
import { financialFixture, ownerId } from './test-support/financial-adjustments-fixture.js';

test('C1-B: trusted cashOut appends a distinct fact after an actual drawer count', async () => {
  const f = financialFixture();
  f.accounts.get(ownerId).grants.push('handover', 'cash.out');
  assert.equal((await f.execute({action:'handover', operationKey:'c1b-count', expectedRevision:0, payload:{actualCash:10000}})).status, 'committed');
  const before = (await f.memory.read()).state;
  const result = await f.execute({action:'cashOut', operationKey:'c1b-out', expectedRevision:1, payload:{amountCents:3000, reason:'Confirmed drawer withdrawal'}});
  assert.equal(result.status, 'committed');
  const after = (await f.memory.read()).state;
  assert.equal(after.cashOutflows.length, 1);
  assert.equal(after.cashOutflows[0].amountCents, 3000);
  assert.equal(after.cashOutflows[0].actualActorPrincipalId, ownerId);
  assert.deepEqual(after.orders, before.orders);
  assert.deepEqual(after.expenses, before.expenses);
  assert.deepEqual(after.inventory, before.inventory);
});

test('C1-B: cashOut uses shared two-person approval and applicant-only single consumption', async () => {
  const { applicantId, reviewerId } = await import('./test-support/financial-adjustments-fixture.js');
  const f = financialFixture();
  f.accounts.get(ownerId).grants.push('handover', 'cash.out');
  f.accounts.get(applicantId).grants.push('cash.out');
  f.accounts.get(reviewerId).grants.push('cash.out');
  await f.execute({action:'handover', operationKey:'approval-count', expectedRevision:0, payload:{actualCash:10000}});
  const command = (key, revision, payload) => ({action:'cashOut', operationKey:key, expectedRevision:revision, payload});
  assert.equal((await f.execute(command('request',1,{amountCents:7000,reason:'Confirmed withdrawal'}),applicantId)).status,'committed');
  let state = (await f.memory.read()).state;
  const requestId = state.financialRequests[0].requestId;
  assert.equal(state.cashOutflows,undefined);
  assert.equal((await f.execute(command('reserve',2,{amountCents:4000,reason:'Exceeds available cash'}))).status,'business-rejected');
  assert.equal((await f.execute(command('early',2,{requestId}),applicantId)).status,'business-rejected');
  const approve={action:'approveFinancialAdjustment',operationKey:'approve',expectedRevision:2,payload:{requestId}};
  await assert.rejects(f.execute({...approve,operationKey:'self'},applicantId),e=>e.code==='AUTHORIZATION_DENIED');
  assert.equal((await f.execute(approve,reviewerId)).status,'committed');
  await assert.rejects(f.execute(command('other',3,{requestId}),reviewerId),e=>e.code==='AUTHORIZATION_DENIED');
  f.setTime('2026-10-15T22:00:00.123456Z');
  const c=command('execute',3,{requestId}), first=await f.execute(c,applicantId);
  assert.equal(first.status,'committed');assert.deepEqual(await f.execute(c,applicantId),first);
  assert.equal((await f.execute(command('new-key',4,{requestId}),applicantId)).status,'business-rejected');
  state=(await f.memory.read()).state;
  assert.equal(state.cashOutflows.length,1);
  assert.equal(state.cashOutflows[0].actualActorPrincipalId,applicantId);
  assert.equal(state.cashOutflows[0].occurredAt,'2026-10-15T22:00:00.123456Z');
  assert.equal(state.cashOutflows[0].businessDate,'2026-10-16');
  assert.equal(state.financialRequests[0].executedAdjustmentId,state.cashOutflows[0].cashOutId);
});

test('C1-B: unpaid retail cancellation preserves sales, payment arrays, inventory and original stock ledger', async () => {
  const { financialOrder } = await import('./test-support/financial-adjustments-fixture.js');
  const f=financialFixture({prepare:s=>{
    const o=financialOrder(s);o.kind='retail';o.room=null;o.payments=[];
    o.sales=[{id:101,productId:'bw',total:10000,totalBaseQuantity:2}];
    s.rooms[0].order=null;s.rooms[0].status='\u7a7a\u95f2';
    s.ledger.push({id:102,product:'bw',delta:-2});
  }});
  f.accounts.get(ownerId).grants.push('order.cancel');
  const before=structuredClone(financialOrder(f.state));
  const c={action:'cancelOrder',operationKey:'cancel',expectedRevision:0,payload:{order:before.id,reason:'Customer withdrew unpaid order'}};
  const result=await f.execute(c);assert.equal(result.status,'committed');
  const state=(await f.memory.read()).state, o=financialOrder(state);
  assert.equal(o.status,'\u5df2\u64a4\u5355');
  assert.deepEqual(o.sales,before.sales);assert.deepEqual(o.payments,before.payments);
  assert.equal(o.cancellation.orderId,o.id);assert.equal(o.cancellation.actualActorPrincipalId,ownerId);
  assert.deepEqual(state.inventory,f.state.inventory);assert.deepEqual(state.ledger,f.state.ledger);
  assert.deepEqual(await f.execute(c),result);
  assert.equal((await f.execute({...c,operationKey:'cancel-again',expectedRevision:1})).status,'business-rejected');
});

import { financialCommand, financialOrder, orderId, applicantId, reviewerId, paymentId } from './test-support/financial-adjustments-fixture.js';
import { cashOutBalance } from './financial-adjustments.js';
import { isHttpCommand } from './http/registry.js';
const cash = (key,rev,amount=3000,extra={})=>({action:'cashOut',operationKey:key,expectedRevision:rev,payload:{amountCents:amount,reason:'Confirmed withdrawal',...extra}});
const cancel = (key='cancel',rev=0,extra={})=>({action:'cancelOrder',operationKey:key,expectedRevision:rev,payload:{order:orderId,reason:'Unpaid customer cancellation',...extra}});
const read = async f=>(await f.memory.read()).state;
function coreFixture(prepare=()=>{}) {
  const f=financialFixture({prepare});
  for(const id of [ownerId,applicantId,reviewerId])f.accounts.get(id).grants.push('cash.out','order.cancel');
  f.accounts.get(ownerId).grants.push('handover','payment.collect');
  return f;
}
async function counted(f,actualCash=10000) {
  const head=await f.memory.read();
  assert.equal((await f.execute({action:'handover',operationKey:'count-'+head.revision,expectedRevision:head.revision,payload:{actualCash}})).status,'committed');
}
for(const amount of [0,-1,0.5,Number.MAX_SAFE_INTEGER+1])test('C1-B: cashOut rejects invalid cents '+amount,async()=>{
  const f=coreFixture();await counted(f);
  assert.equal((await f.execute(cash('invalid',1,amount))).status,'business-rejected');
  assert.equal((await read(f)).cashOutflows,undefined);
});
for(const extra of [{reason:''},{reason:'   '},{actualActorPrincipalId:'forged'},{occurredAt:'1900-01-01T00:00:00Z'}])
test('C1-B: cashOut rejects invalid reason or client authority '+JSON.stringify(extra),async()=>{
  const f=coreFixture();await counted(f);assert.equal((await f.execute(cash('invalid',1,3000,extra))).status,'business-rejected');
  assert.equal((await read(f)).cashOutflows,undefined);
});
for(const prepare of [()=>{},s=>s.handovers.push({actualCash:1000000}),s=>s.handovers.push({trustedHandoverVersion:'drawer-v1',actualCash:1000000})])
test('C1-B: cashOut refuses absent, demo-only or malformed drawer baseline',async()=>{
  const f=coreFixture(prepare);assert.equal((await f.execute(cash('no-baseline',0))).status,'business-rejected');
  assert.equal((await read(f)).cashOutflows,undefined);
});
test('C1-B: cashOut direct replay, current permissions and consumed physical balance',async()=>{
  const f=coreFixture();await counted(f);
  const c=cash('first',1,7000),r=await f.execute(c);assert.equal(r.status,'committed');
  assert.deepEqual(await f.execute(c),r);
  assert.equal((await f.execute({...c,payload:{...c.payload,amountCents:1}})).status,'idempotency-conflict');
  assert.equal((await f.execute(cash('excess',2,4000))).status,'business-rejected');
  f.accounts.get(ownerId).grants=f.accounts.get(ownerId).grants.filter(g=>g!=='cash.out');
  assert.deepEqual(await f.execute(c),r);
  await assert.rejects(f.execute(cash('revoked',2,1)),e=>e.code==='AUTHORIZATION_DENIED');
  assert.equal((await read(f)).cashOutflows.length,1);
});
test('C1-B: new actual count absorbs old cashOut once with the integrated handover formula',async()=>{
  const f=coreFixture();await counted(f);
  assert.equal((await f.execute(cash('first',1,7000))).status,'committed');await counted(f,3000);
  const state=await read(f);
  assert.equal(state.handovers.at(-1).intervalCashOut,7000);
  assert.equal(state.handovers.at(-1).expectedCash,3000);
  assert.equal(cashOutBalance(state).available,3000);
  assert.equal((await f.execute(cash('all-remaining',3,3000))).status,'committed');
  assert.equal((await f.execute(cash('one-too-many',4,1))).status,'business-rejected');
});
for(const [instant,date] of [['2026-10-15T21:59:59.000000Z','2026-10-15'],['2026-10-15T22:00:00.000000Z','2026-10-16']])
test('C1-B: cashOut freezes 06:00 day at '+instant,async()=>{
  const f=coreFixture();await counted(f);f.setTime(instant);
  assert.equal((await f.execute(cash('time',1))).status,'committed');
  const fact=(await read(f)).cashOutflows[0];
  assert.equal(fact.occurredAt,instant);assert.equal(fact.businessDate,date);
  assert.equal(fact.businessDayRuleVersion,'cutoff-0600-v1');assert.equal(fact.businessTimeZone,'Asia/Shanghai');
});
test('C1-B: pending refund reserves current drawer and executed refund is not duplicated as cashOut',async()=>{
  const f=coreFixture();await counted(f);
  assert.equal((await f.execute(financialCommand('refundPayment','refund-request',1,{amount:7000}),applicantId)).status,'committed');
  assert.equal((await f.execute(cash('excess',2,4000))).status,'business-rejected');
  assert.equal((await f.execute(cash('safe',2,3000))).status,'committed');
  let state=await read(f);const requestId=state.financialRequests[0].requestId;
  assert.equal((await f.execute({action:'approveFinancialAdjustment',operationKey:'approve-refund',expectedRevision:3,payload:{requestId}},reviewerId)).status,'committed');
  assert.equal((await f.execute({action:'refundPayment',operationKey:'execute-refund',expectedRevision:4,payload:{order:orderId,requestId}},applicantId)).status,'committed');
  state=await read(f);
  assert.equal(state.cashOutflows.length,1);assert.equal(financialOrder(state).financialAdjustments.length,1);
  assert.equal((await f.execute(cash('ambiguous-boundary',5,1))).status,'business-rejected');
  assert.equal((await read(f)).cashOutflows.length,1);
});
test('C1-B: outside-drawer refund does not invent a drawer outflow',async()=>{
  const f=coreFixture();await counted(f);
  assert.equal((await f.execute(financialCommand('refundPayment','outside',1,{refundFundingSource:'OUTSIDE_DRAWER'}))).status,'committed');
  assert.equal((await f.execute(cash('drawer',2,10000))).status,'committed');
  assert.equal((await read(f)).cashOutflows.length,1);assert.equal((await read(f)).expenses.length,0);
});
test('C1-B: new trusted cash receipts count once; reversed receipts cannot fund cashOut',async()=>{
  const f=coreFixture(s=>financialOrder(s).payments=[]);await counted(f,0);
  assert.equal((await f.execute({action:'collect',operationKey:'receive',expectedRevision:1,payload:{order:orderId,charge:'open',payments:[{method:'\u73b0\u91d1',amount:10000}]}})).status,'committed');
  let state=await read(f),p=financialOrder(state).payments[0];
  assert.equal(cashOutBalance(state).available,10000);
  assert.equal((await f.execute(financialCommand('reversePayment','reverse',2,{originalPaymentId:p.paymentId}))).status,'committed');
  assert.equal((await f.execute(cash('cannot-spend-correction',3,1))).status,'business-rejected');
});
test('C1-B: pending reversal reserves uncounted cash receipt authority',async()=>{
  const f=coreFixture(s=>financialOrder(s).payments=[]);await counted(f,0);
  await f.execute({action:'collect',operationKey:'receive',expectedRevision:1,payload:{order:orderId,charge:'open',payments:[{method:'\u73b0\u91d1',amount:10000}]}});
  const p=financialOrder(await read(f)).payments[0];
  await f.execute(financialCommand('reversePayment','reverse-request',2,{originalPaymentId:p.paymentId}),applicantId);
  assert.equal((await f.execute(cash('reserved-receipt',3,1))).status,'business-rejected');
});
test('C1-B: reject cashOut request releases reservation; no false fact is produced',async()=>{
  const f=coreFixture();await counted(f);
  await f.execute(cash('submit',1,7000),applicantId);
  const requestId=(await read(f)).financialRequests[0].requestId;
  await f.execute({action:'rejectFinancialAdjustment',operationKey:'reject',expectedRevision:2,payload:{requestId,decisionNote:'Withdrawal cancelled'}},reviewerId);
  assert.equal((await read(f)).cashOutflows,undefined);
  assert.equal((await f.execute(cash('all',3,10000))).status,'committed');
});
for(const principal of [ownerId,applicantId,reviewerId])test('C1-B: explicit order.cancel grant permits independent operator '+principal,async()=>{
  const f=coreFixture(s=>financialOrder(s).payments=[]);
  assert.equal((await f.execute(cancel(),principal)).status,'committed');
});
test('C1-B: lacking grants cannot cashOut, approve or cancel regardless of display identity',async()=>{
  const f=coreFixture(s=>financialOrder(s).payments=[]);f.accounts.get(applicantId).grants=[];
  for(const c of [cash('cash',0),cancel(),{action:'approveFinancialAdjustment',operationKey:'approve',expectedRevision:0,payload:{requestId:'70000000-0000-4000-8000-000000000099'}}])
    await assert.rejects(f.execute(c,applicantId),e=>e.code==='AUTHORIZATION_DENIED');
});
for(const extra of [{reason:''},{reason:' '},{actualActorPrincipalId:'forged'},{occurredAt:'1900-01-01T00:00:00Z'}])
test('C1-B: cancel requires reason and refuses client authority '+JSON.stringify(extra),async()=>{
  const f=coreFixture(s=>financialOrder(s).payments=[]);
  assert.equal((await f.execute(cancel('bad',0,extra))).status,'business-rejected');
  assert.equal(financialOrder(await read(f)).cancellation,undefined);
});
for(const kind of ['effective-payment','fully-refunded','fully-reversed','unresolved-credit','pending-rounding','pending-financial','unknown-payments'])
test('C1-B: cancellation fails closed for '+kind,async()=>{
  const f=coreFixture(s=>{
    const o=financialOrder(s);
    if(!['effective-payment','fully-refunded','fully-reversed'].includes(kind))o.payments=[];
    if(kind==='unresolved-credit')o.credit={amount:10000,remaining:10000};
    if(kind==='pending-rounding')o.roundingReview={status:'\u5f85\u5ba1\u6838',amount:10000};
    if(kind==='pending-financial')s.financialRequests=[{requestId:'70000000-0000-4000-8000-000000000099',kind:'REFUND',orderId,originalPaymentId:paymentId,amount:100,reason:'Pending financial request',submittedByPrincipalId:applicantId,submittedAt:'2026-10-15T12:00:00.000000Z',status:'\u5f85\u5ba1\u6838',decidedByPrincipalId:null,decidedAt:null,executedAdjustmentId:null,refundChannel:'\u73b0\u91d1',refundFundingSource:'CURRENT_DRAWER'}];
    if(kind==='unknown-payments')delete o.payments;
  });
  let rev=0;
  if(kind==='fully-refunded'||kind==='fully-reversed'){
    const action=kind==='fully-refunded'?'refundPayment':'reversePayment';
    assert.equal((await f.execute(financialCommand(action,'adjust',0,{amount:10000,...(action==='refundPayment'?{refundFundingSource:'OUTSIDE_DRAWER'}:{})}))).status,'committed');rev=1;
  }
  const before=await read(f);
  assert.equal((await f.execute(cancel('blocked',rev))).status,'business-rejected');
  assert.deepEqual(await read(f),before);
});
test('C1-B: old room cancellation preserves current new guest ownership',async()=>{
  const f=coreFixture(s=>{
    financialOrder(s).payments=[];
    s.orders.push({id:'new-guest',kind:'room',room:s.rooms[0].id,status:'\u8425\u4e1a\u4e2d',payments:[],sales:[]});
    s.rooms[0].order='new-guest';
  });
  const before=structuredClone(f.state.rooms),newGuest=structuredClone(f.state.orders[1]);
  assert.equal((await f.execute(cancel())).status,'committed');
  const s=await read(f);assert.deepEqual(s.rooms,before);assert.deepEqual(s.orders[1],newGuest);
});
test('C1-B: own room release is limited to original ownership; ambiguous ownership rejects',async()=>{
  const f=coreFixture(s=>financialOrder(s).payments=[]);
  assert.equal((await f.execute(cancel())).status,'committed');
  let s=await read(f);assert.equal(s.rooms[0].order,null);assert.equal(s.rooms[0].status,'\u5f85\u6e05\u6d01');
  const g=coreFixture(s=>{financialOrder(s).payments=[];s.rooms[0].order='missing-current-owner';});
  assert.equal((await g.execute(cancel())).status,'business-rejected');assert.deepEqual((await read(g)).rooms,g.state.rooms);
});
for(const readiness of ['DEVICE_PENDING','ACTIVE'])test('C1-B: cancellation retains required device admission '+readiness,async()=>{
  const f=coreFixture(s=>{const o=financialOrder(s);o.payments=[];o.deviceControl={mode:'required'};});
  const original=f.store.runAtomic;
  f.store.runAtomic=work=>original(tx=>{tx.roomControl={findByOrder:async()=>({roomReadiness:readiness})};return work(tx);});
  assert.equal((await f.execute(cancel())).status,readiness==='ACTIVE'?'committed':'business-rejected');
});
test('C1-B: failed transaction publishes neither cashOut nor consumed request',async()=>{
  const f=coreFixture();await counted(f);await f.execute(cash('submit',1),applicantId);
  const requestId=(await read(f)).financialRequests[0].requestId;
  await f.execute({action:'approveFinancialAdjustment',operationKey:'approve',expectedRevision:2,payload:{requestId}},reviewerId);
  const before=await f.memory.read(),original=f.store.runAtomic;
  f.store.runAtomic=work=>original(tx=>{const commit=tx.commit;tx.commit=async change=>{await commit(change);throw Error('C1B_ROLLBACK');};return work(tx);});
  const c={action:'cashOut',operationKey:'execute',expectedRevision:3,payload:{requestId}};
  await assert.rejects(f.execute(c,applicantId),/C1B_ROLLBACK/);
  assert.deepEqual(await f.memory.read(),before);
  f.store.runAtomic=original;assert.equal((await f.execute(c,applicantId)).status,'committed');
});
test('C1-B: cancelled order cannot later collect money through a fresh key',async()=>{
  const f=coreFixture(s=>financialOrder(s).payments=[]);
  await f.execute(cancel());
  assert.equal((await f.execute({action:'collect',operationKey:'late-payment',expectedRevision:1,payload:{order:orderId,charge:'open',payments:[{method:'\u73b0\u91d1',amount:10000}]}})).status,'business-rejected');
  assert.deepEqual(financialOrder(await read(f)).payments,[]);
});
test('C3-A contract: six financial actions use the explicit staff HTTP allowlist',()=>{
  for(const action of ['cashOut','cancelOrder','refundPayment','reversePayment','approveFinancialAdjustment','rejectFinancialAdjustment'])
    assert.equal(isHttpCommand(action),true);
});

test('C1-B: fourth independently granted operator may cancel without role/name authority',async()=>{
  const f=coreFixture(s=>financialOrder(s).payments=[]),id='70000000-0000-4000-8000-000000000005';
  f.accounts.set(id,{grants:['order.cancel']});f.credentials.set(id,{tokenDigest:Buffer.alloc(32,77)});
  assert.equal((await f.execute(cancel(),id)).status,'committed');
  assert.equal(financialOrder(await read(f)).cancellation.actualActorPrincipalId,id);
});
test('C1-B: approved cashOut protects its reservation from refunds and rechecks a later smaller count',async()=>{
  const f=coreFixture();await counted(f);await f.execute(cash('request',1,7000),applicantId);
  const requestId=(await read(f)).financialRequests[0].requestId;
  await f.execute({action:'approveFinancialAdjustment',operationKey:'approve',expectedRevision:2,payload:{requestId}},reviewerId);
  assert.equal((await f.execute(financialCommand('refundPayment','refund',3,{amount:7000}))).status,'business-rejected');
  await counted(f,3000);
  assert.equal((await f.execute({action:'cashOut',operationKey:'execute',expectedRevision:4,payload:{requestId}},applicantId)).status,'business-rejected');
  const s=await read(f);assert.equal(s.cashOutflows,undefined);assert.equal(s.financialRequests[0].executedAdjustmentId,null);
});
test('C1-B: prior drawer-funded refund stays fail closed even after a fresh count, without guessing absorption',async()=>{
  const f=coreFixture(s=>financialOrder(s).financialAdjustments=[{
    adjustmentId:'70000000-0000-4000-8000-000000000098',kind:'REFUND',originalPaymentId:paymentId,amount:3000,
    reason:'Historical drawer refund without attribution',actualActorPrincipalId:ownerId,occurredAt:'2026-10-15T12:00:00.000000Z',
    businessDate:'2026-10-15',businessDayRuleVersion:'cutoff-0600-v1',businessTimeZone:'Asia/Shanghai',requestId:null,
    refundChannel:'\u73b0\u91d1',refundFundingSource:'CURRENT_DRAWER',affectsCurrentDrawer:true
  }]);
  assert.equal((await f.execute({action:'handover',operationKey:'cannot-launder',expectedRevision:0,payload:{actualCash:7000}})).status,'business-rejected');
  assert.equal((await f.execute(cash('unknown-refund-boundary',0,1))).status,'business-rejected');
  assert.equal((await read(f)).cashOutflows,undefined);
});
test('C1-B: changed cash receipt or new ambiguous receipt invalidates drawer eligibility',async()=>{
  for(const corrupt of ['change','new']){
    const f=coreFixture();await counted(f);
    const s=await read(f);if(corrupt==='change')financialOrder(s).payments[0].amount++;
    else financialOrder(s).payments.push({method:'\u73b0\u91d1',amount:1});
    assert.throws(()=>cashOutBalance(s));
  }
});
test('C1-B: cancelling a closed old order never releases the new guest room',async()=>{
  const f=coreFixture(s=>{
    const o=financialOrder(s);o.payments=[];o.status='\u5df2\u7ed3\u8d26';
    s.orders.push({id:'new-guest',kind:'room',room:s.rooms[0].id,status:'\u8425\u4e1a\u4e2d',payments:[],sales:[]});s.rooms[0].order='new-guest';
  });
  assert.equal((await f.execute(cancel())).status,'business-rejected');assert.deepEqual((await read(f)).rooms,f.state.rooms);
});
