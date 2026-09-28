// Phase 0：审计报告第 13 节 Existing Bugs 的重现证据。
// ⚠️ 本文件断言的是【当前有缺陷的行为】，不是产品契约。
// 每个 test 名以「BUG」开头，并在注释中引用审计报告条目编号。
// 修复任一 bug 后，对应断言会失败——这是预期的：修复时必须同步改写
// 这些测试为正确行为的回归测试。Phase 0 只建立证据，不做任何修复。
//
// 覆盖（rules.js 可达范围）：Bug #1 挂账跨级审批、Bug #2 套餐价格口径分裂、
// Bug #3 换酒目标行缺名称快照、Bug #4 收费列表回退当前目录名、Bug #5 采购状态不同步。
// Bug #6（存酒页当前目录名）、#7（报表 credit 布尔，已并入
// characterization-report.test.js 冻结口径）、#8（损坏 localStorage 覆盖）、
// #9（SQL 种子偏差）位于 app.js/database 层，在对应文件中另建证据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from './rules.js';
import { total, collectableCharges } from './sales.js';
import { quote } from './rooms.js';

let seq = 0;
const apply = (s, a, d = {}) => transact(s, a, d, `bug-evidence-${++seq}`);
const at = hour => `2026-09-19T${hour}:00+08:00`;
function stocked(s) { for (const balance of Object.values(s.inventory)) if (balance.count === null) balance.count = 1000; return s; }
const signature = 'data:image/png;base64,' + 'A'.repeat(100);

test('BUG#1 挂账审批：指定「老板」审批的大额挂账可被仅持 credit.approve 权限的「管理员」批准', () => {
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
  // 当前实现：need(s, ['老板'], 'credit.approve') 只校验 permission，忽略岗位限制 → 放行
  s = apply(s, 'approve', { order: id });
  assert.equal(s.orders[0].status, '已挂账', '缺陷：跨级审批被放行');
  assert.equal(s.orders[0].credit.decisionBy, '管理员');
});

test('BUG#2 套餐价格口径分裂：priceCents 可设为与 basePriceCents+includedValueCents 不一致，quote 与账单互相矛盾', () => {
  let s = initialState();
  s.clock = at('20:00');
  s.user = 'administrator';
  // 更新套餐只改总价，不改基础价/含赠价值（当前实现允许）
  s = apply(s, 'updateCatalogPackage', { id: 'room.small.night', priceCents: 9999 });
  const pkg = s.catalog.packages.find(p => p.id === 'room.small.night');
  assert.equal(pkg.priceCents, 9999);
  assert.equal(pkg.basePriceCents + pkg.includedValueCents, 16800, '三字段不再一致（缺陷）');
  // quote() 的 total 用 priceCents，而 base/gift 用 basePriceCents/includedValueCents → 同一报价单内互相矛盾
  const q = quote('小房', at('20:00'), 'bw', '', s.catalog);
  assert.equal(q.total, 9999, 'quote total 用 priceCents');
  assert.equal(q.base + q.gift, 16800, 'base+gift 仍为原基础+赠饮');
  assert.notEqual(q.total, q.base + q.gift, '缺陷：同一报价内 total ≠ base+gift');
  // 开出的订单用 base/gift 口径，与 quote.total 不一致
  s.user = 'shaoBoss';
  s = apply(s, 'open', { room: 'V01', beer: 'bw' });
  const order = s.orders[0];
  assert.equal(order.packagePriceCents, 9999, '订单套餐价快照用 priceCents');
  assert.equal(order.base + order.gift, 16800, '订单 base+gift 口径不变');
  assert.notEqual(order.packagePriceCents, total(order), '缺陷：订单套餐价快照 ≠ 账单 total（两个总价口径）');
});

test('BUG#3 换酒目标行缺少名称快照：换入青岛后新 drinks 行没有 productNameSnapshot', () => {
  let s = stocked(initialState());
  s.clock = at('20:00');
  s.user = 'shaoBoss';
  s = apply(s, 'open', { room: 'V01', beer: 'bw' });
  const id = s.orders[0].id;
  s = apply(s, 'sale', { order: id, product: 'bw', spec: 'single', count: 1 });
  const sourceDrink = s.orders[0].sales[0].drinks[0];
  assert.equal(sourceDrink.productNameSnapshot, '百威', '原行有快照');
  s = apply(s, 'exchange', { order: id, line: `sale:${sourceDrink.id}`, product: 'qd', count: 1 });
  const target = s.orders[0].sales[0].drinks.find(d => d.product === 'qd');
  assert.ok(target, '换入行已存在');
  assert.equal(target.productNameSnapshot, undefined, '缺陷：换入行没有 productNameSnapshot');
  assert.equal(target.baseUnitSnapshot, undefined, '缺陷：换入行没有 baseUnitSnapshot');
  // 后果：历史展示只能回退到当前目录名（见 BUG#4 同类机制），改名后语义漂移
});

test('BUG#4 收费列表回退当前目录：无快照的历史销售行在商品改名后显示新名字', () => {
  let s = initialState();
  s.orders.push({
    id: 'D1', kind: 'room', room: 'V01', time: '2026-09-19T20:00:00+08:00', status: '营业中',
    base: 5000, gift: 11800, drinks: [], extras: [], sales: [{ id: 1, batch: 1, product: 'bw', productId: 'bw', count: 1, spec: 'dozen', bottles: 12, amount: 11800 }],
    otherCharges: [], bonusGifts: [], payments: [], giftRequests: [], exchanges: [], rounding: 0, credit: null
  });
  const before = collectableCharges(s.orders[0], s.catalog).find(c => c.id === 'sale:1');
  assert.match(before.label, /百威/);
  // 后台改名后，同一笔历史销售的待收标签变了
  s.user = 'administrator';
  s = apply(s, 'updateCatalogProduct', { id: 'bw', name: '改名百威' });
  const after = collectableCharges(s.orders[0], s.catalog).find(c => c.id === 'sale:1');
  assert.match(after.label, /改名百威/, '缺陷：历史行金额未变但显示名跟随当前目录');
  assert.equal(after.amount, 11800, '金额本身不受影响');
});

test('BUG#5 采购状态不同步：approveExpense 只改支出状态，关联采购单永远停在「报销待老板审批」', () => {
  let s = initialState();
  s.clock = at('20:00');
  s.user = 'administrator';
  s = apply(s, 'procurement', { date: '2026-09-19', item: '一次性杯', quantity: 100, unit: '个', amount: 60000, method: '现金', type: '报销', nature: '一次性支出' });
  assert.equal(s.procurements[0].status, '报销待老板审批');
  assert.equal(s.expenses[0].status, '待老板审批');
  assert.equal(s.procurements[0].expenseId, s.expenses[0].id);
  s.user = 'zhuBoss';
  s = apply(s, 'approveExpense', { id: s.expenses[0].id });
  assert.equal(s.expenses[0].status, '已审批');
  assert.equal(s.procurements[0].status, '报销待老板审批', '缺陷：采购单状态未同步，仍显示待审批');
});
