// Internal financial core: append-only adjustments/cashOut and guarded unpaid cancellation. No transport or UI.
import { BusinessRejection } from './shared/business-error.js';
import { assertTrustedExecutionContext, requireTrustedPermission, AuthorizationDenied } from './shared/identity.js';
import { authorizeReviewCommand, createTrustedReviewFacts } from './ledger/command-policy.js';
import { orderBusinessDaySnapshot } from './shared/business-day.js';
import { PAYMENT_METHODS } from './sales.js';
import { readTrustedDrawer } from './handover.js';

export const FINANCIAL_ACTIONS = Object.freeze(['cancelOrder', 'cashOut', 'reversePayment', 'refundPayment', 'approveFinancialAdjustment', 'rejectFinancialAdjustment']);
const kinds = ['PAYMENT_REVERSAL', 'REFUND', 'CASH_OUT'];
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const text = (v, max = 191) => typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v;
const positive = v => Number.isSafeInteger(v) && v > 0;
const time = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v.slice(0, 10);
const fail = () => { throw new BusinessRejection('资金事实或申请无法安全解释'); };
const rows = v => { if (v === undefined) return []; if (!Array.isArray(v)) fail(); return v; };
const sum = values => values.reduce((a, b) => { if (!Number.isSafeInteger(b) || b < 0 || !Number.isSafeInteger(a + b)) fail(); return a + b; }, 0);
const permission = kind => kind === 'REFUND' ? 'payment.refund' : 'payment.reverse';
const usesCashDrawer = terms => terms.kind === 'CASH_OUT' || terms.kind === 'REFUND' && terms.refundFundingSource === 'CURRENT_DRAWER';
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
    if (!a || !uuid(a.adjustmentId) || ids.has(a.adjustmentId) || !['PAYMENT_REVERSAL', 'REFUND'].includes(a.kind) ||
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
    let order;
    if (r.kind === 'CASH_OUT') {
      if (r.orderId !== undefined || r.originalPaymentId !== undefined) fail();
    } else {
      const original = validateOriginalPayment(state, r.orderId, r.originalPaymentId);
      order = original.order;
      if (r.kind === 'REFUND') refundTerms(r);
      else if (r.amount !== original.payment.amount) fail();
    }
    if (r.status === '待审核') {
      if (r.decidedByPrincipalId !== null || r.decidedAt !== null || r.executedAdjustmentId !== null) fail();
    } else {
      if (!text(r.decidedByPrincipalId) || r.decidedByPrincipalId === r.submittedByPrincipalId || !time(r.decidedAt)) fail();
      if (r.status === '已执行') {
        if (r.kind === 'CASH_OUT') {
          const facts = cashOutFacts(state).filter(f => f.cashOutId === r.executedAdjustmentId && f.requestId === r.requestId);
          if (facts.length !== 1 || facts[0].actualActorPrincipalId !== r.submittedByPrincipalId ||
              facts[0].amountCents !== r.amount || facts[0].reason !== r.reason) fail();
        } else {
          const a = rows(order.financialAdjustments).filter(a => a.adjustmentId === r.executedAdjustmentId && a.requestId === r.requestId);
          if (a.length !== 1 || a[0].actualActorPrincipalId !== r.submittedByPrincipalId || a[0].kind !== r.kind ||
              a[0].amount !== r.amount || a[0].originalPaymentId !== r.originalPaymentId || a[0].reason !== r.reason ||
              r.kind === 'REFUND' && (a[0].refundChannel !== r.refundChannel || a[0].refundFundingSource !== r.refundFundingSource)) fail();
        }
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
  if (terms.kind === 'CASH_OUT') {
    const balance = cashOutBalance(state, excluding);
    if (!positive(terms.amount) || terms.amount > balance.available) throw new BusinessRejection('Insufficient verified drawer cash');
    return;
  }
  const b = adjustablePaymentBalance(state, terms.orderId, terms.originalPaymentId, excluding);
  if (!positive(terms.amount) || terms.amount > b.available ||
      terms.kind === 'PAYMENT_REVERSAL' && (terms.amount !== b.originalAmount || b.refunds || b.reversed || b.reserved)) {
    throw new BusinessRejection('原付款可调整余额不足或已被占用');
  }
  if (usesCashDrawer(terms)) {
    const drawer = cashOutBalance(state, excluding);
    if (terms.amount > drawer.available)
      throw new BusinessRejection('Cash refund exceeds the current verified drawer boundary');
  }
}
function uniqueId(state) {
  const id = globalThis.crypto.randomUUID();
  if (rows(state.cashOutflows).some(f => f.cashOutId === id) || state.orders.some(o => o.cancellation?.cancellationId === id)) throw Error('Cash-out ID collision');
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
      affectsCurrentDrawer: terms.refundFundingSource === 'CURRENT_DRAWER',
      ...(usesCashDrawer(terms) ? { drawerHandoverId: readTrustedDrawer(state).handoverId } : {}) } : {}) };
  (order.financialAdjustments ??= []).push(adjustment);
  // Only derived credit cache/lifecycle changes; original payment/mirrors stay intact.
  if (terms.kind === 'PAYMENT_REVERSAL' && order.credit) {
    order.credit.remaining = creditRepaymentRemaining(order);
    if (order.credit.remaining > 0 && order.status === '已回款') order.status = '已挂账';
  }
  if (request) { request.status = '已执行'; request.executedAdjustmentId = adjustment.adjustmentId; }
}

