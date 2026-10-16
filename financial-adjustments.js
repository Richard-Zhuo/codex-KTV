// C1-A: append-only adjustments. No transport, drawer accounting or UI.
import { BusinessRejection } from './shared/business-error.js';
import { assertTrustedExecutionContext, requireTrustedPermission, AuthorizationDenied } from './shared/identity.js';
import { authorizeReviewCommand, createTrustedReviewFacts } from './ledger/command-policy.js';
import { orderBusinessDaySnapshot } from './shared/business-day.js';
import { PAYMENT_METHODS } from './sales.js';

export const FINANCIAL_ACTIONS = Object.freeze(['reversePayment', 'refundPayment', 'approveFinancialAdjustment', 'rejectFinancialAdjustment']);
const kinds = ['PAYMENT_REVERSAL', 'REFUND'];
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const text = (v, max = 191) => typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v;
const positive = v => Number.isSafeInteger(v) && v > 0;
const time = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v.slice(0, 10);
const fail = () => { throw new BusinessRejection('资金事实或申请无法安全解释'); };
const rows = v => { if (v === undefined) return []; if (!Array.isArray(v)) fail(); return v; };
const sum = values => values.reduce((a, b) => { if (!Number.isSafeInteger(b) || b < 0 || !Number.isSafeInteger(a + b)) fail(); return a + b; }, 0);
const permission = kind => kind === 'REFUND' ? 'payment.refund' : 'payment.reverse';
function refundTerms(item) {
  if (!PAYMENT_METHODS.includes(item.refundChannel)) fail();
  if (item.refundChannel === '现金' ? !['CURRENT_DRAWER', 'OUTSIDE_DRAWER'].includes(item.refundFundingSource) : item.refundFundingSource !== 'NON_CASH') fail();
}
function paymentInOrder(order, id) {
  const found = rows(order.payments).filter(p => p?.paymentId === id);
  if (!uuid(id) || found.length !== 1) fail();
  const p = found[0];
  if (!positive(p.amount) || !PAYMENT_METHODS.includes(p.method) || !time(p.occurredAt) ||
      !text(p.recordedByPrincipalId) || !text(p.chargeId)) fail();
  return p;
}
// Array position, display name and legacy time never confer payment identity.
export function validateOriginalPayment(state, orderId, paymentId) {
  const matches = rows(state.orders).filter(o => o.id === orderId);
  if (matches.length !== 1) fail();
  const order = matches[0], payment = paymentInOrder(order, paymentId);
  if (state.orders.flatMap(o => rows(o.payments)).filter(p => p?.paymentId === paymentId).length !== 1) fail();
  return { order, payment };
}
function adjustments(order) {
  const ids = new Set(), amounts = new Map();
  for (const a of rows(order.financialAdjustments)) {
    if (!a || !uuid(a.adjustmentId) || ids.has(a.adjustmentId) || !kinds.includes(a.kind) ||
        !positive(a.amount) || !text(a.reason, 300) || !text(a.actualActorPrincipalId) || !time(a.occurredAt) ||
        !(a.requestId === null || uuid(a.requestId))) fail();
    const p = paymentInOrder(order, a.originalPaymentId);
    if (a.kind === 'REFUND') { refundTerms(a); if (a.affectsCurrentDrawer !== (a.refundFundingSource === 'CURRENT_DRAWER')) fail(); }
    const snapshot = orderBusinessDaySnapshot(a.occurredAt, { timeZone: a.businessTimeZone });
    if (a.businessDate !== snapshot.businessDate || a.businessDayRuleVersion !== snapshot.businessDayRuleVersion) fail();
    const totals = amounts.get(p.paymentId) ?? { refunds: 0, reversed: 0 };
    if (a.kind === 'PAYMENT_REVERSAL') {
      if (a.amount !== p.amount || totals.reversed || totals.refunds) fail();
      totals.reversed = a.amount;
    } else { if (totals.reversed) fail(); totals.refunds = sum([totals.refunds, a.amount]); }
    if (sum([totals.refunds, totals.reversed]) > p.amount) fail();
    amounts.set(p.paymentId, totals); ids.add(a.adjustmentId);
  }
  return amounts;
}
// Billing credit deliberately excludes refunds: returning money does not create debt.
export function orderPaymentCredit(order, chargeId) {
  const adjusted = adjustments(order);
  return sum(rows(order.payments).filter(p => chargeId === undefined || p.chargeId === chargeId)
    .map(p => p.amount - (adjusted.get(p.paymentId)?.reversed ?? 0)));
}
export function netReceipts(order) {
  const adjusted = adjustments(order);
  return orderPaymentCredit(order) - sum([...adjusted.values()].map(a => a.refunds));
}
// Preserve legacy caches until a new reversal affects credit. Then derive the
// balance from the active credit and canonical payment references, never refunds.
export function creditRepaymentRemaining(order) {
  const reversed = adjustments(order), credit = order.credit;
  if (!credit) fail();
  const baseline = rows(credit.paymentReversalBaselineIds), baselineIds = new Set(baseline);
  if (baselineIds.size !== baseline.length || baseline.some(id => !rows(order.financialAdjustments).some(a => a.adjustmentId === id && a.kind === 'PAYMENT_REVERSAL'))) fail();
  const corrections = rows(order.financialAdjustments).filter(a => a.kind === 'PAYMENT_REVERSAL' && !baselineIds.has(a.adjustmentId));
  if (!corrections.length) return credit.remaining;
  const repayments = rows(credit.repayments), ids = new Set();
  const paid = sum(repayments.map(link => {
    const p = paymentInOrder(order, link.paymentId);
    if (ids.has(p.paymentId) || p.chargeId !== 'credit-repayment' || p.amount !== link.amount) fail();
    ids.add(p.paymentId); return p.amount - (reversed.get(p.paymentId)?.reversed ?? 0);
  }));
  if (corrections.some(a => paymentInOrder(order, a.originalPaymentId).chargeId === 'credit-repayment' && !ids.has(a.originalPaymentId))) fail();
  const restored = sum(corrections.filter(a => paymentInOrder(order, a.originalPaymentId).chargeId !== 'credit-repayment').map(a => a.amount));
  if (!positive(credit.amount)) fail();
  const principal = sum([credit.amount, restored]);
  if (paid > principal) fail();
  return principal - paid;
}
function requests(state) {
  const ids = new Set();
  for (const r of rows(state.financialRequests)) {
    if (!r || !uuid(r.requestId) || ids.has(r.requestId) || !kinds.includes(r.kind) ||
        !text(r.submittedByPrincipalId) || !text(r.reason, 300) || !positive(r.amount) || !time(r.submittedAt) ||
        !['待审核', '已批准', '已驳回', '已执行'].includes(r.status)) fail();
    const { order, payment } = validateOriginalPayment(state, r.orderId, r.originalPaymentId);
    if (r.kind === 'REFUND') refundTerms(r);
    else if (r.amount !== payment.amount) fail();
    if (r.status === '待审核') {
      if (r.decidedByPrincipalId !== null || r.decidedAt !== null || r.executedAdjustmentId !== null) fail();
    } else {
      if (!text(r.decidedByPrincipalId) || r.decidedByPrincipalId === r.submittedByPrincipalId || !time(r.decidedAt)) fail();
      if (r.status === '已执行') {
        const a = rows(order.financialAdjustments).filter(a => a.adjustmentId === r.executedAdjustmentId && a.requestId === r.requestId);
        if (a.length !== 1 || a[0].actualActorPrincipalId !== r.submittedByPrincipalId || a[0].kind !== r.kind ||
            a[0].amount !== r.amount || a[0].originalPaymentId !== r.originalPaymentId || a[0].reason !== r.reason ||
            r.kind === 'REFUND' && (a[0].refundChannel !== r.refundChannel || a[0].refundFundingSource !== r.refundFundingSource)) fail();
      } else if (r.executedAdjustmentId !== null) fail();
    }
    ids.add(r.requestId);
  }
  return rows(state.financialRequests);
}
// Both kinds and both execution paths adjudicate this same locked-state balance.
export function adjustablePaymentBalance(state, orderId, paymentId, excludingRequestId = null) {
  const { order, payment } = validateOriginalPayment(state, orderId, paymentId);
  const effective = adjustments(order).get(paymentId) ?? { refunds: 0, reversed: 0 };
  const reserved = sum(requests(state).filter(r => r.orderId === orderId && r.originalPaymentId === paymentId &&
    r.requestId !== excludingRequestId && ['待审核', '已批准'].includes(r.status)).map(r => r.amount));
  const available = payment.amount - effective.refunds - effective.reversed - reserved;
  if (available < 0) fail();
  return { ...effective, reserved, available, originalAmount: payment.amount };
}
function eligible(state, terms, excluding = null) {
  const b = adjustablePaymentBalance(state, terms.orderId, terms.originalPaymentId, excluding);
  if (!positive(terms.amount) || terms.amount > b.available ||
      terms.kind === 'PAYMENT_REVERSAL' && (terms.amount !== b.originalAmount || b.refunds || b.reversed || b.reserved)) {
    throw new BusinessRejection('原付款可调整余额不足或已被占用');
  }
}
function uniqueId(state) {
  const id = globalThis.crypto.randomUUID();
  if (rows(state.financialRequests).some(r => r.requestId === id) ||
      state.orders.some(o => rows(o.financialAdjustments).some(a => a.adjustmentId === id))) throw Error('资金事实 ID 冲突');
  return id;
}
function exact(data, allowed, required) {
  if (Object.keys(data).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(data, k))) throw new BusinessRejection('资金命令字段无效');
}
function append(state, terms, context, request = null) {
  eligible(state, terms, request?.requestId ?? null);
  const { order } = validateOriginalPayment(state, terms.orderId, terms.originalPaymentId);
  if (terms.kind === 'PAYMENT_REVERSAL' && order.status === '待审批挂账') throw new BusinessRejection('请先完成挂账审核再冲正付款');
  if (!context.financialBusinessDay) throw TypeError('缺少可信资金营业日快照');
  const adjustment = { adjustmentId: uniqueId(state), kind: terms.kind, originalPaymentId: terms.originalPaymentId,
    amount: terms.amount, reason: terms.reason, actualActorPrincipalId: context.principalId,
    occurredAt: context.dbNow, ...context.financialBusinessDay, requestId: request?.requestId ?? null,
    ...(terms.kind === 'REFUND' ? { refundChannel: terms.refundChannel, refundFundingSource: terms.refundFundingSource,
      affectsCurrentDrawer: terms.refundFundingSource === 'CURRENT_DRAWER' } : {}) };
  (order.financialAdjustments ??= []).push(adjustment);
  // Only derived credit cache/lifecycle changes; original payment/mirrors stay intact.
  if (terms.kind === 'PAYMENT_REVERSAL' && order.credit) {
    order.credit.remaining = creditRepaymentRemaining(order);
    if (order.credit.remaining > 0 && order.status === '已回款') order.status = '已挂账';
  }
  if (request) { request.status = '已执行'; request.executedAdjustmentId = adjustment.adjustmentId; }
}
export function executeFinancialCommand(state, action, data, execution) {
  const context = assertTrustedExecutionContext(execution?.context);
  if (!FINANCIAL_ACTIONS.includes(action)) throw new BusinessRejection('未知资金命令');
  if (action === 'approveFinancialAdjustment' || action === 'rejectFinancialAdjustment') {
    requireTrustedPermission(context, 'financial.approve');
    exact(data, ['requestId', 'decisionNote'], ['requestId']);
    const r = requests(state).find(r => r.requestId === data.requestId);
    if (!r) throw new BusinessRejection('资金申请不存在');
    const policy = authorizeReviewCommand({ principal: context.principal, action,
      reviewFacts: createTrustedReviewFacts({ submittedByPrincipalId: r.submittedByPrincipalId }) });
    if (!policy.allowed) throw new AuthorizationDenied(policy.reason);
    if (r.status !== '待审核') throw new BusinessRejection('资金申请已经处理');
    const note = data.decisionNote ?? '';
    if (typeof note !== 'string' || note.length > 300 || (action === 'rejectFinancialAdjustment' && !note.trim())) throw new BusinessRejection('请填写有效审批说明');
    if (action === 'approveFinancialAdjustment') eligible(state, r, r.requestId);
    r.status = action === 'approveFinancialAdjustment' ? '已批准' : '已驳回';
    r.decidedByPrincipalId = context.principalId; r.decidedAt = context.dbNow; r.decisionNote = note.trim();
    return;
  }
  const kind = action === 'refundPayment' ? 'REFUND' : 'PAYMENT_REVERSAL';
  requireTrustedPermission(context, permission(kind));
  if (Object.hasOwn(data, 'requestId')) {
    exact(data, ['order', 'requestId'], ['order', 'requestId']);
    const r = requests(state).find(r => r.requestId === data.requestId);
    if (!r) throw new BusinessRejection('资金申请不存在');
    if (r.submittedByPrincipalId !== context.principalId) throw new AuthorizationDenied('financial-applicant-required');
    if (r.status !== '已批准' || r.executedAdjustmentId !== null || r.orderId !== data.order || r.kind !== kind) throw new BusinessRejection('资金申请未批准或已执行');
    append(state, r, context, r); return;
  }
  const fields = ['order', 'originalPaymentId', 'amount', 'reason', ...(kind === 'REFUND' ? ['refundChannel', 'refundFundingSource'] : [])];
  exact(data, fields, fields);
  const terms = { orderId: data.order, kind, originalPaymentId: data.originalPaymentId, amount: data.amount, reason: data.reason,
    ...(kind === 'REFUND' ? { refundChannel: data.refundChannel, refundFundingSource: data.refundFundingSource } : {}) };
  if (!text(terms.reason, 300)) throw new BusinessRejection('请填写资金调整原因');
  if (kind === 'REFUND') refundTerms(terms);
  eligible(state, terms);
  if (context.permissionIds.includes('financial.direct')) append(state, terms, context);
  else (state.financialRequests ??= []).push({ requestId: uniqueId(state), ...terms, submittedByPrincipalId: context.principalId,
    submittedAt: context.dbNow, status: '待审核', decidedByPrincipalId: null, decidedAt: null,
    decisionNote: '', executedAdjustmentId: null });
}
