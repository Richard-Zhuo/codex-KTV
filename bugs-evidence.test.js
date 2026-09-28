// 原 Phase 0 的 bug 重现证据测试，Bug 修复任务（2026-09-28）后改写为回归保护。
// Bug #1-#5 已修复：以下断言改为验证修复后的正确行为。
// 修复历史证据见 docs/CURRENT_STAGE.md 与 git 历史（Phase 0 原断言可查
// 重构检查点 46b558a 之前的提交）。
// Bug #6（存酒页）、#7（报表 credit）在 bugs-evidence-app.test.js；
// #8 已由 Phase 1 结构性解决；#9 为 SQL 种子层，在 database.test.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from './rules.js';
import { total, collectableCharges } from './sales.js';
import { quote } from './rooms.js';

let seq = 0;
const apply = (s, a, d = {}) => transact(s, a, d, `bug-fix-${++seq}`);
const at = hour => `2026-09-19T${hour}:00+08:00`;
function stocked(s) { for (const balance of Object.values(s.inventory)) if (balance.count === null) balance.count = 1000; return s; }
const signature = 'data:image/png;base64,' + 'A'.repeat(100);

test('回归（Bug#1 已修）：大额挂账只能由指定审批人岗位（或更高）批准，仅持权限不能跨级', () => {
  let s = stocked(initialState());
  s.clock = at('20:00');
  s.user = 'shaoBoss';
  s = apply(s, 'open', { room: 'V01', beer: 'bw' });
  const id = s.orders[0].id;
  s.orders[0].sales.push({ amount: 83201 }); // 总额 > 100000 分 → 指定审批人「老板」
  s.user = 'keeper';
  s = apply(s, 'credit', { order: id, name: '大额顾客', note: '大额挂账', signature });
  assert.equal(s.orders[0].credit.approver, '老板');
  assert.equal(s.orders[0].status, '待审批挂账');
  // administrator 岗位仅 ['管理员']，无「老板」角色，但持有全部具体权限（含 credit.approve）
  s.user = 'administrator';
  const before = structuredClone(s);
  assert.throws(() => apply(s, 'approve', { order: id }), /这笔挂账需要老板岗位审批/);
  assert.deepEqual(s, before, '拒绝后状态不变');
  // 老板本人批准仍正常
  s.user = 'zhuBoss';
  s = apply(s, 'approve', { order: id });
  assert.equal(s.orders[0].status, '已挂账');
  assert.equal(s.orders[0].credit.decisionBy, '卓老板');
});

test('回归（Bug#1 已修）：小额挂账店长或老板可批；无岗位身份不能批任何挂账', () => {
  let s = stocked(initialState());
  s.clock = at('20:00');
  s.user = 'shaoBoss';
  s = apply(s, 'open', { room: 'V02', beer: 'bw' });
  const id = s.orders[0].id;
  s.user = 'keeper';
  s = apply(s, 'credit', { order: id, name: '小额顾客', note: '小额挂账', signature });
  assert.equal(s.orders[0].credit.approver, '店长');
  // 无营业岗位的管理员不能批店长级挂账
  s.user = 'administrator';
  assert.throws(() => apply(s, 'approve', { order: id }), /这笔挂账需要店长岗位审批/);
  // 老板可批店长级（层级语义）；店长本人也可批
  s.user = 'zhuBoss';
  s = apply(s, 'approve', { order: id });
  assert.equal(s.orders[0].status, '已挂账');
  // 验证店长本人路径
  s = stocked(initialState());
  s.clock = at('20:00');
  s.user = 'shaoBoss';
  s = apply(s, 'open', { room: 'V02', beer: 'bw' });
  const id2 = s.orders[0].id;
  s.user = 'keeper';
  s = apply(s, 'credit', { order: id2, name: '小额顾客', note: '小额挂账', signature });
  s.user = 'shaoBoss';
  s = apply(s, 'approve', { order: id2 });
  assert.equal(s.orders.find(o => o.id === id2).status, '已挂账');
});

test('回归（Bug#2 已修）：套餐三金额字段必须一致，不一致提交被拒绝', () => {
  let s = initialState();
  s.clock = at('20:00');
  s.user = 'administrator';
  const before = structuredClone(s);
  // 只改总价 → 与基础+赠饮不一致 → 拒绝
  assert.throws(() => apply(s, 'updateCatalogPackage', { id: 'room.small.night', priceCents: 9999 }), /套餐总价必须等于基础房费加赠饮参考值/);
  assert.deepEqual(s, before, '拒绝后目录不变');
  // 只改基础价，总价同步重算（UI 提交路径的等价行为）→ 成功且三字段一致
  s = apply(s, 'updateCatalogPackage', { id: 'room.small.night', basePriceCents: 6000, priceCents: 6000 + 11800 });
  const pkg = s.catalog.packages.find(p => p.id === 'room.small.night');
  assert.equal(pkg.priceCents, pkg.basePriceCents + pkg.includedValueCents);
  // quote 与订单口径一致
  const q = quote('小房', at('20:00'), 'bw', '', s.catalog);
  assert.equal(q.total, q.base + q.gift);
  s.user = 'shaoBoss';
  s = apply(s, 'open', { room: 'V01', beer: 'bw' });
  const order = s.orders[0];
  assert.equal(order.packagePriceCents, total(order), '订单套餐价快照与账单 total 同一口径');
});

