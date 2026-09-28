// Phase 0 行为冻结：报表口径 characterization tests。
// 报表聚合目前内嵌在 app.js（reportOrder / reportTotals / reportBreakdown /
// reportPaymentMethods / reportNotes），无法直接在 Node 中 import。
// 本文件按 app.js 中同名函数的当前实现逐字复制其计算逻辑（不含 DOM 模板），
// 作为 Phase 0 冻结报表口径的可执行证据；Phase 6 抽取 reporting selectors 时，
// 这些断言将改为直接测试真正的 selector，并要求结果与本处冻结值一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from './rules.js';
import { total, outstanding, collected, nextCollectCharge } from './sales.js';

let seq = 0;
const apply = (s, a, d = {}) => transact(s, a, d, `report-char-${++seq}`);
const at = hour => `2026-09-19T${hour}:00+08:00`;
const money = cents => `¥${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
const reportDateKey = value => { const d = new Date(value); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
function stocked(s) { for (const balance of Object.values(s.inventory)) if (balance.count === null) balance.count = 1000; return s; }
const signature = 'data:image/png;base64,' + 'A'.repeat(100);

// —— 以下四个函数为 app.js 当前实现的逐字拷贝（仅去掉 HTML 渲染部分）——
function reportPeriodMatch(order, clock, reportPeriod) {
  if (!order) return false;
  const current = new Date(clock), time = new Date(order.time);
  if (reportPeriod === 'month') return current.getFullYear() === time.getFullYear() && current.getMonth() === time.getMonth();
  if (reportPeriod === 'week') { const start = new Date(current); start.setHours(0, 0, 0, 0); const day = (start.getDay() + 6) % 7; start.setDate(start.getDate() - day); const end = new Date(start); end.setDate(start.getDate() + 7); return time >= start && time < end; }
  return reportDateKey(clock) === reportDateKey(order.time);
}
function reportOrder(state, roomId, reportPeriod) {
  const orders = state.orders.filter(order => order.kind !== 'retail' && order.room === roomId && reportPeriodMatch(order, state.clock, reportPeriod)).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  if (!orders.length) return null;
  const base = orders.reduce((sum, order) => sum + Number(order.packageBaseCents ?? order.base ?? 0), 0), gift = orders.reduce((sum, order) => sum + Number(order.packageGiftValueCents ?? order.gift ?? 0), 0);
  return { ...orders.at(-1), periodOrders: orders, packageBaseCents: base, packageGiftValueCents: gift, base, gift, drinks: orders.flatMap(order => order.drinks || []), extras: orders.flatMap(order => order.extras || []), sales: orders.flatMap(order => order.sales || []), otherCharges: orders.flatMap(order => order.otherCharges || []), bonusGifts: orders.flatMap(order => order.bonusGifts || []), payments: orders.flatMap(order => order.payments || []), rounding: orders.reduce((sum, order) => sum + Number(order.rounding || 0), 0), status: orders.at(-1).status, credit: orders.some(order => order.credit), voucher: orders.find(order => order.voucher)?.voucher };
}
function reportTotals(orders) {
  return orders.reduce((sum, order) => { sum.base += Number(order.packageBaseCents ?? order.base ?? 0); sum.sales += (order.sales || []).reduce((n, line) => n + Number(line.amountCents ?? line.amount ?? 0), 0) + Number(order.packageGiftValueCents ?? order.gift ?? 0); sum.gift += (order.bonusGifts || []).reduce((n, gift) => n + (Number.isSafeInteger(gift.referenceValueCents) ? gift.referenceValueCents : 0), 0); sum.total += total(order); sum.rounding += Number(order.rounding || 0); return sum; }, { base: 0, sales: 0, gift: 0, total: 0, rounding: 0 });
}
function reportBreakdown(orders, key) {
  const totals = new Map();
  for (const line of orders.flatMap(order => order.sales || [])) {
    const label = key === 'category' ? (line.categoryLabelSnapshot || line.categorySnapshot || '历史未分类') : (line.person || '归属未记录');
    totals.set(label, (totals.get(label) || 0) + Number(line.amountCents ?? line.amount ?? 0));
  }
  return [...totals.entries()];
}
function reportPaymentMethods(order) {
  if (!order) return '';
  const totals = new Map();
  for (const payment of order.payments || []) {
    if (!payment.method) continue;
    totals.set(payment.method, (totals.get(payment.method) || 0) + Number(payment.amount || 0));
  }
  const methods = [...totals.entries()];
  if (!methods.length) return outstanding(order) ? '未收' : '';
  const hasNonWechat = methods.some(([method]) => method !== '微信');
  return methods.map(([method, amount]) => hasNonWechat ? `${method}${money(amount)}` : method).join('+');
}

// 构造典型场景：V01 房间单（分次收钱 + 混合方式结账）、333 同房两笔订单
// （第一笔挂账 300 元并回款 5 元、第二笔免零结账）、一笔独立零售 4 元。
function scenario() {
  let s = initialState();
  s.clock = at('20:00');
  s.user = 'shaoBoss';
  // V01：开房 + 增购一打 + 收钱（微信）+ 结账（现金+支付宝）
  s = apply(s, 'open', { room: 'V01', beer: 'bw' });
  s = stocked(s);
  const d1 = s.orders[0].id;
  s = apply(s, 'sale', { order: d1, items: [{ product: 'bw', spec: 'dozen', count: 1 }] });
  const saleCharge = nextCollectCharge(s.orders[0]);
  s = apply(s, 'collect', { order: d1, charge: saleCharge.id, payments: [{ method: '微信', amount: saleCharge.remaining }] });
  s = apply(s, 'settle', { order: d1, payments: [{ method: '现金', amount: 10000 }, { method: '支付宝', amount: 6800 }] });
  // 333 第一笔：挂账（库管申请、老板批准、大堂经理审核回款 500 分）
  s = apply(s, 'open', { room: '333', beer: 'bw' });
  const d2 = s.orders.at(-1).id;
  s = apply(s, 'sale', { order: d2, product: 'bw', spec: 'single', count: 1 });
  s.user = 'keeper';
  s = apply(s, 'credit', { order: d2, name: '王生', note: '宴请挂账', signature });
  s.user = 'boss';
  s = apply(s, 'approve', { order: d2 });
  s = apply(s, 'repay', { order: d2, amount: 500, method: '现金' });
  s.user = 'xiongBoss';
  const repayRequestId = s.orders.find(o => o.id === d2).credit.repaymentRequests[0].id;
  s = apply(s, 'approveRepayment', { order: d2, request: repayRequestId });
  // 333 第二笔：清洁后重新开房，瓶装水 + 免零结账
  s.user = 'shaoBoss';
  s = apply(s, 'clean', { room: '333' });
  s = apply(s, 'open', { room: '333', beer: 'bw' });
  const d3 = s.orders.at(-1).id;
  s = apply(s, 'sale', { order: d3, product: 'water', spec: 'single', count: 1 });
  s = apply(s, 'settle', { order: d3, payments: [{ method: '现金', amount: 28200 }] });
  // 独立零售：瓶装水 ×2，美团支付
  s = apply(s, 'retailSale', { items: [{ product: 'water', spec: 'single', count: 2 }], payments: [{ method: '美团', amount: 400 }] });
  return s;
}

test('日报：房间行按房号聚合，跨房间与零售计入同一账单合计', () => {
  const s = scenario();
  assert.equal(reportPeriodMatch(s.orders.find(o => o.id === 'D1'), s.clock, 'day'), true);
  const periodOrders = s.orders.filter(order => reportPeriodMatch(order, s.clock, 'day'));
  assert.equal(periodOrders.length, 4);
  const v01 = reportOrder(s, 'V01', 'day');
  const r333 = reportOrder(s, '333', 'day');
  // V01：小房夜间套餐 base 5000 + 赠饮 11800 + 增购一打 11800 = 28600
  assert.equal(v01.sales.length, 1);
  assert.equal(v01.base, 5000);
  assert.equal(v01.gift, 11800);
  assert.equal(total(v01), 28600);
  // 同房两单聚合：房费与赠饮按订单求和（大房 base 5400 / gift 23600 ×2）
  assert.equal(r333.periodOrders.length, 2);
  assert.equal(r333.base, 10800);
  assert.equal(r333.gift, 47200);
  // 聚合备注的 credit 布尔值：任一订单有挂账即为 true（当前口径）
  assert.equal(r333.credit, true);
  assert.equal(v01.credit, false);
  const totals = reportTotals(periodOrders);
  assert.equal(totals.base, 5000 + 5400 * 2);
  assert.equal(totals.sales, 11800 + 11800 + 23600 + 1000 + 23600 + 200 + 400);
  assert.equal(totals.total, 28600 + 30000 + 29200 + 400);
  assert.equal(totals.rounding, 1000);
});

test('日报：同房多单聚合后备注按聚合 credit 布尔解释，已部分回款的单被最后一笔订单状态遮蔽', () => {
  const s = scenario();
  const r333 = reportOrder(s, '333', 'day');
  // 当前实现：reportNotes 在日报下读取聚合行的 credit 布尔值与聚合行状态（最后一笔订单的状态）。
  // 审计报告第 13 节已确认这是现存口径（Bug 7）：第一笔订单的挂账回款进度被第二笔订单的状态遮蔽。
  // 本断言只冻结当前行为，不代表正确的业务语义。
  assert.equal(r333.credit, true);
  assert.equal(r333.status, '已结账');
  const first = r333.periodOrders[0];
  assert.equal(first.status, '已挂账');
  assert.equal(first.credit.remaining, 29500);
  assert.equal(r333.payments.filter(p => p.chargeId === 'credit-repayment').length, 1);
});

test('日报：回款批准写入 order.payments 且 collected 计入实收（口径冻结）', () => {
  const s = scenario();
  const d2 = s.orders[1];
  assert.equal(d2.payments.filter(p => p.chargeId === 'credit-repayment').length, 1);
  assert.equal(d2.credit.remaining, 29500);
  const allPayments = s.orders.flatMap(o => o.payments);
  assert.equal(allPayments.reduce((n, p) => n + p.amount, 0), 11800 + 16800 + 500 + 28200 + 400);
  assert.equal(collected(s), 11800 + 16800 + 500 + 28200 + 400);
});

test('日报：商品分类与销售人员归属只读销售行快照，改价不影响历史行', () => {
  let s = scenario();
  const dayOrders = () => s.orders.filter(o => reportPeriodMatch(o, s.clock, 'day'));
  const beforeCategory = reportBreakdown(dayOrders(), 'category');
  const beforeSeller = reportBreakdown(dayOrders(), 'seller');
  // 后台改名 + 改价（当前目录变化）
  s.user = 'administrator';
  s = apply(s, 'updateCatalogProduct', { id: 'bw', name: '新百威', saleOptions: [
    { id: 'single', name: '单支', baseQuantity: 1, priceCents: 1200 },
    { id: 'half', name: '半打', baseQuantity: 6, priceCents: 6900 },
    { id: 'dozen', name: '整打', baseQuantity: 12, priceCents: 13800 }
  ] });
  assert.deepEqual(reportBreakdown(dayOrders(), 'category'), beforeCategory);
  assert.deepEqual(reportBreakdown(dayOrders(), 'seller'), beforeSeller);
  assert.deepEqual(beforeCategory, [['啤酒', 12800], ['瓶装水', 600]]);
  assert.deepEqual(beforeSeller, [['邵老板', 13400]]);
});

test('日报：付款方式列对纯微信付款只显示方式名，混合付款显示金额', () => {
  const s = scenario();
  const d1 = reportOrder(s, 'V01', 'day');
  // D1 收钱一笔微信 + 结账现金/支付宝
  assert.equal(reportPaymentMethods(d1), '微信¥118+现金¥100+支付宝¥68');
  // 构造纯微信订单
  let s2 = initialState();
  s2.clock = at('20:00');
  s2.user = 'shaoBoss';
  s2 = apply(s2, 'open', { room: 'V01', beer: 'bw' });
  s2 = apply(s2, 'settle', { order: s2.orders[0].id, payments: [{ method: '微信', amount: 15800 }, { method: '微信', amount: 1000 }] });
  assert.equal(reportPaymentMethods(s2.orders[0]), '微信');
  // 未收
  let s3 = initialState();
  s3.clock = at('20:00');
  s3 = apply(s3, 'open', { room: 'V01', beer: 'bw' });
  assert.equal(reportPaymentMethods(s3.orders[0]), '未收');
});

test('周报与月报：按自然周（周一起始）和自然月过滤订单', () => {
  const s = scenario();
  // 2026-09-19 为周六；本周（09-14 起）应包含全部四笔
  assert.equal(s.orders.filter(o => reportPeriodMatch(o, s.clock, 'week')).length, 4);
  assert.equal(s.orders.filter(o => reportPeriodMatch(o, s.clock, 'month')).length, 4);
  // 把零售单时间改到上周日（09-13）：周报排除、月报仍包含（同年同月）
  const shifted = structuredClone(s);
  shifted.orders.at(-1).time = '2026-09-13T20:00:00+08:00';
  assert.equal(shifted.orders.filter(o => reportPeriodMatch(o, shifted.clock, 'week')).length, 3);
  assert.equal(shifted.orders.filter(o => reportPeriodMatch(o, shifted.clock, 'month')).length, 4);
  // 改到上个月：两种周期都排除
  shifted.orders.at(-1).time = '2026-08-15T20:00:00+08:00';
  assert.equal(shifted.orders.filter(o => reportPeriodMatch(o, shifted.clock, 'week')).length, 3);
  assert.equal(shifted.orders.filter(o => reportPeriodMatch(o, shifted.clock, 'month')).length, 3);
});

test('零售订单不进入房间视图，房间视图只列开过房的房间', () => {
  const s = scenario();
  const roomRows = s.rooms.map(room => ({ room, order: reportOrder(s, room.id, 'day') })).filter(row => row.order);
  assert.deepEqual(roomRows.map(row => row.room.id), ['V01', '333']);
  const retailOrders = s.orders.filter(o => o.kind === 'retail');
  assert.equal(retailOrders.length, 1);
  assert.equal(retailOrders[0].room, null);
  assert.equal(total(retailOrders[0]), 400);
  assert.equal(retailOrders[0].status, '已结账');
});

test('金额不变量：total = 套餐(基础+赠饮) + 销售行 + 其他费用；outstanding 下限为 0', () => {
  const s = scenario();
  for (const order of s.orders) {
    const expected = (order.packageBaseCents ?? order.base ?? 0) + (order.packageGiftValueCents ?? order.gift ?? 0)
      + (order.sales || []).reduce((sum, line) => sum + (line.amountCents ?? line.amount ?? 0), 0)
      + (order.otherCharges || []).reduce((sum, line) => sum + (line.amountCents ?? line.amount ?? 0), 0);
    assert.equal(total(order), expected, `order ${order.id}`);
    const paid = (order.payments || []).reduce((sum, payment) => sum + payment.amount, 0);
    assert.ok(outstanding(order) >= 0, `order ${order.id} outstanding >= 0`);
    assert.ok(paid <= total(order) + (order.credit ? order.credit.amount : 0), `order ${order.id} payments not exceed`);
  }
});
