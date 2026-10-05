import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from './rules.js';
import { quote } from './rooms.js';
import { total, outstanding, collected, nextCollectCharge } from './sales.js';
import { effectiveUser, hasPermission, businessReviewSections } from './shared/identity.js';
import { findProduct, saleOption } from './catalog.js';
import { reviewHistoryRows } from './reviewInbox.js';
import { createDemoPersistence } from './persistence.js';

let serial = 0;
const key = () => `offsite-contract-${++serial}`;
const run = (state, action, data = {}) => transact(state, action, data, key());
const at = (day = 28, hour = 20) => new Date(2026, 8, day, hour).toISOString();
const signature = 'data:image/png;base64,' + 'A'.repeat(100);
function fresh() {
  const state = initialState();
  state.clock = at();
  state.user = 'shaoBoss';
  return state;
}
function opened(room = 'V01') {
  return run(fresh(), 'open', { room, beer: 'bw' });
}
function withStock(state, product = 'bw', count = 30) {
  state.user = 'zhuBoss';
  state = run(state, 'stock', { product, count, reason: '契约测试期初实点' });
  const request = state.inventoryReviews.at(-1).id;
  assert.equal(state.inventory[product].count, null);
  state.user = 'xiongBoss';
  state = run(state, 'approveInventory', { request });
  state.user = 'shaoBoss';
  return state;
}

test('订单合同：房单与零售单共用订单集，零售无房间且不改房态', () => {
  let state = withStock(fresh());
  state = run(state, 'open', { room: 'V01', beer: 'bw' });
  const roomBefore = structuredClone(state.rooms);
  state = run(state, 'retailSale', {
    items: [{ product: 'bw', spec: 'single', count: 1 }],
    payments: [{ method: '现金', amount: 1000 }]
  });
  assert.deepEqual(state.orders.map(o => [o.kind, o.room, o.status]), [
    ['room', 'V01', '营业中'], ['retail', null, '已结账']
  ]);
  assert.deepEqual(state.rooms, roomBefore);
  assert.equal(state.orders[1].payments[0].chargeId, 'retail');
});

test('权限合同：后台入口权不授予营业审核或事务能力', () => {
  let state = opened();
  state.user = 'administrator';
  state = run(state, 'setPermissions', { user: 'zhuYi', permissions: ['backend.view'] });
  state.user = 'zhuYi';
  assert.equal(hasPermission(effectiveUser(state), 'backend.view'), true);
  assert.deepEqual(businessReviewSections(effectiveUser(state)), []);
  const before = structuredClone(state);
  const charge = nextCollectCharge(state.orders[0]);
  assert.throws(() => run(state, 'collect', {
    order: state.orders[0].id, charge: charge.id,
    payments: [{ method: '现金', amount: charge.remaining }]
  }), /权限/);
  assert.throws(() => run(state, 'approve', { order: state.orders[0].id }), /审批已处理|权限/);
  assert.deepEqual(state, before);
});

test('权限合同：具体审核权之外，本人审核还需要 review.self', () => {
  let state = fresh();
  state.user = 'xiongBoss';
  state = run(state, 'stock', { product: 'bw', count: 20, reason: '期初实点' });
  const request = state.inventoryReviews[0].id;
  const before = structuredClone(state);
  assert.throws(() => run(state, 'approveInventory', { request }), /审核本人申请需要/);
  assert.deepEqual(state, before);
  state.user = 'administrator';
  const permissions = effectiveUser(state, 'xiongBoss').permissions;
  state = run(state, 'setPermissions', {
    user: 'xiongBoss', permissions: [...permissions, 'review.self']
  });
  state.user = 'xiongBoss';
  state = run(state, 'approveInventory', { request });
  assert.equal(state.inventoryReviews[0].selfReviewAuthorized, true);
  assert.equal(state.inventory.bw.count, 20);
});

