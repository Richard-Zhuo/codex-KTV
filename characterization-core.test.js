// Phase 0 行为冻结：库存、权限与审核流 characterization tests。
// 保护面：库存（未建账/counted 流水/盘点审核）、权限（need() 语义、
// credit.approve 指定审批人、review.self 自审、多笔付款拆分收款）、
// 采购/支出/审核状态机。所有断言只冻结当前行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from './rules.js';
import { total, outstanding, collected, nextCollectCharge } from './sales.js';
import { effectiveUser, hasPermission, hasRole } from './shared/identity.js';

let seq = 0;
const apply = (s, a, d = {}) => transact(s, a, d, `core-char-${++seq}`);
const at = hour => `2026-09-19T${hour}:00+08:00`;
function stocked(s) { for (const balance of Object.values(s.inventory)) if (balance.count === null) balance.count = 1000; return s; }
const signature = 'data:image/png;base64,' + 'A'.repeat(100);

test('未建账商品禁止销售，期初建账需盘点审核后写入 openedAt 与 counted 流水', () => {
  let s = initialState();
  s.clock = at('20:00');
  s.user = 'shaoBoss';
  s = apply(s, 'open', { room: 'V01', beer: 'bw' });
  const id = s.orders[0].id;
  const before = structuredClone(s);
  assert.throws(() => apply(s, 'sale', { order: id, product: 'bw', spec: 'single', count: 1 }), /未建账/);
  assert.deepEqual(s, before, '失败的销售不得留下任何状态变化');
  // 期初建账：库管盘点 → 店长审核
  s.user = 'wife';
  s = apply(s, 'stock', { product: 'bw', count: 24, reason: '期初建账' });
  assert.equal(s.inventory.bw.count, null, '审核前库存保持未建账');
  assert.equal(s.inventoryReviews.at(-1).source, '期初建账');
  s.user = 'shaoBoss';
  s = apply(s, 'approveInventory', { request: s.inventoryReviews.at(-1).id });
  assert.equal(s.inventory.bw.count, 24);
  assert.equal(s.inventory.bw.openedAt, s.inventoryReviews.at(-1).decidedAt);
  const ledgerEntry = s.ledger.at(-1);
  assert.equal(ledgerEntry.counted, true);
  assert.equal(ledgerEntry.before, null);
  assert.equal(ledgerEntry.after, 24);
  // 建账后可以销售，销售流水 counted 语义：按建账后口径扣减
  s.user = 'shaoBoss';
  s = apply(s, 'sale', { order: id, product: 'bw', spec: 'single', count: 1 });
  assert.equal(s.inventory.bw.count, 23);
  assert.equal(s.orders[0].sales[0].productNameSnapshot, '百威');
});

test('盘点调整审核前不改库存，重复盘点同一商品被拦截', () => {
  let s = stocked(initialState());
  s.clock = at('20:00');
  s.user = 'shaoBoss';
  s = apply(s, 'open', { room: 'V01', beer: 'bw' });
  const beforeCount = s.inventory.bw.count; // 开房赠饮已扣减（-12）
  s.user = 'wife';
  s = apply(s, 'stock', { product: 'bw', count: 30, reason: '盘点调整' });
  assert.equal(s.inventory.bw.count, beforeCount, '审核前库存不变');
  const pendingId = s.inventoryReviews.at(-1).id;
  assert.throws(() => apply(s, 'stock', { product: 'bw', count: 40, reason: '再次盘点' }), /已有库存盘点待审核/);
  s.user = 'shaoBoss';
  s = apply(s, 'approveInventory', { request: pendingId });
  assert.equal(s.inventory.bw.count, 30);
  // 审核期间库存发生变化 → 批准被拒
  s.user = 'wife';
  s = apply(s, 'stock', { product: 'qd', count: 10, reason: '盘点' });
  s.inventory.qd.count = 99; // 模拟审核期间另一渠道变化
  s.user = 'shaoBoss';
  assert.throws(() => apply(s, 'approveInventory', { request: s.inventoryReviews.at(-1).id }), /库存已经变化/);
});

