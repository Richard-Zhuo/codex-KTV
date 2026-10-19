
import test from 'node:test';
import assert from 'node:assert/strict';
import * as queries from './query.js';
import {createTrustedPrincipal} from '../ledger/command-policy.js';
import {registerTrustedExecutionContext} from '../shared/identity.js';
import {initialState} from '../rules.js';
import {seedFinancialState} from '../test-support/financial-adjustments-fixture.js';
const query={fromBusinessDate:'2026-01-01',toBusinessDate:'2026-01-02',paymentInterval:{from:'2026-10-15T06:00:00+08:00',to:'2026-10-16T06:00:00+08:00'}};
function context(grants){
 const principal=createTrustedPrincipal({id:'report-actor',permissionIds:grants});
 return registerTrustedExecutionContext(Object.freeze({mode:'trusted',principalId:principal.id,principal,
 permissionIds:principal.permissionIds,policyAttributesConfigured:false,policyAttributeIds:null,sessionId:'report-session',dbNow:'2026-10-16T12:00:00.000000Z'}));
}
function head(){
 const s=initialState();seedFinancialState(s);s.futureSecret='never-expose-report-secret';
 s.orders[0].privateCustomer='never-expose-customer';s.orders[0].payments[0].privateToken='never-expose-token';
 return {revision:12,state:s};
}
test('C2-B: report.view is mandatory and financial query returns only the approved projection',()=>{
 const h=head(),original=structuredClone(h);
 for(const grants of [[],['backend.view'],['payment.collect'],['handover']])
  assert.throws(()=>queries.projectFinancialReport(h,context(grants),query),e=>e.code==='AUTHORIZATION_DENIED');
 const r=queries.projectFinancialReport(h,context(['report.view']),query);
 assert.equal(r.revision,12);assert.equal(r.report.totals.total,10000);
 assert.equal(r.report.currentBalances.effectivePaymentCreditCents,10000);
 assert.deepEqual(r.report.revenue.orderIds,['financial-order']);assert.equal(r.report.complete,true);
 assert.doesNotMatch(JSON.stringify(r),/never-expose/);assert.equal(r.report.rows,undefined);
 assert.deepEqual(h,original);
});

