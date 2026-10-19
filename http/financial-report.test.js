
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
