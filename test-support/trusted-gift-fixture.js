// Synthetic business facts. Gift has no employee-attribution input.
export const giftOrder = state => state.orders.find(order => order.id === 'synthetic-gift-room');
export const giftCommand = (key = 'first', revision = 0, changes = {}) => ({ operationKey: key, expectedRevision: revision,
  action: 'gift', payload: { order: 'synthetic-gift-room', product: 'bw', halves: 2, ...changes } });
export function seedTrustedGift(state) {
  state.serial = 1000; state.rooms[0].status = '营业中'; state.rooms[0].order = 'synthetic-gift-room';
  state.inventory.bw.count = 50; state.inventory.qd.count = null; state.inventory.lm.count = 0;
  state.ledger.push({ id: 900, product: 'qd', delta: -12, counted: false, productNameSnapshot: null,
    baseUnitSnapshot: '支', person: 'Historical Actor', time: '2026-01-01T12:00:00Z' });
  state.orders.push({ id: 'synthetic-gift-room', kind: 'room', room: 'V01', status: '营业中',
    time: '2026-01-01T12:00:00Z', person: 'Historical Employee', recordedBy: 'Historical Actor',
    creditedEmployeeId: '10000000-0000-4000-8000-000000000001', creditedEmployeeNameSnapshot: 'Historical Employee',
    packageBaseCents: 29000, packageGiftValueCents: 0, packageNameSnapshot: 'Historical Package',
    drinks: [{ id: 501, product: 'lm', productId: 'lm', productNameSnapshot: null, baseUnitSnapshot: '支', count: 20,
      totalBaseQuantity: 20, referenceValueCents: null }],
    resolvedComponents: [{ productId: 'lm', productNameSnapshot: null, totalBaseQuantity: 20 }],
    sales: [{ id: 600, product: 'bw', productId: 'bw', productNameSnapshot: 'Historical Sale Beer',
      saleOptionNameSnapshot: 'Historical Dozen', pricePerSaleUnitCents: null, amountCents: 23600,
      baseQuantityPerSaleUnit: 12, totalBaseQuantity: 24, person: 'Historical Employee', recordedBy: 'Historical Actor',
      drinks: [{ id: 601, product: 'bw', productId: 'bw', productNameSnapshot: null, count: 24, totalBaseQuantity: 24 }] }],
    bonusGifts: [{ id: 700, product: 'qd', productId: 'qd', halves: 1, bottles: 6, productNameSnapshot: null,
      referenceValueCents: null, source: 'Historical Gift', person: 'Historical Actor', requestedBy: 'Historical Applicant',
      drinks: [{ id: 701, product: 'qd', productId: 'qd', productNameSnapshot: null, count: 6, totalBaseQuantity: 6 }] }],
    giftRequests: [{ id: 710, product: 'qd', productId: 'qd', halves: 1, status: '已驳回',
      requestedBy: 'Historical Applicant', requestedById: 'legacy', decidedBy: 'Historical Approver' }],
    otherCharges: [{ id: 800, category: '其他', amount: 300, person: 'Historical Actor' }],
    extras: [{ product: 'fruit', count: 1, served: true }], exchanges: [],
    payments: [{ method: '现金', amount: 100 }, { method: '微信', amount: 200 }], credit: null });
}
