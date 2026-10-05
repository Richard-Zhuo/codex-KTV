import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from './rules.js';
import {
  reportPeriodMatch, reportOrder, reportTotals, reportBreakdown,
  reportPaymentMethods, reportSaleDetails, selectRevenueOrders, selectPaymentFlows
} from './reporting.js';
// UI 模块在导入时注册外观事件；给 Node 测试一个最小浏览器事件入口。
globalThis.window = { addEventListener() {} };
const { reportPage } = await import('./ui/pages/reports.js');
const { ctx } = await import('./ui/context.js');

// 直接调用 reporting.js 的纯投影与报表页面，保留 Track B 的业务断言。
const localAt = (month, day, hour = 20) => new Date(2026, month - 1, day, hour).toISOString();

function fixture() {
  const state = initialState();
  state.clock = localAt(9, 28);
  state.user = 'shaoBoss';
  const room = {
    id: 'D-room', kind: 'room', room: 'V01', time: localAt(9, 28),
    createdAt: localAt(9, 28), status: '已结账',
    packageBaseCents: 5000, packageGiftValueCents: 11800,
    sales: [
      { productId: 'bw', productNameSnapshot: '旧名百威', categoryLabelSnapshot: '啤酒',
        saleQuantity: 2, saleOptionNameSnapshot: '单支', amountCents: 2000,
        person: '卓益', employeeId: 'zhuYi' },
      { productId: 'snack', productNameSnapshot: '验收小吃', categoryLabelSnapshot: '小吃',
        saleQuantity: 1, saleOptionNameSnapshot: '包', amountCents: 3000,
        person: '邵老板', employeeId: 'shaoBoss' }
    ],
    otherCharges: [], bonusGifts: [], drinks: [], extras: [],
    payments: [
      { method: '微信', amount: 10000, time: localAt(9, 28) },
      { method: '现金', amount: 11800, time: localAt(9, 28) }
    ],
    rounding: 0, credit: null, voucher: null
  };
  const retail = {
    id: 'D-retail', kind: 'retail', room: null, time: localAt(9, 28),
    createdAt: localAt(9, 28), status: '已结账',
    packageBaseCents: 0, packageGiftValueCents: 0,
    sales: [{ productId: 'snack', productNameSnapshot: '验收小吃',
      categoryLabelSnapshot: '小吃', saleQuantity: 1, saleOptionNameSnapshot: '包',
      amountCents: 500, person: '邵老板', employeeId: 'shaoBoss' }],
    otherCharges: [], bonusGifts: [], drinks: [], extras: [],
    payments: [{ method: '支付宝', amount: 500, time: localAt(9, 28) }],
    rounding: 0, credit: null, voucher: null
  };
  state.orders = [room, retail];
  return state;
}

function harness(initial) {
  ctx.state = initial;
  ctx.reportPeriod = 'day';
  return {
    setState(value) { ctx.state = value; },
    setPeriod(value) { ctx.reportPeriod = value; },
    match: order => reportPeriodMatch(order, ctx.state.clock, ctx.reportPeriod),
    order: roomId => reportOrder(ctx.state, roomId, ctx.reportPeriod),
    totals: reportTotals,
    breakdown: reportBreakdown,
    payments: reportPaymentMethods,
    saleDetails: reportSaleDetails,
    page: reportPage
  };
}

test('报表合同：日报同时计房间、retail 与商品成交额', () => {
  const state = fixture(), report = harness(state);
  const selected = state.orders.filter(report.match);
  assert.equal(selected.length, 2);
  assert.equal(report.order('V01').room, 'V01');
  assert.equal(report.order('333'), null);
  assert.equal(report.totals(selected).total, 22300);
  assert.equal(report.totals(selected).base, 5000);
  assert.equal(report.totals(selected).sales, 17300);
  const html = report.page();
  assert.match(html, /有消费房间<\/span>/);
  assert.match(html, /独立零售交易<\/span>/);
  assert.match(html, /全部账单合计<\/span>/);
  assert.match(html, /¥223/);
  assert.match(html, /D-retail/);
  assert.match(html, /V01/);
});