// Facts bind to the actual-count cursor, never wall-clock ordering.
function cashOutFacts(state) {
  const facts = rows(state.cashOutflows), seen = new Set();
  const handovers = rows(state.handovers).filter(h => ['drawer-v1', 'drawer-v2'].includes(h.trustedHandoverVersion));
  let previousIndex = -1;
  for (const fact of facts) {
    const index = handovers.findIndex(h => h.handoverId === fact?.drawerHandoverId);
    if (!fact || !uuid(fact.cashOutId) || seen.has(fact.cashOutId) || !positive(fact.amountCents) ||
        !text(fact.reason, 300) || !text(fact.actualActorPrincipalId) || !time(fact.occurredAt) ||
        !(fact.requestId === null || uuid(fact.requestId)) || index < previousIndex || index < 0) fail();
    const snapshot = orderBusinessDaySnapshot(fact.occurredAt, { timeZone: fact.businessTimeZone });
    if (snapshot.businessDate !== fact.businessDate || snapshot.businessDayRuleVersion !== fact.businessDayRuleVersion) fail();
    seen.add(fact.cashOutId); previousIndex = index;
  }
  return facts;
}
// No time-window attribution. Unknown historical refunds remain blocked.
export function cashDrawerFacts(state) {
  const facts = [], paymentReversals = new Map(), seen = new Set();
  const handovers = new Set(rows(state.handovers).filter(h =>
    ['drawer-v1', 'drawer-v2'].includes(h.trustedHandoverVersion)).map(h => h.handoverId));
  const add = fact => { if (seen.has(fact.factId)) fail(); seen.add(fact.factId); facts.push(fact); };
  for (const order of rows(state.orders)) {
    const effective = adjustments(order);
    for (const [id, totals] of effective) if (totals.reversed) paymentReversals.set(id, totals.reversed);
    for (const a of rows(order.financialAdjustments)) {
      if (a.kind === 'REFUND' && !a.affectsCurrentDrawer) continue;
      if (a.kind === 'REFUND' && (!uuid(a.drawerHandoverId) || !handovers.has(a.drawerHandoverId)))
        throw new BusinessRejection('Cash drawer refund attribution requires audited reconciliation');
      add({ factId: a.adjustmentId, kind: a.kind, amount: a.amount, drawerHandoverId: a.drawerHandoverId ?? null,
        signature: JSON.stringify([order.id, a.adjustmentId, a.kind, a.originalPaymentId, a.amount, a.reason,
          a.actualActorPrincipalId, a.occurredAt, a.businessDate, a.businessDayRuleVersion, a.businessTimeZone,
          a.requestId, a.refundChannel ?? null, a.refundFundingSource ?? null, a.affectsCurrentDrawer ?? null, a.drawerHandoverId ?? null]) });
    }
  }
  for (const f of cashOutFacts(state)) add({ factId: f.cashOutId, kind: 'CASH_OUT', amount: f.amountCents,
    drawerHandoverId: f.drawerHandoverId,
    signature: JSON.stringify([f.cashOutId, f.amountCents, f.reason, f.actualActorPrincipalId, f.occurredAt,
      f.businessDate, f.businessDayRuleVersion, f.businessTimeZone, f.requestId, f.drawerHandoverId]) });
  return { facts, paymentReversals };
}

