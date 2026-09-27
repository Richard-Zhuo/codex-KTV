import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact, total, collected } from './rules.js';

let sequence = 0;
const apply = (state, action, data) => transact(state, action, data, `retail-test-${++sequence}`);
const productData = {
  id: 'test_pack', name: '测试零售包', category: '日用品', baseUnit: '包',
  inventoryManaged: true, sellable: true, active: true, sortOrder: 500,
  saleOptions: [{ id: 'pack', name: '1 包', baseQuantity: 1, priceCents: 1800 }]
};
function createdProduct() {
  let state = initialState();
  state.clock = '2026-09-28T20:00:00+08:00';
  state.user = 'administrator';
  state = apply(state, 'createCatalogProduct', productData);
  return state;
}
function bookedProduct(count = 10) {
  let state = createdProduct();
  state.user = 'zhuBoss';
  state = apply(state, 'stock', { product: productData.id, count, reason: '测试期初盘点' });
  assert.equal(state.inventory[productData.id].count, null);
  state.user = 'xiongBoss';
  state = apply(state, 'approveInventory', { request: state.inventoryReviews.at(-1).id });
  assert.equal(state.inventory[productData.id].count, count);
  return state;
}

test('通用商品创建保留未建账状态，并校验稳定 ID 与规格', () => {
  const state = createdProduct();
  assert.equal(state.catalog.products.find(item => item.id === productData.id)?.baseUnit, '包');
  assert.deepEqual(state.inventory[productData.id], { count: null, threshold: 10, unit: '包' });
  const before = structuredClone(state);
  assert.throws(() => apply(state, 'retailSale', { items: [{ product: productData.id, spec: 'pack', count: 1 }], payments: [{ method: '现金', amount: 1800 }] }), /未建账/);
  assert.deepEqual(state, before);
  assert.throws(() => apply(state, 'createCatalogProduct', productData), /ID/);
  assert.throws(() => apply(state, 'createCatalogProduct', { ...productData, id: 'another', saleOptions: [productData.saleOptions[0], productData.saleOptions[0]] }), /不得重复/);
  assert.throws(() => apply(state, 'createCatalogProduct', { ...productData, id: 'another', saleOptions: [{ id: 'pack', name: '包', baseQuantity: 0, priceCents: 1800 }] }), /基础数量/);
  assert.deepEqual(state, before);
});

test('独立零售一次写入订单、付款、销售快照与基础单位库存流水', () => {
  let state = bookedProduct();
  state.user = 'shaoBoss';
  state = apply(state, 'retailSale', { items: [{ product: productData.id, spec: 'pack', count: 2 }], payments: [{ method: '微信', amount: 3600 }] });
  const order = state.orders[0], line = order.sales[0], movement = state.ledger.at(-1);
  assert.equal(order.kind, 'retail');
  assert.equal(order.room, null);
  assert.equal(order.status, '已结账');
  assert.equal(order.createdAt, order.paidAt);
  assert.equal(order.paidAt, order.closedAt);
  assert.equal(order.payments[0].amount, 3600);
  assert.equal(total(order), 3600);
  assert.equal(collected(state), 3600);
  assert.deepEqual([line.productNameSnapshot, line.categorySnapshot, line.baseUnitSnapshot, line.saleOptionNameSnapshot, line.saleQuantity, line.totalBaseQuantity, line.pricePerSaleUnitCents, line.amountCents], ['测试零售包', '日用品', '包', '1 包', 2, 2, 1800, 3600]);
  assert.equal(line.person, '邵老板');
  assert.equal(line.employeeId, 'shaoBoss');
  assert.equal(line.recordedBy, '邵老板');
  assert.equal(order.employeeId, 'shaoBoss');
  assert.equal(state.inventory[productData.id].count, 8);
  assert.deepEqual([movement.orderId, movement.saleLineId, movement.productId, movement.productNameSnapshot, movement.baseUnitSnapshot, movement.baseQuantityDelta, movement.counted], [order.id, line.id, productData.id, '测试零售包', '包', -2, true]);
  assert.equal(state.rooms.some(room => room.order === order.id), false);
});

