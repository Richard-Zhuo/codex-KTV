import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { initialState } from './rules.js';
import { preflightDemoSnapshot } from './snapshot-preflight.js';

const at = '2026-09-29T02:00:00.000Z';
const sale = (id, name, amount, baseQuantity = 1) => ({
  id, product: 'bw', productId: 'bw', productNameSnapshot: name, categorySnapshot: 'beer',
  baseUnitSnapshot: '支', saleOptionId: 'single', saleOptionNameSnapshot: '单支',
  saleQuantity: 1, count: 1, baseQuantityPerSaleUnit: baseQuantity,
  totalBaseQuantity: baseQuantity, bottles: baseQuantity,
  pricePerSaleUnitCents: amount, amountCents: amount, amount, snapshotStatus: 'current'
});
const payment = (id, method, amount, extra = {}) => ({ id, method, amount, time: at, occurredAt: at, ...extra });

function fixture() {
  const state = initialState();
  state.clock = at;
  state.user = 'shaoBoss';
  state.inventory.bw.count = 0;
  state.inventory.qd.count = null;
  state.rooms[0].status = '营业中';
  state.rooms[0].order = 'D1';
  state.orders = [
    {
      id: 'D1', kind: 'room', room: 'V01', time: at, createdAt: at, status: '营业中',
      packageId: 'room.small.night', packageNameSnapshot: '小房夜间',
      packagePriceCents: 16800, packageBaseCents: 5000, packageGiftValueCents: 11800,
      base: 5000, gift: 11800, sales: [sale(10, '百威', 1000)], bonusGifts: [],
      payments: [payment('P1', '微信', 5000), payment('P2', '现金', 11800)]
    },
    {
      id: 'D2', kind: 'retail', room: null, time: at, createdAt: at, status: '已结账',
      packageId: null, packageNameSnapshot: null, packagePriceCents: 0, packageBaseCents: 0,
      packageGiftValueCents: 0, base: 0, gift: 0, sales: [sale(11, '百威', 1000)],
      bonusGifts: [], payments: [payment('P3', '支付宝', 1000)]
    }
  ];
  state.ledger = [
    { id: 20, product: 'bw', delta: 10, counted: true, time: at },
    { id: 21, product: 'bw', delta: -10, counted: true, time: at },
    { id: 22, product: 'qd', delta: -12, counted: false, time: at }
  ];
  state.serial = 22;
  return state;
}

test('预检：只读原文校验和与 room/retail、付款、库存和房态摘要', () => {
  const raw = JSON.stringify(fixture());
  const original = raw;
  const report = preflightDemoSnapshot(raw);
  assert.equal(raw, original);
  assert.equal(report.sha256, createHash('sha256').update(raw, 'utf8').digest('hex'));
  assert.equal(report.sourceKey, 'jbhh-demo-v1');
  assert.equal(report.status, 'ok');
  assert.deepEqual({ room: report.summary.orders.room, retail: report.summary.orders.retail }, { room: 1, retail: 1 });
  assert.equal(report.summary.orders.records[1].room, null);
  assert.equal(report.summary.payments.count, 3);
  assert.equal(report.summary.payments.knownAmountCents, 17800);
  assert.deepEqual(report.summary.payments.byChannel.map(row => row.method).sort(), ['微信', '支付宝', '现金'].sort());
  assert.equal(report.summary.inventory.balances.find(row => row.productId === 'bw').count, 0);
  assert.equal(report.summary.inventory.balances.find(row => row.productId === 'qd').count, null);
  assert.equal(report.summary.inventory.movements.counted, 2);
  assert.equal(report.summary.inventory.movements.uncounted, 1);
  assert.equal(report.summary.inventory.byProduct.find(row => row.productId === 'qd').uncountedDelta, -12);
  assert.equal(report.summary.rooms.activeLinks, 1);
});

