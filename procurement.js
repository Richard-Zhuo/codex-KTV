// 采购领域：采购登记并自动关联支出/报销，与按权限查看。
// Phase 5 自 rules.js 迁出：visibleProcurements 查询与 procurement 命令。
// 函数体逐字节保留，低于阈值直接已记录、报销超阈值进老板审批行为不变。
// 历史 Bug #5 已由 expenses.js 修复；本模块保持现行采购与关联费用的状态规则。
import { BusinessRejection } from './shared/business-error.js';
import { need } from './inventory.js';
import { effectiveUser, hasPermission, assertTrustedExecutionContext, requireTrustedPermission } from './shared/identity.js';
import { PAYMENT_METHODS } from './sales.js';
import { EXPENSE_TYPES, EXPENSE_NATURES, EXPENSE_APPROVAL_THRESHOLD } from './expenses.js';

export function visibleProcurements(state, user = effectiveUser(state)) {
  const rows = Array.isArray(state?.procurements) ? state.procurements : [];
  return hasPermission(user, 'procurement.viewAll') ? rows : rows.filter(row => row.person === user?.name);
}

// —— 命令层：由 rules.js 的 transact 分支委托调用，参数与原分支一致 ——

export function submitProcurement(s, data, person, time, execution = { mode: 'demo' }) {
  if (!execution || !['demo', 'trusted'].includes(execution.mode)) throw TypeError('采购申请执行模式无效');
  const context = execution.mode === 'trusted' ? assertTrustedExecutionContext(execution.context) : null;
  if (context) {
    requireTrustedPermission(context, 'procurement.create');
    person = context.actorSnapshot?.displayName ?? null; time = context.dbNow;
  } else need(s, [], 'procurement.create');
  const procurementDate = String(data.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(procurementDate) || !Number.isFinite(Date.parse(`${procurementDate}T00:00:00`))) throw new BusinessRejection('请选择有效采购日期');
  const item = String(data.item || '').trim().slice(0, 80); if (!item) throw new BusinessRejection('请填写采购项目');
  if (!Number.isSafeInteger(data.quantity) || data.quantity <= 0) throw new BusinessRejection('采购数量应为大于零的整数');
  const unit = String(data.unit || '').trim().slice(0, 20); if (!unit) throw new BusinessRejection('请填写采购单位');
  if (!Number.isSafeInteger(data.amount) || data.amount <= 0) throw new BusinessRejection('采购金额应为大于零的金额');
  if (!PAYMENT_METHODS.includes(data.method)) throw new BusinessRejection('请选择付款方式');
  const type = String(data.type || '支出').trim(); if (!EXPENSE_TYPES.includes(type)) throw new BusinessRejection('请选择记录类型');
  if (!EXPENSE_NATURES.includes(data.nature)) throw new BusinessRejection('请选择支出性质');
  const description = String(data.description || '').trim().slice(0, 200) || `采购${item}`;
  s.expenses ??= [];
  const needsApproval = type === '报销' && data.amount > EXPENSE_APPROVAL_THRESHOLD;
  const expenseId = ++s.serial;
  s.expenses.push({ id: expenseId, date: procurementDate, type, amount: data.amount, method: data.method, nature: data.nature, description, proof: '', proofName: '', status: needsApproval ? '待老板审批' : '已记录', approver: '', approvedAt: '', submittedById: context ? '' : s.user, ...(context ? { submittedByPrincipalId: context.principalId } : {}), person, time, source: '采购' });
  s.procurements ??= [];
  s.procurements.push({ id: ++s.serial, date: procurementDate, item, quantity: data.quantity, unit, amount: data.amount, method: data.method, type, nature: data.nature, description, expenseId, status: needsApproval ? '报销待老板审批' : '已关联支出', person, time,
    ...(context ? { submittedByPrincipalId: context.principalId } : {}) });
}
