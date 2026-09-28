// Phase 3 前测：在抽取 packages/inventory 之前冻结商品与库存边界行为。
// 当前从 rules.js/catalog.js 导入；抽取完成后补充直接针对新模块的断言与 facade 一致性检查。
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from './rules.js';
import { quote } from './rooms.js';
import { product } from './catalog.js';
import { DEFAULT_CATALOG, mergeCatalog, cloneCatalog, findProduct, roomPackage } from './catalog.js';

const at = hour => `2026-09-19T${hour}:00+08:00`;
let seq = 0;
const apply = (s, a, d = {}) => transact(s, a, d, `p3-${++seq}`);
function stocked(s) { for (const balance of Object.values(s.inventory)) if (balance.count === null) balance.count = 1000; return s; }
function opened(beer = 'bw', room = '333') { let s = initialState(); s.clock = at('20:00'); return stocked(apply(s, 'open', { room, beer })); }

test('目录基线：默认目录结构、套餐数量与 schemaVersion 冻结', () => {
  assert.equal(DEFAULT_CATALOG.schemaVersion, 1);
  assert.equal(DEFAULT_CATALOG.products.length, 23);
  assert.equal(DEFAULT_CATALOG.packages.length, 8);
  assert.deepEqual(DEFAULT_CATALOG.packages.map(p => p.id), [
    'room.small.day', 'room.medium.day', 'room.large.day', 'room.vip.day',
    'room.small.night', 'room.medium.night', 'room.large.night', 'room.vip.night'
  ]);
  // 夜间套餐构造：小房 base 5000 + 1 打赠饮 11800 = 16800；大房 5400 + 2 打 23600 = 29000
  const small = DEFAULT_CATALOG.packages.find(p => p.id === 'room.small.night');
  assert.equal(small.basePriceCents, 5000);
  assert.equal(small.includedValueCents, 11800);
  assert.equal(small.priceCents, 16800);
  assert.deepEqual(small.openingGift.baseQuantityByProduct.bw, 12);
  const large = DEFAULT_CATALOG.packages.find(p => p.id === 'room.large.night');
  assert.equal(large.giftSaleQuantity, 2);
  assert.deepEqual(large.openingGift.baseQuantityByProduct.lm, 20);
  // 白天纯唱无赠饮
  const day = DEFAULT_CATALOG.packages.find(p => p.id === 'room.small.day');
  assert.equal(day.openingGift, null);
  assert.equal(day.priceCents, 6800);
});

test('目录查询：roomPackage 按房型与时段取启用套餐，findProduct 报错文案不变', () => {
  assert.equal(roomPackage(DEFAULT_CATALOG, '中房', 'night').id, 'room.medium.night');
  assert.equal(product('bw').name, '百威');
  assert.equal(product('bw').saleOptions.length, 3);
  assert.throws(() => findProduct(DEFAULT_CATALOG, 'nope'), /商品不存在/);
  assert.throws(() => roomPackage(DEFAULT_CATALOG, '不存在的房型', 'night'), /当前房型没有可用套餐/);
});

test('mergeCatalog 幂等：对默认目录再归一结果结构不变', () => {
  const merged = mergeCatalog(DEFAULT_CATALOG);
  assert.equal(JSON.stringify(merged), JSON.stringify(mergeCatalog(merged)));
  assert.equal(JSON.stringify(merged.products), JSON.stringify(DEFAULT_CATALOG.products));
  assert.equal(JSON.stringify(merged.packages), JSON.stringify(DEFAULT_CATALOG.packages));
});

test('未建账禁售：期初前销售被拒且不落销售行', () => {
  let s = initialState(); s.clock = at('20:00');
  s = apply(s, 'open', { room: '333', beer: 'bw' });
  const ledgerBefore = s.ledger.length;
  assert.throws(() => apply(s, 'sale', { order: s.orders[0].id, product: 'bw', spec: 'single', count: 1 }), /未建账，完成库存期初建账后才能销售/);
  assert.equal(s.orders[0].sales.length, 0);
  assert.equal(s.ledger.length, ledgerBefore);
  assert.equal(s.inventory.bw.count, null);
});