test('预检：旧名称、规格及单价未知时不借当前目录补造', () => {
  const state = fixture();
  const line = state.orders[0].sales[0];
  delete line.productNameSnapshot;
  delete line.saleOptionNameSnapshot;
  delete line.pricePerSaleUnitCents;
  line.snapshotStatus = 'legacy';
  state.catalog.products.find(item => item.id === 'bw').name = '目录新名称';
  state.catalog.products.find(item => item.id === 'bw').saleOptions[0].priceCents = 99999;
  const report = preflightDemoSnapshot(JSON.stringify(state));
  assert.equal(report.status, 'ambiguous');
  assert.equal(report.summary.orders.unknownFacts.names, 1);
  assert.equal(report.summary.orders.unknownFacts.optionNames, 1);
  assert.equal(report.summary.orders.unknownFacts.prices, 1);
  assert.ok(report.ambiguities.some(item => item.code === 'HISTORICAL_NAME_UNKNOWN'));
  assert.ok(report.ambiguities.some(item => item.code === 'HISTORICAL_PRICE_UNKNOWN'));
  assert.ok(!JSON.stringify(report).includes('目录新名称'));
  assert.ok(!JSON.stringify(report).includes('99999'));
});

test('预检：旧规格可从原 spec 和 bottles 确定基础数量，但未知价仍保留未知', () => {
  const state = fixture();
  state.orders[0].sales = [{ product: 'bw', spec: 'half', count: 1, bottles: 6, amount: 5900 }];
  const report = preflightDemoSnapshot(JSON.stringify(state));
  assert.equal(report.status, 'ambiguous');
  assert.equal(report.summary.orders.unknownFacts.baseQuantities, 0);
  assert.equal(report.summary.orders.unknownFacts.prices, 1);
  assert.ok(!report.errors.some(item => item.code === 'HISTORICAL_FACT_INVENTED'));
});

test('预检：挂账回款与付款双处引用只计一笔，待审回款不计钱', () => {
  const state = fixture();
  const roomOrder = state.orders[0];
  state.rooms[0].status = '待清洁';
  state.rooms[0].order = null;
  roomOrder.status = '已回款';
  const repaid = payment('P4', '现金', 3000, { chargeId: 'credit-repayment', repaymentRequestId: 31 });
  roomOrder.payments.push(repaid);
  roomOrder.credit = {
    id: 30, amount: 3000, remaining: 0, repayments: [{ ...repaid }],
    repaymentRequests: [
      { id: 31, amount: 3000, method: '现金', status: '已批准' },
      { id: 32, amount: 2000, method: '微信', status: '待审核' }
    ]
  };
  const report = preflightDemoSnapshot(JSON.stringify(state));
  assert.equal(report.summary.payments.count, 4);
  assert.equal(report.summary.payments.knownAmountCents, 20800);
  assert.deepEqual(report.summary.payments.creditRepaymentLinks, { count: 1, matched: 1 });
  assert.ok(!report.ambiguities.some(item => item.code === 'CREDIT_REPAYMENT_LINK_AMBIGUOUS'));
});

test('预检：缺少付款 ID/occurredAt 或回款关联时明确报歧义', () => {
  const state = fixture();
  delete state.orders[0].payments[0].id;
  delete state.orders[0].payments[0].occurredAt;
  state.orders[0].credit = { repayments: [{ repaymentRequestId: 999, amount: 1, method: '微信' }] };
  const report = preflightDemoSnapshot(JSON.stringify(state));
  assert.equal(report.status, 'ambiguous');
  assert.equal(report.summary.payments.missingIds, 1);
  assert.equal(report.summary.payments.missingOccurredAt, 1);
  assert.ok(report.ambiguities.some(item => item.code === 'PAYMENT_IDS_MISSING'));
  assert.ok(report.ambiguities.some(item => item.code === 'PAYMENT_OCCURRED_AT_MISSING'));
  assert.ok(report.ambiguities.some(item => item.code === 'CREDIT_REPAYMENT_LINK_AMBIGUOUS'));
});

