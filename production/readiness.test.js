import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProductionConfig } from './config.js';
import { catalogReadiness,mappingReadiness,productionApiGate } from './readiness.js';
import { validateMappingPlan } from './mapping.js';
import { initialState } from '../rules.js';
import { assertFixtureEnvironment } from '../test-support/destructive-safety.js';
import { acquireMySqlFixtureLock } from '../test-support/mysql-fixture-lock.js';
import { applyPolicyAttributeMigration } from '../test-support/mysql-policy-attributes-fixture.js';
import { createHttpApiFromEnv } from '../http/bootstrap.js';
const env={NODE_ENV:'production',KTV_HTTP_ENV:'production',KTV_API_MODE:'enabled',KTV_STORE_ID:'synthetic-store',KTV_LEDGER_ID:'synthetic-ledger',KTV_BUSINESS_TIME_ZONE:'Asia/Shanghai',KTV_MYSQL_URL:'mysql://synthetic:nonlive@127.0.0.1/synthetic_production',KTV_PUBLIC_ORIGIN:'https://synthetic.invalid',KTV_BUSINESS_DATE_CUTOFF:'12:00',KTV_SESSION_RULE_VERSION:'opening-hours-v1',DEVICE_CONTROL_MODE:'disabled',KTVSKY_LIVE_CONTROL_ENABLED:'false'};
test('production config preserves explicit timezone, noon cutoff, session rules and OFF gate',()=>{
  const c=validateProductionConfig(env);assert.equal(c.timeZone,'Asia/Shanghai');assert.equal(c.businessCutoff,'12:00');assert.equal(c.liveControlEnabled,false);
  assert.equal(c.sessions.DAY,'14:00–18:00');assert.equal(c.sessions.NIGHT,'18:00–02:00');
  assert.equal(JSON.stringify(c).includes('nonlive'),false);
});
test('production startup rejects invalid or incomplete config before connecting',()=>{
  const patches=[{KTV_BUSINESS_TIME_ZONE:'Unknown/Zone'},{KTV_BUSINESS_TIME_ZONE:''},{KTV_MYSQL_URL:''},{KTV_MYSQL_URL:'mysql://u:p@localhost/jbhh_ktv_test'},{KTV_MYSQL_URL:'mysql://u@localhost/live'},{DEVICE_CONTROL_MODE:'guess'},{KTVSKY_LIVE_CONTROL_ENABLED:'true'},{KTVSKY_LIVE_CONTROL_ENABLED:undefined},{KTV_BUSINESS_DATE_CUTOFF:'02:00'},{KTV_SESSION_RULE_VERSION:'unknown'},{KTV_API_MODE:'disabled'},{KTV_INSECURE_COOKIE:'true'},{KTV_PUBLIC_ORIGIN:'http://store.invalid'},{KTV_HTTP_ENV:'development'}];
  for(const patch of patches)assert.throws(()=>validateProductionConfig({...env,...patch}));
  assert.throws(()=>createHttpApiFromEnv({NODE_ENV:'production'}));
});
test('catalog readiness reports exact DAY half/dozen, unchanged singles and null inventory',()=>{
  const state=initialState(),before=JSON.stringify(state),r=catalogReadiness(state);
  for(const p of r.products.filter(p=>p.sellable&&['ORDINARY_BEER','BEVERAGE','PREMIUM_BEER'].includes(p.priceCategory))) {
    const dozen=p.priceCategory==='PREMIUM_BEER'?12000:10000;
    assert.equal(p.day.find(o=>o.id==='dozen').priceCents,dozen);assert.equal(p.day.find(o=>o.id==='half').priceCents,dozen/2);
    assert.equal(p.day.find(o=>o.id==='single').priceCents,p.night.find(o=>o.id==='single').priceCents);
  }
  assert.ok(r.blockers.some(b=>b.code==='OPENING_INVENTORY_REQUIRED'));assert.equal(JSON.stringify(state),before);
  for(const stock of [...Object.values(state.inventory),...Object.values(state.consumables)])stock.count=0;
  assert.equal(catalogReadiness(state).blockers.length,0);
});
test('missing catalog classification, options and invalid DAY option block readiness without guesses',()=>{
  const state=initialState(),p=state.catalog.products.find(p=>p.id==='bw');
  delete p.priceCategory;assert.ok(catalogReadiness(state).blockers.some(b=>b.code==='PRICE_CATEGORY_MISSING_OR_UNKNOWN'));
  p.priceCategory='unknown';assert.ok(catalogReadiness(state).blockers.some(b=>b.code==='PRICE_CATEGORY_MISSING_OR_UNKNOWN'));
  p.priceCategory='ORDINARY_BEER';p.saleOptions=[];assert.ok(catalogReadiness(state).blockers.some(b=>b.code==='SALE_OPTIONS_MISSING'));
  p.saleOptions=[{id:'dozen',baseQuantity:11,priceCents:10000}];assert.ok(catalogReadiness(state).blockers.some(b=>b.code==='DAY_PRICE_INCOMPLETE'));
});
test('required mappings need explicit confirmation and enabled target; report masks device IDs',()=>{
  const rooms=[{id:'V01'},{id:'V06'}],rows=[{internal_room_id:'V06',provider:'ktvsky',external_device_id:'synthetic-device-674B',enabled:1}];
  assert.equal(mappingReadiness(rooms,rows,[],true).blockers.length,2);
  const facts=[{internalRoomId:'V06',provider:'ktvsky',externalDeviceId:'synthetic-device-674B',enabled:true,source:'human-confirmed'}];
  const r=mappingReadiness(rooms,rows,facts,true);assert.equal(r.blockers.length,1);assert.equal(r.checklist[1].status,'CONFIRMED_ENABLED');
  assert.equal(JSON.stringify(r).includes('synthetic-device-674B'),false);
});
test('mapping input rejects guesses, duplicate devices and unknown provider',()=>{
  const m={internalRoomId:'V06',provider:'ktvsky',externalDeviceId:'synthetic',enabled:false,source:'human-confirmed',confirmedAt:'2026-10-08T00:00:00Z',confirmedBy:'synthetic-operator'};
  const p={configVersion:'v1',environment:'test',database:'jbhh_ktv_test',storeId:'s',ledgerId:'l',approved:false,mappings:[m]};
  validateMappingPlan(p);
  assert.throws(()=>validateMappingPlan({...p,mappings:[{...m,source:'guessed'}]}));
  assert.throws(()=>validateMappingPlan({...p,mappings:[m,{...m,internalRoomId:'V01'}]}));
  assert.throws(()=>validateMappingPlan({...p,mappings:[{...m,provider:'unknown'}]}));
});
test('readiness gate blocks all API writes and worker on blockers or exceptions, with safe diagnostics',async()=>{
  for(const read of [async()=>({ready:false,blockers:[{code:'ROOM_MAPPING_REQUIRED'}]}),async()=>{throw Error('sensitive SQL detail');}]) {
    let executed=0,started=0,body='',status=0;const logged=[];
    const gate=productionApiGate({handle:()=>{executed++;return true;}},read,{logger:{error:e=>logged.push(e)},start:()=>started++});
    assert.equal(await gate.handle({url:'/api/v1/commands/open'},{writeHead:s=>status=s,end:b=>body=b}),true);
    assert.equal(status,503);assert.equal(JSON.parse(body).error.code,'service_unavailable');assert.equal(executed,0);assert.equal(started,0);
    assert.equal(JSON.stringify(logged).includes('sensitive SQL detail'),false);
  }
});
test('successful readiness starts worker once and delegates authenticated API',async()=>{
  let started=0,executed=0;
  const gate=productionApiGate({handle:async()=>{executed++;return true;}},async()=>({ready:true}),{start:()=>started++});
  await gate.handle({url:'/api/v1/auth/session'},{});await gate.handle({url:'/api/v1/store/snapshot'},{});
  assert.equal(started,1);assert.equal(executed,2);
});
test('production destructive fixture guards run before any SQL',async()=>{
  for(const key of ['NODE_ENV','KTV_HTTP_ENV','KTV_DEPLOYMENT_ENV'])assert.throws(()=>assertFixtureEnvironment({[key]:'production'}),{code:'PRODUCTION_FIXTURE_DENIED'});
  assertFixtureEnvironment({NODE_ENV:'test'});
  const before=process.env.NODE_ENV;process.env.NODE_ENV='production';
  let sql=0;const c={query:async()=>{sql++;},execute:async()=>{sql++;}};
  try{
    await assert.rejects(acquireMySqlFixtureLock(c),{code:'PRODUCTION_FIXTURE_DENIED'});
    await assert.rejects(applyPolicyAttributeMigration(c,[]),{code:'PRODUCTION_FIXTURE_DENIED'});
    assert.equal(sql,0);
  }finally{if(before===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=before;}
});
