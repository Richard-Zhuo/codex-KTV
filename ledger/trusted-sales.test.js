import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { submitSale, submitRetailSale, total } from '../sales.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTransactionBoundEmployeeResolver } from '../employees/employee-resolver.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { createTrustedLedgerApplication } from './application.js';
import { SALES_TEST_ACTIONS, seedTrustedSalesState, salesCommand, soldOrder } from '../test-support/trusted-sales-fixture.js';

const employeeId='10000000-0000-4000-8000-000000000001';
const secondId='10000000-0000-4000-8000-000000000002';
const dbNow='2026-10-04T12:00:00.123456Z';
const denied=e=>e instanceof AuthorizationDenied&&e.status==='authorization-denied';
function fixture(action,{permissions=action==='sale'?['staff.record']:['retail.sale','staff.record'],setup=()=>{},resolver=true,execute=transact,clock=dbNow,businessTimeZone='Asia/Shanghai',configureBusinessDay=true}={}) {
  const state=initialState();state.user='not-a-demo-user';state.clock='invalid-demo-clock';
  state.administrator=true;state.permissions={administrator:['管理员']};state.capabilities={administrator:['*']};
  state.orders=[{id:'history',kind:'retail',room:null,sales:[{productNameSnapshot:'unknown historical',pricePerSaleUnitCents:null}],payments:[]}];
  seedTrustedSalesState(state);setup(state);
  const memory=createMemoryLedgerStore(state,{ledgerId:'sales-unit'}),digest=Buffer.alloc(32,11),events=[];
  const auth={id:'synthetic-actual-actor',permissions,enabled:true,revoked:false,version:1,sessionVersion:1,
    idle:'2099-01-01T00:00:00.000000Z',absolute:'2099-01-02T00:00:00.000000Z'};
  const employees=new Map([[employeeId,{employeeId,displayName:'Synthetic Same Name',enabled:true}],
    [secondId,{employeeId:secondId,displayName:'Synthetic Same Name',enabled:true}]]);
  const port={locateSessionByDigest:async()=>({principalId:auth.id,sessionId:'synthetic-session'}),
    lockAccount:async()=>{events.push('account');return {principalId:auth.id,enabled:auth.enabled,credentialVersion: auth.version, policyAttributesConfigured: false};},
    lockSessionById:async()=>{events.push('session');return {principalId:auth.id,sessionId:'synthetic-session',tokenDigest:digest,
      revoked:auth.revoked,credentialVersion:auth.sessionVersion,idleExpiresAt:auth.idle,absoluteExpiresAt:auth.absolute};},
    listGrants:async()=>{events.push('grants');return auth.permissions;},listPolicyAttributes:async()=>[],readDbNow:async()=>{events.push('db-now');return clock;}};
  let context,executions=0,hasResolver=resolver,failure=null;
  const store={ledgerId:memory.ledgerId,runAtomic:work=>memory.runAtomic(tx=>{
    events.push('head');const lookup=tx.findOperationResult;
    tx.findOperationResult=key=>{events.push('operation');return lookup(key);};
    tx.sessionRevalidation={revalidateSessionInTransaction:credential=>revalidateSessionInTransaction({port,...credential})};
    if(hasResolver) tx.employeeResolver=createTransactionBoundEmployeeResolver({port:{lockEmployeeForAttribution:async id=>{
      events.push('employee');if(failure)throw failure;return employees.get(id)??null;
    }}});return work(tx);
  })};
  const app=createTrustedLedgerApplication({store,...(configureBusinessDay ? { businessTimeZone } : {}),transactCommand:(...args)=>{events.push('transact');executions++;context=args[4].context;return execute(...args);}});
  return {app,state,memory,auth,employees,events,credential:{tokenDigest:digest},context:()=>context,executions:()=>executions,
    setResolver:value=>{hasResolver=value;},failResolver:error=>{failure=error;},setClock:value=>{clock=value;}};
}
async function noEffects(f) {const head=await f.memory.read();assert.deepEqual(head.state,f.state);assert.equal(head.revision,0);
  assert.equal(head.operationResults.size,0);assert.equal(head.audit.length,0);}

