// Phase 5 前测：审批/挂账/存取酒/费用采购客诉交接 characterization。
// 目的：在拆分 orders/deposits/expenses/procurement/incidents/handover
// 与 reviewInbox 之前冻结赠酒审批、报销审批、客诉恢复审批、存取酒核对、
// 采购联动支出与交班口径。测试从 './rules.js' 导入（抽取前源），
// 抽取后同文件追加后测段验证 facade 同绑定（见文件尾部）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact, total, collected, visibleExpenses, visibleProcurements, visibleIncidents, pendingIncidentReminders, searchDeposits } from './rules.js';

let sequence = 0;
const apply = (state, action, data = {}) => transact(state, action, data, `ops-front-${++sequence}`);
const at = hour => `2026-09-28T${hour}:00:00+08:00`;
function stocked(s) { for (const balance of Object.values(s.inventory)) if (balance.count === null) balance.count = 1000; return s; }
function opened(beer = 'bw', room = '333') { let s = initialState(); s.clock = at('20'); return stocked(apply(s, 'open', { room, beer })); }
const signature = 'data:image/png;base64,' + 'A'.repeat(120);

test('前测·审批矩阵·赠酒：权限、驳回原因与批准入账', () => {
  let s = opened();
  const id = s.orders[0].id;
  s = apply(s, 'sale', { order: id, product: 'bw', spec: 'dozen', count: 2 });
  s = apply(s, 'gift', { order: id, product: 'bw', halves: 2 });
  const requestId = s.orders[0].giftRequests[0].id;
  assert.equal(s.orders[0].giftRequests[0].status, '待确认');
  assert.equal(s.orders[0].giftRequests[0].halves, 1);
  assert.equal(s.orders[0].giftRequests[0].allowanceAtRequest, 1);
  // 无 gift.approve 权限者（开单员）不能审批
  s.user = 'meiJiao';
  assert.throws(() => apply(s, 'approveGift', { order: id, request: requestId }), /操作权限/);
  // 驳回必须填写原因
  s.user = 'shaoBoss';
  assert.throws(() => apply(s, 'rejectGift', { order: id, request: requestId }), /请填写驳回原因/);
  s = apply(s, 'rejectGift', { order: id, request: requestId, decisionNote: '超出招待标准' });
  assert.equal(s.orders[0].giftRequests.find(item => item.id === requestId).status, '已驳回');
  assert.equal(s.orders[0].bonusGifts.length, 1);
  // 重新申请后批准：入账 bonusGifts 并扣库存（审批人卓老板 ≠ 提交人邵老板，避免自审拦截）
  s = apply(s, 'gift', { order: id, product: 'bw', halves: 1 });
  const secondId = s.orders[0].giftRequests[1].id;
  const bwBefore = s.inventory.bw.count;
  s.user = 'zhuBoss';
  s = apply(s, 'approveGift', { order: id, request: secondId });
  assert.equal(s.orders[0].giftRequests.find(item => item.id === secondId).status, '已批准');
  assert.equal(s.orders[0].bonusGifts.at(-1).source, '老板／店长确认赠送');
  assert.equal(s.inventory.bw.count, bwBefore - 6);
  // 已处理的申请不能重复审批
  assert.throws(() => apply(s, 'approveGift', { order: id, request: secondId }), /赠酒水申请已处理/);
});

