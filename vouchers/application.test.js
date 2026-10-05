import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformVoucherApplication } from './application.js';
import { FakePlatformVoucherGateway } from './gateways.js';
import { memoryVoucherFixture } from '../test-support/voucher-fixture.js';

test('claim is committed before provider call; timeout remains UNKNOWN and original key never redeems again', async () => {
  const f = memoryVoucherFixture();
  const gateway = new FakePlatformVoucherGateway({ outcomes: {
    redeemVoucher: async () => { assert.equal(f.active(), false); const e = Error('synthetic timeout'); e.code = 'ETIMEDOUT'; throw e; }
  } });
  const app = createPlatformVoucherApplication({allowTestGateway:true, store: f.store, gateway, voucherCodeSecret: Buffer.alloc(32, 9) });
  const c = { operationKey: 'consume-1', expectedRevision: 0, action: 'redeemVoucher', payload: { voucherCode: '0012345678901' } };
  const result = await app.execute(c, f.credential);
  assert.equal(result.status, 'UNKNOWN');
  assert.deepEqual(await app.execute(c, f.credential), result);
  assert.equal(gateway.calls.redeemVoucher, 1);
  const query = await app.execute({ operationKey: 'query-1', expectedRevision: 0, action: 'queryRedemption',
    payload: { redemptionId: result.redemptionId } }, f.credential);
  assert.equal(query.status, 'REDEEMED');
  assert.deepEqual(await app.execute(c, f.credential), result);
  assert.equal(gateway.calls.redeemVoucher, 1);
});

import { createTrustedProviderContext } from './application.js';
const consume = (key='consume-1', code='0012345678901', extras={}) =>
  ({ operationKey:key, expectedRevision:0, action:'redeemVoucher', payload:{ voucherCode:code,...extras } });
const make = (options={}) => {
  const f=memoryVoucherFixture(), gateway=new FakePlatformVoucherGateway(options);
  const app=createPlatformVoucherApplication({allowTestGateway:true,store:f.store,gateway,voucherCodeSecret:Buffer.alloc(32,9)});
  return {...f,gateway,app};
};
test('authorization denial has no attempt/provider effect; later grant can reuse key', async () => {
  const f=make(); f.auth.permissions=[];
  await assert.rejects(f.app.execute(consume(),f.credential),{code:'AUTHORIZATION_DENIED'});
  assert.equal(f.read().operations.size,0); assert.equal(f.read().redemptions.size,0);
  assert.equal(f.gateway.calls.inspectVoucher,0);
  f.auth.permissions=['room.open']; assert.equal((await f.app.execute(consume(),f.credential)).status,'REDEEMED');
});
test('replay requires valid original actor, uses immutable fingerprint and ignores forged payload authority', async () => {
  const f=make(), c=consume('one',undefined,{actorId:'forged',permissions:['*'],role:'boss',clock:'fake'});
  const original=await f.app.execute(c,f.credential); assert.equal(original.actorId,'synthetic-actor');
  f.auth.permissions=[]; assert.deepEqual(await f.app.execute(c,f.credential),original);
  await assert.rejects(f.app.execute(consume('new'),f.credential),{code:'AUTHORIZATION_DENIED'});
  f.auth.principalId='other'; assert.equal((await f.app.execute(c,f.credential)).reason,'actor-mismatch');
  f.auth.principalId='synthetic-actor';
  assert.equal((await f.app.execute({...c,expectedRevision:1},f.credential)).reason,'request-mismatch');
  assert.equal((await f.app.execute(consume('one','0012345678902'),f.credential)).reason,'request-mismatch');
  f.auth.enabled=false; await assert.rejects(f.app.execute(c,f.credential),{code:'AUTHENTICATION_REQUIRED'});
  f.auth.enabled=true; f.auth.revoked=true;
  await assert.rejects(f.app.execute(c,f.credential),{code:'AUTHENTICATION_REQUIRED'});
  assert.equal(f.gateway.calls.redeemVoucher,1);
});
test('concurrent same code uses one provider attempt even with different operation keys', async () => {
  let release, entered;const reached=new Promise(r=>entered=r), gate=new Promise(r=>release=r);
  const f=make({outcomes:{redeemVoucher:async(input,g)=>{entered();await gate;return g.facts.get(input.providerRequestId);}}});
  const first=f.app.execute(consume('a'),f.credential); await reached;
  const second=await f.app.execute(consume('b'),f.credential);
  assert.equal(second.status,'REDEEMING'); release();
  assert.equal((await first).status,'REDEEMED'); assert.equal(f.gateway.calls.redeemVoucher,1);
  assert.equal(f.read().redemptions.size,1);
});
test('unknown uncorrelated result and failed query never become FAILED without definitive provider evidence', async () => {
  const f=make({outcomes:{redeemVoucher:async input=>({...input,status:'REDEEMED',providerFlowId:'flow',providerRequestId:'wrong'}),
    queryRedemption:async()=>{throw Error('timeout');}}});
  const original=await f.app.execute(consume(),f.credential); assert.equal(original.status,'UNKNOWN');
  const query={operationKey:'query',expectedRevision:0,action:'queryRedemption',payload:{redemptionId:original.redemptionId}};
  assert.equal((await f.app.execute(query,f.credential)).status,'UNKNOWN');
  f.gateway.outcomes.queryRedemption=async input=>({...input,status:'FAILED',definitive:true});
  assert.equal((await f.app.execute({...query,operationKey:'known-query'},f.credential)).status,'FAILED');
  assert.deepEqual(await f.app.execute(consume(),f.credential),original);
  assert.equal(f.gateway.calls.redeemVoucher,1);
});
test('definitive rejection and a different store never create successful redemption', async () => {
  const f=make({outcomes:{redeemVoucher:async input=>({...input,status:'FAILED',definitive:true})}});
  assert.equal((await f.app.execute(consume(),f.credential)).status,'FAILED');
  const wrong=make({storeId:'another-store'});
  assert.equal((await wrong.app.execute(consume(),wrong.credential)).status,'FAILED');
  assert.equal(wrong.gateway.calls.redeemVoucher,0);
});
test('provider messages are deduplicated; terminal reversal/refund does not rewrite a linked business order', async t => {
  for(const status of ['REVERSED','REFUNDED'])await t.test(status,async()=>{
    const f=make(), r=await f.app.execute(consume(),f.credential);
    await f.store.runAtomic(async tx=>{const row=await tx.getRedemption(r.redemptionId); await tx.writeRedemption({...row,linkedOrderId:'existing-order'},row.version);});
    const row=f.read().redemptions.get(r.redemptionId);
    const event={externalMessageId:'business-id',providerEnvelopeMessageId:'envelope-id',
      eventType:status,externalOrderId:row.externalOrderId};
    const provider=createTrustedProviderContext({provider:'meituan',storeId:'synthetic-store'});
    const result=await f.app.receiveProviderEvent(event,provider);
    assert.equal(result.processingStatus,'processed');
    assert.deepEqual(await f.app.receiveProviderEvent(event,provider),result);
    assert.equal(f.read().exceptions.length,1);
    assert.equal(f.read().redemptions.get(r.redemptionId).linkedOrderId,'existing-order');
    await f.app.receiveProviderEvent({...event,externalMessageId:'late',eventType:'REDEEMED',providerFlowId:row.providerFlowId},provider);
    assert.equal(f.read().redemptions.get(r.redemptionId).status,status);
    assert.equal(f.read().events.size,2); assert.equal(f.read().exceptions.length,2);
    await assert.rejects(f.app.receiveProviderEvent(event,{provider:'meituan',storeId:'synthetic-store'}));
    await assert.rejects(f.app.receiveProviderEvent({...event,eventType:'REDEEMED'},provider),{code:'PROVIDER_EVENT_ID_CONFLICT'});
  });
});
test('reconciliation-required event preserves current record instead of inventing redemption evidence', async () => {
  const f=make(), r=await f.app.execute(consume(),f.credential), row=f.read().redemptions.get(r.redemptionId);
  const provider=createTrustedProviderContext({provider:'meituan',storeId:'synthetic-store'});
  const event={externalMessageId:'unknown-order',eventType:'REDEEMED',externalOrderId:'not-correlated'};
  assert.equal((await f.app.receiveProviderEvent(event,provider)).processingStatus,'reconciliation-required');
  assert.deepEqual(f.read().redemptions.get(r.redemptionId),row);
});
test('stale revision is terminal, while program/SQL failures before claim roll back and call no provider', async () => {
  const f=make(), c={...consume(),expectedRevision:1};
  const rejected=await f.app.execute(c,f.credential); assert.equal(rejected.status,'revision-conflict');
  assert.deepEqual(await f.app.execute(c,f.credential),rejected);
  assert.equal(f.gateway.calls.redeemVoucher,0);
  const original=f.store.runAtomic;
  f.store.runAtomic=work=>original(async tx=>{await work(tx);throw Error('synthetic database failure');});
  await assert.rejects(f.app.execute(consume('fault'),f.credential));
  assert.equal(f.read().redemptions.size,0);
  assert.equal(f.read().operations.has('fault'),false);
  f.store.runAtomic=original;
  assert.equal((await f.app.execute(consume('fault'),f.credential)).status,'REDEEMED');
});