for (const action of SALES_TEST_ACTIONS) {
  const request=(key='first',revision=0,changes={})=>salesCommand(action,employeeId,key,revision,changes);
  test(action+': trusted actor/employee/time and immutable business facts use the existing sales pipeline',async()=>{
    const f=fixture(action),cmd=request('first',0,{actorId:'administrator',principalId:'forged',permissions:['*'],role:'administrator',clock:'1900-01-01',
      actualActorPrincipalId:'forged',creditedEmployeeNameSnapshot:'forged',recordedBy:'forged',person:'forged'});
    const result=await f.app.execute(cmd,f.credential),head=await f.memory.read(),order=soldOrder(head.state,action),lines=order.sales.slice(-2);
    assert.equal(result.status,'committed');assert.equal(result.actorId,f.auth.id);assert.equal(head.revision,1);
    for(const line of lines) {assert.equal(line.actualActorPrincipalId,f.auth.id);assert.equal(line.recordedBy,f.auth.id);
      assert.equal(line.creditedEmployeeId,employeeId);assert.equal(line.employeeId,employeeId);assert.equal(line.person,'Synthetic Same Name');
      assert.equal(line.creditedEmployeeNameSnapshot,'Synthetic Same Name');assert.equal(line.time,dbNow);}
    assert.deepEqual(lines.map(l=>[l.productId,l.saleQuantity,l.baseQuantityPerSaleUnit,l.totalBaseQuantity,l.pricePerSaleUnitCents,l.amountCents]),
      [['bw',1,6,6,5900,5900],['water',2,1,2,200,400]]);
    assert.equal(head.state.inventory.bw.count,94);assert.equal(head.state.inventory.water.count,98);
    assert.equal(head.state.inventory.qd.count,null);assert.deepEqual(head.state.orders[0],f.state.orders[0]);
    assert.deepEqual(head.state.rooms,f.state.rooms);assert.deepEqual(head.state.ledger.map(row=>row.baseQuantityDelta),[-6,-2]);
    for(const movement of head.state.ledger){assert.equal(movement.actualActorPrincipalId,f.auth.id);assert.equal(movement.person,f.auth.id);
      assert.equal(movement.time,dbNow);assert.equal(movement.counted,true);assert.equal(movement.orderId,order.id);}
    assert.equal(head.operationResults.get('first').actorId,f.auth.id);assert.equal(head.audit[0].actorId,f.auth.id);
    assert.deepEqual(f.events,['head','account','session','grants','db-now','operation','employee','transact']);
    if(action==='sale'){assert.deepEqual(order.sales[0],f.state.orders[1].sales[0]);assert.deepEqual(order.payments,f.state.orders[1].payments);
      assert.equal(total(order),42300);assert.equal(order.status,'营业中');}
    else {assert.equal(order.room,null);assert.equal(order.kind,'retail');assert.equal(total(order),6300);assert.equal(order.status,'已结账');
      assert.equal(order.actualActorPrincipalId,f.auth.id);assert.equal(order.creditedEmployeeId,employeeId);
      assert.deepEqual(order.payments.map(p=>[p.method,p.amount,p.chargeId,p.person,p.time,p.actualActorPrincipalId]),
        [['微信',3000,'retail',f.auth.id,dbNow,f.auth.id],['现金',3300,'retail',f.auth.id,dbNow,f.auth.id]]);}
  });
  test(action+': original delegated permission gate cannot be obtained from employee or forged fields; denied key is reusable',async()=>{
    const deniedGrants=action==='sale'?[[],['order.sale'],['backend.view']]:[[],['retail.sale'],['staff.record'],['backend.view']];
    for(const permissions of deniedGrants){const f=fixture(action,{permissions});const cmd=request('denied',0,{permissions:['staff.record','retail.sale'],role:'administrator'});
      await assert.rejects(f.app.execute(cmd,f.credential),denied);await noEffects(f);assert.equal(f.events.includes('employee'),false);
      f.auth.permissions=['staff.record',...(action==='retailSale'?['retail.sale']:[])];assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');}
  });
  test(action+': explicit UUID only; aliases and same-name employees stay independent from principal',async()=>{
    const f=fixture(action);const canonical=request('a');assert.equal((await f.app.execute(canonical,f.credential)).status,'committed');
    const alias=request('b',1,{employee:secondId});delete alias.payload.creditedEmployeeId;
    assert.equal((await f.app.execute(alias,f.credential)).status,'committed');
    const head=await f.memory.read(),lines=action==='sale'?head.state.orders[1].sales.slice(1):head.state.orders.slice(2).flatMap(o=>o.sales);
    assert.deepEqual(lines.map(l=>l.creditedEmployeeId),[employeeId,employeeId,secondId,secondId]);
    assert.ok(lines.every(l=>l.person==='Synthetic Same Name'&&l.actualActorPrincipalId===f.auth.id));
    for(const changes of [{creditedEmployeeId:undefined},{creditedEmployeeId:'staff'},{creditedEmployeeId:'Synthetic Same Name'},
      {employee:secondId},{creditedEmployeeId:f.auth.id}]){
      const rejected=fixture(action,{permissions:['order.sale','retail.sale','staff.record']});const cmd=request('bad');Object.assign(cmd.payload,changes);if(Object.hasOwn(changes,'creditedEmployeeId')&&changes.creditedEmployeeId===undefined)delete cmd.payload.creditedEmployeeId;
      assert.equal((await rejected.app.execute(cmd,rejected.credential)).status,'business-rejected');
      const result=await rejected.memory.read();assert.deepEqual(result.state,rejected.state);assert.equal(result.revision,0);assert.equal(result.audit.length,0);
    }
  });
  test(action+': unknown/disabled employee creates only terminal rejection, without half a sale or inventory movement',async()=>{
    for(const unavailable of ['unknown','disabled']) {const f=fixture(action);if(unavailable==='unknown')f.employees.delete(employeeId);else f.employees.get(employeeId).enabled=false;
      const result=await f.app.execute(request('bad'),f.credential);assert.equal(result.status,'business-rejected');const head=await f.memory.read();
      assert.deepEqual(head.state,f.state);assert.equal(head.revision,0);assert.equal(head.operationResults.size,1);assert.equal(head.audit.length,0);assert.equal(f.executions(),0);
      f.employees.set(employeeId,{employeeId,displayName:'Renamed',enabled:true});assert.deepEqual(await f.app.execute(request('bad'),f.credential),result);
    }
  });
  test(action+': revoked grants/renamed disabled employee replay original receipt, and never repeat payment or inventory effects',async()=>{
    const f=fixture(action),cmd=request(),first=await f.app.execute(cmd,f.credential),before=await f.memory.read();
    f.auth.permissions=[];f.employees.get(employeeId).enabled=false;f.employees.get(employeeId).displayName='Changed';f.setResolver(false);f.events.length=0;
    assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.equal(f.events.includes('employee'),false);assert.equal(f.executions(),1);
    await assert.rejects(f.app.execute(request('new',1),f.credential),denied);assert.deepEqual(await f.memory.read(),before);
  });
  test(action+': inactive authentication blocks old receipts before lookup',async()=>{
    for(const invalidate of [f=>f.auth.enabled=false,f=>f.auth.revoked=true,f=>f.auth.idle=dbNow,f=>f.auth.absolute=dbNow,f=>f.auth.version=2]){
      const f=fixture(action),cmd=request();await f.app.execute(cmd,f.credential);const before=await f.memory.read();invalidate(f);f.events.length=0;
      await assert.rejects(f.app.execute(cmd,f.credential),e=>e.code==='AUTHENTICATION_REQUIRED');assert.deepEqual(await f.memory.read(),before);
      assert.equal(f.events.includes('operation'),false);
    }
  });
  test(action+': actor/payload/revision conflicts retain Stage 1 semantics and do not consult employee or current grants',async()=>{
    const f=fixture(action),cmd=request();await f.app.execute(cmd,f.credential);const before=await f.memory.read();f.auth.permissions=[];
    f.auth.id='other-actor';assert.equal((await f.app.execute(cmd,f.credential)).reason,'actor-mismatch');f.auth.id='synthetic-actual-actor';
    for(const changed of [{...cmd,expectedRevision:1},{...cmd,payload:{...cmd.payload,creditedEmployeeId:secondId}},
      {...cmd,payload:{...cmd.payload,items:[{product:'bw',spec:'half',count:2}]}},{...cmd,action:'open'}])
      assert.equal((await f.app.execute(changed,f.credential)).reason,'request-mismatch');
    assert.deepEqual(await f.memory.read(),before);
    const stale=fixture(action);const result=await stale.app.execute(request('stale',4),stale.credential);assert.equal(result.status,'revision-conflict');
    assert.equal(stale.events.includes('employee'),false);stale.auth.permissions=[];assert.deepEqual(await stale.app.execute(request('stale',4),stale.credential),result);
  });
  test(action+': missing resolver/context, copied context or mismatched employee cannot use demo fallback',async()=>{
    const f=fixture(action,{resolver:false});await assert.rejects(f.app.execute(request(),f.credential),TypeError);await noEffects(f);
    f.setResolver(true);await f.app.execute(request(),f.credential);
    for(const context of [undefined,structuredClone(f.context()),{...f.context()}]) assert.throws(()=>transact(f.state,action,request().payload,'direct',{mode:'trusted',context}),TypeError);
    assert.throws(()=>transact(f.state,action,request('x',0,{creditedEmployeeId:secondId}).payload,'direct',{mode:'trusted',context:f.context()}),TypeError);
    const guarded=new Proxy(structuredClone(f.state),{get(target,key,receiver){if(['user','permissions','capabilities','clock','administrator'].includes(key))throw Error('demo fact read');return Reflect.get(target,key,receiver);}});
    if(action==='sale')submitSale(guarded,guarded.orders[1],request().payload,'forged','forged','forged',{mode:'trusted',context:f.context()});
    else submitRetailSale(guarded,request().payload,'forged','forged','forged',{mode:'trusted',context:f.context()});
  });
  test(action+': unexpected resolver/domain error rolls back all effects and keeps original key reusable',async()=>{
    const f=fixture(action);const fault=Error('synthetic SQL');f.failResolver(fault);
    await assert.rejects(f.app.execute(request('retry'),f.credential),fault);await noEffects(f);f.failResolver(null);
    assert.equal((await f.app.execute(request('retry'),f.credential)).status,'committed');
    let fail=true;const other=fixture(action,{execute:(...args)=>{const next=transact(...args);if(fail)throw Error('synthetic after sale');return next;}});
    await assert.rejects(other.app.execute(request('retry'),other.credential),/synthetic after sale/);await noEffects(other);fail=false;
    assert.equal((await other.app.execute(request('retry'),other.credential)).status,'committed');
  });
  test(action+': null/zero/insufficient stock, inactive product, invalid quantities and retail payment errors preserve whole-state atomicity',async()=>{
    const cases=[['uncounted',s=>s.inventory.bw.count=null,{},/未建账/],['zero',s=>s.inventory.bw.count=0,{},/库存不足/],
      ['aggregate',s=>s.inventory.bw.count=7,{items:[{product:'bw',spec:'half',count:1},{product:'bw',spec:'half',count:1}]},/库存不足/],
      ['inactive',s=>s.catalog.products.find(p=>p.id==='water').active=false,{},/不可销售/],
      ['quantity',()=>{},{items:[{product:'bw',spec:'single',count:0}]},/数量/],
      ['price',s=>s.catalog.products.find(p=>p.id==='bw').saleOptions.find(o=>o.id==='half').priceCents=0,{},/价格/]];
    if(action==='sale')cases.push(['inactive-order',s=>s.orders[1].status='已结账',{},/账单已变化/]);
    else cases.push(['payment-total',()=>{},{payments:[{method:'现金',amount:1}]},/之和必须等于/],
      ['payment-method',()=>{},{payments:[{method:'invalid',amount:6300}]},/收款方式/]);
    for(const [label,setup,changes,message]of cases){const f=fixture(action,{setup}),result=await f.app.execute(request(label,0,changes),f.credential);
      assert.equal(result.status,'business-rejected',label);assert.match(result.reason,message);const head=await f.memory.read();
      assert.deepEqual(head.state,f.state);assert.equal(head.revision,0);assert.equal(head.audit.length,0);assert.equal(head.operationResults.size,1);}
  });
  test(action+': manual sale price and non-inventory product preserve runtime catalog facts',async()=>{
    const f=fixture(action,{setup:s=>{s.catalog.products.find(p=>p.id==='bw').manualPriceAllowed=true;}});
    const items=[{productId:'bw',saleOptionId:'dozen',saleQuantity:2,manualPriceCents:12345},{product:'synthetic_service',spec:'single',count:2,manualPriceCents:1}];
    const changes={items,...(action==='retailSale'?{payments:[{method:'现金',amount:25190}]}:{})};
    assert.equal((await f.app.execute(request('manual',0,changes),f.credential)).status,'committed');const head=await f.memory.read(),lines=soldOrder(head.state,action).sales.slice(-2);
    assert.deepEqual(lines.map(l=>[l.totalBaseQuantity,l.pricePerSaleUnitCents,l.amountCents]),[[24,12345,24690],[2,250,500]]);
    assert.equal(head.state.inventory.bw.count,76);assert.equal(head.state.ledger.length,1);assert.equal(head.state.inventory.synthetic_service,undefined);
  });
}

test('K05: retailSale freezes business date from dbNow and explicit store zone before noon', async () => {
  const f=fixture('retailSale',{clock:'2026-10-05T03:59:59.000000Z',businessTimeZone:'Asia/Shanghai'});
  await f.app.execute(salesCommand('retailSale',employeeId,'dated-retail',0),f.credential);
  const saved=soldOrder((await f.memory.read()).state,'retailSale');
  assert.equal(saved.businessDate,'2026-10-04');
  assert.equal(saved.businessDayRuleVersion,'noon-v1');
  assert.equal(saved.businessTimeZone,'Asia/Shanghai');
});

test('K05: trusted retail payments have unique server IDs, real times and actor; replay preserves them',async()=>{
 const f=fixture('retailSale'),cmd=salesCommand('retailSale',employeeId,'payment-facts');
 const first=await f.app.execute(cmd,f.credential),head=await f.memory.read(),order=soldOrder(head.state,'retailSale');
 assert.equal(new Set(order.payments.map(p=>p.paymentId)).size,2);
 for(const payment of order.payments){
  assert.match(payment.paymentId,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(payment.occurredAt,dbNow);assert.equal(payment.recordedByPrincipalId,f.auth.id);
 }
 f.auth.permissions=[];assert.deepEqual(await f.app.execute(cmd,f.credential),first);
 assert.deepEqual(await f.memory.read(),head);assert.equal(f.executions(),1);
});

for(const [time,date]of [['2026-10-05T03:59:59.000000Z','2026-10-04'],['2026-10-05T04:00:00.000000Z','2026-10-05'],
 ['2026-10-05T04:00:01.000000Z','2026-10-05'],['2026-10-04T18:00:00.000000Z','2026-10-04'],['2026-10-05T12:00:00.000000Z','2026-10-05']]){
 test('K05: retail freezes '+time+' as '+date+'; replay never recomputes',async()=>{
  const f=fixture('retailSale',{clock:time}),cmd=salesCommand('retailSale',employeeId,'date-freeze');
  const first=await f.app.execute(cmd,f.credential),head=await f.memory.read(),order=soldOrder(head.state,'retailSale');
  assert.equal(order.businessDate,date);assert.equal(order.businessDayRuleVersion,'noon-v1');
  assert.ok(order.payments.every(p=>p.occurredAt===time));f.setClock('2026-10-06T12:00:00.000000Z');
  assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.deepEqual(await f.memory.read(),head);
 });
}
test('K05: new trusted retail order without configured store time zone fails without consuming operation key',async()=>{
 const f=fixture('retailSale',{configureBusinessDay:false});
 await assert.rejects(f.app.execute(salesCommand('retailSale',employeeId,'no-zone'),f.credential),/explicit store timeZone/);
 await noEffects(f);assert.equal(f.executions(),0);
});

for(const action of ['sale','retailSale']) test('Stage 4A '+action+': DAY price is server resolved, snapshotted and replayed unchanged',async()=>{
 const { businessSessionFor }=await import('../shared/business-session.js');
 const clock='2026-10-08T07:00:00.000000Z';
 const f=fixture(action,{clock,setup:s=>{
   s.inventory.drink0.count=100;s.inventory.lm.count=100;
   if(action==='sale')s.orders.at(-1).businessSession=businessSessionFor(clock,{timeZone:'Asia/Shanghai'});
 }});
 const request=salesCommand(action,employeeId,'day-price',0,{
   sessionType:'NIGHT',pricePlanId:'forged',durationMinutes:9999,targetEndAt:'2099-01-01',
   items:[{product:'bw',spec:'dozen',count:1},{product:'lm',spec:'dozen',count:1},{product:'drink0',spec:'dozen',count:1}],
   ...(action==='retailSale'?{payments:[{method:'现金',amount:32000}]}:{})});
 assert.equal((await f.app.execute(request,f.credential)).status,'committed');
 const h=await f.memory.read(),o=soldOrder(h.state,action),lines=o.sales.slice(-3);
 assert.deepEqual(lines.map(l=>l.pricePerSaleUnitCents),[10000,12000,10000]);
 for(const l of lines){assert.equal(l.pricePlanId,'day-v1');assert.equal(l.businessSession.sessionType,'DAY');assert.equal(l.businessSession.targetEndAt,'2026-10-08T10:00:00.000Z');}
 assert.deepEqual(h.state.orders[0],f.state.orders[0]);
 const saved=structuredClone(lines);f.setClock('2026-10-08T12:00:00.000000Z');
 assert.equal((await f.app.execute(request,f.credential)).status,'committed');
 assert.deepEqual(soldOrder((await f.memory.read()).state,action).sales.slice(-3),saved);
});
test('Stage 4A: historical room without session snapshot uses existing plan, ignores payload DAY',async()=>{
 const f=fixture('sale',{clock:'2026-10-08T07:00:00.000000Z'});
 await f.app.execute(salesCommand('sale',employeeId,'legacy',0,{sessionType:'DAY',items:[{product:'bw',spec:'dozen',count:1}]}),f.credential);
 const l=soldOrder((await f.memory.read()).state,'sale').sales.at(-1);
 assert.equal(l.pricePerSaleUnitCents,11800);assert.equal(l.pricePlanId,'night-existing-v1');assert.equal(l.businessSession,null);
});

test('Stage 4A: catalog changes affect future sales only; existing transaction snapshots stay frozen',async()=>{
 const { businessSessionFor }=await import('../shared/business-session.js');
 const clock='2026-10-08T07:00:00.000000Z';
 const f=fixture('sale',{permissions:['staff.record','catalog.manage'],clock,setup:s=>{
   s.orders.at(-1).businessSession=businessSessionFor(clock,{timeZone:'Asia/Shanghai'});
 }});
 const request=salesCommand('sale',employeeId,'day',0,{items:[{product:'bw',spec:'dozen',count:1}]});
 await f.app.execute(request,f.credential);const before=structuredClone(soldOrder((await f.memory.read()).state,'sale').sales.at(-1));
 await f.app.execute({action:'updateCatalogProduct',operationKey:'change',expectedRevision:1,payload:{id:'bw',name:'Future name',priceCategory:'PREMIUM_BEER'}},f.credential);
 await f.app.execute({...request,operationKey:'next',expectedRevision:2},f.credential);
 const lines=soldOrder((await f.memory.read()).state,'sale').sales;
 assert.deepEqual(lines.at(-2),before);assert.equal(lines.at(-1).pricePerSaleUnitCents,12000);assert.equal(lines.at(-1).productNameSnapshot,'Future name');
});