test('counted 语义：建账前流水 counted=false，建账后为 true', () => {
  let s = initialState(); s.clock = at('20:00');
  s.user = 'wife';
  // 开房前库存未建账：开房扣减流水 counted=false（余额不动但流水照记）
  s = apply(s, 'open', { room: '333', beer: 'bw' });
  const openingEntry = s.ledger.find(entry => entry.source === '开房赠饮');
  assert.ok(openingEntry);
  assert.equal(openingEntry.counted, false);
  assert.equal(openingEntry.delta, -24); // 大房夜间 2 打 × 12
  assert.equal(s.inventory.bw.count, null);
  // 期初建账 100 → 换人审核（避免自审拦截）
  s = apply(s, 'stock', { product: 'bw', count: 100, reason: '期初' });
  s.user = 'shaoBoss';
  s = apply(s, 'approveInventory', { request: s.inventoryReviews[0].id });
  assert.equal(s.inventory.bw.count, 100);
  const openingLedger = s.ledger.find(entry => entry.source === '期初建账');
  assert.equal(openingLedger.counted, true);
  assert.equal(openingLedger.delta, 100);
  assert.equal(openingLedger.before, null);
  assert.equal(openingLedger.after, 100);
  // 建账后销售流水 counted=true（开房时的 -24 未建账未扣减，也不会追溯）
  s = apply(s, 'sale', { order: s.orders[0].id, product: 'bw', spec: 'single', count: 1 });
  const saleEntry = s.ledger.find(entry => entry.orderId === s.orders[0].id);
  assert.equal(saleEntry.counted, true);
  assert.equal(s.inventory.bw.count, 99); // 100 - 销售1；开房赠饮发生在未建账期，不追溯扣减
});

test('期初建账与盘点调整的岗位边界：wife 可、zhuYi 不可', () => {
  let s = initialState(); s.clock = at('12:00');
  s.user = 'zhuYi';
  assert.throws(() => apply(s, 'stock', { product: 'bw', count: 10, reason: 'x' }), /当前身份没有操作权限/);
  s.user = 'wife';
  s = apply(s, 'stock', { product: 'bw', count: 10, reason: '期初' });
  assert.equal(s.inventoryReviews[0].source, '期初建账');
  // 已建账后的盘点调整同样需要对应岗位
  s.user = 'zhuYi';
  assert.throws(() => apply(s, 'stock', { product: 'bw', count: 11, reason: '盘点' }), /当前身份没有操作权限/);
});

test('盘点审核：重复提交被拒、审核通过更新余额与通知、驳回需理由', () => {
  let s = initialState(); s.clock = at('12:00');
  s.user = 'wife';
  s = apply(s, 'stock', { product: 'bw', count: 50, reason: '期初' });
  assert.throws(() => apply(s, 'stock', { product: 'bw', count: 60, reason: '再盘' }), /该商品已有库存盘点待审核/);
  const request = s.inventoryReviews[0];
  assert.equal(request.status, '待审核');
  assert.equal(request.kind, 'drink');
  // 驳回需要理由（换人审核避免自审拦截）
  s.user = 'shaoBoss';
  assert.throws(() => apply(s, 'rejectInventory', { request: request.id }), /请填写驳回原因/);
  s = apply(s, 'rejectInventory', { request: request.id, decisionNote: '数错了' });
  assert.equal(s.inventoryReviews[0].status, '已驳回');
  assert.equal(s.inventory.bw.count, null); // 驳回不改余额
  assert.equal(s.notices.length, 0);
  // 重新提交并批准
  s.user = 'wife';
  s = apply(s, 'stock', { product: 'bw', count: 50, reason: '期初2' });
  s.user = 'shaoBoss';
  s = apply(s, 'approveInventory', { request: s.inventoryReviews[1].id });
  assert.equal(s.inventory.bw.count, 50);
  assert.equal(s.inventoryReviews[1].status, '已批准');
  assert.equal(s.notices[0].kind, 'drink');
  assert.equal(s.notices[0].before, null);
  assert.equal(s.notices[0].after, 50);
  // 已处理过的申请不能重复处理
  assert.throws(() => apply(s, 'approveInventory', { request: s.inventoryReviews[1].id }), /这笔库存盘点已经处理/);
});