test('前测·审批矩阵·报销：大额报销须老板审批、批准/驳回与重复拦截', () => {
  let s = stocked(initialState());
  s.clock = at('20');
  // 普通支出直接已记录
  s = apply(s, 'expense', { date: '2026-09-28', amount: 30000, method: '微信', type: '支出', nature: '一次性支出', description: '零食补货' });
  assert.equal(s.expenses[0].status, '已记录');
  // 报销超过 500 元进入待老板审批
  s = apply(s, 'expense', { date: '2026-09-28', amount: 60000, method: '现金', type: '报销', nature: '一次性支出', description: '垫付酒水货款' });
  const expenseId = s.expenses[1].id;
  assert.equal(s.expenses[1].status, '待老板审批');
  assert.equal(s.expenses[1].approver, '');
  // 店长无 expense.approve 权限，不能审批
  s.user = 'shaoBoss';
  assert.throws(() => apply(s, 'approveExpense', { id: expenseId }), /操作权限/);
  // 老板批准：写入审批人与时间
  s.user = 'zhuBoss';
  s = apply(s, 'approveExpense', { id: expenseId });
  const approved = s.expenses.find(item => item.id === expenseId);
  assert.equal(approved.status, '已审批');
  assert.equal(approved.approver, '卓老板');
  assert.equal(approved.approvedAt, at('20'));
  // 已审批的报销不能重复处理
  assert.throws(() => apply(s, 'approveExpense', { id: expenseId }), /不在待审批状态/);
  // 驳回路径
  s.user = 'staff';
  s = apply(s, 'expense', { date: '2026-09-28', amount: 80000, method: '支付宝', type: '报销', nature: '固定支出', description: '超标打车' });
  const rejectedId = s.expenses[2].id;
  s.user = 'zhuBoss';
  s = apply(s, 'rejectExpense', { id: rejectedId });
  const rejected = s.expenses.find(item => item.id === rejectedId);
  assert.equal(rejected.status, '已驳回');
  assert.equal(rejected.approver, '卓老板');
});

test('前测·审批矩阵·客诉恢复：负责人提交、权限审批、驳回回流', () => {
  let s = stocked(initialState());
  s.clock = at('20');
  s = apply(s, 'incident', { date: '2026-09-28', room: '333', type: '客诉', description: '音响杂音', assignee: 'zhuYi' });
  const incidentId = s.incidents[0].id;
  const incident = () => s.incidents.find(item => item.id === incidentId);
  assert.equal(incident().status, '待处理');
  assert.equal(incident().assignee, '卓益');
  // 非负责人且无 viewAll 权限者不能填写处理结果
  s.user = 'meiJiao';
  assert.throws(() => apply(s, 'resolveIncident', { id: incidentId, result: '已检修', note: '更换线材' }), /只有负责人或管理人员/);
  // 负责人提交处理结果进入待审核
  s.user = 'zhuYi';
  s = apply(s, 'resolveIncident', { id: incidentId, result: '已检修更换线材', note: '现场验证正常' });
  let requestId = incident().resolutionReviews[0].id;
  assert.equal(incident().status, '待审核');
  assert.equal(incident().resolutionReviews[0].status, '待审核');
  // 待审核期间不能重复提交
  assert.throws(() => apply(s, 'resolveIncident', { id: incidentId, result: 'x', note: 'y' }), /已经提交审核/);
  // 驳回必须填写原因
  s.user = 'shaoBoss';
  assert.throws(() => apply(s, 'rejectIncidentResolution', { id: incidentId, request: requestId }), /请填写驳回原因/);
  s = apply(s, 'rejectIncidentResolution', { id: incidentId, request: requestId, decisionNote: '需要补充照片' });
  assert.equal(incident().status, '待处理');
  assert.equal(incident().resolutionReviews.find(item => item.id === requestId).status, '已驳回');
  // 再次提交后批准：写回结果并完成
  s.user = 'zhuYi';
  s = apply(s, 'resolveIncident', { id: incidentId, result: '已检修更换线材并附照片', note: '现场验证正常' });
  const secondId = incident().resolutionReviews[1].id;
  s.user = 'shaoBoss';
  s = apply(s, 'approveIncidentResolution', { id: incidentId, request: secondId });
  assert.equal(incident().status, '已完成');
  assert.equal(incident().result, '已检修更换线材并附照片');
  assert.equal(incident().resolvedBy, '卓益');
  assert.equal(incident().reviewedBy, '邵老板');
  assert.equal(incident().resolutionReviews.find(item => item.id === secondId).status, '已批准');
  // 已完成的客诉不能再提交处理
  assert.throws(() => apply(s, 'resolveIncident', { id: incidentId, result: 'x', note: 'y' }), /已经处理/);
});

