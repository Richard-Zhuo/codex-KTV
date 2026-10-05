import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact, OTHER_CHARGE_CATEGORIES } from '../rules.js';
import { total } from '../sales.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { EMPLOYEE_ATTRIBUTED_ACTIONS } from './employee-attribution.js';
import { ORDER_ADDITION_TEST_ACTIONS, orderAdditionPermission, seedOrderAdditions, orderAdditionCommand, additionOrder } from '../test-support/trusted-order-additions-fixture.js';

const dbNow='2026-10-04T12:00:00.123456Z';
const denied=e=>e instanceof AuthorizationDenied&&e.status==='authorization-denied';
function fixture(action,{permissions=[orderAdditionPermission(action)],setup=()=>{},execute=transact}={}) {
  const state=initialState();state.user='not-a-demo-user';state.clock='invalid-demo-clock';
  state.permissions={administrator:['管理员']};state.capabilities={administrator:['*']};state.administrator=true;
  state.orders=[{id:'history',kind:'retail',room:null,sales:[{productNameSnapshot:null,pricePerSaleUnitCents:null}],payments:[{method:'现金',amount:10}]}];
  seedOrderAdditions(state);setup(state);
  const memory=createMemoryLedgerStore(state,{ledgerId:'order-additions-unit'}),digest=Buffer.alloc(32,13),events=[];
  const auth={id:'synthetic-session-actor',permissions,enabled:true,revoked:false,version:1,sessionVersion:1,
    idle:'2099-01-01T00:00:00.000000Z',absolute:'2099-01-02T00:00:00.000000Z'};
  const port={locateSessionByDigest:async()=>({principalId:auth.id,sessionId:'synthetic-session'}),
    lockAccount:async()=>{events.push('account');return {principalId:auth.id,enabled:auth.enabled,credentialVersion: auth.version, policyAttributesConfigured: false};},
    lockSessionById:async()=>{events.push('session');return {principalId:auth.id,sessionId:'synthetic-session',tokenDigest:digest,
      revoked:auth.revoked,credentialVersion:auth.sessionVersion,idleExpiresAt:auth.idle,absoluteExpiresAt:auth.absolute};},
    listGrants:async()=>{events.push('grants');return auth.permissions;},listPolicyAttributes:async()=>[],readDbNow:async()=>{events.push('db-now');return dbNow;}};
  let context,executions=0;
  const store={ledgerId:memory.ledgerId,runAtomic:work=>memory.runAtomic(tx=>{
    events.push('head');const find=tx.findOperationResult;tx.findOperationResult=key=>{events.push('operation');return find(key);};
    tx.sessionRevalidation={revalidateSessionInTransaction:credential=>revalidateSessionInTransaction({port,...credential})};
    // Deliberately omit the employee port: neither action has employee attribution.
    return work(tx);
  })};
  const app=createTrustedLedgerApplication({store,transactCommand:(...args)=>{events.push('transact');executions++;context=args[4].context;return execute(...args);}});
  return {app,state,memory,auth,events,credential:{tokenDigest:digest},context:()=>context,executions:()=>executions};
}
async function noEffects(f){const head=await f.memory.read();assert.deepEqual(head.state,f.state);assert.equal(head.revision,0);
  assert.equal(head.operationResults.size,0);assert.equal(head.audit.length,0);}