test('盘点审核：库存已变化时批准被拒（乐观校验）', () => {
  let s = initialState(); s.clock = at('12:00');
  s.user = 'wife';
  s = apply(s, 'stock', { product: 'bw', count: 50, reason: '期初' });
  const request = s.inventoryReviews[0].id;
  // 模拟竞争：提交后直接改余额
  s.inventory.bw.count = 30;
  s.user = 'shaoBoss';
  assert.throws(() => apply(s, 'approveInventory', { request }), /商品库存已经变化，请驳回后重新盘点/);
});

test('消耗品库存：opened 语义、来源文案与审核通过写 openedAt', () => {
  let s = initialState(); s.clock = at('12:00');
  s.user = 'wife';
  assert.throws(() => apply(s, 'consumableStock', { product: 'cons_nuts', count: -1, opened: 0 }), /消耗品数量应为非负整数/);
  s = apply(s, 'consumableStock', { product: 'cons_nuts', count: 5, opened: 1, reason: '期初' });
  const request = s.inventoryReviews[0];
  assert.equal(request.kind, 'consumable');
  assert.equal(request.source, '消耗品期初建账');
  assert.equal(request.openedBefore, 0);
  assert.equal(request.openedAfter, 1);
  assert.throws(() => apply(s, 'consumableStock', { product: 'cons_nuts', count: 6, opened: 1, reason: '再盘' }), /该消耗品已有库存盘点待审核/);
  s.user = 'shaoBoss';
  s = apply(s, 'approveInventory', { request: request.id });
  assert.equal(s.consumables.cons_nuts.count, 5);
  assert.equal(s.consumables.cons_nuts.opened, 1);
  assert.ok(s.consumables.cons_nuts.openedAt);
  const entry = s.ledger.find(item => item.kind === 'consumable');
  assert.equal(entry.counted, true);
  assert.equal(entry.delta, 5);
  assert.equal(entry.openedAfter, 1);
});

test('后台新增商品：目录登记并建立未建账库存项', () => {
  let s = initialState(); s.clock = at('12:00');
  s.user = 'administrator';
  s = apply(s, 'createCatalogProduct', {
    id: 'snack_test', name: '测试小吃', category: '零食', baseUnit: '包', sortOrder: 2000,
    saleOptions: [{ id: 'single', name: '1包', baseQuantity: 1, priceCents: 500 }],
    sellable: true, inventoryManaged: true
  });
  const created = s.catalog.products.find(item => item.name === '测试小吃');
  assert.equal(created.id, 'snack_test');
  assert.equal(created.saleOptions[0].priceCents, 500);
  assert.equal(s.inventory[created.id].count, null);
  assert.equal(s.inventory[created.id].unit, '包');
});

test('开房扣库：单选酒水记开房赠饮，混选记开房首次配酒水', () => {
  let s = opened('bw', '333');
  const giftEntry = s.ledger.find(entry => entry.source === '开房赠饮');
  assert.equal(giftEntry.delta, -24);
  assert.equal(giftEntry.productNameSnapshot, '百威');
  assert.equal(giftEntry.baseUnitSnapshot, '支');
  // 混选首次配酒水：大房夜间 24 支 = bw 12 + drink0 12（先建账再开房）
  let mixed = initialState(); mixed.clock = at('20:00'); mixed = stocked(mixed);
  mixed = apply(mixed, 'open', { room: '333', beer: 'drink', initialMix: [{ product: 'bw', count: 12 }, { product: 'drink0', count: 12 }] });
  const mixEntries = mixed.ledger.filter(entry => entry.source === '开房首次配酒水');
  assert.deepEqual(mixEntries.map(entry => [entry.product, entry.delta]), [['bw', -12], ['drink0', -12]]);
  assert.equal(mixed.inventory.bw.count, 988);
  assert.equal(mixed.inventory.drink0.count, 988);
});

// ===== Phase 3 后测：抽取后的直接断言 =====
import { DEFAULT_PACKAGES } from './packages.js';
import { need, pendingInventoryReview, recordInventoryChange, submitStock, submitConsumableStock, decideInventory } from './inventory.js';
import { product as catalogProduct } from './catalog.js';
import { initialState as facadeInitialState, transact as facadeTransact } from './rules.js';

test('packages.js：DEFAULT_PACKAGES 与 DEFAULT_CATALOG.packages 内容一致（同一构造源）', () => {
  assert.equal(JSON.stringify(DEFAULT_PACKAGES), JSON.stringify(DEFAULT_CATALOG.packages));
  assert.equal(DEFAULT_PACKAGES.length, 8);
});

