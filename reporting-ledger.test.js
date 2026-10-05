import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRevenueOrders, selectPaymentFlows, reportViewModel, reportPeriodMatch } from './reporting.js';

const day = date => ({ fromBusinessDate: date, toBusinessDate: date === '2026-10-04' ? '2026-10-05' : '2026-10-06' });
const interval = date => ({ from: date + 'T12:00:00+08:00', to: (date === '2026-10-04' ? '2026-10-05' : '2026-10-06') + 'T12:00:00+08:00' });
const payment = (id, occurredAt, amount = 100) => ({ paymentId: id, occurredAt, amount, method: '现金', recordedByPrincipalId: 'synthetic-actor' });
const order = payments => ({ id: 'O1', kind: 'room', room: 'V01', time: '2026-10-04T20:00:00+08:00',
  businessDate: '2026-10-04', businessDayRuleVersion: 'noon-v1', base: 300, gift: 0, sales: [], payments });

test('K05: revenue stays on frozen order date while cross-day payment enters its own interval', () => {
  const state = { orders: [order([payment('p1', '2026-10-05T14:00:00+08:00')])] };
  assert.equal(selectRevenueOrders(state, day('2026-10-04')).orders.length, 1);
  assert.equal(selectRevenueOrders(state, day('2026-10-05')).orders.length, 0);
  assert.equal(selectPaymentFlows(state, interval('2026-10-04')).totalCents, 0);
  assert.equal(selectPaymentFlows(state, interval('2026-10-05')).totalCents, 100);
});

test('K05: formal report projects frozen revenue and independent funds without reading demo clock',()=>{
 const state={orders:[order([payment('cross','2026-10-05T14:00:00+08:00')])],rooms:[{id:'V01'}]};
 Object.defineProperty(state,'clock',{get(){assert.fail('formal report read demo clock');}});
 const query={...day('2026-10-05'),paymentInterval:interval('2026-10-05')};
 const report=reportViewModel(state,'day',query);
 assert.equal(report.totals.total,0);assert.equal(report.cashFlow.totalCents,100);
 assert.equal(report.cashFlow.payments[0].orderId,'O1');assert.deepEqual(report.revenueAmbiguities,[]);
 assert.equal(reportPeriodMatch(state.orders[0],undefined,'day',day('2026-10-04')),true);
 assert.throws(()=>reportPeriodMatch(state.orders[0],'2026-10-04T20:00:00+08:00','day'),TypeError);
});

test('K05: same-day funds, multiple cross-day channels and revenue counted once',()=>{
 const payments=[payment('a','2026-10-04T20:00:00+08:00',100),
  {...payment('b','2026-10-05T14:00:00+08:00',150),method:'微信'},payment('c','2026-10-05T15:00:00+08:00',50)];
 const state={orders:[order(payments)]},before=structuredClone(state);
 assert.equal(selectRevenueOrders(state,day('2026-10-04')).orders.length,1);
 assert.equal(selectRevenueOrders(state,day('2026-10-05')).orders.length,0);
 const first=selectPaymentFlows(state,interval('2026-10-04')),second=selectPaymentFlows(state,interval('2026-10-05'));
 assert.deepEqual(first.payments.map(p=>p.paymentId),['a']);assert.equal(first.totalCents,100);
 assert.deepEqual(second.payments.map(p=>p.paymentId),['b','c']);assert.equal(second.totalCents,200);
 assert.deepEqual(second.byChannel,[{method:'微信',amountCents:150},{method:'现金',amountCents:50}]);
 assert.equal(first.complete,true);assert.equal(second.complete,true);assert.deepEqual(state,before);
});

test('K05: funds use canonical order payments, never repayment mirror or rounding as money',()=>{
 const p=payment('repay','2026-10-05T14:00:00+08:00',180);
 const state={orders:[{...order([p]),rounding:120,credit:{repayments:[p]}}]};
 const flow=selectPaymentFlows(state,interval('2026-10-05'));
 assert.equal(flow.totalCents,180);assert.equal(flow.payments.length,1);
});