test('权限矩阵：need() 给定 permission 时只查权限、忽略岗位角色限制（当前口径）', () => {
  const s = initialState();
  // administrator 只有「管理员」岗位，但持有全部具体权限（含 credit.approve / inventory.approve）
  const admin = effectiveUser({ ...s, user: 'administrator' });
  assert.deepEqual(admin.roles, ['管理员']);
  assert.equal(hasPermission(admin, 'credit.approve'), true);
  assert.equal(hasPermission(admin, 'inventory.approve'), true);
  // 店长角色默认不含 credit.approve 具体权限（店长岗位不在 credit.approve 的默认岗位列表）
  const manager = effectiveUser({ ...s, user: 'shaoBoss' });
  assert.equal(manager.roles.includes('店长'), true);
  assert.equal(hasPermission(manager, 'credit.approve'), true);
  // hasRole 语义：管理员岗位通吃所有角色
  assert.equal(hasRole(admin, ['服务员']), true);
  assert.equal(hasRole(manager, ['服务员']), true);
  // 老板（卓老板）有 credit.approve
  const boss = effectiveUser({ ...s, user: 'zhuBoss' });
  assert.equal(hasPermission(boss, 'credit.approve'), true);
});

test('挂账审批人按金额分级（≤1000元店长、>1000元老板），跨级审批当前被放行（bug 证据详见 bugs 文件）', () => {
  let s = stocked(initialState());
  s.clock = at('20:00');
  s.user = 'shaoBoss';
  s = apply(s, 'open', { room: 'V01', beer: 'bw' });
  const id = s.orders[0].id;
  // 小额：店长审批
  s.user = 'keeper';
  s = apply(s, 'credit', { order: id, name: '小额顾客', note: '小额挂账', signature });
  assert.equal(s.orders[0].credit.approver, '店长');
  assert.equal(s.orders[0].status, '待审批挂账');
  s.user = 'shaoBoss';
  s = apply(s, 'approve', { order: id });
  assert.equal(s.orders[0].status, '已挂账');
  assert.equal(s.rooms.find(r => r.id === 'V01').status, '待清洁');
  // 大额：指定老板
  s = apply(s, 'clean', { room: 'V01' });
  s = apply(s, 'open', { room: 'V01', beer: 'bw' });
  const id2 = s.orders.at(-1).id;
  s.orders.at(-1).sales.push({ amount: 83201 });
  s.user = 'keeper';
  s = apply(s, 'credit', { order: id2, name: '大额顾客', note: '大额挂账', signature });
  assert.equal(s.orders.at(-1).credit.approver, '老板');
});

test('review.self：无权限者不能审核自己提交的申请，管理员持有 review.self 可以自审', () => {
  let s = stocked(initialState());
  s.clock = at('20:00');
  // 库管提交盘点，本人尝试审核（wife 无 review.self）
  s.user = 'wife';
  s = apply(s, 'stock', { product: 'bw', count: 50, reason: '盘点' });
  assert.throws(() => apply(s, 'approveInventory', { request: s.inventoryReviews.at(-1).id }), /审核本人申请需要/);
  // administrator 持有 review.self → 可以自审
  let s2 = stocked(initialState());
  s2.clock = at('20:00');
  s2.user = 'administrator';
  s2 = apply(s2, 'stock', { product: 'bw', count: 60, reason: '盘点' });
  s2 = apply(s2, 'approveInventory', { request: s2.inventoryReviews.at(-1).id });
  assert.equal(s2.inventory.bw.count, 60);
  assert.equal(s2.inventoryReviews.at(-1).selfReviewAuthorized, true);
  // 他人审核时 selfReviewAuthorized = false
  let s3 = stocked(initialState());
  s3.clock = at('20:00');
  s3.user = 'wife';
  s3 = apply(s3, 'stock', { product: 'bw', count: 70, reason: '盘点' });
  s3.user = 'shaoBoss';
  s3 = apply(s3, 'approveInventory', { request: s3.inventoryReviews.at(-1).id });
  assert.equal(s3.inventoryReviews.at(-1).selfReviewAuthorized, false);
});