test('房间增购复用同一快照和库存关联，改价不污染旧销售', () => {
  let state = bookedProduct();
  state.user = 'shaoBoss';
  state = apply(state, 'open', { room: '333', beer: 'bw' });
  const roomOrderId = state.orders[0].id;
  state = apply(state, 'sale', { order: roomOrderId, items: [{ product: productData.id, spec: 'pack', count: 1 }] });
  const first = state.orders[0].sales[0];
  assert.equal(state.orders[0].kind, 'room');
  assert.equal(state.orders[0].room, '333');
  assert.equal(first.amountCents, 1800);
  assert.equal(first.employeeId, 'shaoBoss');
  assert.equal(state.inventory[productData.id].count, 9);
  assert.equal(state.ledger.at(-1).saleLineId, first.id);
  state.user = 'administrator';
  state = apply(state, 'updateCatalogProduct', { id: productData.id, name: '改名后的零售包', saleOptions: [{ id: 'pack', name: '1 包', baseQuantity: 1, priceCents: 2300 }] });
  state.user = 'shaoBoss';
  state = apply(state, 'sale', { order: roomOrderId, product: productData.id, spec: 'pack', count: 1 });
  assert.deepEqual(state.orders[0].sales.map(line => [line.productNameSnapshot, line.pricePerSaleUnitCents, line.amountCents]), [['测试零售包', 1800, 1800], ['改名后的零售包', 2300, 2300]]);
});

test('百威一打按十二支扣库，库存不足或付款错误整笔零售失败', () => {
  let state = initialState();
  state.clock = '2026-09-28T20:00:00+08:00';
  state.user = 'zhuBoss';
  state = apply(state, 'stock', { product: 'bw', count: 20, reason: '测试期初盘点' });
  state.user = 'xiongBoss';
  state = apply(state, 'approveInventory', { request: state.inventoryReviews[0].id });
  const before = structuredClone(state);
  assert.throws(() => apply(state, 'retailSale', { items: [{ product: 'bw', spec: 'dozen', count: 2 }], payments: [{ method: '现金', amount: 23600 }] }), /库存不足/);
  assert.throws(() => apply(state, 'retailSale', { items: [{ product: 'bw', spec: 'dozen', count: 1 }], payments: [{ method: '现金', amount: 1000 }] }), /必须等于/);
  assert.deepEqual(state, before);
  state = apply(state, 'retailSale', { items: [{ product: 'bw', spec: 'dozen', count: 1 }], payments: [{ method: '现金', amount: 11800 }] });
  assert.equal(state.inventory.bw.count, 8);
  assert.equal(state.orders[0].sales[0].totalBaseQuantity, 12);
  assert.equal(state.ledger.at(-1).baseQuantityDelta, -12);
});

test('多商品零售只要其中一项未建账，已建账商品也不扣库', () => {
  const state = bookedProduct();
  const before = structuredClone(state);
  assert.throws(() => apply(state, 'retailSale', { items: [{ product: productData.id, spec: 'pack', count: 1 }, { product: 'bw', spec: 'single', count: 1 }], payments: [{ method: '现金', amount: 2800 }] }), /未建账/);
  assert.deepEqual(state, before);
});

test('零售权限、商品启停及价格无效都不能留下半笔交易', () => {
  let state = bookedProduct();
  state.user = 'zhuYi';
  const noPermission = structuredClone(state);
  assert.throws(() => apply(state, 'retailSale', { product: productData.id, spec: 'pack', count: 1, payments: [{ method: '现金', amount: 1800 }] }), /权限/);
  assert.deepEqual(state, noPermission);
  state.user = 'administrator';
  state = apply(state, 'updateCatalogProduct', { id: productData.id, active: false });
  const inactive = structuredClone(state);
  assert.throws(() => apply(state, 'retailSale', { product: productData.id, spec: 'pack', count: 1, payments: [{ method: '现金', amount: 1800 }] }), /不可销售/);
  assert.deepEqual(state, inactive);
  state.catalog.products.find(item => item.id === productData.id).active = true;
  state.catalog.products.find(item => item.id === productData.id).saleOptions[0].priceCents = 0;
  const invalidPrice = structuredClone(state);
  assert.throws(() => apply(state, 'retailSale', { product: productData.id, spec: 'pack', count: 1, payments: [{ method: '现金', amount: 1800 }] }), /价格无效/);
  assert.deepEqual(state, invalidPrice);
});
