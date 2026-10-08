// 目录默认值和纯目录 helper。
// 运行时业务必须使用 state.catalog；DEFAULT_CATALOG 只用于初始化、迁移和恢复演示数据。
// 套餐默认值构造在 packages.js；旧订单价格迁移在 migrations.js（目录不迁移订单）。
import { BusinessRejection } from './shared/business-error.js';
import { migratePriceCategory } from './catalog-pricing.js';
import { DEFAULT_PACKAGES } from './packages.js';

const createSaleOptions = (single, half, dozen) => [
  { id: 'single', name: '单支', baseQuantity: 1, priceCents: single },
  ...(half === null || half === undefined ? [] : [{ id: 'half', name: '半打', baseQuantity: 6, priceCents: half }]),
  ...(dozen === null || dozen === undefined ? [] : [{ id: 'dozen', name: '整打', baseQuantity: 12, priceCents: dozen }])
];

const beer = (id, name, sortOrder, single, half, dozen, exchangeLevel, openingGiftEligible = true) => ({
  id,
  name,
  category: 'beer',
  categoryLabel: '啤酒',
  baseUnit: '支',
  saleOptions: createSaleOptions(single, half, dozen),
  inventoryManaged: true,
  inventoryThreshold: 250,
  sellable: true,
  manualPriceAllowed: false,
  exchangeLevel,
  openingGiftEligible,
  active: true,
  sortOrder
});

const singleProduct = (id, name, category, categoryLabel, sortOrder, priceCents, exchangeLevel, options = {}) => ({
  id,
  name,
  category,
  categoryLabel,
  baseUnit: '支',
  saleOptions: createSaleOptions(priceCents, null, null),
  inventoryManaged: true,
  inventoryThreshold: 10,
  sellable: true,
  manualPriceAllowed: false,
  exchangeLevel,
  openingGiftEligible: false,
  active: true,
  sortOrder,
  ...options
});

export const DEFAULT_CATALOG = {
  schemaVersion: 2,
  products: [
    beer('bw', '百威', 10, 1000, 5900, 11800, 2),
    beer('xl', '喜力', 20, 1000, 5900, 11800, 2),
    beer('qd', '青岛', 30, 1000, 5900, 11800, 2),
    beer('redqd', '红青岛', 40, 1000, 5900, 11800, 2),
    beer('lm', '蓝妹', 50, 1150, 6900, 13800, 1),
    beer('lm_can', '蓝妹（罐装）', 60, 1150, 6900, 13800, 1),
    beer('jbw', '黑金百威', 70, 1150, 6900, 13800, 1),
    {
      id: 'drink',
      name: '饮料',
      category: 'drink-choice',
      categoryLabel: '饮料选择',
      baseUnit: '支',
      saleOptions: [],
      inventoryManaged: false,
      inventoryThreshold: 10,
      sellable: false,
      manualPriceAllowed: false,
      exchangeLevel: 2,
      openingGiftEligible: true,
      active: true,
      sortOrder: 80,
      selectionOnly: true
    },
    singleProduct('drink0', '王老吉', 'drink', '饮料', 90, 1000, 2),
    singleProduct('drink1', '马蹄爽', 'drink', '饮料', 100, 1000, 2),
    singleProduct('drink2', '椰汁', 'drink', '饮料', 110, 1000, 2),
    singleProduct('drink3', '柠檬茶', 'drink', '饮料', 120, 1000, 2),
    singleProduct('soda0', '可口可乐', 'soda', '汽水', 130, 600, 3),
    singleProduct('soda1', '百事可乐', 'soda', '汽水', 140, 600, 3),
    singleProduct('soda2', '雪碧', 'soda', '汽水', 150, 600, 3),
    singleProduct('soda3', '芬达', 'soda', '汽水', 160, 600, 3),
    singleProduct('water', '瓶装水', 'water', '瓶装水', 170, 200, 4),
    {
      id: 'fruit',
      name: '果盘',
      category: 'package-component',
      categoryLabel: '套餐配品',
      baseUnit: '份',
      saleOptions: [],
      inventoryManaged: false,
      sellable: false,
      manualPriceAllowed: false,
      exchangeLevel: null,
      openingGiftEligible: false,
      active: true,
      sortOrder: 900,
      kind: 'package-component'
    },
    {
      id: 'nuts',
      name: '花生瓜子',
      category: 'package-component',
      categoryLabel: '套餐配品',
      baseUnit: '份',
      saleOptions: [],
      inventoryManaged: false,
      sellable: false,
      manualPriceAllowed: false,
      exchangeLevel: null,
      openingGiftEligible: false,
      active: true,
      sortOrder: 910,
      kind: 'package-component'
    },
    {
      id: 'cons_nuts',
      name: '瓜子',
      category: 'consumable',
      categoryLabel: '消耗品',
      baseUnit: '包',
      saleOptions: [],
      inventoryManaged: true,
      inventoryThreshold: 2,
      sellable: false,
      manualPriceAllowed: false,
      exchangeLevel: null,
      openingGiftEligible: false,
      active: true,
      sortOrder: 1000,
      kind: 'consumable'
    },
    {
      id: 'cons_ice',
      name: '冰块',
      category: 'consumable',
      categoryLabel: '消耗品',
      baseUnit: '袋',
      saleOptions: [],
      inventoryManaged: true,
      inventoryThreshold: 2,
      sellable: false,
      manualPriceAllowed: false,
      exchangeLevel: null,
      openingGiftEligible: false,
      active: true,
      sortOrder: 1010,
      kind: 'consumable'
    },
    {
      id: 'cons_tissue',
      name: '纸巾',
      category: 'consumable',
      categoryLabel: '消耗品',
      baseUnit: '包',
      saleOptions: [],
      inventoryManaged: true,
      inventoryThreshold: 5,
      sellable: false,
      manualPriceAllowed: false,
      exchangeLevel: null,
      openingGiftEligible: false,
      active: true,
      sortOrder: 1020,
      kind: 'consumable'
    },
    {
      id: 'cons_straw',
      name: '吸管',
      category: 'consumable',
      categoryLabel: '消耗品',
      baseUnit: '包',
      saleOptions: [],
      inventoryManaged: true,
      inventoryThreshold: 2,
      sellable: false,
      manualPriceAllowed: false,
      exchangeLevel: null,
      openingGiftEligible: false,
      active: true,
      sortOrder: 1030,
      kind: 'consumable'
    }
  ].map(item => migratePriceCategory(item, 1)),
  packages: DEFAULT_PACKAGES
};