test('多笔付款：分次收钱累计、结账差额免零上限、付款之和不得超收', () => {
  let s = stocked(initialState());
  s.clock = at('20:00');
  s.user = 'shaoBoss';
  s = apply(s, 'open', { room: 'V01', beer: 'bw' });
  const id = s.orders[0].id;
  s = apply(s, 'sale', { order: id, product: 'bw', spec: 'half', count: 1 });
  const charge = nextCollectCharge(s.orders[0]);
  assert.equal(charge.kind, 'sale');
  assert.equal(charge.remaining, 5900);
  // 一笔收款拆两种方式
  s = apply(s, 'collect', { order: id, charge: charge.id, payments: [{ method: '微信', amount: 2000 }, { method: '现金', amount: 3900 }] });
  assert.equal(outstanding(s.orders[0]), 16800);
  // 收款金额错误（少于或多于待收）整笔失败
  const before = structuredClone(s);
  assert.throws(() => apply(s, 'collect', { order: id, charge: 'open', payments: [{ method: '微信', amount: 100 }] }), /之和必须等于/);
  assert.deepEqual(s, before);
  // 结账：混合付款 + 免零
  s = apply(s, 'settle', { order: id, payments: [{ method: '微信', amount: 16000 }, { method: '支付宝', amount: 700 }] });
  assert.equal(s.orders[0].rounding, 100);
  assert.equal(s.orders[0].roundingType, '免零');
  assert.equal(s.orders[0].roundingReview, null);
  assert.equal(collected(s), 2000 + 3900 + 16000 + 700);
  assert.equal(s.rooms.find(r => r.id === 'V01').status, '待清洁');
  // 超收直接拒绝
  let s2 = stocked(initialState());
  s2.clock = at('20:00');
  s2.user = 'shaoBoss';
  s2 = apply(s2, 'open', { room: 'V01', beer: 'bw' });
  assert.throws(() => apply(s2, 'settle', { order: s2.orders[0].id, payments: [{ method: '现金', amount: 16801 }] }), /不能超过/);
});

test('特殊差额需要店长审核：批准前后 roundingReview 状态与 collected 不变', () => {
  let s = stocked(initialState());
  s.clock = at('20:00');
  s.user = 'shaoBoss';
  s = apply(s, 'open', { room: 'V01', beer: 'bw' });
  const id = s.orders[0].id;
  s = apply(s, 'settle', { order: id, payments: [{ method: '现金', amount: 14000 }], differenceType: '特殊情况', differenceNote: '客人醉酒闹事减免' });
  assert.equal(s.orders[0].rounding, 2800);
  assert.equal(s.orders[0].roundingReview.status, '待审核');
  assert.equal(s.orders[0].status, '已结账');
  const collectedBefore = collected(s);
  // 店长批准（提交人 shaoBoss 本人不持 review.self → 由老板娘/店长身份 wife 审批）
  s.user = 'wife';
  s = apply(s, 'approveRounding', { order: id });
  assert.equal(s.orders[0].roundingReview.status, '已批准');
  assert.equal(collected(s), collectedBefore);
  // 驳回需要原因
  let s2 = stocked(initialState());
  s2.clock = at('20:00');
  s2.user = 'shaoBoss';
  s2 = apply(s2, 'open', { room: 'V01', beer: 'bw' });
  s2 = apply(s2, 'settle', { order: s2.orders[0].id, payments: [{ method: '现金', amount: 14000 }], differenceType: '特殊情况', differenceNote: '需要驳回' });
  s2.user = 'wife';
  assert.throws(() => apply(s2, 'rejectRounding', { order: s2.orders[0].id }), /驳回原因/);
});

