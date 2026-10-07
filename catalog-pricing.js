import { BusinessRejection } from './shared/business-error.js';
import { DAY_PRICE_PLAN, EXISTING_PRICE_PLAN } from './shared/business-session.js';

export const PRICE_CATEGORIES = Object.freeze(['ORDINARY_BEER', 'PREMIUM_BEER', 'BEVERAGE', 'OTHER']);
// One-time v1 catalog classification by stable ID, never by display name or
// historical transaction price. Unknown/custom products require explicit setup.
const legacyCategories = Object.freeze(Object.fromEntries([
  ...['bw', 'xl', 'qd', 'redqd'].map(id => [id, 'ORDINARY_BEER']),
  ...['lm', 'lm_can', 'jbw'].map(id => [id, 'PREMIUM_BEER']),
  ...['drink0', 'drink1', 'drink2', 'drink3'].map(id => [id, 'BEVERAGE'])
]));
export function priceCategory(value) {
  if (!PRICE_CATEGORIES.includes(value)) throw new BusinessRejection('商品价格分类无效');
  return value;
}
export function migratePriceCategory(product, version) {
  return { ...product, priceCategory: priceCategory(product.priceCategory ??
    (version < 2 ? legacyCategories[product.id] ?? 'OTHER' : 'OTHER')) };
}
export function pricedSaleOptions(product, pricePlanId = EXISTING_PRICE_PLAN) {
  if (![DAY_PRICE_PLAN, EXISTING_PRICE_PLAN].includes(pricePlanId)) throw new BusinessRejection('价格方案无效');
  const options = (product?.saleOptions ?? []).map(option => ({ ...option }));
  if (pricePlanId !== DAY_PRICE_PLAN) return options;
  const category = priceCategory(product?.priceCategory ?? 'OTHER');
  const priceCents = { ORDINARY_BEER: 10000, PREMIUM_BEER: 12000, BEVERAGE: 10000 }[category];
  if (!priceCents) return options;
  const dozen = options.find(option => option.id === 'dozen');
  if (dozen && dozen.baseQuantity !== 12) throw new BusinessRejection('白天场整打规格必须为12个基础单位');
  // Only a dozen has a new business price. Singles/halves remain unchanged.
  if (dozen) dozen.priceCents = priceCents;
  else options.push({ id: 'dozen', name: '整打', baseQuantity: 12, priceCents });
  return options;
}
