
import test from 'node:test';
import assert from 'node:assert/strict';
import * as reports from './reporting.js';
import {financialFixture,ownerId,orderId,financialOrder} from './test-support/financial-adjustments-fixture.js';
const query={fromBusinessDate:'2026-01-01',toBusinessDate:'2026-01-02',paymentInterval:{from:'2026-10-15T06:00:00+08:00',to:'2026-10-16T06:00:00+08:00'}};
const read=async f=>(await f.memory.read()).state;
let key=0;
async function execute(f,action,payload,id=ownerId){
 const r=await f.execute({action,payload,operationKey:'c2b-'+(++key),expectedRevision:(await f.memory.read()).revision},id);
 assert.equal(r.status,'committed',JSON.stringify(r));return r;
}
function fixture(prepare=()=>{}){
 const f=financialFixture({prepare});f.accounts.get(ownerId).grants.push('handover','cash.out','payment.collect','order.cancel');return f;
}
test('C2-B: effective totals, categories and sellers exclude only the legally cancelled order',async()=>{
 const f=fixture(s=>{
  const o=financialOrder(s);o.payments=[];o.sales=[{amount:2500,categoryLabelSnapshot:'Drinks',person:'Sam'}];
  const active=structuredClone(o);active.id='active-unpaid';active.room=s.rooms[1].id;active.packageBaseCents=9000;
  active.sales=[{amount:1000,categoryLabelSnapshot:'Drinks',person:'Sam'}];s.orders.push(active);
 });
 const original=await read(f);await execute(f,'cancelOrder',{order:orderId,reason:'Confirmed unpaid cancellation'});
 const s=await read(f),report=reports.reportViewModel(s,'day',query);
 assert.equal(report.totals.total,10000);
 assert.deepEqual(report.categoryRows,[['Drinks',1000]]);assert.deepEqual(report.sellerRows,[['Sam',1000]]);
 assert.deepEqual(report.periodOrders.map(o=>o.id),['active-unpaid']);
 assert.deepEqual(financialOrder(s).sales,financialOrder(original).sales);assert.deepEqual(s.inventory,original.inventory);
 assert.equal(reports.reportTotals(s.orders).total,10000);
 assert.deepEqual(reports.reportBreakdown(s.orders,'category'),[['Drinks',1000]]);
 assert.deepEqual(reports.selectRevenueOrders(s,query).cancelledOrders.map(o=>o.id),[orderId]);
});

test('C2-B: payments, refunds, reversals and independent cashOut use their own periods',async()=>{
 const f=fixture(s=>{
  const o=financialOrder(s);o.payments=[];
  const second=structuredClone(o);second.id='second-order';second.room=s.rooms[1].id;s.orders.push(second);
 });
 await execute(f,'handover',{actualCash:50000});
 f.setTime('2026-10-15T12:00:00.000000Z');
 await execute(f,'collect',{order:orderId,charge:'open',payments:[{method:'\u73b0\u91d1',amount:10000}]});
 await execute(f,'collect',{order:'second-order',charge:'open',payments:[{method:'\u5fae\u4fe1',amount:10000}]});
 const before=await read(f),a=financialOrder(before).payments[0],b=before.orders[1].payments[0];
 f.setTime('2026-10-16T12:00:00.000000Z');
 await execute(f,'refundPayment',{order:orderId,originalPaymentId:a.paymentId,amount:3000,reason:'Actual refund',
 refundChannel:'\u73b0\u91d1',refundFundingSource:'CURRENT_DRAWER'});
 await execute(f,'reversePayment',{order:'second-order',originalPaymentId:b.paymentId,amount:10000,reason:'Wrong payment record'});
 await execute(f,'cashOut',{amountCents:4000,reason:'Actual independent withdrawal'});
 const s=await read(f),original=structuredClone(s);
 const dayA={from:'2026-10-15T06:00:00+08:00',to:'2026-10-16T06:00:00+08:00'};
 const dayB={from:'2026-10-16T06:00:00+08:00',to:'2026-10-17T06:00:00+08:00'};
 const first=reports.selectFinancialFlows(s,dayA),second=reports.selectFinancialFlows(s,dayB);
 assert.equal(first.originalPaymentCents,20000);assert.equal(first.netReceiptsChangeCents,20000);
 assert.equal(first.refundCents,0);assert.equal(first.reversalCents,0);
 assert.equal(second.originalPaymentCents,0);assert.equal(second.reversalCents,10000);assert.equal(second.refundCents,3000);
 assert.equal(second.netReceiptsChangeCents,-13000);assert.equal(second.drawerRefundCents,3000);
 assert.equal(second.independentCashOutCents,4000);assert.equal(second.drawerCashOutCents,7000);
 assert.equal(second.refunds[0].occurredAt,'2026-10-16T12:00:00.000000Z');
 assert.equal(second.reversals[0].originalPaymentId,b.paymentId);assert.equal(second.complete,true);
 assert.equal(reports.selectRevenueOrders(s,query).orders.length,2);
 assert.deepEqual(financialOrder(s).payments,financialOrder(before).payments);
 assert.deepEqual(s,original);
});