test('付款合同：同一房单可跨操作分渠道付款，操作键重试不重复入账', () => {
  let state = opened();
  const id = state.orders[0].id;
  const opening = nextCollectCharge(state.orders[0]);
  const paymentKey = key();
  const first = transact(state, 'collect', {
    order: id, charge: opening.id,
    payments: [{ method: '微信', amount: 10000 }, { method: '现金', amount: 6800 }]
  }, paymentKey);
  assert.strictEqual(transact(first, 'collect', {
    order: id, charge: opening.id,
    payments: [{ method: '微信', amount: 10000 }, { method: '现金', amount: 6800 }]
  }, paymentKey), first);
  state = run(first, 'otherCharge', { order: id, category: '代驾', amount: 3500 });
  const charge = nextCollectCharge(state.orders[0]);
  state = run(state, 'collect', {
    order: id, charge: charge.id,
    payments: [{ method: '支付宝', amount: 2000 }, { method: '抖音', amount: 1500 }]
  });
  assert.deepEqual(state.orders[0].payments.map(p => [p.chargeId, p.method, p.amount]), [
    ['open', '微信', 10000], ['open', '现金', 6800],
    [charge.id, '支付宝', 2000], [charge.id, '抖音', 1500]
  ]);
  assert.equal(collected(state), 20300);
  assert.equal(outstanding(state.orders[0]), 0);
  state = run(state, 'settle', { order: id, payments: [] });
  assert.equal(state.orders[0].payments.length, 4);
  assert.equal(state.orders[0].status, '已结账');
  assert.equal(state.rooms.find(r => r.id === 'V01').status, '待清洁');
});

test('金额合同：原始应收、已付、免零及实收分别保留', () => {
  let state = opened();
  const id = state.orders[0].id;
  state = run(state, 'settle', {
    order: id, payments: [{ method: '现金', amount: 16000 }]
  });
  const order = state.orders[0];
  assert.equal(total(order), 16800);
  assert.equal(order.payments.reduce((n, p) => n + p.amount, 0), 16000);
  assert.equal(order.rounding, 800);
  assert.equal(collected(state), 16000);
  assert.equal(total(order), order.payments.reduce((n, p) => n + p.amount, 0) + order.rounding);
  assert.equal(order.status, '已结账');
});

test('K06 回归：已生效免零抵扣 outstanding，免零不计入实收', () => {
  let state = opened();
  state = run(state, 'settle', {
    order: state.orders[0].id, payments: [{ method: '现金', amount: 16000 }]
  });
  assert.equal(state.orders[0].status, '已结账');
  assert.equal(state.orders[0].rounding, 800);
  assert.equal(outstanding(state.orders[0]), 0);
  assert.equal(collected(state), 16000);
  assert.equal(state.orders[0].payments.length, 1);
});

test('目录合同：运行时目录改价只影响新销售，旧订单持成交快照', () => {
  let state = withStock(fresh());
  state = run(state, 'retailSale', {
    product: 'bw', spec: 'dozen', count: 1,
    payments: [{ method: '现金', amount: 11800 }]
  });
  const old = structuredClone(state.orders[0].sales[0]);
  state.user = 'administrator';
  const current = findProduct(state.catalog, 'bw');
  state = run(state, 'updateCatalogProduct', {
    id: 'bw', name: '改名百威',
    saleOptions: current.saleOptions.map(option => option.id === 'dozen'
      ? { ...option, priceCents: 12800 } : option)
  });
  assert.equal(saleOption(findProduct(state.catalog, 'bw'), 'dozen').priceCents, 12800);
  assert.deepEqual(state.orders[0].sales[0], old);
  state.user = 'shaoBoss';
  state = run(state, 'retailSale', {
    product: 'bw', spec: 'dozen', count: 1,
    payments: [{ method: '微信', amount: 12800 }]
  });
  assert.deepEqual(state.orders.map(o => [
    o.sales[0].productId, o.sales[0].productNameSnapshot,
    o.sales[0].pricePerSaleUnitCents, o.sales[0].amountCents
  ]), [
    ['bw', '百威', 11800, 11800], ['bw', '改名百威', 12800, 12800]
  ]);
});

test('库存合同：销售规格数量乘基础数量等于出库流水和余额变化', () => {
  let state = withStock(fresh(), 'bw', 30);
  state = run(state, 'retailSale', {
    items: [
      { product: 'bw', spec: 'dozen', count: 1 },
      { product: 'bw', spec: 'half', count: 1 }
    ],
    payments: [{ method: '现金', amount: 17700 }]
  });
  const order = state.orders[0];
  assert.deepEqual(order.sales.map(line => [
    line.saleQuantity, line.baseQuantityPerSaleUnit, line.totalBaseQuantity
  ]), [[1, 12, 12], [1, 6, 6]]);
  assert.deepEqual(state.ledger.filter(row => row.saleLineId).map(row => row.baseQuantityDelta), [-12, -6]);
  assert.equal(state.inventory.bw.count, 12);
  assert.equal(order.sales.reduce((sum, line) => sum + line.totalBaseQuantity, 0), 18);
});

