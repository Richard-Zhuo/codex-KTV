import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { reserveRoom, reservationTarget } from '../rooms.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTransactionBoundEmployeeResolver } from '../employees/employee-resolver.js';
import { EmployeeRosterError } from '../employees/errors.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMemoryLedgerStore } from './memory-store.js';

const employeeId = '10000000-0000-4000-8000-000000000001';
const otherEmployeeId = '10000000-0000-4000-8000-000000000002';
const dbNow = '2026-10-03T12:00:00.123456Z';
const payload = () => ({room:'V01',employee:employeeId,dayOffset:2,session:'night',source:'手机',note:'original note'});
const request = (key='reserve-1', revision=0, data=payload()) => ({operationKey:key,expectedRevision:revision,action:'reserve',payload:data});
const denied = error => error instanceof AuthorizationDenied && error.status==='authorization-denied';
function fixture({permissions=['staff.record'],setup=()=>{},resolver=true,execute=transact}={}) {
  const state=initialState();
  state.user='not-a-demo-user';state.clock='invalid-demo-clock';state.administrator=true;
  state.permissions={administrator:['管理员']};state.capabilities={administrator:['*']};
  state.rooms[0].status='空闲'; state.inventory.bw.count=0;
  state.orders=[{id:'history',kind:'retail',room:null,sales:[{productNameSnapshot:'old',pricePerSaleUnitCents:null}],payments:[{method:'现金',amount:100},{method:'微信',amount:200}]}];
  setup(state);
  const memory=createMemoryLedgerStore(state,{ledgerId:'reserve-unit'}), digest=Buffer.alloc(32,9), events=[];
  const auth={id:'synthetic-actor',permissions,enabled:true,revoked:false,version:1,sessionVersion:1,
    idle:'2099-01-01T00:00:00.000000Z',absolute:'2099-01-02T00:00:00.000000Z'};
  const employees=new Map([[employeeId,{employeeId,displayName:'Synthetic Same Name',enabled:true}],
    [otherEmployeeId,{employeeId:otherEmployeeId,displayName:'Synthetic Same Name',enabled:true}]]);
  let context,executionCount=0,resolverFailure=null,hasResolver=resolver;
  const port={
    locateSessionByDigest:async()=>({principalId:auth.id,sessionId:'synthetic-session'}),
    lockAccount:async()=>{events.push('account');return {principalId:auth.id,enabled:auth.enabled,credentialVersion: auth.version, policyAttributesConfigured: false};},
    lockSessionById:async()=>{events.push('session');return {principalId:auth.id,sessionId:'synthetic-session',tokenDigest:digest,
      revoked:auth.revoked,credentialVersion:auth.sessionVersion,idleExpiresAt:auth.idle,absoluteExpiresAt:auth.absolute};},
    listGrants:async()=>{events.push('grants');return auth.permissions;},
    listPolicyAttributes: async () => [],
    readDbNow:async()=>{events.push('db-now');return dbNow;}
  };
  const store={ledgerId:memory.ledgerId,runAtomic:work=>memory.runAtomic(tx=>{
    events.push('head');const lookup=tx.findOperationResult;
    tx.findOperationResult=async key=>{events.push('operation');return lookup(key);};
    tx.sessionRevalidation={revalidateSessionInTransaction:credential=>revalidateSessionInTransaction({port,...credential})};
    if(hasResolver) tx.employeeResolver=createTransactionBoundEmployeeResolver({port:{lockEmployeeForAttribution:async id=>{
      events.push('employee');if(resolverFailure) throw resolverFailure; return employees.get(id)??null;
    }}});
    return work(tx);
  })};
  const app=createTrustedLedgerApplication({store,transactCommand:(...args)=>{
    executionCount++;events.push('transact');context=args[4].context;return execute(...args);
  }});
  return {app,state,memory,auth,employees,events,credential:{tokenDigest:digest},context:()=>context,
    executions:()=>executionCount,failResolver:error=>{resolverFailure=error;},setResolver:value=>{hasResolver=value;}};
}
async function unchanged(f) {
  const head=await f.memory.read();assert.deepEqual(head.state,f.state);assert.equal(head.revision,0);
  assert.equal(head.operationResults.size,0);assert.equal(head.audit.length,0);
}

