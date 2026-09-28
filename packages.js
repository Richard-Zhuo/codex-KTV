// 房型套餐默认值构造。仅用于初始化、迁移和恢复演示数据；运行时唯一来源是 state.catalog。
// 语义冻结（Phase 3）：与原 catalog.js 中的套餐构造区逐字节一致。
const OPENING_GIFT_PRODUCTS = ['bw', 'xl', 'qd', 'redqd', 'lm', 'lm_can', 'jbw', 'drink'];
const MIXABLE_OPENING_PRODUCTS = ['drink0', 'drink1', 'drink2', 'drink3', 'bw', 'xl', 'qd', 'redqd', 'soda0', 'soda1', 'soda2', 'soda3', 'water'];
const HIGH_END_PRODUCTS = new Set(['lm', 'lm_can', 'jbw']);

const openingGiftQuantityByProduct = Object.fromEntries(
  OPENING_GIFT_PRODUCTS.map(id => [id, HIGH_END_PRODUCTS.has(id) ? 10 : 12])
);

const createRoomPackage = (id, name, roomType, period, basePriceCents, giftDozens, fruit, nuts, sortOrder) => {
  const includedValueCents = giftDozens * 11800;
  const packageValue = basePriceCents + includedValueCents;
  const openingGift = giftDozens ? {
    allowedProductIds: [...OPENING_GIFT_PRODUCTS],
    baseQuantityByProduct: Object.fromEntries(OPENING_GIFT_PRODUCTS.map(productId => [
      productId,
      openingGiftQuantityByProduct[productId] * giftDozens
    ])),
    mixedSelectionProductId: 'drink',
    mixedAllowedProductIds: [...MIXABLE_OPENING_PRODUCTS]
  } : null;
  return {
    id,
    name,
    kind: 'room-package',
    roomType,
    period,
    priceCents: packageValue,
    basePriceCents,
    includedValueCents,
    giftSaleQuantity: giftDozens,
    components: [
      ...(openingGift ? [{
        id: 'opening-drink',
        kind: 'choice',
        name: '开房赠饮',
        baseUnit: '支',
        allowedProductIds: [...openingGift.allowedProductIds],
        baseQuantityByProduct: { ...openingGift.baseQuantityByProduct },
        mixedSelectionProductId: openingGift.mixedSelectionProductId,
        mixedAllowedProductIds: [...openingGift.mixedAllowedProductIds]
      }] : []),
      { id: 'fruit', kind: 'fixed', productId: 'fruit', baseQuantity: fruit, baseUnit: '份' },
      { id: 'nuts', kind: 'fixed', productId: 'nuts', baseQuantity: nuts, baseUnit: '份' }
    ],
    openingGift,
    active: true,
    sortOrder
  };
};

export const DEFAULT_PACKAGES = [
  createRoomPackage('room.small.day', '小房白天纯唱', '小房', 'day', 6800, 0, 0, 0, 10),
  createRoomPackage('room.medium.day', '中房白天纯唱', '中房', 'day', 6800, 0, 0, 0, 20),
  createRoomPackage('room.large.day', '大房白天纯唱', '大房', 'day', 8800, 0, 0, 0, 30),
  createRoomPackage('room.vip.day', 'VIP房白天纯唱', 'VIP房', 'day', 10800, 0, 0, 0, 40),
  createRoomPackage('room.small.night', '小房夜间套餐', '小房', 'night', 5000, 1, 1, 1, 50),
  createRoomPackage('room.medium.night', '中房夜间套餐', '中房', 'night', 5000, 1, 1, 1, 60),
  createRoomPackage('room.large.night', '大房夜间套餐', '大房', 'night', 5400, 2, 1, 2, 70),
  createRoomPackage('room.vip.night', 'VIP房夜间套餐', 'VIP房', 'night', 8400, 2, 2, 2, 80)
];