test('库存合同：一项库存失败不能留下半张零售单、付款或流水', () => {
  const state = withStock(fresh(), 'bw', 10);
  const before = structuredClone(state);
  assert.throws(() => run(state, 'retailSale', {
    items: [
      { product: 'bw', spec: 'single', count: 1 },
      { product: 'bw', spec: 'dozen', count: 1 }
    ],
    payments: [{ method: '现金', amount: 12800 }]
  }), /库存不足/);
  assert.deepEqual(state, before);
  assert.equal(state.orders.length, 0);
});

test('库存合同：建账前赠饮的 counted:false 不是实际余额扣减', () => {
  let state = opened();
  assert.equal(state.inventory.bw.count, null);
  assert.equal(state.ledger.length, 1);
  assert.deepEqual([state.ledger[0].baseQuantityDelta, state.ledger[0].counted], [-12, false]);
  state = withStock(state, 'bw', 20);
  assert.equal(state.inventory.bw.count, 20);
  assert.equal(state.ledger.find(row => row.counted === false).baseQuantityDelta, -12);
});

test('挂账合同：申请、审核、回款申请及审核后付款保持金额对应', () => {
  let state = opened();
  const id = state.orders[0].id;
  state = run(state, 'credit', {
    order: id, name: '测试客人', note: '约定次日结清', signature
  });
  assert.equal(state.orders[0].status, '待审批挂账');
  assert.equal(state.orders[0].credit.amount, 16800);
  assert.equal(state.orders[0].credit.remaining, 16800);
  assert.equal(state.orders[0].payments.length, 0);
  assert.equal(collected(state), 0);
  state.user = 'wife';
  state = run(state, 'approve', { order: id });
  assert.equal(state.orders[0].status, '已挂账');
  state.user = 'shaoBoss';
  state = run(state, 'repay', { order: id, amount: 5000, method: '微信' });
  const request = state.orders[0].credit.repaymentRequests[0];
  assert.equal(request.status, '待审核');
  assert.equal(state.orders[0].credit.remaining, 16800);
  assert.equal(collected(state), 0);
  state.user = 'xiongBoss';
  state = run(state, 'approveRepayment', { order: id, request: request.id });
  const order = state.orders[0];
  assert.equal(order.credit.remaining, 11800);
  assert.equal(order.credit.repayments.length, 1);
  assert.equal(order.payments.length, 1);
  assert.equal(order.credit.repayments[0].repaymentRequestId, request.id);
  assert.equal(order.payments[0].repaymentRequestId, request.id);
  assert.equal(order.credit.repayments[0].amount, order.payments[0].amount);
  assert.equal(collected(state), 5000);
  assert.equal(order.credit.amount - order.credit.repayments.reduce((n, p) => n + p.amount, 0), order.credit.remaining);
  state.user = 'shaoBoss';
  state = run(state, 'repay', { order: id, amount: 11800, method: '现金' });
  state.user = 'xiongBoss';
  state = run(state, 'approveRepayment', {
    order: id, request: state.orders[0].credit.repaymentRequests.at(-1).id
  });
  assert.equal(state.orders[0].status, '已回款');
  assert.equal(state.orders[0].credit.remaining, 0);
  assert.equal(collected(state), total(state.orders[0]));
});

test('库存审批合同：申请期间余额不变，批准时才留下有来源的调整', () => {
  let state = withStock(fresh(), 'bw', 30);
  state.user = 'zhuBoss';
  state = run(state, 'stock', { product: 'bw', count: 27, reason: '实点破损三支' });
  const request = state.inventoryReviews.at(-1);
  assert.equal(state.inventory.bw.count, 30);
  assert.equal(request.status, '待审核');
  state.user = 'xiongBoss';
  state = run(state, 'approveInventory', { request: request.id });
  assert.equal(state.inventory.bw.count, 27);
  assert.equal(state.ledger.at(-1).delta, -3);
  assert.deepEqual([state.ledger.at(-1).before, state.ledger.at(-1).after], [30, 27]);
  assert.equal(state.inventoryReviews.at(-1).status, '已批准');
});