test('预检：损坏或不合规原文停在只读错误结果，不碰 localStorage', () => {
  const raw = '{broken';
  const expectedHash = createHash('sha256').update(raw, 'utf8').digest('hex');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('localStorage should not be used'); } });
  try {
    const broken = preflightDemoSnapshot(raw);
    assert.equal(broken.sha256, expectedHash);
    assert.equal(broken.status, 'error');
    assert.deepEqual(broken.errors.map(item => item.code), ['JSON_INVALID']);
    assert.equal(broken.summary, null);
    const invalid = preflightDemoSnapshot(JSON.stringify({ version: 1, rooms: [], inventory: {} }));
    assert.ok(invalid.errors.some(item => item.code === 'STRUCTURE_INVALID'));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('预检：零售房号不为 null、销售基础数量不等式及套餐价错误都拒绝自动导入', () => {
  const state = fixture();
  state.orders[1].room = 'V01';
  state.orders[1].sales[0].totalBaseQuantity = 2;
  state.catalog.packages.find(item => item.id === 'room.small.night').priceCents = 100;
  const report = preflightDemoSnapshot(JSON.stringify(state));
  assert.equal(report.status, 'error');
  assert.ok(report.errors.some(item => item.code === 'RETAIL_ROOM_INVALID'));
  assert.ok(report.errors.some(item => item.code === 'SALE_BASE_QUANTITY_MISMATCH'));
  assert.ok(report.errors.some(item => item.code === 'MIGRATED_STATE_INVALID'));
  assert.equal(report.summary.orders.records[1].room, 'V01');
});

test('预检：无效销售数量与价格不当作未知值或自动纠正', () => {
  const state = fixture();
  state.orders[1].sales[0].saleQuantity = '2';
  state.orders[1].sales[0].pricePerSaleUnitCents = -1;
  const report = preflightDemoSnapshot(JSON.stringify(state));
  assert.equal(report.status, 'error');
  assert.ok(report.errors.some(item => item.code === 'SALE_QUANTITY_INVALID'));
  assert.ok(report.errors.some(item => item.code === 'SALE_PRICE_INVALID'));
});

test('预检：旧套餐组成和赠酒参考未知时保留歧义，计账标记缺失不猜余额', () => {
  const state = fixture();
  state.orders[0].resolvedComponents = [{ productId: 'bw', productNameSnapshot: null, totalBaseQuantity: null, baseUnitSnapshot: null }];
  state.orders[0].bonusGifts = [{ productId: 'bw', referenceValueCents: null }];
  delete state.ledger[2].counted;
  const report = preflightDemoSnapshot(JSON.stringify(state));
  assert.equal(report.status, 'ambiguous');
  assert.ok(report.ambiguities.some(item => item.code === 'COMPONENT_NAME_UNKNOWN'));
  assert.ok(report.ambiguities.some(item => item.code === 'COMPONENT_BASE_QUANTITY_UNKNOWN'));
  assert.ok(report.ambiguities.some(item => item.code === 'HISTORICAL_GIFT_REFERENCE_UNKNOWN'));
  assert.equal(report.summary.inventory.movements.unknown, 1);
  assert.ok(report.ambiguities.some(item => item.code === 'MOVEMENT_COUNTED_UNKNOWN'));
});

test('预检：库存原文单位与当前目录不同须报错，不按新单位换算', () => {
  const state = fixture();
  state.inventory.bw.unit = '箱';
  const report = preflightDemoSnapshot(JSON.stringify(state));
  assert.equal(report.status, 'error');
  assert.ok(report.errors.some(item => item.code === 'INVENTORY_UNIT_CHANGED'));
  assert.equal(report.summary.inventory.balances.find(row => row.productId === 'bw').count, 0);
});

test('预检：重复执行不改变原始快照，未建账赠饮流水不抵扣余额', () => {
  const raw = JSON.stringify(fixture());
  const first = preflightDemoSnapshot(raw);
  const second = preflightDemoSnapshot(raw);
  assert.deepEqual(second, first);
  assert.equal(JSON.parse(raw).inventory.qd.count, null);
  assert.equal(first.summary.inventory.byProduct.find(row => row.productId === 'qd').countedDelta, 0);
});


test('预检：新旧金额与库存字段冲突时报错且不把矛盾付款计入金额摘要', () => {
  const state = fixture();
  state.orders[0].payments[0].amountCents = 1;
  state.orders[0].sales[0].amountCents = 2;
  state.ledger[0].productId = 'qd';
  state.ledger[0].baseQuantityDelta = 9;
  const report = preflightDemoSnapshot(JSON.stringify(state));
  assert.equal(report.status, 'error');
  for (const code of ['PAYMENT_AMOUNT_CONFLICT', 'SALE_AMOUNT_CONFLICT', 'MOVEMENT_PRODUCT_CONFLICT', 'MOVEMENT_DELTA_CONFLICT']) {
    assert.ok(report.errors.some(item => item.code === code), code);
  }
  assert.equal(report.summary.payments.amountComplete, false);
  assert.equal(report.summary.payments.knownAmountCents, 12800);
});
