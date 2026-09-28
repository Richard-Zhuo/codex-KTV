// Phase 1 前测/后测：persistence / migration 边界。
// 覆盖：旧状态夹具迁移（幂等、未知历史价格保 null、消耗品别名、
// 房间恢复申请口径升级）、结构校验拒绝、启动补值链、身份归一化、
// 以及 persistence adapter 的失败不覆盖/原始数据保留策略。
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from './rules.js';
import { validateDemoState, migrateStartupState, migrateDemoState, normalizeDemoUser } from './migrations.js';
import { createDemoPersistence, DEMO_STATE_KEY, DEMO_BACKUP_KEY } from './persistence.js';

let seq = 0;
const apply = (s, a, d = {}) => transact(s, a, d, `migration-test-${++seq}`);
const at = hour => `2026-09-19T${hour}:00+08:00`;
function stocked(s) { for (const balance of Object.values(s.inventory)) if (balance.count === null) balance.count = 1000; return s; }
const signature = 'data:image/png;base64,' + 'A'.repeat(100);

// 夹具：v0 旧格式状态（缺 kind/快照/能力模式，旧消耗品别名，待审核房间恢复申请）
function legacyFixture() {
  const s = initialState();
  s.capabilitySchemaVersion = 0;
  delete s.capabilities;
  s.user = 'boss'; // 别名身份
  s.orders = [{ id: 'D1', room: 'V01', time: at('20:00'), person: '陈姐', status: '已结账', base: 5000, gift: 11800, drinks: [{ id: 1, product: 'bw', count: 12 }], sales: [{ id: 2, product: 'bw', spec: 'dozen', count: 1, amount: 11800 }], bonusGifts: [{ product: 'bw', halves: 1, bottles: 6 }], payments: [{ method: '现金', amount: 17800 }] }];
  s.consumables = { nuts: { count: 5, opened: 1 } };
  s.permissions = { shaoBoss: ['店长'] };
  s.roomIssueReviews = [{ id: 3, room: '333', change: '标记异常', fromStatus: '空闲', requestedStatus: '故障/维护中', issueType: '故障', status: '待审核', submittedBy: '陈姐', submittedAt: at('20:00') }];
  s.inventoryReviews = [{ id: 4, kind: 'drink', product: 'bw', before: null, after: 24, reason: '建账', source: '期初建账', status: '待审核', submittedBy: '林哥' }];
  return s;
}

test('旧格式迁移：补齐字段但未知历史价格保持 null，不用当前价格填补', () => {
  const migrated = migrateDemoState(legacyFixture());
  const order = migrated.orders[0];
  assert.equal(order.kind, 'room');
  assert.equal(order.packageBaseCents, 5000);
  assert.equal(order.packageGiftValueCents, 11800);
  assert.equal(order.packagePriceCents, 16800);
  const sale = order.sales[0];
  assert.equal(sale.amountCents, 11800, '已知金额保留');
  assert.equal(sale.pricePerSaleUnitCents, null, '未知单价保持 null');
  assert.equal(sale.productNameSnapshot, null, '未知名称保持 null');
  assert.equal(sale.snapshotStatus, 'legacy');
  assert.equal(order.bonusGifts[0].referenceValueCents, null, '赠饮参考值未知保持 null');
  // 消耗品旧别名 cons_nuts
  assert.equal(migrated.consumables.cons_nuts.count, 5);
  // 房间恢复申请：待审核标记按新规则立即生效
  assert.equal(migrated.roomIssueReviews[0].status, '无需审核');
  assert.equal(migrated.rooms.find(r => r.id === '333').status, '故障/维护中');
  // 盘点审核补提交人 ID 与自审标记
  assert.equal(migrated.inventoryReviews[0].submittedById, 'keeper');
  assert.equal(migrated.inventoryReviews[0].selfReviewAuthorized, false);
});

test('旧格式迁移幂等：二次迁移结果一致', () => {
  const once = migrateDemoState(legacyFixture());
  const twice = migrateDemoState(structuredClone(once));
  assert.deepEqual(twice, once);
});

test('结构校验：版本不符或核心结构缺失即拒绝', () => {
  assert.throws(() => validateDemoState({ ...initialState(), version: 2 }), /结构无效/);
  assert.throws(() => validateDemoState({ ...initialState(), rooms: null }), /结构无效/);
  assert.throws(() => validateDemoState({ ...initialState(), inventory: undefined }), /结构无效/);
  validateDemoState(initialState()); // 合法状态不抛
});