test('K01 回归：超额免零待审期间保留付款、余额及营业房态', () => {
  let state = opened();
  state = run(state, 'settle', {
    order: state.orders[0].id, payments: [{ method: '现金', amount: 1 }]
  });
  assert.equal(total(state.orders[0]), 16800);
  assert.equal(state.orders[0].rounding, 16799);
  assert.equal(collected(state), 1);
  assert.equal(state.orders[0].roundingReview.status, '待审核');
  assert.equal(outstanding(state.orders[0]), 16799);
  assert.equal(state.orders[0].status, '营业中');
  assert.equal(state.rooms.find(r => r.id === 'V01').status, '营业中');
  assert.equal(state.rooms.find(r => r.id === 'V01').order, state.orders[0].id);
});

test('K02 回归：拒绝不一致套餐价格，报价与账单使用同一金额', () => {
  let state = fresh();
  state.user = 'administrator';
  const before = structuredClone(state);
  assert.throws(() => run(state, 'updateCatalogPackage', {
    id: 'room.small.night', priceCents: 100
  }), /套餐总价必须等于基础房费加赠饮参考值/);
  assert.deepEqual(state, before);
  state = run(state, 'updateCatalogPackage', {
    id: 'room.small.night', basePriceCents: 6000, priceCents: 17800
  });
  const quoted = quote('小房', state.clock, 'bw', '', state.catalog);
  assert.equal(quoted.total, quoted.base + quoted.gift);
  assert.equal(quoted.total, 17800);
  state.user = 'shaoBoss';
  state = run(state, 'open', { room: 'V01', beer: 'bw' });
  assert.equal(state.orders[0].packagePriceCents, 17800);
  assert.equal(total(state.orders[0]), 17800);
  assert.equal(outstanding(state.orders[0]), 17800);
});

test('K03 回归：高额挂账仅指定老板岗位可审批', () => {
  let state = opened();
  state = run(state, 'otherCharge', {
    order: state.orders[0].id, category: '代驾', amount: 100000
  });
  state = run(state, 'credit', {
    order: state.orders[0].id, name: '测试客人', note: '大额挂账核验', signature
  });
  assert.equal(state.orders[0].credit.approver, '老板');
  state.user = 'wife';
  assert.equal(effectiveUser(state).roles.includes('老板'), false);
  assert.equal(hasPermission(effectiveUser(state), 'credit.approve'), true);
  const before = structuredClone(state);
  assert.throws(() => run(state, 'approve', { order: state.orders[0].id }), /这笔挂账需要老板岗位审批/);
  assert.deepEqual(state, before);
  state.user = 'zhuBoss';
  state = run(state, 'approve', { order: state.orders[0].id });
  assert.equal(state.orders[0].status, '已挂账');
  assert.equal(state.orders[0].credit.decisionBy, '卓老板');
});

test.skip('KNOWN BUSINESS ISSUE：重复交班沿用全历史累计实收', () => {
  let state = opened();
  state = run(state, 'pay', {
    order: state.orders[0].id, payments: [{ method: '现金', amount: 16800 }]
  });
  state = run(state, 'handover', { actual: 16800, drawerCash: 16800 });
  state = run(state, 'handover', { actual: 0, drawerCash: 0 });
  assert.deepEqual(state.handovers.map(h => h.expected), [16800, 16800]);
  assert.equal(state.handovers[1].difference, -16800);
});

test.skip('KNOWN BUSINESS ISSUE：旧 SQL 房单表要求 room_id 非空，无法原样承载 retail.room=null', async () => {
  const { readFileSync } = await import('node:fs');
  const schema = readFileSync(new URL('./database/schema.sql', import.meta.url), 'utf8');
  const roomOrders = schema.slice(
    schema.indexOf('CREATE TABLE room_orders ('),
    schema.indexOf('CREATE TABLE order_items (')
  );
  assert.match(roomOrders, /room_id bigint NOT NULL REFERENCES rooms\(id\)/);
});

