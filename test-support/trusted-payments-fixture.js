// Synthetic room charges plus untouched historical payments/snapshots; no employee attribution.
export const paymentPrincipalId = '60000000-0000-4000-8000-000000000001';
export const otherPaymentPrincipalId = '60000000-0000-4000-8000-000000000002';
export const paymentDbNow = '2026-10-06T01:23:45.123456Z';
export const paymentOrderId = 'trusted-payment-room';
export const paymentOrder = state => state.orders.find(order => order.id === paymentOrderId);
export const paymentPermission = action => action === 'collect' ? 'payment.collect' : 'payment.settle';
export const paymentCommand = (action = 'collect', key = 'payment-first', revision = 0, changes = {}) => ({
  operationKey: key, expectedRevision: revision, action,
  payload: { order: paymentOrderId, ...(action === 'collect' ? { charge: 'other:810' } : {}),
    payments: action === 'collect' ? [{ method: '微信', amount: 2000 }, { method: '现金', amount: 1000 }]
      : [{ method: '支付宝', amount: 12000 }, { method: '现金', amount: 9200 }], ...changes }
});
export function seedTrustedPayments(state) {
  state.serial = 1000; state.inventory.qd.count = null; state.inventory.bw.count = 0;
  state.rooms[0].status = '营业中'; state.rooms[0].order = paymentOrderId;
  state.orders.push({ id: paymentOrderId, kind: 'room', room: state.rooms[0].id,
    time: '2026-01-01T12:00:00Z', createdAt: '2026-01-01T12:00:00Z', person: 'Historical Seller',
    employeeId: 'unmapped-historical-employee', status: '营业中', packageBaseCents: 16800, packageGiftValueCents: 0,
    base: 16800, gift: 0, packageNameSnapshot: 'Historical room package', packagePriceCents: 16800,
    sales: [{ id: 800, batch: 800, productId: 'historical-only-product', productNameSnapshot: null,
      saleOptionNameSnapshot: 'Historical specification', pricePerSaleUnitCents: null,
      baseQuantityPerSaleUnit: 12, totalBaseQuantity: 24, saleQuantity: 2, amountCents: 2400 }],
    otherCharges: [{ id: 810, batch: 810, category: '其他', item: 'Historical service', amountCents: 3000 }],
    payments: [{ method: '现金', amount: 1000, chargeId: 'open', person: 'Historical Collector', time: '2026-01-01T12:30:00Z' }],
    giftRequests: [], rounding: 0, roundingType: '', roundingNote: '', roundingReview: null,
    credit: null, drinks: [], extras: [], bonusGifts: [], exchanges: [] });
}
