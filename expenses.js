// 费用领域：支出/报销登记、大额报销审批与可见性。
// Phase 5 自 rules.js 迁出：visibleExpenses 查询、expense 命令与
// approveExpense+rejectExpense 审批命令。函数体逐字节保留，
// 阈值分级（报销超过 500 元须老板审批）与按权限查看行为不变。
// 已知 bug（审批费用后关联 procurement.status 不同步）保持原状，修复另立任务。
import { need } from './inventory.js';
import { effectiveUser, hasPermission } from './shared/identity.js';
import { PAYMENT_METHODS } from './sales.js';

export const EXPENSE_NATURES = ['一次性支出', '固定支出', '资金周转'];
export const EXPENSE_TYPES = ['支出', '报销'];
export const EXPENSE_APPROVAL_THRESHOLD = 50000;

export function visibleExpenses(state, user = effectiveUser(state)) {
  const rows = Array.isArray(state?.expenses) ? state.expenses : [];
  return hasPermission(user, 'expense.viewAll') ? rows : rows.filter(row => row.person === user?.name);
}

// —— 命令层：由 rules.js 的 transact 分支委托调用，参数与原分支一致 ——

export function submitExpense(s, data, person, time) {
  need(s, ['管理员','老板','店长','财务','采购','开单员','服务员','收银员','库管'], 'expense.create');
  const expenseDate = String(data.date || '').trim();
  const parsedDate = Date.parse(`${expenseDate}T00:00:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate) || !Number.isFinite(parsedDate)) throw Error('请选择有效支出日期');
  if (!Number.isSafeInteger(data.amount) || data.amount <= 0) throw Error('支出金额应为大于零的金额');
  if (!PAYMENT_METHODS.includes(data.method)) throw Error('请选择付款方式');
  const type = String(data.type || '支出').trim();
  if (!EXPENSE_TYPES.includes(type)) throw Error('请选择记录类型');
  if (!EXPENSE_NATURES.includes(data.nature)) throw Error('请选择支出性质');
  const description = String(data.description || '').trim().slice(0, 200);
  if (!description) throw Error('请填写支出说明');
  const proof = String(data.proof || '').trim();
  if (proof && (!proof.startsWith('data:image/') || proof.length > 800000)) throw Error('图片凭证格式或大小无效');
  s.expenses ??= [];
  const needsApproval = type === '报销' && data.amount > EXPENSE_APPROVAL_THRESHOLD;
  s.expenses.push({ id: ++s.serial, date: expenseDate, type, amount: data.amount, method: data.method, nature: data.nature, description, proof, proofName: String(data.proofName || '').trim().slice(0, 120), status: needsApproval ? '待老板审批' : '已记录', approver: '', approvedAt: '', person, time });
}
export function decideExpense(s, action, data, person, time) {
  need(s, ['老板'], 'expense.approve');
  const expense = (s.expenses || []).find(item => item.id === Number(data.id));
  if (!expense || expense.status !== '待老板审批') throw Error('这笔报销不在待审批状态');
  expense.status = action === 'approveExpense' ? '已审批' : '已驳回';
  expense.approver = person;
  expense.approvedAt = time;
  // Bug #5 修复：审批结果同步到关联采购单，采购页不再停留在旧状态。
  for (const procurement of (s.procurements || [])) {
    if (procurement.expenseId !== expense.id || procurement.status !== '报销待老板审批') continue;
    procurement.status = action === 'approveExpense' ? '已关联支出' : '报销已驳回';
    procurement.decisionAt = time;
    procurement.decisionBy = person;
  }
}