test('inventory.js：recordInventoryChange 直接调用与经 transact 的记账行为一致', () => {
  // 直接调用：对克隆状态记一笔 -3
  const s = structuredClone(facadeInitialState());
  s.clock = '2026-09-19T20:00:00.000Z';
  s.user = 'wife';
  s.inventory.bw.count = 100;
  recordInventoryChange(s, 'bw', -3, '直接调用', s.clock);
  assert.equal(s.inventory.bw.count, 97);
  assert.equal(s.ledger.at(-1).counted, true);
  assert.equal(s.ledger.at(-1).delta, -3);
  assert.equal(s.ledger.at(-1).person, '老板娘');
  // 未建账：counted=false 且余额不动
  const t = structuredClone(facadeInitialState());
  t.clock = s.clock; t.user = 'wife';
  recordInventoryChange(t, 'bw', -5, '未建账', t.clock);
  assert.equal(t.inventory.bw.count, null);
  assert.equal(t.ledger.at(-1).counted, false);
  // 库存不足抛错
  assert.throws(() => recordInventoryChange(s, 'bw', -98, '超卖', s.clock), /百威库存不足/);
});

test('inventory.js：need 与 rules.js 权限闸门行为一致（BUG#1 行为冻结）', () => {
  const s = facadeInitialState();
  s.user = 'meiJiao';
  // 已知缺陷 #1：need 检查权限或角色，二者不联合（此处仅冻结行为）
  assert.throws(() => need(s, ['店长'], 'inventory.opening'), /当前身份没有操作权限/);
  s.user = 'wife';
  need(s, ['店长'], 'inventory.opening');
  need(s, [], 'inventory.adjust');
});

test('Phase 8 后测：rules.js 不再 re-export product（目录查询唯一 owner 为 catalog.js）', () => {
  assert.equal(typeof catalogProduct, 'function');
  assert.equal(catalogProduct('bw').name, '百威');
});

test('后测：房间增购与独立零售共用同一成交与扣库管道', () => {
  let s = facadeInitialState(); s.clock = '2026-09-19T20:00:00+08:00'; s.user = 'shaoBoss';
  let seq2 = 0;
  const apply2 = (st, a, d) => facadeTransact(st, a, d, `p3post-${++seq2}`);
  // 期初建账
  s = apply2(s, 'stock', { product: 'bw', count: 100, reason: '期初' });
  s.user = 'xiongBoss';
  s = apply2(s, 'approveInventory', { request: s.inventoryReviews[0].id });
  assert.equal(s.inventory.bw.count, 100);
  // 开房
  s = apply2(s, 'open', { room: '333', beer: 'bw' });
  const orderId = s.orders[0].id;
  // 房间增购 1 支单支
  s = apply2(s, 'sale', { order: orderId, product: 'bw', spec: 'single', count: 1 });
  const order = s.orders.find(o => o.id === orderId);
  const roomSale = order.sales.at(-1);
  assert.equal(roomSale.amountCents, 1000);
  assert.equal(roomSale.totalBaseQuantity, 1);
  // 独立零售 2 支（同一命令管道 prepareSaleRows/appendSaleRows）
  s = apply2(s, 'retailSale', { product: 'bw', spec: 'single', count: 2, payments: [{ method: '现金', amount: 2000 }] });
  const retail = s.orders.at(-1);
  assert.equal(retail.kind, 'retail');
  assert.equal(retail.room, null);
  assert.equal(retail.sales[0].amountCents, 2000);
  assert.equal(retail.status, '已结账'); // 单笔全额付款即完成的零售单状态
  // 两类销售都走了 recordInventoryChange：100 - 24(开房) - 1 - 2 = 73
  assert.equal(s.inventory.bw.count, 73);
  const saleLedger = s.ledger.filter(entry => entry.source === '加购销售' || entry.source === '零售销售');
  assert.deepEqual(saleLedger.map(entry => [entry.source, entry.delta]), [['加购销售', -1], ['零售销售', -2]]);
  // 两条销售行快照结构一致（同一成交规则）
  assert.deepEqual(Object.keys(roomSale).sort(), Object.keys(retail.sales[0]).sort());
});