test('启动补值链：旧订单字段回填、失效预订房复位、消耗品补位', () => {
  let s = initialState();
  s.clock = at('12:00');
  s.user = 'shaoBoss';
  s = apply(s, 'reserve', { room: 'V01', dayOffset: 0, session: 'afternoon', source: '抖音', note: '王生' });
  s.clock = at('16:00'); // 预订场次已开始且无订单 → 房间应复位空闲
  const order = { room: 'V02', time: at('21:00'), person: '陈姐', status: '已结账', base: 5000, gift: 11800, sales: [{ product: 'bw', spec: 'single', count: 2 }], drinks: [{ product: 'bw', count: 12 }] };
  s.orders = [order];
  delete s.consumables;
  const migrated = migrateStartupState(s);
  assert.equal(migrated.rooms.find(r => r.id === 'V01').status, '空闲');
  const m0 = migrated.orders[0];
  assert.equal(m0.sales[0].bottles, 2);
  assert.equal(m0.sales[0].drinks.length, 1);
  assert.equal(m0.bonusGifts.length, 0);
  assert.ok(migrated.consumables.cons_nuts, '消耗品整表补位');
});

test('身份归一化：别名映射到当前身份，淘汰身份回落 shaoBoss', () => {
  const alias = normalizeDemoUser({ ...initialState(), user: 'boss' });
  assert.equal(alias.user, 'zhuBoss');
  const legacy = normalizeDemoUser({ ...initialState(), user: 'staff' });
  assert.equal(legacy.user, 'shaoBoss');
  const unknown = normalizeDemoUser({ ...initialState(), user: 'nobody' });
  assert.equal(unknown.user, 'shaoBoss');
  const current = normalizeDemoUser({ ...initialState(), user: 'meiJiao' });
  assert.equal(current.user, 'meiJiao');
});

test('persistence：载入-迁移-保存全链路，保存后可无损重载', () => {
  const storage = new Map();
  const adapter = createDemoPersistence({ storage });
  let s = adapter.load().state;
  assert.equal(s.version, 1); // 全新环境 → 初始状态
  s.clock = at('20:00');
  s.user = 'shaoBoss';
  s = apply(s, 'open', { room: 'V01', beer: 'bw' });
  adapter.save(s);
  const reloaded = adapter.load().state;
  assert.equal(reloaded.orders.length, 1);
  assert.equal(reloaded.orders[0].room, 'V01');
  assert.equal(reloaded.rooms.find(r => r.id === 'V01').status, '营业中');
});

test('persistence：损坏 JSON 不覆盖原文，备份后仍保持停写', () => {
  const storage = new Map([[DEMO_STATE_KEY, '{corrupted json']]);
  const adapter = createDemoPersistence({ storage });
  const result = adapter.load();
  assert.equal(result.recovered, false);
  assert.equal(typeof result.state.version, 'number');
  // 原始数据仍可取证
  assert.equal(storage.get(DEMO_STATE_KEY), '{corrupted json', '原文未被覆盖');
  assert.equal(storage.get(DEMO_BACKUP_KEY), '{corrupted json', '原始数据已备份到独立 key');
  assert.equal(result.readOnly, true);
  assert.equal(adapter.isWriteBlocked(), true);
  assert.throws(() => adapter.save(initialState()), /已停止写入/);
  assert.equal(storage.get(DEMO_STATE_KEY), '{corrupted json');
  assert.equal(adapter.recoveryRecord().raw, '{corrupted json');
});

test('persistence：结构非法同样保留原文并备份', () => {
  const bad = JSON.stringify({ version: 99, rooms: 'x' });
  const storage = new Map([[DEMO_STATE_KEY, bad]]);
  const adapter = createDemoPersistence({ storage });
  const result = adapter.load();
  assert.equal(result.recovered, false);
  assert.equal(storage.get(DEMO_STATE_KEY), bad);
  assert.equal(storage.get(DEMO_BACKUP_KEY), bad);
});

test('persistence：save 失败抛错且不改原 key 内容（存储配额场景）', () => {
  const storage = new Map([[DEMO_STATE_KEY, JSON.stringify(initialState())]]);
  let failNext = false;
  const adapter = createDemoPersistence({ storage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => { if (failNext) throw Error('QuotaExceededError'); storage.set(k, v); } } });
  const s = adapter.load().state;
  const before = storage.get(DEMO_STATE_KEY);
  failNext = true;
  assert.throws(() => adapter.save(s), /本机保存失败/);
  assert.equal(storage.get(DEMO_STATE_KEY), before, '保存失败原数据不变');
});