test('采购合同：记录订量和费用关联，但仅采购不增加库存', () => {
  let state = fresh();
  state = run(state, 'procurement', {
    date: '2026-09-28', item: '百威', quantity: 10, unit: '支',
    amount: 8000, method: '微信', type: '支出',
    nature: '一次性支出', description: '契约测试采购'
  });
  assert.equal(state.procurements.length, 1);
  assert.equal(state.expenses.length, 1);
  assert.equal(state.procurements[0].expenseId, state.expenses[0].id);
  assert.equal(state.inventory.bw.count, null);
  assert.equal(state.ledger.length, 0);
});

test('付款合同：无房零售也保留分渠道的两笔原付款', () => {
  let state = withStock(fresh(), 'bw', 20);
  state = run(state, 'retailSale', {
    items: [{ product: 'bw', spec: 'dozen', count: 1 }],
    payments: [{ method: '微信', amount: 10000 }, { method: '现金', amount: 1800 }]
  });
  assert.equal(state.orders[0].room, null);
  assert.deepEqual(state.orders[0].payments.map(p => [p.method, p.amount, p.chargeId]), [
    ['微信', 10000, 'retail'], ['现金', 1800, 'retail']
  ]);
  assert.equal(collected(state), total(state.orders[0]));
});

test('审核合同：挂账与大额报销本人审批须 review.self，授权结果留痕', () => {
  let state = fresh();
  state.user = 'zhuBoss';
  state = run(state, 'open', { room: 'V01', beer: 'bw' });
  state = run(state, 'credit', {
    order: state.orders[0].id, name: '测试客人', note: '自审校验', signature
  });
  const beforeCredit = structuredClone(state);
  assert.throws(() => run(state, 'approve', { order: state.orders[0].id }), /审核本人申请需要/);
  assert.throws(() => run(state, 'reject', { order: state.orders[0].id }), /审核本人申请需要/);
  assert.deepEqual(state, beforeCredit);
  state = run(state, 'expense', {
    date: '2026-09-28', type: '报销', amount: 60000, method: '现金',
    nature: '一次性支出', description: '测试报销'
  });
  const expenseId = state.expenses[0].id;
  const beforeExpense = structuredClone(state);
  assert.throws(() => run(state, 'approveExpense', { id: expenseId }), /审核本人申请需要/);
  assert.throws(() => run(state, 'rejectExpense', { id: expenseId }), /审核本人申请需要/);
  assert.deepEqual(state, beforeExpense);
  state.user = 'administrator';
  assert.throws(() => run(state, 'approveExpense', { id: expenseId }), /老板岗位审批/);
  state = run(state, 'setPermissions', {
    user: 'zhuBoss',
    permissions: [...effectiveUser(state, 'zhuBoss').permissions, 'review.self']
  });
  state.user = 'zhuBoss';
  state = run(state, 'approve', { order: state.orders[0].id });
  state = run(state, 'approveExpense', { id: expenseId });
  assert.equal(state.orders[0].credit.selfReviewAuthorized, true);
  assert.equal(state.expenses[0].selfReviewAuthorized, true);
  assert.equal(state.expenses[0].status, '已审批');
});

test('挂账合同：驳回保留原申请和决定，审核历史可查且不抢占已释放房间', () => {
  let state = opened();
  const orderId = state.orders[0].id;
  state = run(state, 'credit', {
    order: orderId, name: '测试客人', note: '驳回留痕', signature
  });
  const original = structuredClone(state.orders[0].credit);
  state.user = 'wife';
  state = run(state, 'reject', { order: orderId });
  const order = state.orders[0];
  assert.equal(order.status, '营业中');
  assert.equal(order.credit, null);
  assert.equal(order.creditHistory.length, 1);
  assert.equal(order.creditHistory[0].id, original.id);
  assert.equal(order.creditHistory[0].amount, original.amount);
  assert.equal(order.creditHistory[0].decisionStatus, '已驳回');
  assert.equal(order.creditHistory[0].decisionBy, '老板娘');
  assert.equal(order.creditHistory[0].signature, signature);
  assert.equal(state.rooms.find(room => room.id === 'V01').order, null);
  assert.ok(reviewHistoryRows(state, effectiveUser(state)).some(row =>
    row.section === 'creditApproval' && row.status === '已驳回'));
  const adapter = createDemoPersistence({ storage: new Map() });
  adapter.save(state);
  const reloaded = adapter.load().state;
  assert.equal(reloaded.orders[0].creditHistory[0].decisionStatus, '已驳回');
  assert.equal(reloaded.orders[0].creditHistory[0].id, original.id);
});
