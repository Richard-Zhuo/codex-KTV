import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHttpApi} from './api.js';
import {digestSessionToken} from '../auth/session-token.js';
import {revalidateSessionInTransaction} from '../auth/session-revalidation.js';
import {SessionAuthenticationRequired} from '../ledger/trusted-execution.js';
import {createMemoryLedgerStore} from '../ledger/memory-store.js';
import {createTrustedLedgerApplication} from '../ledger/application.js';
import {initialState} from '../rules.js';
import {seedFinancialState,orderId,paymentId} from '../test-support/financial-adjustments-fixture.js';
import {HTTP_COMMAND_ACTIONS} from './registry.js';

const cash='\u73b0\u91d1',wechat='\u5fae\u4fe1';
const pending='\u5f85\u5ba1\u6838',approved='\u5df2\u6279\u51c6',executed='\u5df2\u6267\u884c',rejected='\u5df2\u9a73\u56de';
const grants=['payment.reverse','payment.refund','cash.out','order.cancel','financial.approve'];
async function fixture(t,{prepare=()=>{}}={}){
 const state=initialState();seedFinancialState(state);prepare(state);
 const memory=createMemoryLedgerStore(state,{ledgerId:'financial-http-unit'});
 const accounts=new Map([
  ['direct',{grants:[...grants,'financial.direct','handover']}],
  ['applicant',{grants:[...grants,'review.self']}],
  ['reviewer',{grants:[...grants]}],
  ['assistant',{grants:['backend.view','report.view','review.self']}],
  ['other',{grants:[...grants]}]
 ]);
 for(const [i,a] of [...accounts.values()].entries())Object.assign(a,{id:'83000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),
  token:String.fromCharCode(65+i).repeat(43),enabled:true,revoked:false,version:1,sessionVersion:1,expired:false});
 let dbNow='2026-10-18T12:00:00.000000Z',beforeExecute=null,sequence=0;
 const accountFor=credential=>[...accounts.values()].find(a=>digestSessionToken(a.token).equals(credential.tokenDigest));
 const revalidate=credential=>{
  const a=accountFor(credential);if(!a)return null;
  return revalidateSessionInTransaction({tokenDigest:credential.tokenDigest,port:{
   async locateSessionByDigest(){return {principalId:a.id,sessionId:a.id};},
   async lockAccount(){return {principalId:a.id,enabled:a.enabled,credentialVersion:a.version,policyAttributesConfigured:false};},
   async lockSessionById(){return {principalId:a.id,sessionId:a.id,tokenDigest:digestSessionToken(a.token),revoked:a.revoked,
    credentialVersion:a.sessionVersion,idleExpiresAt:a.expired?'2020-01-01T00:00:00.000000Z':'2099-01-01T00:00:00.000000Z',absoluteExpiresAt:'2099-01-02T00:00:00.000000Z'};},
   async listGrants(){return a.grants;},async listPolicyAttributes(){return [];},async readDbNow(){return dbNow;}
  }});
 };
 const store={ledgerId:memory.ledgerId,runAtomic:work=>memory.runAtomic(tx=>{
  tx.sessionRevalidation={revalidateSessionInTransaction:revalidate};return work(tx);
 })};
 const application=createTrustedLedgerApplication({store,businessTimeZone:'Asia/Shanghai'});
 let api;
 const server=http.createServer((req,res)=>void api.handle(req,res));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port,diagnostics=[];
 api=createHttpApi({origin,environment:'development',allowInsecureCookie:true,businessTimeZone:'Asia/Shanghai',
  authService:{login(){throw Error('unused');},async authenticateSession(token){
   const a=[...accounts.values()].find(a=>a.token===token);
   return a&&a.enabled&&!a.revoked&&!a.expired&&a.version===a.sessionVersion?{id:a.id,permissionIds:[...grants]}:null;
  },logout(){throw Error('unused');}},
  application:{async execute(command,credential){const hook=beforeExecute;beforeExecute=null;hook?.();return application.execute(command,credential);}},
  store:{async readInTransaction(connection){return connection.head;}},
  sessionReader:{async withContext(credential,work){return store.runAtomic(async tx=>{
   const context=await tx.sessionRevalidation.revalidateSessionInTransaction(credential);
   if(!context)throw new SessionAuthenticationRequired();
   return work(context,{head:await tx.read()});
  });}},logger:{error:entry=>diagnostics.push(entry)}});
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const clients=new Map();
 async function client(name){
  if(clients.has(name))return clients.get(name);
  const cookie='jbhh_session='+accounts.get(name).token;
  const response=await fetch(origin+'/api/v1/auth/session',{headers:{Cookie:cookie}});
  assert.equal(response.status,200);const {csrfToken}=await response.json(),c={cookie,csrfToken};clients.set(name,c);return c;
 }
 async function send(name,path,{method='GET',body,headers={}}={}){
  const c=name?await client(name):{};
  const response=await fetch(origin+path,{method,headers:{...(c.cookie?{Cookie:c.cookie}:{}),
   ...(method!=='GET'?{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':c.csrfToken}:{}),...headers},
   body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 }
 async function post(name,action,payload,envelope){
  const request=envelope??{operationKey:'financial-http-'+(++sequence),expectedRevision:(await memory.read()).revision,payload};
  return {...await send(name,'/api/v1/commands/'+action,{method:'POST',body:request}),request};
 }
 return {accounts,memory,post,send,client,diagnostics,origin,setTime:value=>{dbNow=value;},beforeExecute:hook=>{beforeExecute=hook;},
  async snapshot(name){return send(name,'/api/v1/store/snapshot');}};
}
const order=s=>s.orders.find(o=>o.id===orderId);
const refundPayload={order:orderId,originalPaymentId:paymentId,amount:3000,reason:'Manual refund confirmation',
 refundChannel:wechat,refundFundingSource:'NON_CASH'};
const reversePayload={order:orderId,originalPaymentId:paymentId,amount:10000,reason:'Correct wrong payment'};
test('C3-A: direct refund uses the existing authenticated HTTP dispatcher and trusted actor/time',async t=>{
 const f=await fixture(t),r=await f.post('direct','refundPayment',refundPayload);
 assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.result.status,'committed');
 const s=(await f.memory.read()).state,a=order(s).financialAdjustments[0];
 assert.equal(a.amount,3000);assert.equal(a.actualActorPrincipalId,f.accounts.get('direct').id);
 assert.equal(a.occurredAt,'2026-10-18T12:00:00.000000Z');assert.equal(a.requestId,null);
 assert.deepEqual(f.diagnostics,[]);
});

test('C3-A: own request and eligible review inbox use the existing staff snapshot without private order leakage',async t=>{
 const f=await fixture(t),r=await f.post('applicant','refundPayment',refundPayload);assert.equal(r.status,200);
 const own=(await f.snapshot('applicant')).body.view.workspace.financial;
 assert.ok(own,'financial staff projection missing');
 assert.equal(own.requests.length,1);assert.equal(own.requests[0].status,pending);
 assert.equal(own.requests[0].canExecute,false);assert.equal(own.requests[0].canApprove,false);
 const reviewer=(await f.snapshot('reviewer')).body.view.workspace.financial;
 assert.equal(reviewer.requests.length,1);assert.equal(reviewer.requests[0].canApprove,true);
 assert.equal(reviewer.requests[0].canExecute,false);
 assert.equal(own.payments[0].paymentId,paymentId);assert.equal(own.payments[0].amount,10000);
 assert.equal((await f.snapshot('assistant')).body.view.workspace.financial,undefined);
 assert.deepEqual(f.diagnostics,[]);
});

test('C3-A: exactly six financial commands require their own grants, not role/name or unrelated grants',async t=>{
 const f=await fixture(t);
 const actions=['reversePayment','refundPayment','cashOut','cancelOrder','approveFinancialAdjustment','rejectFinancialAdjustment'];
 for(const action of actions)assert.ok(HTTP_COMMAND_ACTIONS.includes(action));
 for(const permissions of [[],['backend.view'],['report.view'],['review.self'],['financial.direct']]){
  f.accounts.get('assistant').grants=permissions;
  for(const action of actions){
   const r=await f.post('assistant',action,{});assert.equal(r.status,403,action+JSON.stringify(r.body));
   assert.equal(r.body.error.code,'authorization_denied');
  }
  assert.equal((await f.snapshot('assistant')).body.view.workspace?.financial,undefined);
 }
 assert.equal((await f.memory.read()).revision,0);assert.deepEqual(f.diagnostics,[]);
});
for(const [action,payload] of [['refundPayment',refundPayload],['reversePayment',reversePayload],
 ['cashOut',{amountCents:2000,reason:'Manual actual withdrawal'}]]){
 test('C3-A: '+action+' requires other-person approval and original-applicant execution, then consumes the request',async t=>{
  const f=await fixture(t);
  if(action==='cashOut')assert.equal((await f.post('direct','handover',{actualCash:50000})).status,200);
  const before=(await f.memory.read()).state;
  assert.equal((await f.post('applicant',action,payload)).status,200);
  const request=(await f.snapshot('applicant')).body.view.workspace.financial.requests[0],requestId=request.requestId;
  const execution=action==='cashOut'?{requestId}:{order:orderId,requestId};
  assert.equal(request.status,pending);assert.equal(request.canExecute,false);
  assert.equal((await f.post('applicant',action,execution)).status,422);
  assert.equal((await f.post('applicant','approveFinancialAdjustment',{requestId})).status,403);
  assert.equal((await f.post('applicant','rejectFinancialAdjustment',{requestId,decisionNote:'Self rejection attempt'})).status,403);
  assert.equal((await f.post('reviewer','approveFinancialAdjustment',{requestId})).status,200);
  const afterApproval=(await f.memory.read()).state;
  assert.deepEqual(order(afterApproval).payments,order(before).payments);
  assert.equal(order(afterApproval).financialAdjustments?.length??0,0);
  assert.equal(afterApproval.cashOutflows?.length??0,0);
  const approvedView=(await f.snapshot('applicant')).body.view.workspace.financial.requests[0];
  assert.equal(approvedView.status,approved);assert.equal(approvedView.canExecute,true);
  assert.equal((await f.snapshot('reviewer')).body.view.workspace.financial.requests.length,0);
  assert.equal((await f.post('other',action,execution)).status,403);
  const done=await f.post('applicant',action,execution);assert.equal(done.status,200,JSON.stringify(done.body));
  const retry=await f.post('applicant',action,execution,done.request);assert.equal(retry.status,200);assert.deepEqual(retry.body,done.body);
  const countFacts=s=>(order(s).financialAdjustments?.length??0)+(s.cashOutflows?.length??0);
  assert.equal(countFacts((await f.memory.read()).state),1);
  const finalView=(await f.snapshot('applicant')).body.view.workspace.financial;
  assert.equal(finalView.requests[0].status,executed);assert.equal(finalView.requests[0].canExecute,false);
  assert.equal(finalView.results.length,1);assert.equal(finalView.results[0].requestId,requestId);
  assert.equal((await f.post('applicant',action,execution)).status,422);
  assert.equal(countFacts((await f.memory.read()).state),1);assert.deepEqual(f.diagnostics,[]);
 });
}
test('C3-A: rejection remains a rejected request with no money fact or executable intent',async t=>{
 const f=await fixture(t);await f.post('applicant','refundPayment',refundPayload);
 const {requestId}=(await f.snapshot('applicant')).body.view.workspace.financial.requests[0];
 const r=await f.post('reviewer','rejectFinancialAdjustment',{requestId,decisionNote:'Do not refund'});
 assert.equal(r.status,200);
 const own=(await f.snapshot('applicant')).body.view.workspace.financial;
 assert.equal(own.requests[0].status,rejected);assert.equal(own.requests[0].canExecute,false);assert.equal(own.results.length,0);
 assert.equal((await f.post('applicant','refundPayment',{order:orderId,requestId})).status,422);
 assert.equal(order((await f.memory.read()).state).financialAdjustments?.length??0,0);
});
test('C3-A: direct reverse and direct cashOut append facts immediately without approval requests',async t=>{
 const f=await fixture(t);
 assert.equal((await f.post('direct','reversePayment',reversePayload)).status,200);
 assert.equal((await f.post('direct','handover',{actualCash:50000})).status,200);
 assert.equal((await f.post('direct','cashOut',{amountCents:4000,reason:'Direct physical out'})).status,200);
 const own=(await f.snapshot('direct')).body.view.workspace.financial;
 assert.equal(own.requests.length,0);assert.equal(own.results.length,2);
 assert.equal(own.capabilities.cashOut.mode,'DIRECT');
 assert.equal(own.drawer.availableCents,46000);
});
test('C3-A: same operation key with different content conflicts, stale revision rejects without a money fact',async t=>{
 const f=await fixture(t),done=await f.post('direct','refundPayment',refundPayload);assert.equal(done.status,200);
 const conflict=await f.post('direct','refundPayment',{}, {...done.request,payload:{...refundPayload,amount:2000}});
 assert.equal(conflict.status,409);assert.equal(conflict.body.error.code,'idempotency_conflict');
 const foreign=await f.post('applicant','refundPayment',refundPayload,done.request);assert.equal(foreign.status,409);
 const stale=await f.post('direct','refundPayment',refundPayload,{operationKey:'stale-financial',expectedRevision:0,payload:refundPayload});
 assert.equal(stale.status,409);assert.equal(stale.body.error.code,'revision_conflict');
 assert.equal(order((await f.memory.read()).state).financialAdjustments.length,1);
});
test('C3-A: concurrent approved-request execution commits once under the existing ledger transaction',async t=>{
 const f=await fixture(t);await f.post('applicant','refundPayment',refundPayload);
 const {requestId}=(await f.snapshot('applicant')).body.view.workspace.financial.requests[0];
 await f.post('reviewer','approveFinancialAdjustment',{requestId});
 const revision=(await f.memory.read()).revision,payload={order:orderId,requestId};
 const responses=await Promise.all(['concurrent-a','concurrent-b'].map(operationKey=>f.post('applicant','refundPayment',payload,{operationKey,expectedRevision:revision,payload})));
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
 assert.equal(order((await f.memory.read()).state).financialAdjustments.length,1);
});
test('C3-A: actor/approver/time/grants and attribution fields cannot forge financial authority',async t=>{
 const f=await fixture(t),before=(await f.memory.read()).state;
 for(const [field,value] of [['actor','boss'],['actualActorPrincipalId','boss'],['approver','boss'],
  ['decidedByPrincipalId','boss'],['occurredAt','2000-01-01T00:00:00Z'],['dbNow','2000-01-01T00:00:00Z'],
  ['grants',['financial.direct']],['permissionIds',['financial.direct']],['drawerHandoverId','forged'],
  ['businessDate','2000-01-01'],['creditedEmployeeId','forged']]){
  const r=await f.post('applicant','refundPayment',{...refundPayload,[field]:value});
  assert.ok([400,403,422].includes(r.status),field+JSON.stringify(r.body));
  assert.equal(r.body.result?.status==='committed',false);
 }
 assert.deepEqual((await f.memory.read()).state,before);assert.deepEqual(f.diagnostics,[]);
});
test('C3-A: new requests revalidate revoked grants under lock, while saved same-key results remain recoverable',async t=>{
 const f=await fixture(t),done=await f.post('direct','refundPayment',refundPayload);assert.equal(done.status,200);
 f.beforeExecute(()=>{f.accounts.get('direct').grants=[];});
 const denied=await f.post('direct','refundPayment',refundPayload);
 assert.equal(denied.status,403);assert.equal(denied.body.error.code,'authorization_denied');
 assert.equal((await f.snapshot('direct')).body.view.workspace?.financial,undefined);
 const retry=await f.post('direct','refundPayment',refundPayload,done.request);assert.equal(retry.status,200);
 assert.deepEqual(retry.body,done.body);assert.equal(order((await f.memory.read()).state).financialAdjustments.length,1);
});
test('C3-A: invalid sessions and expiry reject commands and financial reads, including revocation after HTTP auth',async t=>{
 const f=await fixture(t);await f.client('applicant');
 for(const [field,value] of [['revoked',true],['expired',true],['enabled',false],['version',2]]){
  Object.assign(f.accounts.get('applicant'),{revoked:false,expired:false,enabled:true,version:1});
  f.accounts.get('applicant')[field]=value;
  assert.equal((await f.post('applicant','refundPayment',refundPayload)).status,401);
  assert.equal((await f.snapshot('applicant')).status,401);
 }
 Object.assign(f.accounts.get('applicant'),{revoked:false,expired:false,enabled:true,version:1});
 f.beforeExecute(()=>{f.accounts.get('applicant').revoked=true;});
 assert.equal((await f.post('applicant','refundPayment',refundPayload)).status,401);
 assert.equal((await f.memory.read()).revision,0);
});
test('C3-A: financial POST preserves same-origin and CSRF gates; unauthenticated requests cannot dispatch',async t=>{
 const f=await fixture(t),body={operationKey:'csrf-financial',expectedRevision:0,payload:refundPayload};
 assert.equal((await f.send(null,'/api/v1/commands/refundPayment',{method:'POST',body})).status,401);
 for(const headers of [{'X-CSRF-Token':'Z'.repeat(43)},{Origin:'https://forged.example'}])
  assert.equal((await f.send('direct','/api/v1/commands/refundPayment',{method:'POST',body,headers})).status,403);
 assert.equal((await f.memory.read()).revision,0);
});
test('C3-A: cancelOrder remains unpaid-only and all four qualified synthetic operators can cancel',async t=>{
 const paid=await fixture(t);
 assert.equal((await paid.post('direct','cancelOrder',{order:orderId,reason:'Paid order must reject'})).status,422);
 for(const actor of ['direct','applicant','reviewer','other']){
  const f=await fixture(t,{prepare:s=>{order(s).payments=[];}}),before=(await f.memory.read()).state;
  const r=await f.post(actor,'cancelOrder',{order:orderId,reason:'Confirmed unpaid cancellation'});assert.equal(r.status,200);
  const state=(await f.memory.read()).state;assert.equal(order(state).cancellation.actualActorPrincipalId,f.accounts.get(actor).id);
  assert.deepEqual(state.inventory,before.inventory);assert.deepEqual(order(state).sales,order(before).sales);
 }
});
test('C3-A: cashOut without a verified drawer or beyond available cash fails through domain validation',async t=>{
 const f=await fixture(t);
 assert.equal((await f.post('direct','cashOut',{amountCents:1,reason:'No baseline'})).status,422);
 await f.post('direct','handover',{actualCash:1000});
 assert.equal((await f.post('direct','cashOut',{amountCents:1001,reason:'Too much'})).status,422);
 assert.equal((await f.memory.read()).state.cashOutflows?.length??0,0);
});
test('C3-A: financial queries isolate own requests/results and only eligible pending reviews; no private data or report bypass',async t=>{
 const f=await fixture(t,{prepare:s=>{
  order(s).privateCustomer='PRIVATE_CUSTOMER_SENTINEL';order(s).payments[0].secret='PRIVATE_PAYMENT_SENTINEL';
  const other=structuredClone(order(s));other.id='unrelated-order';other.payments[0].paymentId='84000000-0000-4000-8000-000000000001';s.orders.push(other);
 }});
 f.accounts.get('applicant').grants=['payment.refund'];
 f.accounts.get('other').grants=['payment.refund'];
 f.accounts.get('reviewer').grants=['financial.approve'];
 await f.post('applicant','refundPayment',{...refundPayload,reason:'Applicant private reason'});
 await f.post('other','refundPayment',{...refundPayload,amount:1000,reason:'Other private reason'});
 const before=await f.memory.read(),a=await f.snapshot('applicant'),b=await f.snapshot('other'),review=await f.snapshot('reviewer');
 assert.equal(a.body.view.workspace.financial.requests.length,1);assert.equal(b.body.view.workspace.financial.requests.length,1);
 assert.doesNotMatch(JSON.stringify(a.body),/Other private reason|PRIVATE_/);
 assert.equal(a.body.view.workspace.orders,undefined);assert.equal(a.body.view.financialReport,undefined);
 const requests=review.body.view.workspace.financial.requests;assert.equal(requests.length,2);assert.ok(requests.every(r=>r.canApprove));
 assert.deepEqual(review.body.view.workspace.financial.payments.map(p=>p.paymentId),[paymentId]);
 assert.equal(review.body.view.workspace.orders,undefined);assert.doesNotMatch(JSON.stringify(review.body),/PRIVATE_/);
 assert.equal((await f.send('applicant','/api/v1/store/snapshot?financialRequests=all')).status,400);
 const params=new URLSearchParams({fromBusinessDate:'2026-01-01',toBusinessDate:'2026-01-02',paymentFrom:'2026-10-18T00:00:00Z',paymentTo:'2026-10-19T00:00:00Z'});
 assert.equal((await f.send('applicant','/api/v1/store/snapshot?'+params)).status,403);
 assert.equal((await f.snapshot('assistant')).body.view.workspace.financial,undefined);
 assert.deepEqual(await f.memory.read(),before);assert.deepEqual(f.diagnostics,[]);
});
test('C3-A: stale reviewer permissions remove pending inbox and cannot approve',async t=>{
 const f=await fixture(t);await f.post('applicant','refundPayment',refundPayload);
 const requestId=(await f.snapshot('applicant')).body.view.workspace.financial.requests[0].requestId;
 await f.client('reviewer');f.accounts.get('reviewer').grants=['backend.view','report.view','review.self'];
 assert.equal((await f.snapshot('reviewer')).body.view.workspace.financial,undefined);
 assert.equal((await f.post('reviewer','approveFinancialAdjustment',{requestId})).status,403);
 assert.equal(order((await f.memory.read()).state).financialAdjustments?.length??0,0);
});
import {createEmployeeCommandFlow} from '../ui/command-flow.js';
import {createPendingCommandJournal} from '../ui/pending-command-journal.js';
import {HttpApiError,HttpTransportError} from '../ui/api-client.js';
test('C3-A: lost financial response restores existing pending journal and retries the exact original key once',async t=>{
 const f=await fixture(t),values=new Map(),sent=[];let drop=true,keys=0,revision=0;
 const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const journal=createPendingCommandJournal({storageProvider:()=>storage});
 const state={getState:()=>({snapshot:{revision},session:{principalId:f.accounts.get('direct').id}}),isWritable:()=>true,
  async refreshSnapshot(){revision=(await f.snapshot('direct')).body.revision;}};
 const api={async executeCommand(action,request){
  sent.push(structuredClone(request));const response=await f.post('direct',action,request.payload,request);
  if(drop){drop=false;assert.equal(response.status,200);throw new HttpTransportError('lost-response',true);}
  if(response.status!==200)throw new HttpApiError(response.body.error.code,response.status);
  return response.body;
 }};
 const make=()=>createEmployeeCommandFlow({api,state,journal,randomUUID:()=>{keys++;return 'financial-lost-response-key';}});
 const first=make();await assert.rejects(first.submit('refundPayment',refundPayload),HttpTransportError);
 assert.equal(first.getStatus().phase,'unknown');assert.equal(order((await f.memory.read()).state).financialAdjustments.length,1);
 const restored=make();assert.equal(restored.restore().phase,'unknown');await restored.retryUnknown();
 assert.equal(keys,1);assert.deepEqual(sent[1],sent[0]);assert.equal(journal.load(),null);
 assert.equal(order((await f.memory.read()).state).financialAdjustments.length,1);
});