test('persistence：恢复成功时不显示问题提示、不写备份', () => {
  const storage = new Map();
  const adapter = createDemoPersistence({ storage });
  const result = adapter.load();
  assert.equal(result.recovered, true);
  assert.equal(result.problem, '');
  assert.equal(storage.has(DEMO_BACKUP_KEY), false);
});

test('persistence：旧格式真实保存值经 load 完成整条迁移链', () => {
  const legacy = legacyFixture();
  const storage = new Map([[DEMO_STATE_KEY, JSON.stringify(legacy)]]);
  const adapter = createDemoPersistence({ storage });
  const { state, recovered } = adapter.load();
  assert.equal(recovered, true);
  assert.equal(state.orders[0].kind, 'room');
  assert.equal(state.orders[0].sales[0].pricePerSaleUnitCents, null);
  assert.equal(state.capabilitySchemaVersion, 4);
  // 身份归一化已执行
  assert.equal(state.user, 'zhuBoss');
});

test('persistence：备份失败或成功都停写，原记录修正并重检后才可保存', () => {
  const raw = '{broken';
  const values = new Map([[DEMO_STATE_KEY, raw]]);
  let failBackup = true;
  const adapter = createDemoPersistence({ storage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      if (key === DEMO_BACKUP_KEY && failBackup) throw Error('QuotaExceededError');
      values.set(key, value);
    }
  } });
  const failed = adapter.load();
  assert.equal(failed.readOnly, true);
  assert.equal(adapter.isWriteBlocked(), true);
  assert.match(failed.problem, /独立备份失败/);
  assert.throws(() => adapter.save(initialState()), /已停止写入/);
  assert.equal(values.get(DEMO_STATE_KEY), raw);
  assert.equal(values.has(DEMO_BACKUP_KEY), false);
  failBackup = false;
  const retried = adapter.load();
  assert.equal(retried.readOnly, true);
  assert.equal(values.get(DEMO_BACKUP_KEY), raw);
  assert.throws(() => adapter.save(retried.state), /已停止写入/);
  assert.equal(values.get(DEMO_STATE_KEY), raw);
  values.set(DEMO_STATE_KEY, JSON.stringify(initialState())); // 人工修正主记录后显式重检
  const restored = adapter.load();
  assert.equal(restored.recovered, true);
  assert.equal(adapter.isWriteBlocked(), false);
  adapter.save(restored.state);
});

