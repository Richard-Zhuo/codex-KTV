import { seedTrustedCredit, creditOrder } from './trusted-credit-fixture.js';
export const CREDIT_REVIEW_ACTIONS = ['approve', 'reject'];
export const creditReviewCommand = (action = 'approve', key = 'decision', revision = 0, changes = {}) => ({
  operationKey: key, expectedRevision: revision, action, payload: { order: 'synthetic-credit-order', ...changes }
});
export const creditDecision = (state, action = 'approve') => action === 'reject' ? creditOrder(state).creditHistory.at(-1) : creditOrder(state).credit;
export function seedCreditReview(state, applicant = 'synthetic-credit-applicant', amount = 100000) {
  seedTrustedCredit(state);
  const order = creditOrder(state);
  order.status = '待审批挂账';
  order.credit = { id: 1001, amount, remaining: amount, phone: '13800000000', name: 'Historical customer',
    note: 'Historical credit note', person: 'Applicant display snapshot', submittedById: 'legacy',
    submittedByPrincipalId: applicant, openedBy: order.openedBy, openSource: order.openSource,
    reservedBy: order.reservedBy, reservationSource: order.reservationSource,
    signature: 'data:image/png;base64,synthetic', submittedAt: '2026-01-01T12:00:00.000000Z',
    due: '2026-01-02T12:00:00.000Z', approver: amount > 100000 ? '老板' : '店长', repayments: [], repaymentRequests: [] };
  // Credit creation already released the room; it may now belong to another guest.
  state.rooms[0].order = 'another-room-order';
  state.rooms[0].status = '营业中';
}
