import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneCatalog, findProduct, mergeCatalog } from './catalog.js';
import { pricedSaleOptions, priceCategory } from './catalog-pricing.js';
import { DAY_PRICE_PLAN, EXISTING_PRICE_PLAN } from './shared/business-session.js';
import { migrateLegacyOrderPricing } from './migrations.js';
for(const [id,cents] of [['bw',10000],['xl',10000],['lm',12000],['lm_can',12000],['drink0',10000],['drink3',10000]])
 test('DAY stable category dozen price '+id,()=>{
  const p=findProduct(cloneCatalog(),id);p.name='Renamed arbitrary product';
  const options=pricedSaleOptions(p,DAY_PRICE_PLAN);
  assert.deepEqual(options.find(o=>o.id==='dozen'),{id:'dozen',name:'整打',baseQuantity:12,priceCents:cents});
  for(const o of p.saleOptions.filter(o=>o.id!=='dozen'))assert.deepEqual(options.find(x=>x.id===o.id),o);
 });
test('catalog v1 migration classifies by IDs, preserves current prices and custom explicit category',()=>{
 const c=cloneCatalog();c.schemaVersion=1;for(const p of c.products)delete p.priceCategory;
 c.products.find(p=>p.id==='bw').saleOptions[2].priceCents=12500;
 c.products.push({id:'custom',name:'百威',priceCategory:'OTHER',saleOptions:[]});
 const next=mergeCatalog(c);assert.equal(next.schemaVersion,2);
 assert.equal(findProduct(next,'bw').priceCategory,'ORDINARY_BEER');
 assert.equal(findProduct(next,'custom').priceCategory,'OTHER');
 for(const p of c.products)assert.deepEqual(pricedSaleOptions(findProduct(next,p.id),EXISTING_PRICE_PLAN),p.saleOptions);
 assert.deepEqual(mergeCatalog(next),next);
 assert.throws(()=>priceCategory('guessed'));
});
test('non-DAY and OTHER prices, historical unit prices and amounts never migrate to DAY prices',()=>{
 const c=cloneCatalog();for(const p of c.products)assert.deepEqual(pricedSaleOptions(p),p.saleOptions);
 const water=findProduct(c,'water');assert.deepEqual(pricedSaleOptions(water,DAY_PRICE_PLAN),water.saleOptions);
 const records=[{sales:[{product:'bw',spec:'dozen',count:1,bottles:12,amount:11800,pricePerSaleUnitCents:11800,pricePlanId:EXISTING_PRICE_PLAN}]}];
 const migrated=migrateLegacyOrderPricing(records);assert.equal(migrated[0].sales[0].pricePerSaleUnitCents,11800);
 assert.equal(migrated[0].sales[0].pricePlanId,EXISTING_PRICE_PLAN);assert.equal(records[0].sales[0].amount,11800);
});
