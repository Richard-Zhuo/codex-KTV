import { paymentOrder, paymentOrderId, seedTrustedPayments, paymentPrincipalId } from './trusted-payments-fixture.js';
export { paymentOrder, paymentOrderId, seedTrustedPayments };
export const settleCommand = (key = 'settle-first', revision = 0, difference = 1001, changes = {}) => ({
  operationKey: key, expectedRevision: revision, action: 'settle',
  payload: { order: paymentOrderId, payments: [{ method: '微信', amount: 12000 }, { method: '现金', amount: 9200 - difference }],
    differenceType: '免零', ...changes }
});
export const roundingCommand = (action = 'approveRounding', key = 'rounding-first', revision = 0, changes = {}) => ({
  operationKey: key, expectedRevision: revision, action,
  payload: { order: paymentOrderId, ...(action === 'rejectRounding' ? { decisionNote: 'Synthetic rejection' } : {}), ...changes }
});
// A pending waiver remains ineffective while the order and room stay active.
export function seedPendingRounding(state, applicant = paymentPrincipalId, amount = 1001, type = '免零') {
  const order = paymentOrder(state);
  order.payments.push({ method: '现金', amount: 21200 - amount, chargeId: 'settlement', time: '2026-01-02T01:00:00Z', person: 'Historical Collector' });
  order.status = '营业中'; delete order.closedAt;
  order.rounding = amount; order.roundingType = type; order.roundingNote = type === '特殊情况' ? 'Synthetic special note' : '';
  order.roundingReview = { status: '待审核', amount, note: order.roundingNote, submittedBy: 'Untrusted demo applicant',
    submittedById: 'administrator', ...(applicant === undefined ? {} : { submittedByPrincipalId: applicant }),
    submittedAt: '2026-01-02T01:00:00Z', approver: '店长', decidedBy: '', decidedAt: '', decisionNote: '' };
  state.rooms[0].status = '营业中'; state.rooms[0].order = order.id;
}
