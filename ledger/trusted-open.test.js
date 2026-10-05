import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { quote } from '../rooms.js';
import { total } from '../sales.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTransactionBoundEmployeeResolver } from '../employees/employee-resolver.js';
import { createTransactionBoundVoucherBinding } from '../vouchers/binding.js';
import { orderBusinessDaySnapshot } from '../shared/business-day.js';
const employeeId='10000000-0000-4000-8000-000000000001',rid='20000000-0000-4000-8000-000000000001';
const dbNow='2026-10-05T12:00:00.123456Z';
const cmd=(key='open',revision=0,payload={})=>({operationKey:key,expectedRevision:revision,action:'open',
 payload:{room:'V01',beer:'bw',creditedEmployeeId:employeeId,...payload}});
function fixture({permissions=['room.open','staff.record'],setup=()=>{},mapping=true,binding=true,timeZone='Asia/Shanghai'}={}){
 const state=initialState();state.user='invalid-demo';state.clock='not-time';state.permissions={administrator:['管理员']};state.capabilities={administrator:['*']};
 state.inventory.bw.count=100;state.inventory.qd.count=null;state.inventory.lm.count=0;
 state.orders=[{id:'old-retail',kind:'retail',room:null,sales:[{productNameSnapshot:'old name',pricePerSaleUnitCents:null}],payments:[]}];setup(state);
 const memory=createMemoryLedgerStore(state,{ledgerId:'open-unit'}),digest=Buffer.alloc(32,9),events=[];
 const auth={principalId:'synthetic-session-actor',permissions,enabled:true,revoked:false};
 const employee={employeeId,displayName:'Synthetic employee',enabled:true,principalId:null};
 const rows=new Map([[rid,{id:rid,ledgerId:'open-unit',provider:'meituan',storeId:'synthetic-store',status:'REDEEMED',
  version:2,linkedOrderId:null,providerFlowId:'provider-flow',productId:'synthetic-product',productNameSnapshot:'Provider original name'}]]);
 const authPort={
 locateSessionByDigest:async()=>({principalId:auth.principalId,sessionId:'synthetic-session'}),
 lockAccount:async()=>{events.push('account');return{principalId:auth.principalId,enabled:auth.enabled,credentialVersion:1,policyAttributesConfigured:false};},
 lockSessionById:async()=>{events.push('session');return{principalId:auth.principalId,sessionId:'synthetic-session',tokenDigest:digest,credentialVersion:1,
  revoked:auth.revoked,idleExpiresAt:'2099-01-01T00:00:00.000000Z',absoluteExpiresAt:'2099-01-02T00:00:00.000000Z'};},
 listGrants:async()=>{events.push('grants');return auth.permissions;},listPolicyAttributes:async()=>[],
 readDbNow:async()=>{events.push('dbNow');return dbNow;}
 };
 let executionContext,executions=0,fault=null;
 const store={ledgerId:memory.ledgerId,runAtomic:async work=>{
  const copied=structuredClone(rows);
  const response=await memory.runAtomic(async tx=>{
   events.push('head');const lookup=tx.findOperationResult;tx.findOperationResult=async key=>{events.push('operation');return lookup(key);};
   tx.sessionRevalidation={revalidateSessionInTransaction:credential=>revalidateSessionInTransaction({port:authPort,...credential})};
   tx.employeeResolver=createTransactionBoundEmployeeResolver({port:{lockEmployeeForAttribution:async id=>{events.push('employee');return id===employeeId?employee:null;}}});
   if(binding)tx.voucherBinding=createTransactionBoundVoucherBinding({ledgerId:'open-unit',provider:'meituan',storeId:'synthetic-store',
    packageMappings:mapping?[{productId:'synthetic-product',packageIds:['room.small.night']}]:[],
    port:{lockRedemption:async id=>{events.push('voucher-lock');return copied.get(id)??null;},
      writeRedemption:async next=>{events.push('voucher-link');copied.set(next.id,next);}}});
   return work(tx);
  });rows.clear();for(const [id,row]of copied)rows.set(id,row);return response;
 }};
 const app=createTrustedLedgerApplication({store,...(timeZone===null?{}:{businessTimeZone:timeZone}),transactCommand:(...args)=>{
  executions++;events.push('transact');executionContext=args[4].context;const next=transact(...args);if(fault)throw fault;return next;
 }});
 return{state,memory,app,auth,employee,rows,events,credential:{tokenDigest:digest},context:()=>executionContext,
  executions:()=>executions,fail:error=>{fault=error;}};
}
async function unchanged(f,terminals=0){const h=await f.memory.read();assert.deepEqual(h.state,f.state);assert.equal(h.revision,0);
 assert.equal(h.audit.length,0);assert.equal(h.operationResults.size,terminals);assert.equal(f.rows.get(rid).linkedOrderId,null);}