test('reserve: resolved UUID/name snapshot and session actor are independent; DB time alone sets target',async()=>{
  const f=fixture(), cmd=request('first',0,{...payload(),actorId:'administrator',principalId:'forged',user:'administrator',
    permissions:['*'],role:'administrator',clock:'1900-01-01',person:'forged name',displayName:'forged name',
    creditedEmployeeNameSnapshot:'forged name',actualActorPrincipalId:'forged'});
  const result=await f.app.execute(cmd,f.credential), head=await f.memory.read(), booking=head.state.reservations.at(-1);
  assert.equal(result.status,'committed');assert.equal(result.actorId,f.auth.id);assert.equal(head.revision,1);
  assert.equal(booking.actualActorPrincipalId,f.auth.id);assert.equal(booking.recordedBy,f.auth.id);
  assert.equal(booking.creditedEmployeeId,employeeId);assert.equal(booking.employeeId,employeeId);
  assert.equal(booking.creditedEmployeeNameSnapshot,'Synthetic Same Name');assert.equal(booking.person,'Synthetic Same Name');
  assert.notEqual(booking.creditedEmployeeId,booking.actualActorPrincipalId);
  assert.equal(booking.at,reservationTarget(dbNow,2,'night'));
  assert.equal(f.context().dbNow,dbNow);assert.equal(Object.isFrozen(f.context()),true);
  assert.deepEqual(f.events,['head','account','session','grants','db-now','operation','employee','transact']);
  assert.equal(head.operationResults.get('first').actorId,f.auth.id);assert.equal(head.audit[0].actorId,f.auth.id);
  const expected=structuredClone(f.state);expected.serial++;expected.reservations.push(booking);expected.processed.push('first');
  assert.deepEqual(head.state,expected,'no unrelated state, historical facts, room or inventory changes');
});

test('reserve: canonical creditedEmployeeId and employee alias accept one explicit UUID; same names stay distinct',async()=>{
  const f=fixture();
  const data={...payload(),creditedEmployeeId:otherEmployeeId};delete data.employee;
  assert.equal((await f.app.execute(request('other',0,data),f.credential)).status,'committed');
  assert.equal((await f.app.execute(request('both',1,{...payload(),creditedEmployeeId:employeeId,dayOffset:3}),f.credential)).status,'committed');
  const head=await f.memory.read();assert.deepEqual(head.state.reservations.map(row=>row.creditedEmployeeId),[otherEmployeeId,employeeId]);
  assert.equal(head.state.reservations[0].person,head.state.reservations[1].person);
});

test('reserve: original delegated staff.record gate cannot be obtained from employee, demo state or payload',async()=>{
  for(const permissions of [[],['room.reserve'],['backend.view'],['room.open']]) {
    const f=fixture({permissions}); const cmd=request('denied',0,{...payload(),permissions:['staff.record'],role:'administrator'});
    await assert.rejects(f.app.execute(cmd,f.credential),denied);await unchanged(f);
    assert.equal(f.events.includes('employee'),false);assert.equal(f.executions(),0);
    f.auth.permissions=['staff.record'];assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');
  }
});

test('reserve: disabled and unknown employees are explicit terminal business rejections',async()=>{
  for(const unavailable of ['disabled','unknown']) {
    const f=fixture();if(unavailable==='disabled') f.employees.get(employeeId).enabled=false;else f.employees.delete(employeeId);
    const cmd=request(unavailable),result=await f.app.execute(cmd,f.credential), before=await f.memory.read();
    assert.equal(result.status,'business-rejected');assert.deepEqual(before.state,f.state);assert.equal(before.revision,0);
    assert.equal(before.audit.length,0);assert.equal(before.operationResults.size,1);assert.equal(f.executions(),0);
    f.employees.set(employeeId,{employeeId,displayName:'Now Enabled',enabled:true});f.auth.permissions=[];
    assert.deepEqual(await f.app.execute(cmd,f.credential),result);assert.deepEqual(await f.memory.read(),before);
  }
});

test('reserve: missing UUID, legacy ID, name and conflicting aliases are never inferred',async()=>{
  for(const data of [{...payload(),employee:undefined},{...payload(),employee:'meiJiao'},
    {...payload(),employee:'Synthetic Same Name'},{...payload(),creditedEmployeeId:otherEmployeeId}]) {
    if(data.employee===undefined) delete data.employee;
    const f=fixture({permissions:['room.reserve','staff.record']});
    assert.equal((await f.app.execute(request('invalid',0,data),f.credential)).status,'business-rejected');
    const head=await f.memory.read();assert.deepEqual(head.state,f.state);assert.equal(head.revision,0);assert.equal(head.audit.length,0);
    assert.equal(f.events.includes('employee'),false);
  }
});

test('reserve: revoke/employee rename or disable after success cannot change replay; new keys use current grants',async()=>{
  const f=fixture(),cmd=request('replay'),first=await f.app.execute(cmd,f.credential),before=await f.memory.read();
  f.auth.permissions=[];f.employees.get(employeeId).displayName='New Name';f.employees.get(employeeId).enabled=false;
  f.events.length=0;f.setResolver(false);
  assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.equal(f.events.includes('employee'),false);
  await assert.rejects(f.app.execute({...cmd,operationKey:'new',expectedRevision:1},f.credential),denied);
  assert.deepEqual(await f.memory.read(),before);assert.equal(f.executions(),1);
});