import http from 'node:http';
import {createHttpApi} from './api.js';
import {digestSessionToken} from '../auth/session-token.js';
test('C2-B: existing GET snapshot accepts explicit report ranges with revalidated report.view only',async()=>{
 let grants=['report.view'],api;const h=head(),original=structuredClone(h),token='R'.repeat(43),diagnostics=[];
 const server=http.createServer((req,res)=>{void api.handle(req,res);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 api=createHttpApi({origin,environment:'development',allowInsecureCookie:true,businessTimeZone:'Asia/Shanghai',
 authService:{login(){throw Error('unused');},async authenticateSession(raw){return raw===token?{id:'report-actor',permissionIds:['report.view']}:null;},logout(){throw Error('unused');}},
 application:{execute(){assert.fail('report query must not execute a write');}},
 store:{async readInTransaction(){return structuredClone(h);}},
 sessionReader:{async withContext(credential,work){assert.deepEqual(credential.tokenDigest,digestSessionToken(token));return work(context(grants),{});}},
 logger:{error:entry=>diagnostics.push(entry)}});
 const params=new URLSearchParams({fromBusinessDate:query.fromBusinessDate,toBusinessDate:query.toBusinessDate,
 paymentFrom:query.paymentInterval.from,paymentTo:query.paymentInterval.to});
 const path='/api/v1/store/snapshot',get=(suffix='',cookie=true)=>fetch(origin+path+suffix,{headers:cookie?{Cookie:'jbhh_session='+token}:{}});
 try{
  const response=await get('?'+params);assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.view.financialReport.totals.total,10000);
  assert.equal(body.view.financialReport.currentBalances.netReceiptsCents,10000);assert.doesNotMatch(JSON.stringify(body),/never-expose/);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await get('?'+params,false)).status,401);
  grants=[];assert.equal((await get('?'+params)).status,403);grants=['payment.collect'];
  assert.equal((await get('?'+params)).status,403);grants=['report.view'];
  for(const suffix of ['?fromBusinessDate=2026-01-01','?'+params+'&fromBusinessDate=2026-01-01','?'+params+'&principalId=forged',
    '?'+new URLSearchParams({...Object.fromEntries(params),paymentTo:'invalid'})]){
   assert.equal((await get(suffix)).status,400,suffix);
  }
  assert.equal((await (await get()).json()).view.financialReport,undefined);
  assert.deepEqual(h,original);assert.deepEqual(diagnostics,[]);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

import {financialFixture,ownerId,orderId,paymentId} from '../test-support/financial-adjustments-fixture.js';
async function drawerReportFixture({outflows=true,countAfterOutflows=false}={}){
 const f=financialFixture();f.accounts.get(ownerId).grants.push('handover','cash.out');
 f.setTime('2026-10-15T12:00:00.000000Z');
 let sequence=0;
 const execute=async(action,payload)=>{
  const r=await f.execute({action,payload,operationKey:'drawer-report-trust-'+(++sequence),
   expectedRevision:(await f.memory.read()).revision});
  assert.equal(r.status,'committed',JSON.stringify(r));
 };
 await execute('handover',{actualCash:50000});
 if(outflows){
  await execute('refundPayment',{order:orderId,originalPaymentId:paymentId,amount:6000,reason:'Reporting regression refund',
   refundChannel:'\u73b0\u91d1',refundFundingSource:'CURRENT_DRAWER'});
  await execute('cashOut',{amountCents:4000,reason:'Reporting regression cash out'});
  if(countAfterOutflows)await execute('handover',{actualCash:40000});
 }
 return {f,h:await f.memory.read()};
}
function assertUnknownDrawer(report){
 assert.equal(report.complete,false);assert.equal(report.cashCounts.complete,false);
 assert.equal(report.financialFlows.complete,false);
 assert.ok(report.cashCounts.ambiguities.some(a=>a.code==='CASH_COUNT_CHAIN_UNVERIFIABLE'));
 assert.ok(report.financialFlows.ambiguities.some(a=>a.code==='DRAWER_FACTS_UNVERIFIABLE'));
 assert.equal(report.financialFlows.drawerRefundCents,null);
 assert.equal(report.financialFlows.independentCashOutCents,null);
 assert.equal(report.financialFlows.drawerCashOutCents,null);
 assert.deepEqual(report.financialFlows.cashOutflows,[]);
 // These facts do not derive their authority from the drawer chain.
 assert.equal(report.totals.total,10000);assert.equal(report.financialFlows.refundCents,6000);
 assert.equal(report.currentBalances.netReceiptsCents,4000);
}
test('C2B-P1-01: broken handover chain invalidates drawer amounts without mutating financial facts',async()=>{
 const {f,h}=await drawerReportFixture(),ledgerBefore=structuredClone(h);
 const damaged=structuredClone(h);
 damaged.state.handovers[0].previousHandoverId='90000000-0000-4000-8000-000000000099';
 const before=structuredClone(damaged);
 assertUnknownDrawer(queries.projectFinancialReport(damaged,context(['report.view']),query).report);
 assert.deepEqual(damaged,before);assert.deepEqual(await f.memory.read(),ledgerBefore);
});

test('C2B-P1-01: valid chain preserves 6000 refund plus 4000 independent cash out',async()=>{
 const {f,h}=await drawerReportFixture(),before=structuredClone(h);
 const r=queries.projectFinancialReport(h,context(['report.view']),query).report;
 assert.equal(r.complete,true);assert.equal(r.cashCounts.complete,true);
 assert.equal(r.financialFlows.drawerRefundCents,6000);
 assert.equal(r.financialFlows.independentCashOutCents,4000);
 assert.equal(r.financialFlows.drawerCashOutCents,10000);
 assert.equal(r.financialFlows.cashOutflows.length,1);
 assert.deepEqual(h,before);assert.deepEqual(await f.memory.read(),before);
});
test('C2B-P1-01: captured cash-fact signature mismatch invalidates every dependent drawer amount',async()=>{
 const {f,h}=await drawerReportFixture({countAfterOutflows:true}),ledgerBefore=structuredClone(h);
 const damaged=structuredClone(h),captured=damaged.state.handovers[1].cashBoundary.facts;
 assert.equal(captured.length,2);captured[0].signature+='-tampered';
 const before=structuredClone(damaged);
 assertUnknownDrawer(queries.projectFinancialReport(damaged,context(['report.view']),query).report);
 assert.deepEqual(damaged,before);assert.deepEqual(await f.memory.read(),ledgerBefore);
});
test('C2B-P1-01: trusted no-outflow interval returns real zeros rather than unknown amounts',async()=>{
 const {f,h}=await drawerReportFixture({outflows:false}),before=structuredClone(h);
 const r=queries.projectFinancialReport(h,context(['report.view']),query).report;
 assert.equal(r.complete,true);assert.deepEqual(r.financialFlows.ambiguities,[]);
 assert.equal(r.financialFlows.drawerRefundCents,0);
 assert.equal(r.financialFlows.independentCashOutCents,0);
 assert.equal(r.financialFlows.drawerCashOutCents,0);
 assert.deepEqual(h,before);assert.deepEqual(await f.memory.read(),before);
});
test('C2B-P1-01: formal GET preserves unknown drawer amounts as JSON null without ledger writes',async()=>{
 const {f,h}=await drawerReportFixture(),ledgerBefore=structuredClone(h);
 const damaged=structuredClone(h);
 damaged.state.handovers[0].previousHandoverId='90000000-0000-4000-8000-000000000099';
 const before=structuredClone(damaged),token='N'.repeat(43),diagnostics=[];let api;
 const server=http.createServer((req,res)=>{void api.handle(req,res);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 api=createHttpApi({origin,environment:'development',allowInsecureCookie:true,businessTimeZone:'Asia/Shanghai',
 authService:{login(){throw Error('unused');},async authenticateSession(raw){return raw===token?{id:'report-actor',permissionIds:['report.view']}:null;},logout(){throw Error('unused');}},
 application:{execute(){assert.fail('financial report must never write');}},
 store:{async readInTransaction(){return structuredClone(damaged);}},
 sessionReader:{async withContext(credential,work){assert.deepEqual(credential.tokenDigest,digestSessionToken(token));return work(context(['report.view']),{});}},
 logger:{error:entry=>diagnostics.push(entry)}});
 const params=new URLSearchParams({fromBusinessDate:query.fromBusinessDate,toBusinessDate:query.toBusinessDate,
 paymentFrom:query.paymentInterval.from,paymentTo:query.paymentInterval.to});
 try{
  const response=await fetch(origin+'/api/v1/store/snapshot?'+params,{headers:{Cookie:'jbhh_session='+token}});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const r=(await response.json()).view.financialReport;assertUnknownDrawer(r);
  for(const field of ['drawerRefundCents','independentCashOutCents','drawerCashOutCents'])
   assert.ok(Object.hasOwn(r.financialFlows,field));
  assert.deepEqual(damaged,before);assert.deepEqual(await f.memory.read(),ledgerBefore);assert.deepEqual(diagnostics,[]);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