test('前测·挂账矩阵·审批侧：按金额分级审批人、越权拒绝、批准转已挂账', () => {
  let s = opened();
  const id = s.orders[0].id;
  // 小额挂账（≤1000 元）由店长审批
  s = apply(s, 'credit', { order: id, name: '王生', note: '熟客月底结', signature });
  assert.equal(s.orders[0].status, '待审批挂账');
  assert.equal(s.orders[0].credit.approver, '店长');
  assert.equal(s.rooms.find(r => r.id === '333').status, '待清洁');
  // 开单员无 credit.approve 权限
  s.user = 'meiJiao';
  assert.throws(() => apply(s, 'approve', { order: id }), /操作权限/);
  // 店长批准转已挂账；房间不重新占用
  s.user = 'shaoBoss';
  s = apply(s, 'approve', { order: id });
  assert.equal(s.orders[0].status, '已挂账');
  assert.equal(s.orders[0].credit.decisionBy, '邵老板');
  assert.equal(s.rooms.find(r => r.id === '333').status, '待清洁');
  // 重复审批被拒
  assert.throws(() => apply(s, 'approve', { order: id }), /审批已处理/);
  // 大额挂账（>1000 元）指定老板审批
  let big = opened('bw', '333');
  const bigId = big.orders[0].id;
  // 总价 >1000 元（123400 分）：挂账审批人指定为老板
  big = apply(big, 'sale', { order: bigId, product: 'bw', spec: 'dozen', count: 8 });
  big = apply(big, 'credit', { order: bigId, name: '李小姐', note: '公司挂账', signature });
  assert.equal(big.orders[0].credit.approver, '老板');
  // 驳回恢复营业中、挂账清空、房间保持待清洁不被回收
  big.user = 'zhuBoss';
  big = apply(big, 'reject', { order: bigId });
  assert.equal(big.orders[0].status, '营业中');
  assert.equal(big.orders[0].credit, null);
  assert.equal(big.rooms.find(r => r.id === '333').status, '待清洁');
});

test('前测·存取酒矩阵：一次多酒、身份核对、超量拦截与失败不提交', () => {
  let s = stocked(initialState());
  s.clock = at('20');
  // 手机号和姓名至少填一个
  assert.throws(() => apply(s, 'deposit', { room: '333', items: [{ product: 'bw', count: 2 }] }), /至少填写一个/);
  // 手机号格式校验
  assert.throws(() => apply(s, 'deposit', { room: '333', phone: '1380000', items: [{ product: 'bw', count: 2 }] }), /11位手机号/);
  // 一次存两种酒共用同一 group，保存名称快照
  s = apply(s, 'deposit', { room: '333', phone: '13800001234', name: '王生', items: [{ product: 'bw', count: 6 }, { product: 'lm', count: 3 }] });
  assert.equal(s.deposits.length, 2);
  assert.equal(new Set(s.deposits.map(d => d.group)).size, 1);
  assert.equal(s.deposits[0].initial, 6);
  assert.equal(s.deposits[1].productNameSnapshot, s.catalog.products.find(p => p.id === 'lm').name);
  // 存酒不扣商品库存
  assert.equal(s.inventory.bw.count, 1000);
  // 取酒身份核对：手机尾号 4 位
  s = apply(s, 'withdraw', { id: s.deposits[0].id, identity: '1234', count: 2 });
  assert.equal(s.deposits[0].count, 4);
  assert.equal(s.withdrawals[0].count, 2);
  // 姓名核对
  s = apply(s, 'withdraw', { id: s.deposits[0].id, identity: '王生', count: 1 });
  assert.equal(s.deposits[0].count, 3);
  // 错误身份被拒且失败不提交
  const before = structuredClone(s);
  assert.throws(() => apply(s, 'withdraw', { id: s.deposits[0].id, identity: '9999', count: 1 }), /请输入登记手机号尾号/);
  assert.throws(() => apply(s, 'withdraw', { id: s.deposits[0].id, identity: '1234', count: 9 }), /取酒不能超过剩余数量/);
  assert.deepEqual(s, before);
  // 取酒不写商品库存
  s = apply(s, 'withdraw', { id: s.deposits[0].id, identity: '1234', count: 3 });
  assert.equal(s.deposits[0].count, 0);
  assert.equal(s.inventory.bw.count, 1000);
});