test('reserve: changed actor, payload, credited UUID or revision keeps original idempotency conflicts',async()=>{
  const f=fixture(),cmd=request('key');await f.app.execute(cmd,f.credential);const before=await f.memory.read();f.auth.permissions=[];
  for(const altered of [{...cmd,expectedRevision:1},{...cmd,payload:{...cmd.payload,note:'changed'}},
    {...cmd,payload:{...cmd.payload,employee:otherEmployeeId}}]) {
    assert.equal((await f.app.execute(altered,f.credential)).reason,'request-mismatch');
  }
  f.auth.id='synthetic-other';assert.equal((await f.app.execute(cmd,f.credential)).reason,'actor-mismatch');
  assert.deepEqual(await f.memory.read(),before);assert.equal(f.executions(),1);
});

test('reserve: disabled/revoked/expired/version-changed authentication cannot access terminal',async()=>{
  for(const change of [auth=>{auth.enabled=false;},auth=>{auth.revoked=true;},auth=>{auth.idle=dbNow;},
    auth=>{auth.absolute=dbNow;},auth=>{auth.version++;}]) {
    const f=fixture(),cmd=request('private');await f.app.execute(cmd,f.credential);const before=await f.memory.read();change(f.auth);
    await assert.rejects(f.app.execute(cmd,f.credential),error=>error.code==='AUTHENTICATION_REQUIRED');
    assert.deepEqual(await f.memory.read(),before);
  }
});

test('reserve: stale revision is terminal before employee lookup; a future state cannot re-execute old key',async()=>{
  const f=fixture(),cmd=request('stale',9);const result=await f.app.execute(cmd,f.credential);
  assert.equal(result.status,'revision-conflict');assert.equal(f.events.includes('employee'),false);assert.equal(f.executions(),0);
  f.auth.permissions=[];assert.deepEqual(await f.app.execute(cmd,f.credential),result);
  const head=await f.memory.read();assert.equal(head.revision,0);assert.equal(head.audit.length,0);assert.deepEqual(head.state,f.state);
});

test('reserve: original room/source/date/session/pending-review/duplicate validation is retained',async()=>{
  for(const [changes,setup] of [
    [{room:'unknown'},()=>{}],[{},s=>{s.rooms[0].status='故障/维护中';}],
    [{},s=>{s.roomIssueReviews.push({room:'V01',status:'待审核'});}],[{source:'微信'},()=>{}],
    [{dayOffset:-1},()=>{}],[{dayOffset:31},()=>{}],[{dayOffset:1.5},()=>{}],[{session:'invalid'},()=>{}],
    [{},s=>{s.reservations.push({id:3,room:'V01',at:reservationTarget(dbNow,2,'night'),status:'已预订'});}]
  ]) {
    const f=fixture({setup});assert.equal((await f.app.execute(request('business',0,{...payload(),...changes}),f.credential)).status,'business-rejected');
    const head=await f.memory.read();assert.deepEqual(head.state,f.state);assert.equal(head.revision,0);assert.equal(head.audit.length,0);
    assert.equal(head.operationResults.size,1);
  }
  for(const status of ['空闲','营业中','待清洁','已预订']) {
    const f=fixture({setup:s=>{s.rooms[0].status=status;}});
    assert.equal((await f.app.execute(request(),f.credential)).status,'committed');
    assert.equal((await f.memory.read()).state.rooms[0].status,status);
  }
});

test('reserve: unknown resolver/program failures roll back and leave the original key reusable',async()=>{
  const f=fixture();const error=new Error('synthetic SQL fault');f.failResolver(error);
  await assert.rejects(f.app.execute(request('recover'),f.credential),error);await unchanged(f);
  f.failResolver(new EmployeeRosterError('UNRECOGNIZED'));await assert.rejects(f.app.execute(request('recover'),f.credential),e=>e.code==='UNRECOGNIZED');await unchanged(f);
  f.failResolver(null);assert.equal((await f.app.execute(request('recover'),f.credential)).status,'committed');
});

test('reserve: missing resolver/context and copied or overridden metadata never fall back to demo',async()=>{
  const f=fixture({resolver:false});await assert.rejects(f.app.execute(request(),f.credential),TypeError);await unchanged(f);
  f.setResolver(true);await f.app.execute(request(),f.credential);
  for(const context of [undefined,structuredClone(f.context()),{...f.context()}]) {
    assert.throws(()=>transact(f.state,'reserve',payload(),'direct',{mode:'trusted',context}),TypeError);
  }
  const other=fixture({permissions:['room.clean','staff.record'],setup:s=>{s.rooms[0].status='待清洁';}});
  assert.equal((await other.app.execute({...request(),action:'clean',payload:{room:'V01'}},other.credential)).status,'committed');
  assert.throws(()=>transact(f.state,'reserve',payload(),'no-attribution',{mode:'trusted',context:other.context()}),TypeError);
  assert.throws(()=>reserveRoom(f.state,f.state.rooms[0],{...payload(),employee:otherEmployeeId},'forged','forged','forged',
    {mode:'trusted',context:f.context()}),TypeError);
});
