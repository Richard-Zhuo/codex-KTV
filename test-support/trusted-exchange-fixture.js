// Synthetic persisted room/retail facts. Exchange has no employee attribution input.
export function seedTrustedExchange(state) {
  state.serial = 1000;
  state.rooms[0].status = '营业中'; state.rooms[0].order = 'synthetic-exchange-room';
  state.inventory.lm.count = 50; state.inventory.bw.count = 50;
  state.inventory.soda0.count = 20; state.inventory.qd.count = null; state.inventory.water.count = 0;
  state.ledger.push({ id: 900, product: 'bw', delta: -12, counted: true,
    person: 'Historical Actor', time: '2026-01-01T12:00:00Z' });
  state.orders.push({ id: 'synthetic-exchange-room', kind: 'room', room: 'V01', status: '营业中',
    time: '2026-01-01T12:00:00Z', person: 'Historical Employee', recordedBy: 'Historical Actor',
    creditedEmployeeId: '10000000-0000-4000-8000-000000000001',
    packageBaseCents: 29000, packageGiftValueCents: 0, packageNameSnapshot: 'Historical Package',
    drinks: [{ id: 501, product: 'lm', productId: 'lm', productNameSnapshot: 'Historical Opening Beer',
      baseUnitSnapshot: '支', count: 20, baseQuantity: 20, totalBaseQuantity: 20, referenceValueCents: null }],
    sales: [{ id: 600, product: 'bw', productId: 'bw', productNameSnapshot: 'Historical Sale Beer',
      saleOptionNameSnapshot: 'Historical Dozen', pricePerSaleUnitCents: null, amountCents: 11800,
      baseQuantityPerSaleUnit: 12, totalBaseQuantity: 12, person: 'Historical Employee', recordedBy: 'Historical Actor',
      drinks: [{ id: 601, product: 'bw', productId: 'bw', productNameSnapshot: null, baseUnitSnapshot: '支', count: 12, totalBaseQuantity: 12 }] }],
    bonusGifts: [{ id: 700, product: 'bw', productId: 'bw', productNameSnapshot: 'Historical Bonus Beer',
      referenceValueCents: 5900, source: 'Historical Approved Gift',
      drinks: [{ id: 701, product: 'bw', productId: 'bw', productNameSnapshot: 'Historical Bonus Beer', baseUnitSnapshot: '支', count: 6 }] }],
    giftRequests: [{ id: 710, status: '已批准', requestedBy: 'Historical Applicant', decidedBy: 'Historical Approver' }],
    resolvedComponents: [{ productId: 'lm', productNameSnapshot: 'Historical Opening Beer', totalBaseQuantity: 20 }],
    otherCharges: [{ id: 800, category: '其他', amount: 300, person: 'Historical Actor' }],
    extras: [{ product: 'fruit', count: 1, served: true }], exchanges: [],
    payments: [{ method: '现金', amount: 100 }, { method: '微信', amount: 200 }], credit: null });
}
export const exchangeOrder = state => state.orders.find(order => order.id === 'synthetic-exchange-room');
export const exchangeLines = (state, scope = '套餐') => scope === '增购' ? exchangeOrder(state).sales[0].drinks :
  scope === '赠送' ? exchangeOrder(state).bonusGifts[0].drinks : exchangeOrder(state).drinks;
export const exchangeLineSelector = scope => scope === '增购' ? 'sale:601' : scope === '赠送' ? 'bonus:701' : 501;
export const exchangeCommand = (key = 'first', revision = 0, changes = {}) => ({ operationKey: key, expectedRevision: revision,
  action: 'exchange', payload: { order: 'synthetic-exchange-room', line: 501, product: 'soda0', count: 3, ...changes } });
export function seedExistingExchangeTarget(state, scope) {
  exchangeLines(state, scope)[0].count -= 2;
  exchangeLines(state, scope).push({ id: 850, product: 'soda0', productId: 'soda0', productNameSnapshot: 'Historical Target',
    baseUnitSnapshot: '支', count: 2, totalBaseQuantity: 2, snapshotStatus: 'current' });
}