test('回归（Bug#3 已修）：换酒换入行带完整名称/单位快照', () => {
  let s = stocked(initialState());
  s.clock = at('20:00');
  s.user = 'shaoBoss';
  s = apply(s, 'open', { room: 'V01', beer: 'bw' });
  const id = s.orders[0].id;
  s = apply(s, 'sale', { order: id, product: 'bw', spec: 'single', count: 1 });
  const sourceDrink = s.orders[0].sales[0].drinks[0];
  s = apply(s, 'exchange', { order: id, line: `sale:${sourceDrink.id}`, product: 'qd', count: 1 });
  const target = s.orders[0].sales[0].drinks.find(d => d.product === 'qd');
  assert.ok(target, '换入行已存在');
  assert.equal(target.productNameSnapshot, '青岛', '换入行有名称快照');
  assert.equal(target.baseUnitSnapshot, '支', '换入行有单位快照');
  assert.equal(target.productId, 'qd');
  assert.equal(target.snapshotStatus, 'current');
  assert.equal(target.totalBaseQuantity, 1);
  // 改名后历史行展示不漂移
  s.user = 'administrator';
  s = apply(s, 'updateCatalogProduct', { id: 'qd', name: '改名青岛' });
  assert.equal(s.orders[0].sales[0].drinks.find(d => d.product === 'qd').productNameSnapshot, '青岛', '快照不随当前目录改名');
});

test('回归（Bug#4 已修）：无快照历史销售行显示「历史商品（id）」，不跟随当前目录改名', () => {
  let s = initialState();
  s.orders.push({
    id: 'D1', kind: 'room', room: 'V01', time: '2026-09-19T20:00:00+08:00', status: '营业中',
    base: 5000, gift: 11800, drinks: [], extras: [], sales: [{ id: 1, batch: 1, product: 'bw', productId: 'bw', count: 1, spec: 'dozen', bottles: 12, amount: 11800 }],
    otherCharges: [], bonusGifts: [], payments: [], giftRequests: [], exchanges: [], rounding: 0, credit: null
  });
  const before = collectableCharges(s.orders[0], s.catalog).find(c => c.id === 'sale:1');
  s.orders[0].sales[0].productNameSnapshot = '百威';
  const snapshotted = collectableCharges(s.orders[0], s.catalog).find(c => c.id === 'sale:1');
  assert.match(snapshotted.label, /百威/, '有快照时正常显示快照名');
  s.user = 'administrator';
  s = apply(s, 'updateCatalogProduct', { id: 'bw', name: '改名百威' });
  // 无快照行（模拟旧数据）
  s.orders[0].sales[0].productNameSnapshot = undefined;
  const after = collectableCharges(s.orders[0], s.catalog).find(c => c.id === 'sale:1');
  assert.match(after.label, /历史商品（bw）/, '无快照显示历史占位，不读当前目录');
  assert.doesNotMatch(after.label, /改名百威/);
  assert.equal(after.amount, 11800, '金额不受影响');
  // 商品从目录移除后也不抛错（不再回退查询当前目录）
  s.catalog.products = s.catalog.products.filter(p => p.id !== 'bw');
  const removed = collectableCharges(s.orders[0], s.catalog).find(c => c.id === 'sale:1');
  assert.match(removed.label, /历史商品（bw）/);
});

test('回归（Bug#5 已修）：审批费用后关联采购单状态同步', () => {
  let s = initialState();
  s.clock = at('20:00');
  s.user = 'administrator';
  s = apply(s, 'procurement', { date: '2026-09-19', item: '一次性杯', quantity: 100, unit: '个', amount: 60000, method: '现金', type: '报销', nature: '一次性支出' });
  assert.equal(s.procurements[0].status, '报销待老板审批');
  assert.equal(s.procurements[0].expenseId, s.expenses[0].id);
  s.user = 'zhuBoss';
  s = apply(s, 'approveExpense', { id: s.expenses[0].id });
  assert.equal(s.expenses[0].status, '已审批');
  assert.equal(s.procurements[0].status, '已关联支出', '采购单状态同步');
  assert.equal(s.procurements[0].decisionBy, '卓老板');
  // 驳回路径：新建一笔大额报销后驳回 → 采购单显示已驳回
  s.user = 'administrator';
  s = apply(s, 'procurement', { date: '2026-09-19', item: '洋酒', quantity: 2, unit: '瓶', amount: 200000, method: '支付宝', type: '报销', nature: '资金周转' });
  s.user = 'zhuBoss';
  s = apply(s, 'rejectExpense', { id: s.expenses[1].id });
  assert.equal(s.expenses[1].status, '已驳回');
  assert.equal(s.procurements[1].status, '报销已驳回', '驳回同步到采购单');
});