export function cloneCatalog(catalog = DEFAULT_CATALOG) {
  return structuredClone(catalog);
}

function mergeItems(defaultItems, rawItems) {
  const rawById = new Map((Array.isArray(rawItems) ? rawItems : []).filter(item => item && item.id).map(item => [item.id, item]));
  const merged = defaultItems.map(defaultItem => {
    const raw = rawById.get(defaultItem.id);
    if (!raw) return structuredClone(defaultItem);
    const next = { ...structuredClone(defaultItem), ...structuredClone(raw) };
    delete next.affectsInventory;
    delete next.sku;
    if (Array.isArray(raw.saleOptions)) next.saleOptions = raw.saleOptions.map(option => ({ ...option }));
    if (Array.isArray(raw.components)) next.components = raw.components.map(component => ({ ...component }));
    if (raw.openingGift) next.openingGift = structuredClone(raw.openingGift);
    rawById.delete(defaultItem.id);
    return next;
  });
  const extras = [...rawById.values()].map(item => {
    const next = structuredClone(item);
    delete next.affectsInventory;
    delete next.sku;
    return next;
  });
  return [...merged, ...extras];
}

export function mergeCatalog(raw) {
  if (!raw || typeof raw !== 'object') return cloneCatalog(DEFAULT_CATALOG);
  // Classify raw facts before defaults can fill a missing v2 category.
  // Only v1 records may inherit the explicit stable-ID migration mapping.
  const products = (Array.isArray(raw.products) ? raw.products : []).filter(item => item && item.id)
    .map(item => migratePriceCategory(item, Number(raw.schemaVersion || 1)));
  return {
    schemaVersion: 2,
    products: mergeItems(DEFAULT_CATALOG.products, products),
    packages: mergeItems(DEFAULT_CATALOG.packages, raw.packages)
  };
}

export function assertCatalogPackagePrices(catalog) {
  for (const item of catalog?.packages || []) {
    const base = item?.basePriceCents, included = item?.includedValueCents, price = item?.priceCents;
    if (![base, included, price].every(value => Number.isSafeInteger(value) && value >= 0) || price !== base + included) {
      throw new BusinessRejection(`套餐 ${item?.id || '未知'} 价格不一致，已停止使用`);
    }
  }
}

export function findProduct(catalog, id) {
  const source = catalog?.products || DEFAULT_CATALOG.products;
  const item = source.find(product => product.id === id);
  if (!item) throw new BusinessRejection('商品不存在');
  return item;
}

export function findPackage(catalog, id) {
  const source = catalog?.packages || DEFAULT_CATALOG.packages;
  const item = source.find(packageItem => packageItem.id === id);
  if (!item) throw new BusinessRejection('套餐不存在');
  return item;
}

export function roomPackage(catalog, roomType, period) {
  const item = (catalog?.packages || DEFAULT_CATALOG.packages).find(packageItem => packageItem.roomType === roomType && packageItem.period === period && packageItem.active !== false);
  if (!item) throw new BusinessRejection('当前房型没有可用套餐');
  return item;
}

export function saleOptions(product) {
  return Array.isArray(product?.saleOptions) ? product.saleOptions.filter(option => Number.isSafeInteger(option.priceCents) && option.priceCents >= 0 && Number.isSafeInteger(option.baseQuantity) && option.baseQuantity > 0) : [];
}

export function saleOption(product, id = 'single') {
  const option = saleOptions(product).find(item => item.id === id);
  if (!option) throw new BusinessRejection('该商品不支持所选销售规格');
  return option;
}

export function inventoryProducts(catalog) {
  return (catalog?.products || DEFAULT_CATALOG.products).filter(product => product.inventoryManaged && product.kind !== 'consumable');
}

export function consumableProducts(catalog) {
  return (catalog?.products || DEFAULT_CATALOG.products).filter(product => product.kind === 'consumable');
}

export function sellableProducts(catalog) {
  return (catalog?.products || DEFAULT_CATALOG.products).filter(product => product.sellable && product.active !== false && saleOptions(product).length);
}

export function categoryLabel(product) {
  return product?.categoryLabel || product?.category || '未分类';
}

export function productIdOf(record) {
  return record?.productId || record?.product || '';
}

// 商品查询包装：按当前 state.catalog 查找商品（原 rules.js 定义，Phase 3 迁入目录模块）。
export const product = (id, catalog = DEFAULT_CATALOG) => findProduct(catalog, id);

// 旧订单只补充可从原记录确定的金额和数量；缺失的历史商品元数据与参考价值保持未知，绝不读取迁移当天的当前售价。
// migrateLegacyOrderPricing 已迁至 migrations.js（Phase 3：目录不迁移订单）。