for(const action of ORDER_ADDITION_TEST_ACTIONS){
  const request=(key='first',revision=0,changes={})=>orderAdditionCommand(action,key,revision,changes);
  test(action+': trusted actor/time commit only original order change, preserving inventory, payments and historical snapshots',async()=>{
    const f=fixture(action),cmd=request('first',0,{actorId:'administrator',principalId:'forged',user:'administrator',role:'administrator',
      permissions:['*'],clock:'1900-01-01',person:'forged',actualActorPrincipalId:'forged',servedBy:'forged',servedByPrincipalId:'forged',
      employee:'10000000-0000-4000-8000-000000000001'});
    const result=await f.app.execute(cmd,f.credential),head=await f.memory.read(),order=additionOrder(head.state),expected=structuredClone(f.state);
    assert.equal(result.status,'committed');assert.equal(result.actorId,f.auth.id);assert.equal(head.revision,1);assert.equal(f.executions(),1);
    if(action==='otherCharge'){
      const line=order.otherCharges.at(-1);assert.equal(line.actualActorPrincipalId,f.auth.id);assert.equal(line.person,f.auth.id);assert.equal(line.time,dbNow);
      assert.equal(line.amount,8800);assert.equal(line.category,'其他');assert.equal(line.item,'Synthetic Room Service');
      assert.equal(total(order),45100);expected.serial+=2;additionOrder(expected).otherCharges.push(line);
      assert.equal(Object.hasOwn(line,'creditedEmployeeId'),false);
    }else{
      const extra=order.extras[0];assert.equal(extra.served,true);assert.equal(extra.servedBy,f.auth.id);assert.equal(extra.servedByPrincipalId,f.auth.id);assert.equal(extra.servedAt,dbNow);
      Object.assign(additionOrder(expected).extras[0],{served:true,servedBy:f.auth.id,servedByPrincipalId:f.auth.id,servedAt:dbNow});
      assert.equal(total(order),36300);
    }
    expected.processed.push('first');assert.deepEqual(head.state,expected);assert.equal(head.state.inventory.bw.count,0);assert.equal(head.state.inventory.qd.count,null);
    assert.equal(head.operationResults.get('first').actorId,f.auth.id);assert.equal(head.audit[0].actorId,f.auth.id);
    assert.deepEqual(f.events,['head','account','session','grants','db-now','operation','transact']);
    assert.equal(f.context().dbNow,dbNow);assert.equal(Object.hasOwn(f.context(),'creditedEmployeeId'),false);
  });
  test(action+': specific grant cannot come from backend.view, staff.record, demo role or payload; denied key succeeds after grant',async()=>{
    for(const permissions of [[],['backend.view'],['staff.record'],[action==='serveExtra'?'order.sale':'order.serveExtra']]){
      const f=fixture(action,{permissions}),cmd=request('denied',0,{permissions:[orderAdditionPermission(action)],role:'administrator',actorId:'administrator'});
      await assert.rejects(f.app.execute(cmd,f.credential),denied);await noEffects(f);assert.equal(f.executions(),0);
      f.auth.permissions=[orderAdditionPermission(action)];assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');
    }
  });
  test(action+': unsupported credited employee cannot confer authorization or introduce attribution',async()=>{
    assert.deepEqual(EMPLOYEE_ATTRIBUTED_ACTIONS,['reserve','sale','retailSale','open']);const f=fixture(action);
    await assert.rejects(f.app.execute(request('attribution',0,{creditedEmployeeId:'10000000-0000-4000-8000-000000000001'}),f.credential),e=>denied(e)&&e.reason==='invalid-attribution');
    await noEffects(f);assert.equal((await f.app.execute(request('attribution'),f.credential)).status,'committed');
  });
  test(action+': revoke replay returns original terminal and new operation is denied without more state changes',async()=>{
    const f=fixture(action),cmd=request(),first=await f.app.execute(cmd,f.credential),before=await f.memory.read();f.auth.permissions=[];
    assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.equal(f.executions(),1);
    await assert.rejects(f.app.execute(request('new',1),f.credential),denied);assert.deepEqual(await f.memory.read(),before);
  });
  test(action+': disabled/revoked/idle/absolute/credential invalidation cannot read existing result',async()=>{
    for(const invalidate of [f=>f.auth.enabled=false,f=>f.auth.revoked=true,f=>f.auth.idle=dbNow,f=>f.auth.absolute=dbNow,f=>f.auth.version=2]){
      const f=fixture(action),cmd=request();await f.app.execute(cmd,f.credential);const before=await f.memory.read();invalidate(f);f.events.length=0;
      await assert.rejects(f.app.execute(cmd,f.credential),e=>e.code==='AUTHENTICATION_REQUIRED');assert.equal(f.events.includes('operation'),false);
      assert.deepEqual(await f.memory.read(),before);
    }
  });
  test(action+': actor, action, payload and expectedRevision conflicts preserve old terminal',async()=>{
    const f=fixture(action),cmd=request();await f.app.execute(cmd,f.credential);const before=await f.memory.read();f.auth.permissions=[];
    f.auth.id='synthetic-other-actor';assert.equal((await f.app.execute(cmd,f.credential)).reason,'actor-mismatch');f.auth.id='synthetic-session-actor';
    for(const changed of [{...cmd,expectedRevision:1},{...cmd,action:'open'},{...cmd,payload:{...cmd.payload,note:'changed'}}]){
      assert.equal((await f.app.execute(changed,f.credential)).reason,'request-mismatch');
    }
    assert.equal(f.executions(),1);assert.deepEqual(await f.memory.read(),before);
  });
  test(action+': stale revision is terminal, unchanged after later grant revocation',async()=>{
    const f=fixture(action),cmd=request('stale',99),result=await f.app.execute(cmd,f.credential);assert.equal(result.status,'revision-conflict');
    const before=await f.memory.read();assert.deepEqual(before.state,f.state);assert.equal(before.revision,0);assert.equal(before.operationResults.size,1);assert.equal(before.audit.length,0);
    f.auth.permissions=[];assert.deepEqual(await f.app.execute(cmd,f.credential),result);assert.equal(f.executions(),0);assert.deepEqual(await f.memory.read(),before);
  });
  test(action+': original domain rejections are atomic business terminals and cannot later re-execute',async()=>{
    const cases=[['missing-order',{},s=>s.orders=[],/账单已变化/],['closed-order',{},s=>additionOrder(s).status='已结账',/账单已变化/]];
    if(action==='serveExtra')cases.push(['missing-extra',{product:'unknown'},()=>{},/没有这项配品/],['already-served',{product:'already-served'},()=>{},/已经标记已上/]);
    else cases.push(['category',{category:'invalid'},()=>{},/类别/],['zero',{amount:0},()=>{},/金额/],['negative',{amount:-1},()=>{},/金额/],
      ['fraction',{amount:0.01},()=>{},/金额/],['overflow',{amount:Number.MAX_SAFE_INTEGER+1},()=>{},/金额/],['empty-item',{item:'  '},()=>{},/项目/]);
    for(const [label,changes,setup,message]of cases){const f=fixture(action,{setup}),cmd=request(label,0,changes),result=await f.app.execute(cmd,f.credential);
      assert.equal(result.status,'business-rejected');assert.match(result.reason,message);const head=await f.memory.read();
      assert.deepEqual(head.state,f.state);assert.equal(head.revision,0);assert.equal(head.operationResults.size,1);assert.equal(head.audit.length,0);
      f.auth.permissions=[];assert.deepEqual(await f.app.execute(cmd,f.credential),result);
    }
  });
  test(action+': unknown exception after domain mutation rolls back and original operation key remains reusable',async()=>{
    let fail=true;const f=fixture(action,{execute:(...args)=>{const next=transact(...args);if(fail)throw Error('synthetic order fault');return next;}});
    const cmd=request('retry');await assert.rejects(f.app.execute(cmd,f.credential),/synthetic order fault/);await noEffects(f);
    fail=false;assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');
  });
  test(action+': missing or copied trusted context never falls back to demo',async()=>{
    const f=fixture(action);await f.app.execute(request(),f.credential);
    for(const context of [undefined,structuredClone(f.context()),{...f.context()}])assert.throws(()=>transact(f.state,action,request().payload,'direct',{mode:'trusted',context}),TypeError);
    const deniedContext=fixture(action,{permissions:['room.clean'],setup:s=>s.rooms[1].status='待清洁'});
    await deniedContext.app.execute({operationKey:'clean',expectedRevision:0,action:'clean',payload:{room:'V02'}},deniedContext.credential);
    assert.throws(()=>transact(f.state,action,request().payload,'direct',{mode:'trusted',context:deniedContext.context()}),denied);
  });
  test(action+': historical package snapshots and original category/mark-only rules survive current catalog changes',async()=>{
    if(action==='serveExtra'){
      const f=fixture(action,{setup:s=>{s.catalog.products.find(p=>p.id==='water').name='Current Rename';s.catalog.products.find(p=>p.id==='water').active=false;}});
      const initialTotal=total(additionOrder(f.state)),initialInventory=structuredClone(f.state.inventory),initialLedger=structuredClone(f.state.ledger);
      for(const [key,product]of [['water','water'],['removed','removed-extra']])assert.equal((await f.app.execute(request(key,key==='water'?0:1,{product}),f.credential)).status,'committed');
      const {state}=await f.memory.read();assert.deepEqual(state.inventory,initialInventory);assert.deepEqual(state.ledger,initialLedger);
      assert.equal(total(additionOrder(state)),initialTotal);assert.equal(additionOrder(state).extras[0].productNameSnapshot,'Historical Water');
      assert.equal(additionOrder(state).extras[1].productNameSnapshot,null);
    }else{
      const f=fixture(action);let revision=0;
      for(const category of OTHER_CHARGE_CATEGORIES)assert.equal((await f.app.execute(request(category,revision++,{category:'  '+category+'  ',item:' '+('x'.repeat(70))+' ',amount:1}),f.credential)).status,'committed');
      const {state}=await f.memory.read(),lines=additionOrder(state).otherCharges.slice(1);
      assert.deepEqual(lines.map(l=>l.category),OTHER_CHARGE_CATEGORIES);assert.equal(lines.at(-1).item,'x'.repeat(50));
      assert.ok(lines.slice(0,-1).every(l=>l.item===l.category));assert.equal(total(additionOrder(state)),36300+OTHER_CHARGE_CATEGORIES.length);
      assert.deepEqual(state.inventory,f.state.inventory);assert.deepEqual(state.ledger,f.state.ledger);
    }
  });
}
