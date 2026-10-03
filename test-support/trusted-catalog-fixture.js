// Synthetic test data only; this module is not a business execution port.
export const CATALOG_TEST_ACTIONS = Object.freeze(['createCatalogProduct', 'updateCatalogProduct', 'updateCatalogPackage']);
export function catalogTestPayload(action) {
  if (action === 'createCatalogProduct') return { id: 'synthetic_pack', name: 'Synthetic product', category: 'Synthetic category',
    baseUnit: '包', inventoryManaged: true, sellable: true, active: true, sortOrder: 500,
    saleOptions: [{ id: 'pack', name: 'Synthetic pack', baseQuantity: 3, priceCents: 1234 }] };
  if (action === 'updateCatalogProduct') return { id: 'bw', name: 'Synthetic current name', sortOrder: 20,
    saleOptions: [{ id: 'single', name: 'Synthetic single', baseQuantity: 1, priceCents: 1001 },
      { id: 'half', name: 'Synthetic half', baseQuantity: 6, priceCents: 6001 },
      { id: 'dozen', name: 'Synthetic dozen', baseQuantity: 12, priceCents: 13001 }] };
  if (action === 'updateCatalogPackage') return { id: 'room.small.night', name: 'Synthetic current package',
    basePriceCents: 5200, includedValueCents: 11800, priceCents: 17000, sortOrder: 20, active: true };
  throw TypeError('Unknown test action');
}
export function seedCatalogHistory(state) {
  const line = { productId: 'bw', productNameSnapshot: 'Historical name', categorySnapshot: 'beer', baseUnitSnapshot: '支',
    saleOptionId: 'dozen', saleOptionNameSnapshot: 'Historical spec', saleQuantity: 2,
    baseQuantityPerSaleUnit: 12, totalBaseQuantity: 24, pricePerSaleUnitCents: 11800, amountCents: 23600 };
  state.orders = [
    { id: 'history-room', kind: 'room', room: 'V03', packageId: 'room.small.night', packageNameSnapshot: 'Historical package',
      packagePriceCents: 16800, packageBaseCents: 5000, packageGiftValueCents: 11800,
      resolvedComponents: [{ productId: 'bw', productNameSnapshot: null, baseUnitSnapshot: '支', totalBaseQuantity: 12 }],
      sales: [structuredClone(line)], payments: [{ id: 'room-payment', method: '现金', amount: 100, occurredAt: '2026-09-29T13:00:00Z' }] },
    { id: 'history-retail', kind: 'retail', room: null,
      sales: [{ ...line, productNameSnapshot: null, saleOptionNameSnapshot: null, pricePerSaleUnitCents: null, snapshotStatus: 'legacy' }],
      payments: [{ id: 'retail-cash', method: '现金', amount: 100 }, { id: 'retail-wechat', method: '微信', amount: 200 }] }
  ];
  state.inventory.bw.count = 0; state.inventory.qd.count = null;
}
export function invalidCatalogPayloads(action) {
  const payload = catalogTestPayload(action);
  if (action === 'createCatalogProduct') return [ { ...payload, id: 'bw' }, { ...payload, id: 'INVALID' },
    { ...payload, name: '' }, { ...payload, sortOrder: 0.5 }, { ...payload, saleOptions: [] },
    { ...payload, saleOptions: [payload.saleOptions[0], payload.saleOptions[0]] },
    { ...payload, saleOptions: [{ ...payload.saleOptions[0], baseQuantity: 0 }] },
    { ...payload, saleOptions: [{ ...payload.saleOptions[0], priceCents: 0 }] } ];
  if (action === 'updateCatalogProduct') return [ { ...payload, id: 'missing' }, { ...payload, name: '' },
    { ...payload, sortOrder: 0.5 }, { ...payload, saleOptions: [] },
    { ...payload, saleOptions: [payload.saleOptions[0], payload.saleOptions[0]] },
    { ...payload, saleOptions: [{ ...payload.saleOptions[0], priceCents: -1 }] } ];
  return [ { ...payload, id: 'missing' }, { ...payload, name: '' }, { ...payload, priceCents: 1 },
    { ...payload, includedValueCents: -1 }, { ...payload, sortOrder: 0.5 } ];
}
