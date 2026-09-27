import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CATALOG, cloneCatalog, mergeCatalog, findProduct, roomPackage, saleOption, inventoryProducts, consumableProducts, migrateLegacyOrderPricing } from './catalog.js';

test('默认目录使用稳定商品 ID、销售规格和基础库存单位', () => {
  const bw = findProduct(DEFAULT_CATALOG, 'bw');
  assert.equal(bw.id, 'bw');
  assert.equal('sku' in bw, false);
  assert.equal(bw.baseUnit, '支');
  assert.deepEqual(saleOption(bw, 'dozen'), { id: 'dozen', name: '整打', baseQuantity: 12, priceCents: 11800 });
  assert.equal(inventoryProducts(DEFAULT_CATALOG).some(item => item.id === 'bw'), true);
  assert.equal(consumableProducts(DEFAULT_CATALOG).some(item => item.id === 'cons_nuts'), true);
});

test('套餐表达选择范围和实际基础数量，不保存套餐级库存开关', () => {
  const night = roomPackage(DEFAULT_CATALOG, '大房', 'night');
  assert.equal(night.openingGift.allowedProductIds.includes('bw'), true);
  assert.equal(night.openingGift.baseQuantityByProduct.bw, 24);
  assert.equal(night.openingGift.baseQuantityByProduct.lm, 20);
  assert.equal('affectsInventory' in night, false);
  assert.equal(night.components.some(component => component.kind === 'choice'), true);
});

test('迁移目录保留已保存的当前价格，不用默认价格覆盖', () => {
  const raw = cloneCatalog(DEFAULT_CATALOG);
  const rawBw = raw.products.find(item => item.id === 'bw');
  rawBw.saleOptions.find(option => option.id === 'dozen').priceCents = 12800;
  rawBw.sku = 'bw';
  raw.packages[0].affectsInventory = true;
  raw.products.push({ id: 'legacy-item', name: '历史项目', category: 'legacy', baseUnit: '份', saleOptions: [], inventoryManaged: false, sellable: false, active: false, sku: 'legacy-item' });
  const migrated = mergeCatalog(raw);
  assert.equal(saleOption(findProduct(migrated, 'bw'), 'dozen').priceCents, 12800);
  assert.equal('sku' in findProduct(migrated, 'bw'), false);
  assert.equal('affectsInventory' in migrated.packages[0], false);
  assert.equal(findProduct(migrated, 'legacy-item').name, '历史项目');
  assert.equal('sku' in findProduct(migrated, 'legacy-item'), false);
});

test('旧订单迁移保留历史成交金额，缺失价格与赠酒参考值保持未知', () => {
  const oldOrders = [{ base: 5000, gift: 11800, sales: [{ product: 'bw', spec: 'dozen', count: 1, bottles: 12, amount: 11800 }], bonusGifts: [{ product: 'bw', halves: 1, bottles: 6 }] }];
  const migrated = migrateLegacyOrderPricing(oldOrders)[0];
  assert.equal(migrated.sales[0].amountCents, 11800);
  assert.equal(migrated.sales[0].pricePerSaleUnitCents, null);
  assert.equal(migrated.sales[0].productNameSnapshot, null);
  assert.equal(migrated.bonusGifts[0].referenceValueCents, null);
  const changedCatalog = cloneCatalog(DEFAULT_CATALOG);
  saleOption(findProduct(changedCatalog, 'bw'), 'dozen').priceCents = 12800;
  assert.equal(migrated.sales[0].amountCents, 11800);
  assert.equal(saleOption(findProduct(changedCatalog, 'bw'), 'dozen').priceCents, 12800);
});