test('K05: unknown legacy time is excluded and exposed; old time, order time and principal cannot prove it',()=>{
 const state={orders:[order([
  {method:'现金',amount:100,time:'2026-10-05T14:00:00+08:00'},
  {method:'现金',amount:200,time:'2026-10-05T14:00:00+08:00',approvedByPrincipalId:'old-reviewer'},
  payment('known','2026-10-05T14:00:00+08:00',300)
 ])]},before=structuredClone(state);
 const flow=selectPaymentFlows(state,interval('2026-10-05'));
 assert.equal(flow.totalCents,300);assert.equal(flow.complete,false);
 assert.deepEqual(flow.ambiguities.map(a=>a.code),['PAYMENT_TIME_AMBIGUOUS','PAYMENT_TIME_AMBIGUOUS']);
 assert.deepEqual(flow.ambiguities.map(a=>a.paymentIndex),[0,1]);assert.deepEqual(state,before);
});

test('K05: invalid occurredAt does not fall back to a plausible time or fabricate a date',()=>{
 const state={orders:[order([{...payment('bad','2026-02-30T14:00:00+08:00'),time:'2026-10-05T14:00:00+08:00'},
  payment('offset-missing','2026-10-05T14:00:00'),payment('bad-amount','2026-10-05T14:00:00+08:00',-1)])]};
 const flow=selectPaymentFlows(state,interval('2026-10-05'));
 assert.equal(flow.totalCents,0);assert.equal(flow.payments.length,0);assert.equal(flow.complete,false);
 assert.deepEqual(flow.ambiguities.map(a=>a.code),['PAYMENT_OCCURRED_AT_INVALID','PAYMENT_OCCURRED_AT_INVALID','PAYMENT_AMOUNT_INVALID']);
});

test('K05: half-open money interval preserves exact microseconds at noon and the actual 02:00 timestamp',()=>{
 const points=['2026-10-05T02:00:00+08:00','2026-10-05T11:59:59.999999+08:00',
  '2026-10-05T12:00:00+08:00','2026-10-05T12:00:00.000001+08:00'];
 const state={orders:[order(points.map((point,i)=>payment(String(i),point)))]};
 const first=selectPaymentFlows(state,interval('2026-10-04')),second=selectPaymentFlows(state,interval('2026-10-05'));
 assert.deepEqual(first.payments.map(p=>p.paymentId),['0','1']);assert.deepEqual(second.payments.map(p=>p.paymentId),['2','3']);
 assert.equal(first.payments[0].occurredAt,points[0]);
 const narrow=selectPaymentFlows(state,{from:'2026-10-05T04:00:00.000000Z',to:'2026-10-05T04:00:00.000001Z'});
 assert.deepEqual(narrow.payments.map(p=>p.paymentId),['2']);
});

test('K05: frozen historical business date wins over order timestamp and current rule version',()=>{
 const frozen={...order([]),businessDate:'2026-10-04',businessDayRuleVersion:'historical-policy',time:'2099-01-01T20:00:00Z'};
 assert.equal(selectRevenueOrders({orders:[frozen]},day('2026-10-04')).orders[0],frozen);
 assert.equal(reportPeriodMatch(frozen,'2099-01-01T20:00:00Z','month',day('2026-10-04')),true);
});

test('K05: unknown historical business date is explicit ambiguity rather than current-cutoff recalculation',()=>{
 const unknown={...order([])};delete unknown.businessDate;
 const result=selectRevenueOrders({orders:[unknown,{...order([]),id:'invalid',businessDate:'2026-02-30'}]},day('2026-10-04'));
 assert.equal(result.orders.length,0);assert.equal(result.complete,false);
 assert.deepEqual(result.ambiguities.map(a=>a.code),['ORDER_BUSINESS_DATE_UNKNOWN','ORDER_BUSINESS_DATE_UNKNOWN']);
});

test('K05: empty and damaged payment lists are safe and clear; invalid query intervals fail closed',()=>{
 assert.deepEqual(selectPaymentFlows({orders:[]},interval('2026-10-05')),{payments:[],totalCents:0,byChannel:[],ambiguities:[],complete:true});
 const result=selectPaymentFlows({orders:[{id:'damaged',payments:{}},order([null])]},interval('2026-10-05'));
 assert.equal(result.totalCents,0);assert.deepEqual(result.ambiguities.map(a=>a.code),['ORDER_PAYMENTS_UNKNOWN','PAYMENT_TIME_AMBIGUOUS']);
 for(const range of [{from:'2026-10-05',to:'2026-10-06'}, {from:'2026-10-05T12:00:00+08:00',to:'2026-10-05T12:00:00+08:00'}])assert.throws(()=>selectPaymentFlows({orders:[]},range),TypeError);
 assert.throws(()=>selectRevenueOrders({orders:[]},{fromBusinessDate:'2026-02-30',toBusinessDate:'2026-10-05'}),TypeError);
});