test('trusted ordinary open uses session actor, independent employee and frozen DB time/businessDate',async()=>{
 const f=fixture(),request=cmd('normal',0,{actorId:'forged',principalId:'forged',person:'forged',employeeName:'forged',permissions:['*'],role:'boss',clock:'1900-01-01'});
 const result=await f.app.execute(request,f.credential),h=await f.memory.read(),o=h.state.orders.at(-1);
 assert.equal(result.status,'committed');assert.equal(o.actualActorPrincipalId,f.auth.principalId);
 assert.equal(o.recordedBy,f.auth.principalId);assert.equal(o.creditedEmployeeId,employeeId);assert.equal(o.person,f.employee.displayName);
 assert.equal(o.time,dbNow);assert.deepEqual({businessDate:o.businessDate,businessDayRuleVersion:o.businessDayRuleVersion,businessTimeZone:o.businessTimeZone},
  orderBusinessDaySnapshot(dbNow,{timeZone:'Asia/Shanghai'}));
 assert.equal(h.revision,1);assert.equal(h.state.rooms[0].status,'营业中');
 const q=quote(f.state.rooms[0].type,'2026-10-05T20:00:00+08:00','bw','',f.state.catalog);
 assert.equal(o.base,q.base);assert.equal(o.gift,q.gift);assert.equal(h.state.inventory.bw.count,100-q.bottles);
 assert.equal(h.state.inventory.qd.count,null);assert.equal(h.state.inventory.lm.count,0);assert.deepEqual(h.state.orders[0],f.state.orders[0]);
});
test('trusted platform open locks server evidence and links order in the same atomic commit',async()=>{
 const f=fixture(),r=await f.app.execute(cmd('voucher',0,{voucherRedemptionId:rid}),f.credential),h=await f.memory.read(),o=h.state.orders.at(-1);
 assert.equal(r.status,'committed');assert.equal(total(o),0);assert.equal(o.voucherRedemptionId,rid);
 assert.equal(o.voucher.status,'REDEEMED');assert.equal(o.voucher.providerFlowId,'provider-flow');assert.equal(o.openSource,'美团');
 assert.equal(f.rows.get(rid).linkedOrderId,o.id);
 assert.ok(f.events.indexOf('head')<f.events.indexOf('account'));assert.ok(f.events.indexOf('session')<f.events.indexOf('voucher-lock'));
 assert.ok(f.events.indexOf('voucher-lock')<f.events.indexOf('transact'));assert.ok(f.events.indexOf('transact')<f.events.indexOf('voucher-link'));
});
test('unverified platform, forged voucher flags/JSON, wrong source and unconfigured product fail closed',async()=>{
 for(const payload of [{openSource:'美团'},{receiptCode:'0012345678901'},{redeemed:true},{verified:true},{status:'REDEEMED'},{voucher:{status:'REDEEMED'}},
  {voucherRedemptionId:rid,openSource:'抖音'}]){
  const f=fixture();assert.equal((await f.app.execute(cmd('bad',0,payload),f.credential)).status,'business-rejected');await unchanged(f,1);
 }
 const f=fixture({mapping:false});await assert.rejects(f.app.execute(cmd('map',0,{voucherRedemptionId:rid}),f.credential),{code:'AUTHORIZATION_DENIED'});await unchanged(f);
});
test('all non-REDEEMED, cross-store, missing and already-bound redemptions cannot open',async()=>{
 for(const change of [{status:'PENDING'},{status:'REDEEMING'},{status:'FAILED'},{status:'UNKNOWN'},{status:'REVERSED'},{status:'REFUNDED'},
  {storeId:'other'},{linkedOrderId:'D0'}]){
  const f=fixture();Object.assign(f.rows.get(rid),change);
  assert.equal((await f.app.execute(cmd('bad',0,{voucherRedemptionId:rid}),f.credential)).status,'business-rejected');
  const h=await f.memory.read();assert.deepEqual(h.state,f.state);assert.equal(h.revision,0);
 }
 const f=fixture();assert.equal((await f.app.execute(cmd('missing',0,{voucherRedemptionId:'20000000-0000-4000-8000-000000000099'}),f.credential)).status,'business-rejected');await unchanged(f,1);
});
test('authorization denial occupies no key; employee never grants actor authority',async()=>{
 for(const permissions of [[],['backend.view'],['room.open'],['staff.record']]){
  const f=fixture({permissions}),request=cmd('denied',0,{permissions:['room.open','staff.record'],role:'administrator'});
  await assert.rejects(f.app.execute(request,f.credential),{code:'AUTHORIZATION_DENIED'});await unchanged(f);assert.equal(f.executions(),0);
  f.auth.permissions=['room.open','staff.record'];assert.equal((await f.app.execute(request,f.credential)).status,'committed');
 }
});
test('replay after revoke bypasses current action/mapping/employee checks but never authentication or fingerprint',async()=>{
 const f=fixture(),request=cmd('same',0,{voucherRedemptionId:rid}),first=await f.app.execute(request,f.credential),before=await f.memory.read();
 f.auth.permissions=[];f.employee.enabled=false;f.events.length=0;
 assert.deepEqual(await f.app.execute(request,f.credential),first);assert.equal(f.events.includes('voucher-lock'),false);
 await assert.rejects(f.app.execute({...request,operationKey:'new',expectedRevision:1},f.credential),{code:'AUTHORIZATION_DENIED'});
 assert.equal((await f.app.execute({...request,expectedRevision:1},f.credential)).reason,'request-mismatch');
 assert.equal((await f.app.execute({...request,payload:{...request.payload,beer:'qd'}},f.credential)).reason,'request-mismatch');
 f.auth.principalId='other';assert.equal((await f.app.execute(request,f.credential)).reason,'actor-mismatch');f.auth.principalId=first.actorId;
 f.auth.revoked=true;await assert.rejects(f.app.execute(request,f.credential),{code:'AUTHENTICATION_REQUIRED'});
 f.auth.revoked=false;f.auth.enabled=false;await assert.rejects(f.app.execute(request,f.credential),{code:'AUTHENTICATION_REQUIRED'});
 assert.deepEqual(await f.memory.read(),before);assert.equal(f.executions(),1);
});
test('trusted room/package/inventory/reservation validations retain domain behavior without consuming redemption on rejection',async()=>{
 for(const [payload,setup]of [[{},s=>s.rooms[0].status='营业中'],[{},s=>s.rooms[0].status='待清洁'],
  [{beer:'invalid'},()=>{}],[{},s=>s.inventory.bw.count=0],[{},s=>s.roomIssueReviews.push({room:'V01',status:'待审核'})]]){
  const f=fixture({setup});assert.equal((await f.app.execute(cmd('reject',0,{voucherRedemptionId:rid,...payload}),f.credential)).status,'business-rejected');await unchanged(f,1);
 }
 const f=fixture({setup:s=>{s.rooms[0].status='已预订';s.reservations.push({id:1,room:'V01',at:'2026-10-05T11:00:00Z',session:'night',status:'已预订',person:'historical snapshot',source:'手机'});}});
 assert.equal((await f.app.execute(cmd(),f.credential)).status,'committed');
 assert.equal((await f.memory.read()).state.reservations[0].status,'已到店');
});
test('unknown domain failure leaves provider evidence redeemed/unlinked and original open key retryable',async()=>{
 const f=fixture(),request=cmd('fault',0,{voucherRedemptionId:rid});f.fail(Error('synthetic failure after business work'));
 await assert.rejects(f.app.execute(request,f.credential));await unchanged(f);assert.equal(f.rows.get(rid).status,'REDEEMED');
 f.fail(null);assert.equal((await f.app.execute(request,f.credential)).status,'committed');
});
test('missing connection-bound binding/context/time-zone and copied contexts never fall back to demo',async()=>{
 const f=fixture({binding:false});await assert.rejects(f.app.execute(cmd('missing',0,{voucherRedemptionId:rid}),f.credential),TypeError);await unchanged(f);
 const noZone=fixture({timeZone:null});await assert.rejects(noZone.app.execute(cmd(),noZone.credential),TypeError);await unchanged(noZone);
 assert.throws(()=>transact(f.state,'open',cmd().payload,'direct',{mode:'trusted'}),TypeError);
 const good=fixture();await good.app.execute(cmd(),good.credential);
 for(const context of [structuredClone(good.context()),{...good.context()}])assert.throws(()=>transact(f.state,'open',cmd().payload,'direct',{mode:'trusted',context}),TypeError);
});
