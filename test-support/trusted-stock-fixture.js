// Synthetic balances and commands; no employee or demo identity mapping.
export const STOCK_ACTIONS = Object.freeze(['stock', 'consumableStock']);
export const STOCK_PRINCIPAL = '20000000-0000-4000-8000-000000000001';
export const stockProduct = action => action === 'stock' ? 'bw' : 'cons_nuts';
export const stockBalance = (state, action) => action === 'stock'
  ? state.inventory[stockProduct(action)] : state.consumables[stockProduct(action)];
export function seedTrustedStock(state, action, count = null) {
  stockBalance(state, action).count = count;
  if (action === 'consumableStock') stockBalance(state, action).opened = 3;
  state.ledger.push({ id: ++state.serial, product: 'qd', delta: -12, counted: false,
    productNameSnapshot: null, baseUnitSnapshot: '支', person: 'historical display', time: '2026-01-01T00:00:00Z' });
}
export const stockCommand = (action, key = 'submit', revision = 0, changes = {}) => ({
  operationKey: key, expectedRevision: revision, action,
  payload: { product: stockProduct(action), count: 17, reason: 'synthetic stock check',
    ...(action === 'consumableStock' ? { opened: 2 } : {}), ...changes }
});
