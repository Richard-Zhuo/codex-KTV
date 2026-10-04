// Synthetic locked ledger facts; names and demo IDs never establish applicant identity.
export const INVENTORY_REVIEW_ACTIONS = Object.freeze(['approveInventory', 'rejectInventory']);
export const INVENTORY_REVIEWER = '30000000-0000-4000-8000-000000000001';
export const INVENTORY_APPLICANT = '30000000-0000-4000-8000-000000000002';
export const inventoryReview = state => state.inventoryReviews.find(request => request.id === 701);
export const reviewBalance = (state, kind) => kind === 'consumable' ? state.consumables.cons_nuts : state.inventory.bw;
export function seedInventoryReview(state, { kind = 'drink', before = null, after = 17,
  submittedByPrincipalId = INVENTORY_APPLICANT } = {}) {
  state.serial = 800;
  const item = reviewBalance(state, kind); item.count = before;
  if (before !== null) item.openedAt = '2026-01-01T00:00:00Z';
  if (kind === 'consumable') item.opened = 3;
  state.ledger.push({ id: 650, product: 'qd', delta: -12, counted: false,
    productNameSnapshot: null, baseUnitSnapshot: '支', person: 'historical display', time: '2026-01-01T00:00:00Z' });
  state.inventoryReviews.push({ id: 701, kind, product: kind === 'consumable' ? 'cons_nuts' : 'bw', before, after,
    ...(kind === 'consumable' ? { openedBefore: 3, openedAfter: 2 } : {}), reason: 'synthetic stock check',
    source: (kind === 'consumable' ? '消耗品' : '') + (before === null ? '期初建账' : '盘点调整'), status: '待审核',
    submittedByPrincipalId, submittedBy: 'historical stock submitter', submittedById: '', submittedAt: '2026-01-02T00:00:00Z',
    decidedBy: '', decidedAt: '', decisionNote: '' });
}
export const inventoryReviewCommand = (action, key = 'decide', revision = 0, changes = {}) => ({
  operationKey: key, expectedRevision: revision, action,
  payload: { request: 701, decisionNote: 'synthetic inventory decision', ...changes }
});