test('persistence：旧套餐不等式进入只读核对，历史订单与付款不会被新练习覆盖', () => {
  let oldState = initialState();
  oldState.clock = at('20:00');
  oldState.user = 'shaoBoss';
  oldState = apply(oldState, 'open', { room: 'V01', beer: 'bw' });
  oldState = apply(oldState, 'pay', {
    order: oldState.orders[0].id, payments: [{ method: '现金', amount: 16800 }]
  });
  const originalOrder = structuredClone(oldState.orders[0]);
  const brokenPackage = oldState.catalog.packages.find(item => item.id === 'room.small.night');
  brokenPackage.priceCents = 100;
  const raw = JSON.stringify(oldState);
  const storage = new Map([[DEMO_STATE_KEY, raw]]);
  const adapter = createDemoPersistence({ storage });
  const loaded = adapter.load();
  assert.equal(loaded.recovered, false);
  assert.equal(loaded.readOnly, true);
  assert.equal(adapter.isWriteBlocked(), true);
  assert.match(loaded.problem, /套餐价格不一致.*停止写入/);
  assert.equal(loaded.state.catalog.packages.find(item => item.id === brokenPackage.id).priceCents, 100);
  assert.equal(loaded.state.orders.length, 1);
  assert.equal(loaded.state.orders[0].id, originalOrder.id);
  assert.equal(loaded.state.orders[0].packagePriceCents, originalOrder.packagePriceCents);
  assert.deepEqual(loaded.state.orders[0].payments, originalOrder.payments);
  assert.equal(adapter.recoveryRecord().raw, raw);
  assert.equal(adapter.recoveryRecord().readable, true);
  assert.equal(storage.get(DEMO_BACKUP_KEY), raw);
  assert.throws(() => apply(loaded.state, 'open', { room: 'V02', beer: 'bw' }), /价格不一致/);
  assert.throws(() => adapter.save({ ...loaded.state, orders: [] }), /已停止写入/);
  assert.throws(() => adapter.loadExternal(JSON.stringify(initialState())), /已停写/);
  assert.equal(storage.get(DEMO_STATE_KEY), raw);
  const reloaded = createDemoPersistence({ storage }).load();
  assert.deepEqual(reloaded.state.orders[0].payments, originalOrder.payments);
  assert.equal(reloaded.state.orders[0].packagePriceCents, originalOrder.packagePriceCents);
  assert.equal(storage.get(DEMO_STATE_KEY), raw);
  storage.delete(DEMO_STATE_KEY); // 外部清空主键也不能把停写变成全新练习
  const missing = adapter.load();
  assert.equal(missing.readOnly, true);
  assert.equal(adapter.isWriteBlocked(), true);
  assert.deepEqual(missing.state.orders[0].payments, originalOrder.payments);
  assert.equal(adapter.recoveryRecord().raw, raw);
  assert.throws(() => adapter.save(initialState()), /已停止写入/);
  const repaired = structuredClone(oldState);
  repaired.catalog.packages.find(item => item.id === brokenPackage.id).priceCents =
    brokenPackage.basePriceCents + brokenPackage.includedValueCents;
  storage.set(DEMO_STATE_KEY, JSON.stringify(repaired)); // 人工仅修当前套餐配置
  const restored = adapter.load();
  assert.equal(restored.recovered, true);
  assert.equal(adapter.isWriteBlocked(), false);
  assert.deepEqual(restored.state.orders[0].payments, originalOrder.payments);
  assert.equal(restored.state.orders[0].packagePriceCents, originalOrder.packagePriceCents);
  adapter.save(restored.state);
  assert.deepEqual(JSON.parse(storage.get(DEMO_STATE_KEY)).orders[0].payments, originalOrder.payments);
  assert.equal(JSON.parse(storage.get(DEMO_STATE_KEY)).orders[0].packagePriceCents, originalOrder.packagePriceCents);
  assert.equal(storage.get(DEMO_BACKUP_KEY), raw, '原始异常记录副本仍保留');
});


test('persistence：已有不同恢复副本不会被新的异常记录覆盖', () => {
  const oldBackup = '{"earlier":"record"}';
  const currentRaw = '{broken-current';
  const storage = new Map([[DEMO_STATE_KEY, currentRaw], [DEMO_BACKUP_KEY, oldBackup]]);
  const adapter = createDemoPersistence({ storage });
  const loaded = adapter.load();
  assert.equal(loaded.readOnly, true);
  assert.equal(adapter.recoveryRecord().raw, currentRaw);
  assert.equal(adapter.recoveryRecord().backupSaved, false);
  assert.equal(storage.get(DEMO_BACKUP_KEY), oldBackup);
  assert.equal(storage.get(DEMO_STATE_KEY), currentRaw);
  assert.throws(() => adapter.save(initialState()), /已停止写入/);
});


test('persistence：另一标签页写入异常旧记录时，本页立即停写并保留付款', () => {
  const storage = new Map([[DEMO_STATE_KEY, JSON.stringify(initialState())]]);
  const adapter = createDemoPersistence({ storage });
  assert.equal(adapter.load().recovered, true);
  const previous = initialState();
  previous.orders = [{ id: 'history-1', room: 'V01', status: '已结账', base: 5000, gift: 11800,
    sales: [], drinks: [], payments: [{ method: '现金', amount: 16800 }] }];
  previous.catalog.packages.find(item => item.id === 'room.small.night').priceCents = 100;
  const raw = JSON.stringify(previous);
  storage.set(DEMO_STATE_KEY, raw); // 模拟跨标签页存储事件已写入的新值
  const visible = adapter.loadExternal(raw);
  assert.equal(adapter.isWriteBlocked(), true);
  assert.equal(visible.orders[0].payments[0].amount, 16800);
  assert.throws(() => adapter.save(initialState()), /已停止写入/);
  assert.equal(storage.get(DEMO_STATE_KEY), raw);
});


test('persistence：主键存在但原文为空也不当作首次练习覆盖', () => {
  const storage = new Map([[DEMO_STATE_KEY, '']]);
  const adapter = createDemoPersistence({ storage });
  const loaded = adapter.load();
  assert.equal(loaded.readOnly, true);
  assert.equal(adapter.isWriteBlocked(), true);
  assert.equal(adapter.recoveryRecord().raw, '');
  assert.throws(() => adapter.save(initialState()), /已停止写入/);
  assert.equal(storage.get(DEMO_STATE_KEY), '');
});