export function cashOutBalance(state, excludingRequestId = null) {
  const drawer = readTrustedDrawer(state), included = new Set(drawer.boundaryPaymentIds);
  const reserved = sum(requests(state).filter(r => r.requestId !== excludingRequestId &&
    ['\u5f85\u5ba1\u6838', '\u5df2\u6279\u51c6'].includes(r.status) &&
    (r.kind === 'CASH_OUT' || r.kind === 'REFUND' && r.refundFundingSource === 'CURRENT_DRAWER' ||
      r.kind === 'PAYMENT_REVERSAL' && !included.has(r.originalPaymentId) &&
      validateOriginalPayment(state, r.orderId, r.originalPaymentId).payment.method === '\u73b0\u91d1'))
    .map(r => r.amount));
  const available = drawer.expectedCash - reserved;
  if (!Number.isSafeInteger(available) || available < 0) fail();
  return { drawerHandoverId: drawer.handoverId, available, reserved };
}
function appendCashOut(state, terms, context, request = null) {
  const balance = cashOutBalance(state, request?.requestId ?? null);
  if (!positive(terms.amount) || terms.amount > balance.available) throw new BusinessRejection('Insufficient verified drawer cash');
  if (!context.financialBusinessDay) throw TypeError('Missing trusted financial day');
  const cashOutId = uniqueId(state);
  (state.cashOutflows ??= []).push({ cashOutId, amountCents: terms.amount, reason: terms.reason,
    actualActorPrincipalId: context.principalId, occurredAt: context.dbNow, ...context.financialBusinessDay,
    drawerHandoverId: balance.drawerHandoverId, requestId: request?.requestId ?? null });
  if (request) { request.status = '\u5df2\u6267\u884c'; request.executedAdjustmentId = cashOutId; }
}
function cancelUnpaidOrder(state, data, context) {
  requireTrustedPermission(context, 'order.cancel');
  exact(data, ['order', 'reason'], ['order', 'reason']);
  if (!text(data.reason, 300)) throw new BusinessRejection('A cancellation reason is required');
  const matches = rows(state.orders).filter(o => o.id === data.order);
  if (matches.length !== 1) fail();
  const order = matches[0];
  if (order.cancellation || order.status !== '\u8425\u4e1a\u4e2d' ||
      !Array.isArray(order.payments) || order.payments.length ||
      rows(order.financialAdjustments).length || order.credit || rows(order.creditHistory).length ||
      order.roundingReview || order.voucher) throw new BusinessRejection('Only an unambiguous unpaid order may be cancelled');
  if (requests(state).some(r => r.orderId === order.id && !['\u5df2\u9a73\u56de', '\u5df2\u6267\u884c'].includes(r.status)) ||
      rows(order.giftRequests).some(r => !['\u5df2\u6279\u51c6', '\u5df2\u9a73\u56de'].includes(r.status)))
    throw new BusinessRejection('Unfinished order request prevents cancellation');
  const owners = rows(state.rooms).filter(r => r.order === order.id);
  if (order.kind === 'retail') {
    if (order.room !== null || owners.length) fail();
  } else if (order.kind === 'room') {
    const rooms = state.rooms.filter(r => r.id === order.room);
    if (rooms.length !== 1 || owners.length > 1 || owners.some(r => r.id !== order.room)) fail();
    const room = rooms[0];
    if (room.order === order.id) {
      if (room.status !== '\u8425\u4e1a\u4e2d') fail();
      room.order = null; room.status = '\u5f85\u6e05\u6d01';
    } else if (room.order === null) {
      if (!['\u7a7a\u95f2', '\u5f85\u6e05\u6d01'].includes(room.status)) fail();
    } else {
      const current = state.orders.filter(o => o.id === room.order && o.room === room.id &&
        o.kind === 'room' && o.status === '\u8425\u4e1a\u4e2d' && !o.cancellation);
      if (current.length !== 1 || room.status !== '\u8425\u4e1a\u4e2d') fail();
    }
  } else fail();
  order.cancellation = { cancellationId: uniqueId(state), orderId: order.id, reason: data.reason,
    actualActorPrincipalId: context.principalId, occurredAt: context.dbNow, status: 'CANCELLED' };
  order.status = '\u5df2\u64a4\u5355';
}
export function executeFinancialCommand(state, action, data, execution) {
  const context = assertTrustedExecutionContext(execution?.context);
  if (!FINANCIAL_ACTIONS.includes(action)) throw new BusinessRejection('未知资金命令');
  if (action === 'cancelOrder') return cancelUnpaidOrder(state, data, context);
  if (action === 'cashOut') {
    requireTrustedPermission(context, 'cash.out');
    if (Object.hasOwn(data, 'requestId')) {
      exact(data, ['requestId'], ['requestId']);
      const r = requests(state).find(r => r.requestId === data.requestId);
      if (!r) throw new BusinessRejection('Financial request not found');
      if (r.submittedByPrincipalId !== context.principalId) throw new AuthorizationDenied('financial-applicant-required');
      if (r.kind !== 'CASH_OUT' || r.status !== '\u5df2\u6279\u51c6' || r.executedAdjustmentId !== null) throw new BusinessRejection('Cash-out request is not approved or is consumed');
      appendCashOut(state, r, context, r); return;
    }
    exact(data, ['amountCents', 'reason'], ['amountCents', 'reason']);
    if (!text(data.reason, 300)) throw new BusinessRejection('A withdrawal reason is required');
    const terms = { kind: 'CASH_OUT', amount: data.amountCents, reason: data.reason };
    eligible(state, terms);
    if (context.permissionIds.includes('financial.direct')) appendCashOut(state, terms, context);
    else (state.financialRequests ??= []).push({ requestId: uniqueId(state), ...terms,
      submittedByPrincipalId: context.principalId, submittedAt: context.dbNow,
      status: '\u5f85\u5ba1\u6838', decidedByPrincipalId: null, decidedAt: null,
      decisionNote: '', executedAdjustmentId: null });
    return;
  }
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