test('采购联动支出：低于阈值直接已记录，超过阈值需老板审批', () => {
  let s = initialState();
  s.clock = at('20:00');
  s.user = 'administrator';
  // 500 元（50000 分）以下报销：直接记录
  s = apply(s, 'procurement', { date: '2026-09-19', item: '纸巾', quantity: 10, unit: '包', amount: 40000, method: '现金', type: '报销', nature: '一次性支出' });
  assert.equal(s.procurements[0].status, '已关联支出');
  assert.equal(s.expenses[0].status, '已记录');
  // 超过阈值：两边都待审批
  s = apply(s, 'procurement', { date: '2026-09-19', item: '一次性杯', quantity: 100, unit: '个', amount: 60000, method: '现金', type: '报销', nature: '一次性支出' });
  assert.equal(s.procurements[1].status, '报销待老板审批');
  assert.equal(s.expenses[1].status, '待老板审批');
  assert.equal(s.procurements[1].expenseId, s.expenses[1].id, '采购记录与支出记录关联');
  // 只有老板能审批支出
  s.user = 'shaoBoss';
  assert.throws(() => apply(s, 'approveExpense', { id: s.expenses[1].id }), /权限/);
  s.user = 'zhuBoss';
  s = apply(s, 'approveExpense', { id: s.expenses[1].id });
  assert.equal(s.expenses[1].status, '已审批');
});

test('赠酒水超过配额进入待确认，批准后入账且计入 bonusGifts 参考值', () => {
  let s = stocked(initialState());
  s.clock = at('20:00');
  s.user = 'shaoBoss';
  s = apply(s, 'open', { room: 'V01', beer: 'bw' });
  const id = s.orders[0].id;
  // 增购 2 打（24 支）后配额 1 半打（6 支）内直接赠送
  s = apply(s, 'sale', { order: id, product: 'bw', spec: 'dozen', count: 2 });
  s = apply(s, 'gift', { order: id, product: 'bw', halves: 1 });
  assert.equal(s.orders[0].bonusGifts.length, 1);
  assert.equal(s.orders[0].bonusGifts[0].referenceValueCents, 5900);
  assert.equal(s.orders[0].giftRequests.length, 0);
  // 超配额部分进入待确认
  s = apply(s, 'gift', { order: id, product: 'bw', halves: 2 });
  assert.equal(s.orders[0].giftRequests.length, 1);
  assert.equal(s.orders[0].giftRequests[0].status, '待确认');
  s.user = 'zhuBoss';
  s = apply(s, 'approveGift', { order: id, request: s.orders[0].giftRequests[0].id });
  assert.equal(s.orders[0].giftRequests[0].status, '已批准');
  assert.equal(s.orders[0].bonusGifts.length, 2);
});

test('房间故障与恢复审核：营业中不能标记，恢复需管理员/店长/老板审核', () => {
  let s = stocked(initialState());
  s.clock = at('20:00');
  s.user = 'shaoBoss';
  s = apply(s, 'open', { room: 'V01', beer: 'bw' });
  assert.throws(() => apply(s, 'markRoomIssue', { room: 'V01', issueType: '故障', evidenceText: '音响坏了' }), /营业中/);
  // 空闲房间可标记
  s.user = 'administrator';
  s = apply(s, 'markRoomIssue', { room: '333', issueType: '故障', evidenceText: '麦克风丢失' });
  assert.equal(s.rooms.find(r => r.id === '333').status, '故障/维护中');
  // 恢复申请待审核期间不能开房（clearRoomIssue 提交恢复空房申请）
  s = apply(s, 'clearRoomIssue', { room: '333', evidenceText: '已维修' });
  assert.equal(s.roomIssueReviews.at(-1).status, '待审核');
  s.user = 'shaoBoss';
  assert.throws(() => apply(s, 'open', { room: '333', beer: 'bw' }), /房间已在使用|恢复申请正在审核/);
  // 审核通过恢复空闲（room.issue.approve：管理员/老板/店长）
  s = apply(s, 'approveRoomIssue', { request: s.roomIssueReviews.at(-1).id });
  assert.equal(s.rooms.find(r => r.id === '333').status, '空闲');
});
