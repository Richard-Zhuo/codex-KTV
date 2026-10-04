import { seedTrustedGift, giftOrder } from './trusted-gift-fixture.js';

export const GIFT_REVIEW_ACTIONS = ['approveGift', 'rejectGift'];
export const GIFT_APPLICANT = 'synthetic-gift-applicant';
export const GIFT_REVIEWER = 'synthetic-gift-reviewer';
export const giftReview = state => giftOrder(state).giftRequests.find(request => request.id === 1001);
export const giftReviewCommand = (action, key = 'decision', revision = 0, changes = {}) => ({
  operationKey: key, expectedRevision: revision, action,
  payload: { order: 'synthetic-gift-room', request: 1001, decisionNote: 'Synthetic decision', ...changes }
});
// Controlled pending facts for unit/legacy cases. Integration success also creates a real trusted gift request.
export function seedGiftReview(state, applicant = GIFT_APPLICANT) {
  seedTrustedGift(state); state.serial = 1001;
  giftOrder(state).giftRequests.push({ id: 1001, product: 'bw', productId: 'bw',
    productNameSnapshot: 'Request Beer Snapshot', categorySnapshot: 'beer', baseUnitSnapshot: '\u652f',
    saleOptionId: 'half', saleOptionNameSnapshot: 'Request Half Snapshot', halves: 2, saleQuantity: 2,
    baseQuantityPerSaleUnit: 6, bottles: 12, totalBaseQuantity: 12, referenceValueCents: 11800,
    allowanceAtRequest: 0, status: '\u5f85\u786e\u8ba4', requestedBy: 'Applicant Display Snapshot', requestedById: '',
    submittedByPrincipalId: applicant, submittedAt: '2026-01-01T12:00:00Z', time: '2026-01-01T12:00:00Z',
    decidedBy: '', decidedAt: '', decisionNote: '', snapshotStatus: 'current' });
}