test('C2-B: full refund changes current net receipts, never revenue or cancellation status',async()=>{
 const f=fixture(),before=await read(f),p=financialOrder(before).payments[0];
 await execute(f,'refundPayment',{order:orderId,originalPaymentId:p.paymentId,amount:10000,reason:'Full actual refund',
 refundChannel:'\u73b0\u91d1',refundFundingSource:'OUTSIDE_DRAWER'});
 const s=await read(f),r=reports.reportViewModel(s,'day',query);
 assert.equal(r.totals.total,10000);assert.equal(r.currentBalances.effectivePaymentCreditCents,10000);
 assert.equal(r.currentBalances.netReceiptsCents,0);assert.equal(r.periodOrders.length,1);
 assert.equal(r.financialFlows.refundCents,10000);assert.equal(r.financialFlows.drawerCashOutCents,0);
 assert.equal(financialOrder(s).cancellation,undefined);assert.deepEqual(financialOrder(s).payments,financialOrder(before).payments);
});

test('C2-B: unpaid, credit and reversed zero-net orders remain effective transactions',async()=>{
 const unpaid=fixture(s=>financialOrder(s).payments=[]);
 assert.equal(reports.reportViewModel(await read(unpaid),'day',query).totals.total,10000);
 const credit=fixture(s=>{financialOrder(s).payments=[];financialOrder(s).credit={amount:10000,remaining:10000};financialOrder(s).status='\u5df2\u6302\u8d26';});
 assert.equal(reports.reportViewModel(await read(credit),'day',query).totals.total,10000);
 const reversed=fixture(),p=financialOrder(await read(reversed)).payments[0];
 await execute(reversed,'reversePayment',{order:orderId,originalPaymentId:p.paymentId,amount:10000,reason:'Wrong receipt'});
 const r=reports.reportViewModel(await read(reversed),'day',query);
 assert.equal(r.totals.total,10000);assert.equal(r.currentBalances.effectivePaymentCreditCents,0);
 assert.equal(r.currentBalances.netReceiptsCents,0);assert.equal(r.cancelledOrders.length,0);
});
test('C2-B: ambiguous cancellation is explicit and never guessed from net receipts',()=>{
 const s={orders:[{id:'unknown-cancel',status:'\u5df2\u64a4\u5355',businessDate:'2026-01-01',base:10000,sales:[],payments:[]}],rooms:[]};
 const r=reports.selectRevenueOrders(s,query);
 assert.equal(r.complete,false);assert.equal(r.orders.length,0);assert.equal(r.cancelledOrders.length,0);
 assert.equal(r.ambiguities[0].code,'ORDER_CANCELLATION_UNVERIFIABLE');
 assert.throws(()=>reports.reportTotals(s.orders),TypeError);
});
test('C2-B: current balances differ explicitly from original-period receipts',async()=>{
 const f=fixture(),p=financialOrder(await read(f)).payments[0];
 f.setTime('2026-10-16T12:00:00.000000Z');
 await execute(f,'refundPayment',{order:orderId,originalPaymentId:p.paymentId,amount:3000,reason:'Later refund',refundChannel:'\u5fae\u4fe1',refundFundingSource:'NON_CASH'});
 const q={...query,paymentInterval:{from:'2026-01-01T00:00:00Z',to:'2026-01-02T00:00:00Z'}};
 const r=reports.reportViewModel(await read(f),'day',q);
 assert.equal(r.financialFlows.originalPaymentCents,10000);assert.equal(r.financialFlows.netReceiptsChangeCents,10000);
 assert.equal(r.currentBalances.effectivePaymentCreditCents,10000);assert.equal(r.currentBalances.netReceiptsCents,7000);
 assert.equal(r.totals.total,10000);
});
test('C2-B: cutoff boundaries preserve actual event time and frozen revenue dates',async()=>{
 const f=fixture();await execute(f,'handover',{actualCash:10000});
 for(const time of ['2026-10-15T21:59:59.000000Z','2026-10-15T22:00:00.000000Z']){
  f.setTime(time);await execute(f,'cashOut',{amountCents:1000,reason:'Boundary withdrawal'});
 }
 const s=await read(f);
 const a=reports.selectFinancialFlows(s,{from:'2026-10-15T06:00:00+08:00',to:'2026-10-16T06:00:00+08:00'});
 const b=reports.selectFinancialFlows(s,{from:'2026-10-16T06:00:00+08:00',to:'2026-10-17T06:00:00+08:00'});
 assert.equal(a.independentCashOutCents,1000);assert.equal(b.independentCashOutCents,1000);
 assert.equal(a.cashOutflows[0].businessDate,'2026-10-15');assert.equal(b.cashOutflows[0].businessDate,'2026-10-16');
 assert.equal(a.cashOutflows[0].occurredAt,'2026-10-15T21:59:59.000000Z');
 assert.equal(reports.selectRevenueOrders(s,query).orders.length,1);
 assert.equal(reports.selectRevenueOrders(s,{fromBusinessDate:'2026-10-15',toBusinessDate:'2026-10-17'}).orders.length,0);
});
test('C2-B: 60 current-drawer refund plus 40 cashOut is exactly 100; pending intent is not movement',async()=>{
 const f=fixture();await execute(f,'handover',{actualCash:50000});
 const p=financialOrder(await read(f)).payments[0];
 await execute(f,'refundPayment',{order:orderId,originalPaymentId:p.paymentId,amount:6000,reason:'Cash refund',
 refundChannel:'\u73b0\u91d1',refundFundingSource:'CURRENT_DRAWER'});
 await execute(f,'cashOut',{amountCents:4000,reason:'Independent cash withdrawal'});
 const {applicantId}=await import('./test-support/financial-adjustments-fixture.js');
 f.accounts.get(applicantId).grants.push('cash.out');
 await execute(f,'cashOut',{amountCents:1000,reason:'Not yet executed'},applicantId);
 const r=reports.selectFinancialFlows(await read(f),query.paymentInterval);
 assert.equal(r.drawerRefundCents,6000);assert.equal(r.independentCashOutCents,4000);assert.equal(r.drawerCashOutCents,10000);
 assert.equal(r.cashOutflows.length,1);assert.equal(r.refunds.length,1);assert.equal(r.reversals.length,0);
});
test('C2-B: negative expectedCash and old variance survive subsequent counts without becoming expense',async()=>{
 const f=fixture(s=>financialOrder(s).payments=[]);await execute(f,'handover',{actualCash:0});
 await execute(f,'collect',{order:orderId,charge:'open',payments:[{method:'\u73b0\u91d1',amount:10000}]});
 const p=financialOrder(await read(f)).payments[0];
 await execute(f,'cashOut',{amountCents:10000,reason:'Actual cash withdrawn'});
 await execute(f,'reversePayment',{order:orderId,originalPaymentId:p.paymentId,amount:10000,reason:'Wrong cash receipt'});
 await execute(f,'handover',{actualCash:0});const old=await read(f);
 await execute(f,'handover',{actualCash:0});const s=await read(f),before=structuredClone(s),r=reports.reportViewModel(s,'day',query);
 assert.equal(r.cashCounts.complete,true);assert.equal(r.cashCounts.counts[1].expectedCash,-10000);
 assert.equal(r.cashCounts.counts[1].actualCash,0);assert.equal(r.cashCounts.counts[1].difference,10000);
 assert.equal(r.cashCounts.counts[1].cashAnomaly,'NEGATIVE_EXPECTED_CASH');
 assert.equal(r.cashCounts.unresolvedDifferences.length,1);assert.equal(r.cashCounts.counts[2].difference,0);
 assert.equal(r.financialFlows.drawerCashOutCents,10000);assert.equal(r.financialFlows.netReceiptsChangeCents,0);
 assert.deepEqual(s.handovers.slice(0,2),old.handovers);assert.deepEqual(s,before);
});
test('C2-B: unknown refund attribution remains visible and drawer totals are unknown, not invented zero',()=>{
 const f=fixture(s=>financialOrder(s).financialAdjustments=[{adjustmentId:'84000000-0000-4000-8000-000000000001',
 kind:'REFUND',originalPaymentId:financialOrder(s).payments[0].paymentId,amount:3000,reason:'Historical unknown cursor',
 actualActorPrincipalId:ownerId,occurredAt:'2026-10-15T12:00:00.000000Z',businessDate:'2026-10-15',
 businessDayRuleVersion:'cutoff-0600-v1',businessTimeZone:'Asia/Shanghai',requestId:null,
 refundChannel:'\u73b0\u91d1',refundFundingSource:'CURRENT_DRAWER',affectsCurrentDrawer:true}]);
 const before=structuredClone(f.state),r=reports.selectFinancialFlows(f.state,query.paymentInterval);
 assert.equal(r.complete,false);assert.equal(r.refundCents,3000);assert.equal(r.drawerCashOutCents,null);
 assert.ok(r.ambiguities.some(a=>a.code==='DRAWER_FACTS_UNVERIFIABLE'));assert.deepEqual(f.state,before);
});
test('C2-B: v1 counts and discrepancies remain exact historical facts and never become extra flows',async()=>{
 const f=fixture();await execute(f,'handover',{actualCash:12000});await execute(f,'handover',{actualCash:11000});
 const s=await read(f);
 for(const h of s.handovers){h.trustedHandoverVersion='drawer-v1';h.cashBoundary.version='payment-set-v1';delete h.cashBoundary.facts;}
 const before=structuredClone(s),r=reports.reportViewModel(s,'day',query);
 assert.equal(r.cashCounts.complete,true);assert.equal(r.cashCounts.counts[1].difference,-1000);
 assert.equal(r.cashCounts.counts[0].trustedHandoverVersion,'drawer-v1');
 assert.equal(r.financialFlows.drawerCashOutCents,0);assert.deepEqual(s,before);
});
test('C2-B: untrusted original money fields stay incomplete without time or identity fabrication',()=>{
 const f=fixture(),s=structuredClone(f.state);delete financialOrder(s).payments[0].occurredAt;
 const before=structuredClone(s),r=reports.reportViewModel(s,'day',query);
 assert.equal(r.financialFlows.complete,false);assert.equal(r.currentBalances.complete,false);
 assert.equal(r.currentBalances.netReceiptsCents,null);assert.deepEqual(s,before);
});

test('C2-B: duplicate or missing original payment identities cannot inflate trusted period receipts',()=>{
 for(const duplicate of [false,true]){
  const f=fixture(),s=structuredClone(f.state),p=financialOrder(s).payments[0];
  p.occurredAt='2026-10-15T12:00:00.000000Z';
  if(duplicate)financialOrder(s).payments.push(structuredClone(p));else delete p.paymentId;
  const r=reports.selectFinancialFlows(s,query.paymentInterval);
  assert.equal(r.complete,false);assert.equal(r.originalPaymentCents,0);assert.equal(r.payments.length,0);
  assert.ok(r.ambiguities.some(a=>a.code==='PAYMENT_IDENTITY_UNVERIFIABLE'));
 }
});