test('前测·跨域原子性·采购联动支出：失败两表都不写、成功一次关联', () => {
  let s = stocked(initialState());
  s.clock = at('20');
  // 采购登记需要采购类权限（店长/财务/采购/老板/管理员）
  s.user = 'shaoBoss';
  // 无效日期：支出与采购两表都不落记录
  const before = structuredClone(s);
  assert.throws(() => apply(s, 'procurement', { date: '2026/09/28', item: '啤酒', quantity: 10, unit: '箱', amount: 30000, method: '微信', type: '支出', nature: '一次性支出' }), /请选择有效采购日期/);
  assert.deepEqual(s, before);
  // 低于阈值的采购：支出已记录、采购已关联
  s = apply(s, 'procurement', { date: '2026-09-28', item: '纸巾', quantity: 20, unit: '包', amount: 20000, method: '微信', type: '支出', nature: '一次性支出', description: '吧台补货' });
  assert.equal(s.expenses[0].status, '已记录');
  assert.equal(s.procurements[0].status, '已关联支出');
  assert.equal(s.procurements[0].expenseId, s.expenses[0].id);
  assert.equal(s.procurements[0].description, '吧台补货');
  // 大额报销：两边同时进入待审批（已知 bug：审批后采购状态不同步，见 bugs-evidence #5，单独修复）
  s = apply(s, 'procurement', { date: '2026-09-28', item: '洋酒', quantity: 2, unit: '瓶', amount: 200000, method: '支付宝', type: '报销', nature: '资金周转' });
  assert.equal(s.expenses[1].status, '待老板审批');
  assert.equal(s.procurements[1].status, '报销待老板审批');
  // 老板批准支出后，采购状态保持旧值（bug #5 行为冻结，修复另立任务）
  s.user = 'zhuBoss';
  s = apply(s, 'approveExpense', { id: s.expenses[1].id });
  assert.equal(s.expenses[1].status, '已审批');
  assert.equal(s.procurements[1].status, '报销待老板审批');
});

test('前测·交班与可见性：expected 口径取 collected、按权限过滤行', () => {
  let s = opened();
  const id = s.orders[0].id;
  s = apply(s, 'collect', { order: id, charge: 'open', payments: [{ method: '微信', amount: total(s.orders[0]) }] });
  s = apply(s, 'handover', { actual: total(s.orders[0]), drawerCash: 500 });
  assert.equal(s.handovers[0].expected, collected(s));
  assert.equal(s.handovers[0].difference, 0);
  assert.equal(s.handovers[0].drawerCash, 500);
  assert.throws(() => apply(s, 'handover', { actual: -1, drawerCash: 0 }), /有效实点金额/);
  // 可见性选择器：低岗只看本人，viewAll 看全部
  s = apply(s, 'expense', { date: '2026-09-28', amount: 10000, method: '现金', type: '支出', nature: '一次性支出', description: '零星支出' });
  s.user = 'meiJiao';
  assert.equal(visibleExpenses(s).length, 0);
  s.user = 'shaoBoss';
  assert.equal(visibleExpenses(s).length, 1);
  s.user = 'administrator';
  assert.equal(visibleProcurements(s).length, 0);
  assert.equal(visibleIncidents(s).length, 0);
});

// —— 后测段（Phase 5 抽取后追加）：facade 同绑定、reviewInbox 纯投影与跨域原子性 ——

import { collected as salesCollected } from './sales.js';
import { searchDeposits as depositsSearchDeposits, submitDeposit, withdrawDeposit } from './deposits.js';
import { visibleExpenses as expensesVisible, submitExpense, decideExpense } from './expenses.js';
import { visibleProcurements as procurementVisible, submitProcurement } from './procurement.js';
import { visibleIncidents as incidentsVisible, pendingIncidentReminders as incidentsReminders, submitIncident, submitIncidentResolution, decideIncidentResolution } from './incidents.js';
import { submitHandover } from './handover.js';
import { pendingBusinessReviewCount, reviewHistoryRows } from './reviewInbox.js';
import { effectiveUser } from './rules.js';

test('后测·facade 同绑定：rules.js re-export 与各领域模块导出是同一函数', () => {
  assert.strictEqual(collected, salesCollected);
  assert.strictEqual(visibleExpenses, expensesVisible);
  assert.strictEqual(visibleProcurements, procurementVisible);
  assert.strictEqual(visibleIncidents, incidentsVisible);
  assert.strictEqual(pendingIncidentReminders, incidentsReminders);
  assert.strictEqual(searchDeposits, depositsSearchDeposits);
});