test('Fake gateway cannot be selected as an implicit production implementation', () => {
  const f=memoryVoucherFixture(), options={store:f.store,gateway:new FakePlatformVoucherGateway(),voucherCodeSecret:Buffer.alloc(32,9)};
  assert.throws(()=>createPlatformVoucherApplication(options), /explicit test mode/);
  assert.throws(()=>createPlatformVoucherApplication({...options,allowTestGateway:true,store:{...f.store,testOnly:false}}), /isolated test store/);
});
test('unparseable inspection and invalid provider time are UNKNOWN, not definite rejection', async () => {
  const empty=make({outcomes:{inspectVoucher:async()=>null}});
  assert.equal((await empty.app.execute(consume(),empty.credential)).status,'UNKNOWN');
  assert.equal(empty.gateway.calls.redeemVoucher,0);
  const invalid=make({outcomes:{redeemVoucher:async(input,g)=>({...g.facts.get(input.providerRequestId),redeemedAt:'2026-10-05T20:00:00+08:00'})}});
  assert.equal((await invalid.app.execute(consume(),invalid.credential)).status,'UNKNOWN');
});
test('business fingerprint is independent of key order and command snapshot cannot change while claim awaits', async () => {
  const f=make(), c=consume('stable',undefined,{extra:{a:1,b:2}});
  const saved=await f.app.execute(c,f.credential);
  const reordered={action:c.action,payload:{extra:{b:2,a:1},voucherCode:c.payload.voucherCode},expectedRevision:0,operationKey:c.operationKey};
  assert.deepEqual(await f.app.execute(reordered,f.credential),saved);
  const bad=consume('cycle');bad.payload.self=bad.payload;
  await assert.rejects(f.app.execute(bad,f.credential),TypeError);
  assert.equal(f.read().operations.has('cycle'),false);
  const f2=make(), changing=consume('snapshot');
  const frozen=structuredClone(changing), promise=f2.app.execute(changing,f2.credential);
  changing.payload.voucherCode='9999999999999';changing.action='queryRedemption';
  const original=await promise;
  assert.deepEqual(await f2.app.execute(frozen,f2.credential),original);
  assert.equal(f2.gateway.calls.redeemVoucher,1);
});
