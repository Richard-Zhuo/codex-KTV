import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact } from '../rules.js';
import { businessDateFor } from '../shared/business-day.js';
import { selectRevenueOrders, selectPaymentFlows, reportViewModel } from '../reporting.js';
import { seedTrustedSalesState, salesCommand, soldOrder } from '../test-support/trusted-sales-fixture.js';
import { seedRepaymentReview, repaymentReviewCommand, repayOrder } from '../test-support/trusted-repayment-review-fixture.js';

// Reuses the guarded fixture. Owns no database/table creation or cleanup.
export async function testK05Reporting({ t,pool,setup,auth,table,provision,seed,inspect,application,roster,
 assertUnchanged,wrapConnection,poolOptions }) {
 const login=await provision(['retail.sale','staff.record','credit.repay.approve']);
 const employee=await roster.createEmployee({displayName:'Synthetic K05 employee'},{actorPrincipalId:login.principalId});
 const allTime={from:'1970-01-01T00:00:00Z',to:'2100-01-01T00:00:00Z'};
 const sources={
  retail:{prepare:seedTrustedSalesState,command:(key,revision=0)=>salesCommand('retailSale',employee.employeeId,key,revision),
   order:state=>soldOrder(state,'retailSale'),count:2,amount:6300},
  repayment:{prepare:seedRepaymentReview,command:(key,revision=0)=>repaymentReviewCommand('approveRepayment',key,revision),
   order:repayOrder,count:1,amount:15000}
 };
 const facts=(actual,source,context)=>{
  const order=source.order(actual.head.state),payments=order.payments.slice(-source.count);
  assert.equal(new Set(payments.map(p=>p.paymentId)).size,source.count);
  for(const payment of payments){
   assert.match(payment.paymentId,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
   assert.equal(payment.occurredAt,context.dbNow);assert.equal(payment.recordedByPrincipalId,login.principalId);
  }
  if(source===sources.retail){
   assert.equal(order.room,null);assert.equal(order.businessDate,businessDateFor(context.dbNow,{timeZone:'Asia/Shanghai'}));
   assert.equal(order.businessDayRuleVersion,'noon-v1');assert.equal(order.businessTimeZone,'Asia/Shanghai');
   assert.equal(actual.head.state.inventory.bw.count,94);assert.equal(actual.head.state.inventory.qd.count,null);
   assert.equal(actual.head.state.inventory.xl.count,0);
  }else{
   assert.equal(payments[0].approvedByPrincipalId,login.principalId);
   assert.deepEqual(order.credit.repayments.at(-1),payments[0]);assert.equal(order.credit.remaining,54500);
  }
  const flow=selectPaymentFlows(actual.head.state,allTime);
  assert.equal(flow.totalCents,source.amount);assert.equal(flow.payments.length,source.count);
 };
 for(const [name,source]of Object.entries(sources)){
  await t.test('K05 MySQL '+name+': trusted payment facts survive reconnect and revoked-permission replay without duplicates',async()=>{
   const id='k05-first-'+name;await seed(id,s=>source.prepare(s));const run=application(id),cmd=source.command('original');
   const first=await run.app.execute(cmd,login.credential),actual=await inspect(id);facts(actual,source,run.context());
   assert.equal(actual.head.revision,1);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);
   const permissionId=name==='retail'?'retail.sale':'credit.repay.approve';
   await auth.revokePermission({principalId:login.principalId,permissionId});const reconnect=mysql.createPool(poolOptions);
   try{
    const again=application(id,{connectionPool:reconnect,transactCommand:()=>assert.fail('replay executed domain')});
    assert.deepEqual(await again.app.execute(cmd,login.credential),first);await assertUnchanged(id,actual);
    await assert.rejects(again.app.execute(source.command('new',1),login.credential),e=>e.status==='authorization-denied');
    await assertUnchanged(id,actual);
   }finally{await reconnect.end();await auth.grantPermission({principalId:login.principalId,permissionId});}
  });

  await t.test('K05 MySQL '+name+': two verified connections compete on old revision and produce funds once',async()=>{
   const id='k05-race-'+name;await seed(id,s=>source.prepare(s));const a=await pool.getConnection(),b=await pool.getConnection();
   try{
    const [[ai]]=await a.query('SELECT CONNECTION_ID() AS id'),[[bi]]=await b.query('SELECT CONNECTION_ID() AS id');
    assert.notEqual(ai.id,bi.id);await a.query('SET SESSION innodb_lock_wait_timeout=5');await b.query('SET SESSION innodb_lock_wait_timeout=5');
    const first=application(id,{connectionPool:{getConnection:async()=>wrapConnection(a,[],false)}});
    const second=application(id,{connectionPool:{getConnection:async()=>wrapConnection(b,[],false)}});
    const results=await Promise.all([first.app.execute(source.command('a'),login.credential),second.app.execute(source.command('b'),login.credential)]);
    assert.deepEqual(results.map(r=>r.status).sort(),['committed','revision-conflict']);assert.equal(first.executions()+second.executions(),1);
    const winner=results[0].status==='committed'?first:second,actual=await inspect(id);facts(actual,source,winner.context());
    assert.equal(actual.head.revision,1);assert.equal(actual.operations.length,2);assert.equal(actual.audit.length,1);
    t.diagnostic('K05 '+name+' verified two independent CONNECTION_ID values');
   }finally{try{await a.rollback();await b.rollback();}finally{a.release();b.release();}}
  });

  for(const fault of ['sql','unknown'])await t.test('K05 MySQL '+name+': '+fault+' failure rolls back payment/state/inventory/credit/revision/operation/audit',async()=>{
   const id='k05-fault-'+name+'-'+fault;await seed(id,s=>source.prepare(s));const before=await inspect(id);let broken=true;
   const run=application(id,{transactCommand:(...args)=>{const next=transact(...args);if(fault==='unknown'&&broken)throw Error('synthetic K05 fault');return next;}});
   const cmd=source.command('retry');
   if(fault==='sql')await setup.query('ALTER TABLE '+table('ledger_success_audit')+" ADD CONSTRAINT chk_k05_fault CHECK (ledger_id <> '"+id+"')");
   try{
    await assert.rejects(run.app.execute(cmd,login.credential),e=>fault==='sql'?e.code==='ER_CHECK_CONSTRAINT_VIOLATED':e.message==='synthetic K05 fault');
    assert.ok(run.calls.some(c=>c.kind==='rollback'));assert.ok(!run.calls.some(c=>c.kind==='commit'));await assertUnchanged(id,before);
    if(fault==='sql')assert.ok(run.calls.some(c=>c.kind==='sql'&&c.sql.startsWith('INSERT ')&&c.sql.includes('ledger_operations')));
   }finally{if(fault==='sql')await setup.query('ALTER TABLE '+table('ledger_success_audit')+' DROP CHECK chk_k05_fault');}
   broken=false;assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');const actual=await inspect(id);
   facts(actual,source,run.context());assert.equal(actual.head.revision,1);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);
  });
 }

 await t.test('K05 MySQL: JSON roundtrip keeps frozen revenue date, cross-day microsecond funds and ambiguous legacy facts separate',async()=>{
  const payments=[{paymentId:'synthetic-before',occurredAt:'2026-10-05T11:59:59.999999+08:00',amount:100,method:'现金'},
   {paymentId:'synthetic-noon',occurredAt:'2026-10-05T12:00:00+08:00',amount:200,method:'微信'},
   {amount:50,method:'现金',time:'2026-10-05T14:00:00+08:00'}];
  const original=await seed('k05-projection',s=>{s.orders=[{id:'synthetic-boundary',kind:'room',room:'V01',businessDate:'2026-10-04',
   businessDayRuleVersion:'noon-v1',time:'2026-10-05T11:59:59+08:00',base:300,gift:0,sales:[],payments,
   credit:{repayments:[payments[1]]}}];});
  const actual=await inspect('k05-projection'),state=actual.head.state;assert.deepEqual(state,original);
  const d1={fromBusinessDate:'2026-10-04',toBusinessDate:'2026-10-05'},d2={fromBusinessDate:'2026-10-05',toBusinessDate:'2026-10-06'};
  assert.equal(selectRevenueOrders(state,d1).orders.length,1);assert.equal(selectRevenueOrders(state,d2).orders.length,0);
  const before=selectPaymentFlows(state,{from:'2026-10-04T12:00:00+08:00',to:'2026-10-05T12:00:00+08:00'});
  const after=selectPaymentFlows(state,{from:'2026-10-05T12:00:00+08:00',to:'2026-10-06T12:00:00+08:00'});
  assert.equal(before.totalCents,100);assert.equal(after.totalCents,200);assert.equal(after.payments.length,1);
  assert.equal(after.complete,false);assert.equal(after.ambiguities[0].code,'PAYMENT_TIME_AMBIGUOUS');
  const report=reportViewModel(state,'day',{...d2,paymentInterval:{from:'2026-10-05T12:00:00+08:00',to:'2026-10-06T12:00:00+08:00'}});
  assert.equal(report.totals.total,0);assert.equal(report.cashFlow.totalCents,200);assert.deepEqual(state,original);
 });
}
