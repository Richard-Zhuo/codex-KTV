import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransactionBoundEmployeeResolver } from './employee-resolver.js';
import { EmployeeRosterError } from './errors.js';
const id='00000000-0000-4000-8000-000000000001', otherId='00000000-0000-4000-8000-000000000002';
const row=()=>({employeeId:id,displayName:'Synthetic Same Name',enabled:true});
const resolver=lookup=>createTransactionBoundEmployeeResolver({port:{lockEmployeeForAttribution:lookup}});
const isCode=code=>error=>error instanceof EmployeeRosterError&&error.code===code;

test('employee resolver requires an explicit transaction lookup port',()=>{
  for(const port of [null,{}, {lockEmployeeForAttribution:1}]) assert.throws(()=>createTransactionBoundEmployeeResolver({port}),TypeError);
});
test('enabled employee returns only stable ID and immutable display snapshot',async()=>{
  const record=row(), calls=[], bound=resolver(async employeeId=>{calls.push(employeeId);return record;});
  const result=await bound.resolveCreditedEmployeeInTransaction({creditedEmployeeId:id});
  assert.deepEqual(calls,[id]);assert.deepEqual(result,{employeeId:id,displayName:record.displayName});
  assert.equal(Object.isFrozen(result),true);assert.equal(Object.isFrozen(bound),true);
  record.displayName='Changed Later';assert.equal(result.displayName,'Synthetic Same Name');
});
test('disabled employee is rejected for new attribution',async()=>{
  await assert.rejects(resolver(async()=>({...row(),enabled:false})).resolveCreditedEmployeeInTransaction({creditedEmployeeId:id}),isCode('EMPLOYEE_DISABLED'));
});
test('missing employee is rejected rather than inferred from actor or name',async()=>{
  await assert.rejects(resolver(async()=>null).resolveCreditedEmployeeInTransaction({creditedEmployeeId:id}),isCode('EMPLOYEE_NOT_FOUND'));
});
test('principal association is optional and never becomes actor or employee key',async()=>{
  for(const principalId of [null,otherId]){
    const result=await resolver(async()=>({...row(),principalId})).resolveCreditedEmployeeInTransaction({creditedEmployeeId:id});
    assert.deepEqual(result,{employeeId:id,displayName:'Synthetic Same Name'});
    assert.ok(!Object.hasOwn(result,'principalId'));assert.ok(!Object.hasOwn(result,'actualActorPrincipalId'));
  }
});
test('same-name employees remain distinguishable by explicit UUID',async()=>{
  const bound=resolver(async employeeId=>({...row(),employeeId}));
  const a=await bound.resolveCreditedEmployeeInTransaction({creditedEmployeeId:id}), b=await bound.resolveCreditedEmployeeInTransaction({creditedEmployeeId:otherId});
  assert.equal(a.displayName,b.displayName);assert.notEqual(a.employeeId,b.employeeId);
});
test('names, demo IDs, principal and injected actor fields never trigger lookup',async()=>{
  let calls=0;const bound=resolver(async()=>{calls++;return row();}), accessor={};
  Object.defineProperty(accessor,'creditedEmployeeId',{get(){assert.fail('must not evaluate accessor');},enumerable:true});
  for(const input of [null,{},[],{creditedEmployeeId:'Synthetic Same Name'},{creditedEmployeeId:'administrator'},
    {employeeId:id},{principalId:id},{creditedEmployeeId:id,actualActorPrincipalId:otherId},
    {creditedEmployeeId:id,displayName:'Guessed'},{creditedEmployeeId:id,permissions:['*']},accessor]) await assert.rejects(bound.resolveCreditedEmployeeInTransaction(input),TypeError);
  assert.equal(calls,0);
});
test('requested employee ID is captured before asynchronous lookup',async()=>{
  let finish;const input={creditedEmployeeId:id};
  const bound=resolver(employeeId=>new Promise(resolve=>{finish=()=>resolve({...row(),employeeId});}));
  const pending=bound.resolveCreditedEmployeeInTransaction(input);input.creditedEmployeeId=otherId;finish();assert.equal((await pending).employeeId,id);
});
test('unknown lookup errors propagate without normal rejection classification',async()=>{
  const failure=Error('synthetic infrastructure fault');
  await assert.rejects(resolver(async()=>{throw failure;}).resolveCreditedEmployeeInTransaction({creditedEmployeeId:id}),error=>error===failure&&!(error instanceof EmployeeRosterError));
});
test('malformed port facts fail closed as unknown contract errors',async()=>{
  for(const record of [undefined,{}, {...row(),employeeId:otherId},{...row(),enabled:1},{...row(),displayName:''}]){
    await assert.rejects(resolver(async()=>record).resolveCreditedEmployeeInTransaction({creditedEmployeeId:id}),error=>error instanceof TypeError&&!(error instanceof EmployeeRosterError));
  }
});