test('后测·审核中心不决定业务状态：reviewInbox 是纯投影', () => {
  let s = opened();
  const id = s.orders[0].id;
  s = apply(s, 'expense', { date: '2026-09-28', amount: 60000, method: '微信', type: '报销', nature: '一次性支出', description: '垫付货款' });
  s = apply(s, 'incident', { date: '2026-09-28', room: '333', type: '客诉', description: '音响杂音', assignee: 'zhuYi' });
  s.user = 'zhuYi';
  s = apply(s, 'resolveIncident', { id: s.incidents[0].id, result: '已检修', note: '验证正常' });
  // 投影计数只读状态：未审核前 expense=1、incident=1
  assert.equal(pendingBusinessReviewCount(s, 'expense'), 1);
  assert.equal(pendingBusinessReviewCount(s, 'incident'), 1);
  assert.equal(pendingBusinessReviewCount(s, 'creditApproval'), 0);
  // 快照原状态
  const before = structuredClone(s);
  // 反复调用投影不产生任何状态变化
  for (const section of ['creditApproval', 'creditRepayment', 'rounding', 'gift', 'roomRecovery', 'inventory', 'incident', 'expense']) {
    pendingBusinessReviewCount(s, section);
    reviewHistoryRows(s, effectiveUser(s));
  }
  assert.deepEqual(s, before);
  // 审核决定仍走领域命令：老板批准报销后投影归零
  s.user = 'zhuBoss';
  s = apply(s, 'approveExpense', { id: s.expenses[0].id });
  assert.equal(s.expenses[0].status, '已审批');
  assert.equal(pendingBusinessReviewCount(s, 'expense'), 0);
});

test('后测·领域命令直连：不经 transact 也可用（同一克隆约定由调用方保证）', () => {
  let s = stocked(initialState());
  s.clock = at('20');
  // 直连存酒/取酒命令（对克隆状态操作，与 transact 内调用同一函数）
  submitDeposit(s, { room: '333', phone: '13800001234', name: '王生', items: [{ product: 'bw', count: 2 }] }, '陈姐', at('20'));
  withdrawDeposit(s, { id: s.deposits[0].id, identity: '1234', count: 1 }, '陈姐', at('21'));
  assert.equal(s.deposits[0].count, 1);
  assert.equal(s.withdrawals[0].count, 1);
  // 直连费用命令 + 审批命令（报销审批需老板身份）
  submitExpense(s, { date: '2026-09-28', amount: 90000, method: '支付宝', type: '报销', nature: '一次性支出', description: '垫付' }, '陈姐', at('20'));
  s.user = 'zhuBoss';
  decideExpense(s, 'rejectExpense', { id: s.expenses[0].id }, '卓老板', at('21'));
  assert.equal(s.expenses[0].status, '已驳回');
  // 直连采购/客诉/交班命令（采购需采购类权限）
  s.user = 'shaoBoss';
  submitProcurement(s, { date: '2026-09-28', item: '纸巾', quantity: 10, unit: '包', amount: 5000, method: '现金', type: '支出', nature: '一次性支出' }, '邵老板', at('20'));
  assert.equal(s.procurements[0].status, '已关联支出');
  submitIncident(s, { date: '2026-09-28', room: 'V01', type: '卫生异常', description: '地面污渍', assignee: 'zhuYi' }, '邵老板', at('20'));
  s.user = 'zhuYi';
  submitIncidentResolution(s, { id: s.incidents[0].id, result: '已清理', note: '复核干净' }, '卓益', at('21'));
  const approveIt = () => true;
  s.user = 'shaoBoss';
  decideIncidentResolution(s, 'approveIncidentResolution', { id: s.incidents[0].id, request: s.incidents[0].resolutionReviews[0].id }, '邵老板', at('22'), approveIt);
  assert.equal(s.incidents[0].status, '已完成');
  submitHandover(s, { actual: 0, drawerCash: 100 }, '邵老板', at('23'));
  assert.equal(s.handovers[0].expected, salesCollected(s));
  assert.equal(s.handovers[0].difference, 0);
});

test('后测·跨域原子性·挂账拒绝路径：证件缺失时房态/订单/流水全不变', () => {
  let s = opened();
  const id = s.orders[0].id;
  const before = structuredClone(s);
  // 挂账缺签字被拒：房间不释放、订单仍营业中、状态不变
  assert.throws(() => apply(s, 'credit', { order: id, name: '王生', note: '熟客' }), /请由经办员工本人手写签字/);
  assert.deepEqual(s, before);
  // 挂账备注缺失同样被拒
  assert.throws(() => apply(s, 'credit', { order: id, name: '王生', signature }), /请填写挂账备注/);
  assert.deepEqual(s, before);
});