test('报表合同：商品分类及销售归属由房单和零售销售行共同汇总', () => {
  const state = fixture(), report = harness(state);
  const category = Object.fromEntries(report.breakdown(state.orders, 'category'));
  const seller = Object.fromEntries(report.breakdown(state.orders, 'seller'));
  assert.deepEqual({ ...category }, { '啤酒': 2000, '小吃': 3500 });
  assert.deepEqual({ ...seller }, { '卓益': 2000, '邵老板': 3500 });
  const html = report.page();
  assert.match(html, /商品分类销售/);
  assert.match(html, /销售人员归属/);
  assert.match(html, /验收小吃/);
});

test('报表合同：多支付渠道按原单记录展示，零售付款单独展示', () => {
  const state = fixture(), report = harness(state);
  assert.equal(report.payments(state.orders[0]), '微信¥100+现金¥118');
  assert.equal(report.payments(state.orders[1]), '支付宝¥5');
  const html = report.page();
  assert.match(html, /微信¥100\+现金¥118/);
  assert.match(html, /支付宝¥5/);
});

test('报表合同：日、周、月选择按当前订单日期口径筛选', () => {
  const state = fixture();
  state.orders.push({
    ...structuredClone(state.orders[1]), id: 'D-prior-week',
    time: localAt(9, 27), createdAt: localAt(9, 27)
  });
  state.orders.push({
    ...structuredClone(state.orders[1]), id: 'D-next-month',
    time: localAt(10, 1), createdAt: localAt(10, 1)
  });
  const report = harness(state);
  assert.deepEqual(state.orders.filter(report.match).map(o => o.id), ['D-room', 'D-retail']);
  report.setPeriod('week');
  assert.deepEqual(state.orders.filter(report.match).map(o => o.id), ['D-room', 'D-retail', 'D-next-month']);
  report.setPeriod('month');
  assert.deepEqual(state.orders.filter(report.match).map(o => o.id), ['D-room', 'D-retail', 'D-prior-week']);
});

test('报表合同：当前改名改价不重算旧销售名称、分类与成交价', () => {
  const state = fixture(), report = harness(state);
  const before = report.page();
  const bw = state.catalog.products.find(p => p.id === 'bw');
  bw.name = '当前新名';
  bw.saleOptions.find(o => o.id === 'single').priceCents = 99900;
  const after = report.page();
  assert.equal(after, before);
  assert.match(after, /旧名百威/);
  assert.doesNotMatch(after, /当前新名|¥999/);
  assert.deepEqual([...report.saleDetails(state.orders[0])].map(String), [
    '啤酒 · 旧名百威 × 2（单支） ¥20',
    '小吃 · 验收小吃 × 1（包） ¥30'
  ]);
});

test('K05 fixed: cross-day funds follow payment occurredAt while revenue stays on frozen businessDate', () => {
 const state=fixture();
 state.orders=[{...state.orders[0],businessDate:'2026-10-04',businessDayRuleVersion:'noon-v1',
  time:'2026-10-04T20:00:00+08:00',createdAt:'2026-10-04T20:00:00+08:00',
  payments:[{paymentId:'synthetic-cross-day',method:'现金',amount:21800,occurredAt:'2026-10-05T14:00:00+08:00'}]}];
 const revenue=selectRevenueOrders(state,{fromBusinessDate:'2026-10-04',toBusinessDate:'2026-10-05'});
 assert.equal(revenue.orders.length,1);assert.equal(revenue.orders[0].businessDate,'2026-10-04');
 assert.equal(selectRevenueOrders(state,{fromBusinessDate:'2026-10-05',toBusinessDate:'2026-10-06'}).orders.length,0);
 assert.equal(selectPaymentFlows(state,{from:'2026-10-04T12:00:00+08:00',to:'2026-10-05T12:00:00+08:00'}).totalCents,0);
 const paid=selectPaymentFlows(state,{from:'2026-10-05T12:00:00+08:00',to:'2026-10-06T12:00:00+08:00'});
 assert.equal(paid.totalCents,21800);assert.equal(paid.payments[0].occurredAt,'2026-10-05T14:00:00+08:00');
});
