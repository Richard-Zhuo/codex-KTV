import test from 'node:test';
import assert from 'node:assert/strict';
const previousWindow=globalThis.window;globalThis.window??={addEventListener(){}};
const {buildFinancialIntent,financialStatus}=await import('./financial.js');
if(previousWindow===undefined)delete globalThis.window;
const source=()=>({capabilities:{refundPayment:{allowed:true,mode:'REQUEST'},reversePayment:{allowed:true,mode:'REQUEST'},cashOut:{allowed:true,mode:'DIRECT'},cancelOrder:{allowed:true,mode:'DIRECT'}},
 payments:[{paymentId:'payment-a',orderId:'order-a',amount:12345,method:'\u73b0\u91d1',occurredAt:'2026-10-19T12:00:00Z'}],orders:[{id:'order-a',room:'V01'}],requests:[]});
test('C3-B UI: decimal yuan becomes exact integer cents and request is not actual execution',()=>{
 const f=source(),before=structuredClone(f),i=buildFinancialIntent(f,'refundPayment',{paymentId:'payment-a',amount:'12.34',reason:'Customer return',refundChannel:'\u5fae\u4fe1'});
 assert.equal(i.payload.amount,1234);assert.equal(i.payload.refundFundingSource,'NON_CASH');assert.equal(i.actual,false);assert.deepEqual(f,before);
});
test('C3-B UI: approval and execution statuses cannot be conflated',()=>{
 assert.equal(financialStatus('\u5df2\u6279\u51c6'),'\u5df2\u6279\u51c6\uff0c\u5f85\u5b9e\u9645\u6267\u884c');
 assert.equal(financialStatus('\u5df2\u6267\u884c'),'\u5df2\u6267\u884c\u5b8c\u6210');
});

test('C3-B UI: invalid yuan amounts reject rather than round or truncate',()=>{
 for(const amount of ['0','-1','1.001','1e2','NaN','9007199254740992']){
  assert.throws(()=>buildFinancialIntent(source(),'cashOut',{amount,reason:'Actual withdrawal'}));
 }
});
test('C3-B UI: reversal uses full original amount and explicitly is not a customer refund',()=>{
 const i=buildFinancialIntent(source(),'reversePayment',{paymentId:'payment-a',amount:'1',reason:'Wrong record'});
 assert.equal(i.payload.amount,12345);assert.equal(i.payload.refundChannel,undefined);
 const direct=source();direct.capabilities.reversePayment.mode='DIRECT';
 const actual=buildFinancialIntent(direct,'reversePayment',{paymentId:'payment-a',reason:'Wrong record'});
 assert.equal(actual.actual,true);assert.match(actual.confirmation,/\u4e0d\u4ee3\u8868\u5df2\u5411\u987e\u5ba2\u9000\u6b3e/);
});
test('C3-B UI: direct cashOut and cancellation require explicit manual confirmation, never infer final eligibility',()=>{
 const cash=buildFinancialIntent(source(),'cashOut',{amount:'20.01',reason:'Physical out'});
 assert.equal(cash.payload.amountCents,2001);assert.equal(cash.actual,true);assert.match(cash.confirmation,/\u5df2\u5b9e\u9645/);
 const f=source();f.orders[0].status='\u5df2\u7ed3\u6e05';
 const cancel=buildFinancialIntent(f,'cancelOrder',{order:'order-a',reason:'Ask server to validate'});
 assert.deepEqual(cancel.payload,{order:'order-a',reason:'Ask server to validate'});assert.equal(cancel.actual,true);
 assert.match(cancel.confirmation,/\u4e0d\u81ea\u52a8\u6062\u590d\u5e93\u5b58/);
});
test('C3-B UI: approved request execution submits only trusted reference and actual refund acknowledgement',()=>{
 const f=source();f.requests=[{requestId:'request-a',orderId:'order-a',kind:'REFUND',amount:1234,reason:'Approved return',canExecute:true}];
 const i=buildFinancialIntent(f,'refundPayment',{requestId:'request-a',amount:'999',reason:'Forged'});
 assert.deepEqual(i.payload,{order:'order-a',requestId:'request-a'});assert.equal(i.amount,1234);
 assert.equal(i.reason,'Approved return');assert.equal(i.actual,true);assert.match(i.confirmation,/\u5df2\u5b9e\u9645\u5c06\u4e0a\u8ff0\u91d1\u989d\u9000\u8fd8\u987e\u5ba2/);
 f.requests[0].canExecute=false;assert.throws(()=>buildFinancialIntent(f,'refundPayment',{requestId:'request-a'}));
});
test('C3-B UI: self approval, missing trusted identity and missing capabilities stay unavailable',()=>{
 const f=source();f.requests=[{requestId:'request-a',canApprove:false,canReject:false,submittedByDisplayName:'\u540c\u540d'}];
 assert.throws(()=>buildFinancialIntent(f,'approveFinancialAdjustment',{requestId:'request-a'}));
 f.requests[0].canApprove=true;f.requests[0].submittedByDisplayName=null;
 assert.throws(()=>buildFinancialIntent(f,'approveFinancialAdjustment',{requestId:'request-a'}));
 f.capabilities.refundPayment.allowed=false;
 assert.throws(()=>buildFinancialIntent(f,'refundPayment',{paymentId:'payment-a',amount:'1',reason:'Not permitted'}));
});
test('C3-B UI: approval acknowledgement authorizes a request without claiming execution',()=>{
 const f=source();f.requests=[{requestId:'request-a',canApprove:true,submittedByDisplayName:'\u7533\u8bf7\u4eba',amount:1000,reason:'Review'}];
 const i=buildFinancialIntent(f,'approveFinancialAdjustment',{requestId:'request-a'});
 assert.equal(i.actual,false);assert.match(i.confirmation,/\u6279\u51c6\u4e0d\u4ee3\u8868\u8d44\u91d1\u5df2\u7ecf\u6267\u884c/);
 assert.deepEqual(i.payload,{requestId:'request-a'});
});
