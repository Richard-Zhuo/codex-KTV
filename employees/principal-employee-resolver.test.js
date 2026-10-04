import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransactionBoundPrincipalEmployeeResolver } from './employee-resolver.js';
import { EmployeeRosterError } from './errors.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
const principalId='00000000-0000-4000-8000-000000000011', employeeId='00000000-0000-4000-8000-000000000001';
const otherId='00000000-0000-4000-8000-000000000002';
async function context(id=principalId){
 const digest=Buffer.alloc(32,7);
 return revalidateSessionInTransaction({tokenDigest:digest,port:{
  locateSessionByDigest:async()=>({principalId:id,sessionId:'synthetic-session'}),
  lockAccount:async()=>({principalId:id,enabled:true,credentialVersion:'1',policyAttributesConfigured:false}),
  lockSessionById:async()=>({sessionId:'synthetic-session',principalId:id,tokenDigest:digest,credentialVersion:'1',revoked:false,
   idleExpiresAt:'2026-10-06T00:00:00.000000Z',absoluteExpiresAt:'2026-10-07T00:00:00.000000Z'}),
  listGrants:async()=>[],listPolicyAttributes:async()=>[],readDbNow:async()=>'2026-10-05T12:00:00.123456Z'
 }});
}
const row=(id=principalId)=>({employeeId,principalId:id,displayName:'Synthetic Same Name',enabled:true});
const bind=lookup=>createTransactionBoundPrincipalEmployeeResolver({port:{lockEmployeeForPrincipal:lookup}});
const isCode=code=>error=>error instanceof EmployeeRosterError&&error.code===code;
test('principal employee: explicit transaction port is required',()=>{
 for(const port of [null,{}, {lockEmployeeForPrincipal:1}]) assert.throws(()=>createTransactionBoundPrincipalEmployeeResolver({port}),TypeError);
});
test('principal employee: only authenticated context principal locates an immutable employee snapshot',async()=>{
 const trustedContext=await context(), record=row(), calls=[];
 const result=await bind(async id=>{calls.push(id);return record;}).resolvePrincipalEmployeeInTransaction({trustedContext});
 assert.deepEqual(calls,[principalId]);assert.deepEqual(result,{employeeId,displayName:record.displayName});
 assert.notEqual(result.employeeId,trustedContext.principalId);assert.equal(Object.isFrozen(result),true);
 record.displayName='Changed';assert.equal(result.displayName,'Synthetic Same Name');
});
test('principal employee: raw principal, JSON lookalike, extra identity fields and accessors reject before lookup',async()=>{
 const trustedContext=await context();let calls=0;const resolver=bind(async()=>{calls++;return row();});
 const accessor={};Object.defineProperty(accessor,'trustedContext',{enumerable:true,get(){assert.fail('do not evaluate accessor');}});
 for(const input of [null,{},[],{principalId},{employeeId},{trustedContext:{...trustedContext}},
  {trustedContext,principalId:otherId},{trustedContext,name:'Synthetic Same Name'},{trustedContext,role:'administrator'},accessor]){
  await assert.rejects(resolver.resolvePrincipalEmployeeInTransaction(input),TypeError);
 }assert.equal(calls,0);
});
test('principal employee: no explicit association fails closed',async()=>{
 await assert.rejects(bind(async()=>null).resolvePrincipalEmployeeInTransaction({trustedContext:await context()}),isCode('EMPLOYEE_PRINCIPAL_NOT_LINKED'));
});
test('principal employee: disabled association fails closed',async()=>{
 await assert.rejects(bind(async()=>({...row(),enabled:false})).resolvePrincipalEmployeeInTransaction({trustedContext:await context()}),isCode('EMPLOYEE_DISABLED'));
});
test('principal employee: same names are separate employees and cannot substitute for principal linkage',async()=>{
 const resolver=bind(async id=>({...row(id),employeeId:id===principalId?employeeId:otherId}));
 const a=await resolver.resolvePrincipalEmployeeInTransaction({trustedContext:await context()});
 const b=await resolver.resolvePrincipalEmployeeInTransaction({trustedContext:await context(otherId)});
 assert.equal(a.displayName,b.displayName);assert.notEqual(a.employeeId,b.employeeId);
});
test('principal employee: malformed or mismatched association facts are unknown contract errors',async()=>{
 const trustedContext=await context();
 for(const value of [undefined,{}, {...row(),principalId:otherId},{...row(),employeeId:'name'},{...row(),enabled:1},{...row(),displayName:''}]){
  await assert.rejects(bind(async()=>value).resolvePrincipalEmployeeInTransaction({trustedContext}),TypeError);
 }
});
test('principal employee: unknown lookup exception propagates and owns no transaction lifecycle',async()=>{
 const failure=Error('synthetic SQL fault');
 await assert.rejects(bind(async()=>{throw failure;}).resolvePrincipalEmployeeInTransaction({trustedContext:await context()}),error=>error===failure);
});
