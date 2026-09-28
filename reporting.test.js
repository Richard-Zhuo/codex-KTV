// Phase 6 前测：报表域（reporting selectors / view models）行为冻结。
// 报表聚合目前内嵌在 app.js（reportOrder / reportTotals / reportBreakdown /
// reportGiftDetails / reportSaleDetails / reportOtherDetails / reportGiftPerson /
// reportPaymentMethods / reportNotes / reportPage 视图模型常量）。
// 本文件按 app.js 同名函数当前实现逐字拷贝其计算逻辑（闭包变量 → 显式参数，
// 不含 DOM 模板），作为 Phase 6 抽取 reporting.js 前的冻结证据。
// Phase 6 抽取后，文件末尾的后测将直接 import reporting.js，要求输出与
// 本处冻结值完全一致；拷贝函数继续保留作为冻结参考，不删除。
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from './rules.js';
import { total, outstanding, nextCollectCharge } from './sales.js';

let seq = 0;
const apply = (s, a, d = {}) => transact(s, a, d, `reporting-char-${++seq}`);
const at = hour => `2026-09-19T${hour}:00+08:00`;
const money = cents => `¥${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
const productIdOf = line => line.productId ?? line.product;
function stocked(s) { for (const balance of Object.values(s.inventory)) if (balance.count === null) balance.count = 1000; return s; }
const signature = 'data:image/png;base64,' + 'A'.repeat(100);

// —— 以下函数为 app.js 当前实现的逐字拷贝（闭包→参数，仅替换自由变量）——
const reportMoney = centsValue => money(Number(centsValue || 0));
const reportQuantity = value => Number(value || 0).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
const reportDateKey = value => { const d = new Date(value); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const reservationDate = time => new Date(time).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
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
  return { ...orders.at(-1), periodOrders: orders, packageBaseCents: base, packageGiftValueCents: gift, base, gift, drinks: orders.flatMap(order => order.drinks || []), extras: orders.flatMap(order => order.extras || []), sales: orders.flatMap(order => order.sales || []), otherCharges: orders.flatMap(order => order.otherCharges || []), bonusGifts: orders.flatMap(order => order.bonusGifts || []), payments: orders.flatMap(order => order.payments || []), rounding: orders.reduce((sum, order) => sum + Number(order.rounding || 0), 0), status: orders.at(-1).status, voucher: orders.find(order => order.voucher)?.voucher };
}
const reportGiftAmount = order => (order?.bonusGifts || []).reduce((sum, gift) => sum + (Number.isSafeInteger(gift.referenceValueCents) ? gift.referenceValueCents : 0), 0);
function reportGiftDetails(order) {
  return (order?.bonusGifts || []).flatMap(gift => (gift.drinks || []).filter(line => line.count).map(line => `${reportQuantity(line.totalBaseQuantity ?? line.count)}${line.baseUnitSnapshot || gift.baseUnitSnapshot || '基础单位'}${line.productNameSnapshot || gift.productNameSnapshot || `历史商品（${productIdOf(line)}）`}`));
}
function reportSaleDetails(order) {
  return (order?.sales || []).map(line => `${line.categoryLabelSnapshot || line.categorySnapshot || '历史未分类'} · ${line.productNameSnapshot || `历史商品（${productIdOf(line)}）`} × ${line.saleQuantity ?? line.count}（${line.saleOptionNameSnapshot || line.baseUnitSnapshot || '规格未记录'}） ${money(line.amountCents ?? line.amount ?? 0)}`);
}
function reportOtherDetails(order) {
  return (order?.otherCharges || []).map(line => `${line.category === '其他' ? line.item : line.category} ${money(line.amountCents ?? line.amount ?? 0)}`);
}
function reportBreakdown(orders, key) {
  const totals = new Map();
  for (const line of orders.flatMap(order => order.sales || [])) {
    const label = key === 'category' ? (line.categoryLabelSnapshot || line.categorySnapshot || '历史未分类') : (line.person || '归属未记录');
    totals.set(label, (totals.get(label) || 0) + Number(line.amountCents ?? line.amount ?? 0));
  }
  return [...totals.entries()];
}
function reportTotals(orders) {
  return orders.reduce((sum, order) => { sum.base += Number(order.packageBaseCents ?? order.base ?? 0); sum.sales += (order.sales || []).reduce((n, line) => n + Number(line.amountCents ?? line.amount ?? 0), 0) + Number(order.packageGiftValueCents ?? order.gift ?? 0); sum.gift += reportGiftAmount(order); sum.total += total(order); sum.rounding += Number(order.rounding || 0); return sum; }, { base: 0, sales: 0, gift: 0, total: 0, rounding: 0 });
}
function reportGiftPerson(order) {
  if (!order) return '';
  const people = (order.bonusGifts || []).map(gift => gift.requestedBy).filter(Boolean);
  return [...new Set(people)].join('、');
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
function reportNotes(order, reportPeriod) {
  if (!order) return [];
  const repaymentSuffix = item => {
    const credit = item?.credit;
    const fullyRepaid = item?.status === '已回款' || (credit && typeof credit === 'object' && Number(credit.remaining || 0) === 0);
    return credit && fullyRepaid ? ' 已回款' : '';
  };
  // Bug #7 修复后的正确口径：日报备注逐笔列出周期内每笔挂账（含金额与回款状态）。
  if (reportPeriod === 'day') {
    const creditNotes = [...(order.periodOrders || [order])]
      .filter(item => item.credit)
      .sort((a, b) => Date.parse(b.credit.submittedAt || b.time) - Date.parse(a.credit.submittedAt || a.time))
      .map(item => `挂账${reportMoney(item.credit.amount)}${repaymentSuffix(item)}`);
    return [...creditNotes, order.voucher ? `${order.voucher.provider}待验券` : '', order.status === '已结账' ? '已结账' : ''].filter(Boolean);
  }
  return [...(order.periodOrders || [])]
    .filter(item => item.credit)
    .sort((a, b) => Date.parse(b.credit.submittedAt || b.time) - Date.parse(a.credit.submittedAt || a.time))
    .map(item => `${reservationDate(item.credit.submittedAt || item.time)} 挂账${reportMoney(item.credit.amount)}${repaymentSuffix(item)}`);
}
// reportPage 头部的视图模型聚合（逐行来自 HEAD app.js reportPage，不含模板字符串）
function reportViewModel(state, reportPeriod) {
  const periodOrders = state.orders.filter(order => reportPeriodMatch(order, state.clock, reportPeriod)), roomOrders = periodOrders.filter(order => order.kind !== 'retail'), retailOrders = periodOrders.filter(order => order.kind === 'retail');
  const rows = state.rooms.map(room => ({ room, order: reportOrder(state, room.id, reportPeriod) })).filter(row => row.order);
  const totals = reportTotals(periodOrders), roomTotals = reportTotals(roomOrders);
  const roomSales = roomOrders.flatMap(order => order.sales || []).reduce((sum, line) => sum + Number(line.amountCents ?? line.amount ?? 0), 0);
  const roomOther = roomOrders.flatMap(order => order.otherCharges || []).reduce((sum, line) => sum + Number(line.amountCents ?? line.amount ?? 0), 0);
  const categoryRows = reportBreakdown(periodOrders, 'category'), sellerRows = reportBreakdown(periodOrders, 'seller');
  return { periodOrders, roomOrders, retailOrders, rows, totals, roomTotals, roomSales, roomOther, categoryRows, sellerRows };
}

// —— 场景 A：与 characterization-report.test.js 相同（分次收款、挂账回款、同房两单、零售）——
function scenarioA() {
  let s = initialState();
  s.clock = at('20:00');
  s.user = 'shaoBoss';
  s = apply(s, 'open', { room: 'V01', beer: 'bw' });
  s = stocked(s);
  const d1 = s.orders[0].id;
  s = apply(s, 'sale', { order: d1, items: [{ product: 'bw', spec: 'dozen', count: 1 }] });
  const saleCharge = nextCollectCharge(s.orders[0]);
  s = apply(s, 'collect', { order: d1, charge: saleCharge.id, payments: [{ method: '微信', amount: saleCharge.remaining }] });
  s = apply(s, 'settle', { order: d1, payments: [{ method: '现金', amount: 10000 }, { method: '支付宝', amount: 6800 }] });
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
  s.user = 'shaoBoss';
  s = apply(s, 'clean', { room: '333' });
  s = apply(s, 'open', { room: '333', beer: 'bw' });
  const d3 = s.orders.at(-1).id;
  s = apply(s, 'sale', { order: d3, product: 'water', spec: 'single', count: 1 });
  s = apply(s, 'settle', { order: d3, payments: [{ method: '现金', amount: 28200 }] });
  s = apply(s, 'retailSale', { items: [{ product: 'water', spec: 'single', count: 2 }], payments: [{ method: '美团', amount: 400 }] });
  return s;
}

// —— 场景 B：赠酒（增购 2 打直接赠半打）+ 其他消费 + 美团平台券开房 ——
function scenarioB() {
  let s = initialState();
  s.clock = at('20:00');
  s.user = 'shaoBoss';
  s = apply(s, 'open', { room: 'V05', beer: 'bw' });
  s = stocked(s);
  const id = s.orders[0].id;
  s = apply(s, 'sale', { order: id, items: [{ product: 'bw', spec: 'dozen', count: 2 }] });
  s = apply(s, 'gift', { order: id, product: 'bw', halves: 1 });
  s = apply(s, 'otherCharge', { order: id, category: '小吃', amount: 1000 });
  s = apply(s, 'settle', { order: id, payments: [{ method: '微信', amount: total(s.orders[0]) }] });
  s = apply(s, 'open', { room: 'V06', beer: 'bw', openSource: '美团' });
  const d2 = s.orders.at(-1).id;
  s = apply(s, 'settle', { order: d2, payments: [] });
  return s;
}

test('前测·销售明细格式：分类快照 · 名称快照 × 数量（规格快照） 金额', () => {
  const s = scenarioA();
  const v01 = reportOrder(s, 'V01', 'day'), r333 = reportOrder(s, '333', 'day');
  assert.deepEqual(reportSaleDetails(v01), ['啤酒 · 百威 × 1（整打） ¥118']);
  assert.deepEqual(reportSaleDetails(r333), ['啤酒 · 百威 × 1（单支） ¥10', '瓶装水 · 瓶装水 × 1（单支） ¥2']);
});

test('前测·赠酒明细与赠送人：数量+基础单位+名称快照；requestedBy 去重', () => {
  const s = scenarioB();
  const v05 = reportOrder(s, 'V05', 'day');
  assert.deepEqual(reportGiftDetails(v05), ['6支百威']);
  assert.equal(reportGiftPerson(v05), '邵老板');
  assert.equal(reportGiftAmount(v05), 5900);
  const a = scenarioA();
  assert.deepEqual(reportGiftDetails(reportOrder(a, 'V01', 'day')), []);
  assert.equal(reportGiftPerson(reportOrder(a, 'V01', 'day')), '');
});

test('前测·其他消费明细：非“其他”分类显示分类名，金额带 ¥', () => {
  const s = scenarioB();
  const v05 = reportOrder(s, 'V05', 'day');
  assert.deepEqual(reportOtherDetails(v05), ['小吃 ¥10']);
  const a = scenarioA();
  assert.deepEqual(reportOtherDetails(reportOrder(a, 'V01', 'day')), []);
});

test('前测·备注矩阵：日报逐笔挂账含金额；非日报列挂账流水；平台券待验券', () => {
  const a = scenarioA();
  const v01 = reportOrder(a, 'V01', 'day'), r333 = reportOrder(a, '333', 'day');
  assert.deepEqual(reportNotes(v01, 'day'), ['已结账']);
  assert.deepEqual(reportNotes(r333, 'day'), ['挂账¥300', '已结账']);
  // 周/月报：只列有挂账的订单，按提交时间倒序，日期为提交日（9/19），部分回款不显示已回款
  assert.deepEqual(reportNotes(r333, 'week'), ['9/19 挂账¥300']);
  assert.deepEqual(reportNotes(r333, 'month'), ['9/19 挂账¥300']);
  assert.deepEqual(reportNotes(v01, 'week'), []);
  const b = scenarioB();
  const v06 = reportOrder(b, 'V06', 'day');
  assert.deepEqual(reportNotes(v06, 'day'), ['美团待验券', '已结账']);
  // 平台券聚合：voucher 取首个有券订单
  assert.deepEqual(v06.voucher, { provider: '美团', status: '待验券', covered: 16800, interface: 'platform-voucher-scan' });
  // Bug #7 回归：同房多单时日报备注逐笔保留每笔挂账金额
  let multi = scenarioA();
  multi = apply(multi, 'clean', { room: '333' });
  multi.user = 'shaoBoss';
  multi = apply(multi, 'open', { room: '333', beer: 'bw' });
  const d5 = multi.orders.at(-1).id;
  multi = apply(multi, 'sale', { order: d5, product: 'water', spec: 'single', count: 1 });
  multi.user = 'keeper';
  multi = apply(multi, 'credit', { order: d5, name: '二单顾客', note: '第二笔挂账', signature });
  const r333m = reportOrder(multi, '333', 'day');
  const secondAmount = multi.orders.find(o => o.id === d5).credit.amount;
  assert.deepEqual(reportNotes(r333m, 'day'), ['挂账¥300', `挂账${reportMoney(secondAmount)}`], '两笔挂账逐笔列出且金额各自保留（末单未审批完成，不显示已结账）');
});

test('前测·付款方式列：纯微信只显示方式名；混合显示金额；未收款显示“未收”；0 元券单为空', () => {
  const a = scenarioA();
  const v01 = reportOrder(a, 'V01', 'day');
  assert.equal(reportPaymentMethods(v01), '微信¥118+现金¥100+支付宝¥68');
  const b = scenarioB();
  const v05 = reportOrder(b, 'V05', 'day'), v06 = reportOrder(b, 'V06', 'day');
  assert.equal(reportPaymentMethods(v05), '微信');
  assert.equal(reportPaymentMethods(v06), '');
  let s3 = initialState();
  s3.clock = at('20:00');
  s3 = apply(s3, 'open', { room: 'V01', beer: 'bw' });
  assert.equal(reportPaymentMethods(s3.orders[0]), '未收');
});

test('前测·视图模型（日报）：房间行、合计、零售分离；分类/人员归 breakdown', () => {
  const a = scenarioA();
  const view = reportViewModel(a, 'day');
  assert.deepEqual(view.rows.map(row => row.room.id), ['V01', '333']);
  assert.equal(view.periodOrders.length, 4);
  assert.equal(view.retailOrders.length, 1);
  assert.deepEqual(view.totals, { base: 15800, sales: 72400, gift: 0, total: 88200, rounding: 1000 });
  assert.deepEqual(view.roomTotals, { base: 15800, sales: 72000, gift: 0, total: 87800, rounding: 1000 });
  assert.equal(view.roomSales, 13000);
  assert.equal(view.roomOther, 0);
  assert.deepEqual(view.categoryRows, [['啤酒', 12800], ['瓶装水', 600]]);
  assert.deepEqual(view.sellerRows, [['邵老板', 13400]]);
});

test('前测·视图模型（含赠酒/其他消费/平台券）：合计口径 total=房费+赠饮+销售+其他', () => {
  const b = scenarioB();
  const view = reportViewModel(b, 'day');
  assert.deepEqual(view.rows.map(row => row.room.id), ['V05', 'V06']);
  assert.equal(view.retailOrders.length, 0);
  assert.deepEqual(view.totals, { base: 5000, sales: 35400, gift: 5900, total: 41400, rounding: 0 });
  assert.deepEqual(view.roomTotals, view.totals);
  assert.equal(view.roomSales, 23600);
  assert.equal(view.roomOther, 1000);
  assert.deepEqual(view.categoryRows, [['啤酒', 23600]]);
  assert.deepEqual(view.sellerRows, [['邵老板', 23600]]);
  const v05 = view.rows[0].order;
  assert.equal(v05.base, 5000);
  assert.equal(v05.gift, 11800);
  assert.equal(v05.bonusGifts.length, 1);
  assert.equal(v05.otherCharges.length, 1);
  assert.equal(total(v05), 41400);
});

test('前测·周/月报视图模型：自然周（周一起始）与自然月过滤', () => {
  const a = scenarioA();
  // 2026-09-19 为周六：本周（09-14 起）含全部 4 笔
  const week = reportViewModel(a, 'week'), month = reportViewModel(a, 'month');
  assert.equal(week.periodOrders.length, 4);
  assert.equal(month.periodOrders.length, 4);
  // 零售单移到上周日（09-13）：周报排除、月报仍含
  const shifted = structuredClone(a);
  shifted.orders.at(-1).time = '2026-09-13T20:00:00+08:00';
  assert.equal(reportViewModel(shifted, 'week').periodOrders.length, 3);
  assert.equal(reportViewModel(shifted, 'month').periodOrders.length, 4);
  // 移到上个月：两种周期都排除
  shifted.orders.at(-1).time = '2026-08-15T20:00:00+08:00';
  assert.equal(reportViewModel(shifted, 'week').periodOrders.length, 3);
  assert.equal(reportViewModel(shifted, 'month').periodOrders.length, 3);
});

// —— 后测（Phase 6 抽取后）：直接测试 reporting.js 的 selectors／view models，
// 要求输出与上方前测冻结拷贝（HEAD app.js 逐字拷贝）完全一致 ——
import * as reporting from './reporting.js';

test('后测·reporting.js 与前测冻结拷贝输出一致（场景 A：聚合、明细、备注、视图模型）', () => {
  const a = scenarioA();
  const v01 = reportOrder(a, 'V01', 'day'), r333 = reportOrder(a, '333', 'day');
  const v01n = reporting.reportOrder(a, 'V01', 'day'), r333n = reporting.reportOrder(a, '333', 'day');
  assert.deepEqual(v01n, v01);
  assert.deepEqual(r333n, r333);
  assert.deepEqual(reporting.reportSaleDetails(v01n), reportSaleDetails(v01));
  assert.deepEqual(reporting.reportSaleDetails(r333n), reportSaleDetails(r333));
  assert.deepEqual(reporting.reportGiftDetails(v01n), reportGiftDetails(v01));
  assert.equal(reporting.reportGiftPerson(r333n), reportGiftPerson(r333));
  assert.deepEqual(reporting.reportOtherDetails(v01n), reportOtherDetails(v01));
  assert.deepEqual(reporting.reportNotes(v01n, 'day'), reportNotes(v01, 'day'));
  assert.deepEqual(reporting.reportNotes(r333n, 'day'), reportNotes(r333, 'day'));
  assert.deepEqual(reporting.reportNotes(r333n, 'week'), reportNotes(r333, 'week'));
  assert.deepEqual(reporting.reportNotes(r333n, 'month'), reportNotes(r333, 'month'));
  assert.equal(reporting.reportPaymentMethods(v01n), reportPaymentMethods(v01));
  const vmEquals = (actual, frozen) => {
    assert.deepEqual(actual.rows.map(row => ({ room: row.room, order: row.order })), frozen.rows);
    for (const [i, row] of actual.rows.entries()) {
      assert.equal(row.sales, (frozen.rows[i].order.sales || []).reduce((sum, line) => sum + Number(line.amountCents ?? line.amount ?? 0), 0));
      assert.equal(row.other, (frozen.rows[i].order.otherCharges || []).reduce((sum, line) => sum + Number(line.amountCents ?? line.amount ?? 0), 0));
    }
    assert.deepEqual(actual.periodOrders, frozen.periodOrders);
    assert.deepEqual(actual.roomOrders, frozen.roomOrders);
    assert.deepEqual(actual.retailOrders, frozen.retailOrders);
    assert.deepEqual(actual.totals, frozen.totals);
    assert.deepEqual(actual.roomTotals, frozen.roomTotals);
    assert.equal(actual.roomSales, frozen.roomSales);
    assert.equal(actual.roomOther, frozen.roomOther);
    assert.deepEqual(actual.categoryRows, frozen.categoryRows);
    assert.deepEqual(actual.sellerRows, frozen.sellerRows);
  };
  vmEquals(reporting.reportViewModel(a, 'day'), reportViewModel(a, 'day'));
  vmEquals(reporting.reportViewModel(a, 'week'), reportViewModel(a, 'week'));
  vmEquals(reporting.reportViewModel(a, 'month'), reportViewModel(a, 'month'));
});

test('后测·reporting.js 与前测冻结拷贝输出一致（场景 B：赠酒／其他消费／平台券）', () => {
  const b = scenarioB();
  const v05 = reportOrder(b, 'V05', 'day'), v06 = reportOrder(b, 'V06', 'day');
  const v05n = reporting.reportOrder(b, 'V05', 'day'), v06n = reporting.reportOrder(b, 'V06', 'day');
  assert.deepEqual(v05n, v05);
  assert.deepEqual(v06n, v06);
  assert.deepEqual(reporting.reportGiftDetails(v05n), ['6支百威']);
  assert.equal(reporting.reportGiftPerson(v05n), '邵老板');
  assert.equal(reporting.reportGiftAmount(v05n), 5900);
  assert.deepEqual(reporting.reportOtherDetails(v05n), ['小吃 ¥10']);
  assert.equal(reporting.reportPaymentMethods(v05n), '微信');
  assert.equal(reporting.reportPaymentMethods(v06n), '');
  assert.deepEqual(reporting.reportNotes(v06n, 'day'), ['美团待验券', '已结账']);
  const frozen = reportViewModel(b, 'day'), actual = reporting.reportViewModel(b, 'day');
  assert.deepEqual(actual.rows.map(row => ({ room: row.room, order: row.order })), frozen.rows);
  assert.deepEqual(actual.totals, frozen.totals);
  assert.deepEqual(actual.roomTotals, frozen.roomTotals);
  assert.equal(actual.roomSales, frozen.roomSales);
  assert.equal(actual.roomOther, frozen.roomOther);
  assert.deepEqual(actual.categoryRows, frozen.categoryRows);
  assert.deepEqual(actual.sellerRows, frozen.sellerRows);
  const view = reporting.reportViewModel(b, 'day');
  assert.equal(view.rows[0].sales, 23600);
  assert.equal(view.rows[0].other, 1000);
});

test('后测·reporting.js 是纯投影：反复调用不改变 state（UI 无报表聚合的等价性基础）', () => {
  const a = scenarioA();
  const before = structuredClone(a);
  for (const period of ['day', 'week', 'month']) {
    reporting.reportViewModel(a, period);
    for (const room of ['V01', '333', 'V02']) reporting.reportOrder(a, room.id, period);
  }
  assert.deepEqual(a, before);
});

test('后测·基础格式化选择器与冻结口径一致', () => {
  assert.equal(reporting.reportMoney(0), '¥0');
  assert.equal(reporting.reportMoney(41400), '¥414');
  assert.equal(reporting.reportMoney(undefined), '¥0');
  assert.equal(reporting.reportQuantity(6), '6');
  assert.equal(reporting.reportQuantity(6.5), '6.5');
  assert.equal(reporting.reportDateKey('2026-09-19T20:00:00+08:00'), '2026-9-19');
  assert.equal(reporting.reportPeriodMatch(null, '2026-09-19T20:00:00+08:00', 'day'), false);
});
