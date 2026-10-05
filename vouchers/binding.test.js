import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransactionBoundVoucherBinding } from './binding.js';
const id='20000000-0000-4000-8000-000000000001';
const record=()=>({id,ledgerId:'l',provider:'meituan',storeId:'s',status:'REDEEMED',version:2,
  providerFlowId:'provider-flow',productId:'provider-product',productNameSnapshot:'Original provider name',linkedOrderId:null});
const mapping=[{productId:'provider-product',packageIds:['medium-night']}];
function fixture(row=record()){
  let saved;const calls=[];
  const port={lockRedemption:async value=>{calls.push('lock');assert.equal(value,id);return row;},
    writeRedemption:async(next,version)=>{calls.push('write');assert.equal(version,row.version);saved=next;}};
  const binding=createTransactionBoundVoucherBinding({port,ledgerId:'l',provider:'meituan',storeId:'s',packageMappings:mapping});
  return{binding,calls,saved:()=>saved};
}
test('voucher binding port locks caller row, returns trusted proof and links one stable order without transaction management',async()=>{
 const f=fixture(),proof=await f.binding.lockForOpen({redemptionId:id});
 assert.equal(proof.redemptionId,id);assert.equal(proof.providerFlowId,'provider-flow');
 assert.deepEqual(proof.allowedPackageIds,['medium-night']);assert.ok(Object.isFrozen(proof));assert.ok(Object.isFrozen(proof.allowedPackageIds));
 await f.binding.linkToOrder({redemptionId:id,orderId:'D1'});
 assert.deepEqual(f.calls,['lock','write']);assert.equal(f.saved().linkedOrderId,'D1');assert.equal(f.saved().status,'REDEEMED');
});
test('only REDEEMED current-store unlinked business evidence can bind',async()=>{
 for(const change of [{status:'PENDING'},{status:'REDEEMING'},{status:'FAILED'},{status:'UNKNOWN'},{status:'REVERSED'},{status:'REFUNDED'},
  {storeId:'other'},{ledgerId:'other'},{provider:'douyin'},{linkedOrderId:'already'},{providerFlowId:null}]){
  const f=fixture({...record(),...change});await assert.rejects(f.binding.lockForOpen({redemptionId:id}));assert.equal(f.saved(),undefined);
 }
 await assert.rejects(fixture(null).binding.lockForOpen({redemptionId:id}));
});
test('provider product never maps by name or automatic equality; absent explicit mapping fails closed',async()=>{
 const f=fixture({...record(),productId:'unknown',productNameSnapshot:'medium-night'});
 await assert.rejects(f.binding.lockForOpen({redemptionId:id}),{code:'AUTHORIZATION_DENIED'});
 await assert.rejects(f.binding.linkToOrder({redemptionId:id,orderId:'D1'}));assert.equal(f.saved(),undefined);
});
