import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { submitIncidentResolution } from '../incidents.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTransactionBoundPrincipalEmployeeResolver } from '../employees/employee-resolver.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { createTrustedLedgerApplication } from './application.js';
import { TRUSTED_ENABLED_ACTIONS } from './trusted-execution.js';
import { resolutionCommand,seedIncidentResolution,resolutionEmployeeId as employeeId,otherResolutionEmployeeId as otherEmployeeId,
 resolutionPrincipalId as principalId,otherResolutionPrincipalId as otherPrincipalId,resolutionDbNow as dbNow } from '../test-support/trusted-incident-resolution-fixture.js';
const denied=e=>e instanceof AuthorizationDenied&&e.status==='authorization-denied';
function fixture({permissions=['incident.resolve'],resolver=true,execute=transact,prepare=()=>{}}={}){
 const state=initialState();state.user='not-demo';state.clock='invalid-demo-clock';state.permissions={administrator:['管理员']};state.capabilities={administrator:['*']};state.administrator=true;
 state.inventory.bw.count=0;state.orders=[{id:'history',kind:'retail',room:null,sales:[{productNameSnapshot:'Historic',pricePerSaleUnitCents:null}],payments:[{method:'现金',amount:100}]}];
 seedIncidentResolution(state);prepare(state);
 const memory=createMemoryLedgerStore(state,{ledgerId:'resolution-unit'}),digest=Buffer.alloc(32,8),events=[];
 const auth={id:principalId,permissions,enabled:true,revoked:false,version:'1',sessionVersion:'1',idle:'2099-01-01T00:00:00.000000Z',absolute:'2099-01-02T00:00:00.000000Z'};
 const employees=new Map([[principalId,{employeeId,principalId,displayName:'Synthetic Same Name',enabled:true}],
  [otherPrincipalId,{employeeId:otherEmployeeId,principalId:otherPrincipalId,displayName:'Synthetic Same Name',enabled:true}]]);
 let context,executions=0,lookupError=null,hasResolver=resolver;
 const port={locateSessionByDigest:async()=>({principalId:auth.id,sessionId:'synthetic-session'}),
  lockAccount:async()=>{events.push('account');return {principalId:auth.id,enabled:auth.enabled,credentialVersion:auth.version,policyAttributesConfigured:false};},
  lockSessionById:async()=>{events.push('session');return {principalId:auth.id,sessionId:'synthetic-session',tokenDigest:digest,credentialVersion:auth.sessionVersion,revoked:auth.revoked,idleExpiresAt:auth.idle,absoluteExpiresAt:auth.absolute};},
  listGrants:async()=>{events.push('grants');return auth.permissions;},listPolicyAttributes:async()=>[],readDbNow:async()=>{events.push('db-now');return dbNow;}};
 const store={ledgerId:memory.ledgerId,runAtomic:work=>memory.runAtomic(tx=>{
  events.push('head');const find=tx.findOperationResult;tx.findOperationResult=async key=>{events.push('operation');return find(key);};
  tx.sessionRevalidation={revalidateSessionInTransaction:credential=>revalidateSessionInTransaction({port,...credential})};
  if(hasResolver)tx.employeeResolver=createTransactionBoundPrincipalEmployeeResolver({port:{lockEmployeeForPrincipal:async id=>{events.push('actor-employee');if(lookupError)throw lookupError;return employees.get(id)??null;}}});
  return work(tx);
 })};
 const app=createTrustedLedgerApplication({store,transactCommand:(...args)=>{executions++;context=args[4].context;events.push('transact');return execute(...args);}});
 return {app,memory,state,auth,employees,events,credential:{tokenDigest:digest},context:()=>context,executions:()=>executions,failLookup:e=>{lookupError=e;},setResolver:value=>{hasResolver=value;}};
}
async function unchanged(f){const head=await f.memory.read();assert.deepEqual(head.state,f.state);assert.equal(head.revision,0);assert.equal(head.operationResults.size,0);assert.equal(head.audit.length,0);}
test('resolveIncident: only matched session employee submits one pending request with stable principal and DB time',async()=>{
 const f=fixture(),result=await f.app.execute(resolutionCommand('first'),f.credential),head=await f.memory.read(),incident=head.state.incidents[0],request=incident.resolutionReviews[0];
 assert.equal(result.status,'committed');assert.equal(result.actorId,principalId);assert.equal(request.submittedByPrincipalId,principalId);
 assert.equal(request.submittedByEmployeeId,employeeId);assert.equal(request.submittedBy,'Synthetic Same Name');assert.equal(request.submittedById,null);assert.equal(request.submittedAt,dbNow);
 assert.equal(request.status,'待审核');assert.equal(request.result,'Synthetic result');assert.equal(request.note,'Synthetic note');
 assert.equal(incident.status,'待审核');assert.equal(incident.result,'');assert.equal(incident.note,'');assert.equal(incident.lastReminderDate,'');
 assert.equal(incident.assignee,'Historical Assignee');assert.equal(incident.assigneeEmployeeId,employeeId);
 assert.equal(f.context().actorEmployeeId,employeeId);assert.equal(Object.hasOwn(f.context(),'creditedEmployeeId'),false);
 assert.deepEqual(f.events,['head','account','session','grants','db-now','operation','actor-employee','transact']);
 const expected=structuredClone(f.state);expected.serial++;expected.incidents[0]={...expected.incidents[0],status:'待审核',lastReminderDate:'',resolutionReviews:[request]};expected.processed.push('first');
 assert.deepEqual(head.state,expected);assert.equal(head.revision,1);assert.equal(head.audit.length,1);
});
test('resolveIncident: spoofed payload and poisoned demo state cannot replace session principal, employee or time',async()=>{
 const f=fixture(),cmd=resolutionCommand('spoof',0,{assigneeEmployeeId:otherEmployeeId,assignee:'forged',employeeId:otherEmployeeId,employee:otherEmployeeId,
  principalId:otherPrincipalId,actorId:'administrator',role:'administrator',permissions:['*'],clock:'1900-01-01',submittedBy:'forged',submittedByPrincipalId:otherPrincipalId});
 await f.app.execute(cmd,f.credential);const request=(await f.memory.read()).state.incidents[0].resolutionReviews[0];
 assert.equal(request.submittedByPrincipalId,principalId);assert.equal(request.submittedByEmployeeId,employeeId);assert.equal(request.submittedAt,dbNow);assert.equal(request.submittedBy,'Synthetic Same Name');
});
test('resolveIncident: missing concrete permission is nonterminal and the same key can succeed after grant',async()=>{
 for(const permissions of [[],['backend.view'],['incident.viewAll'],['incident.resolve.approve']]){
  const f=fixture({permissions}),cmd=resolutionCommand('grant');await assert.rejects(f.app.execute(cmd,f.credential),denied);await unchanged(f);
  assert.equal(f.events.includes('actor-employee'),false);f.auth.permissions=['incident.resolve'];assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');
 }
});
test('resolveIncident: same-name wrong assignee is denied even with viewAll; payload cannot claim matching linkage',async()=>{
 const f=fixture({permissions:['incident.resolve','incident.viewAll']});f.auth.id=otherPrincipalId;
 await assert.rejects(f.app.execute(resolutionCommand('wrong',0,{assigneeEmployeeId:otherEmployeeId,employeeId:employeeId,principalId}),f.credential),denied);await unchanged(f);
});
test('resolveIncident: unlinked employee identity does not occupy key and explicit later linkage can retry',async()=>{
 const f=fixture(),record=f.employees.get(principalId);f.employees.delete(principalId);const cmd=resolutionCommand('link');
 await assert.rejects(f.app.execute(cmd,f.credential),denied);await unchanged(f);f.employees.set(principalId,record);
 assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');
});
test('resolveIncident: disabled linked employee cannot create a request',async()=>{
 const f=fixture();f.employees.get(principalId).enabled=false;await assert.rejects(f.app.execute(resolutionCommand(),f.credential),denied);await unchanged(f);
});
test('resolveIncident: legacy or invalid assignee stable ID fails closed despite names or forged payload',async()=>{
 for(const value of [undefined,null,'wife',principalId]){
  const f=fixture({prepare:s=>{s.incidents[0].assigneeEmployeeId=value;if(value===undefined)delete s.incidents[0].assigneeEmployeeId;s.incidents[0].assignee='Synthetic Same Name';}});
  await assert.rejects(f.app.execute(resolutionCommand('legacy',0,{assigneeEmployeeId:employeeId,assignee:'Synthetic Same Name'}),f.credential),denied);await unchanged(f);
 }
});
test('resolveIncident: current display snapshot never rewrites historical incident assignee name',async()=>{
 const f=fixture();f.employees.get(principalId).displayName='Renamed Employee';await f.app.execute(resolutionCommand(),f.credential);
 const incident=(await f.memory.read()).state.incidents[0];assert.equal(incident.assignee,'Historical Assignee');assert.equal(incident.assigneeEmployeeNameSnapshot,'Historical Assignee');assert.equal(incident.resolutionReviews[0].submittedBy,'Renamed Employee');
});
test('resolveIncident: original missing/completed/pending and required result/note rejections remain atomic terminals',async()=>{
 for(const [label,prepare,changes] of [['absent',s=>{s.incidents=[];},{}],['completed',s=>{s.incidents[0].status='已完成';},{}],
  ['pending',s=>{s.incidents[0].resolutionReviews=[{id:42,status:'待审核'}];},{}],['result',()=>{},{result:' '}],['note',()=>{},{note:' '}]]){
  const f=fixture({prepare}),cmd=resolutionCommand(label,0,changes),result=await f.app.execute(cmd,f.credential);assert.equal(result.status,'business-rejected');
  const head=await f.memory.read();assert.deepEqual(head.state,f.state);assert.equal(head.revision,0);assert.equal(head.audit.length,0);assert.equal(head.operationResults.size,1);
  f.auth.permissions=[];assert.deepEqual(await f.app.execute(cmd,f.credential),result);
 }
});
test('resolveIncident: original 300-character limits and prior rejected request history are preserved',async()=>{
 const f=fixture({prepare:s=>{s.incidents[0].resolutionReviews=[{id:40,status:'已驳回',submittedBy:'Historic'}];}});
 await f.app.execute(resolutionCommand('long',0,{result:'r'.repeat(350),note:'n'.repeat(350)}),f.credential);
 const reviews=(await f.memory.read()).state.incidents[0].resolutionReviews;assert.deepEqual(reviews[0],f.state.incidents[0].resolutionReviews[0]);assert.equal(reviews[1].result.length,300);assert.equal(reviews[1].note.length,300);
});
test('resolveIncident: success replay precedes revoked grant and unavailable employee port; new key uses current permission',async()=>{
 const f=fixture(),cmd=resolutionCommand('replay'),first=await f.app.execute(cmd,f.credential),before=await f.memory.read();
 f.auth.permissions=[];f.employees.delete(principalId);f.setResolver(false);assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.deepEqual(await f.memory.read(),before);assert.equal(f.executions(),1);
 await assert.rejects(f.app.execute(resolutionCommand('new',1),f.credential),denied);assert.deepEqual(await f.memory.read(),before);
});
for(const invalid of ['disabled','revoked','idle','absolute','credential'])test('resolveIncident: '+invalid+' session cannot replay a prior success',async()=>{
 const f=fixture(),cmd=resolutionCommand();await f.app.execute(cmd,f.credential);const before=await f.memory.read();
 if(invalid==='disabled')f.auth.enabled=false;else if(invalid==='revoked')f.auth.revoked=true;else if(invalid==='credential')f.auth.version='2';else f.auth[invalid]=dbNow;
 await assert.rejects(f.app.execute(cmd,f.credential),e=>e.code==='AUTHENTICATION_REQUIRED');assert.deepEqual(await f.memory.read(),before);
});
test('resolveIncident: actor, payload and expectedRevision changes retain Stage 1 idempotency conflict',async()=>{
 const f=fixture(),cmd=resolutionCommand();await f.app.execute(cmd,f.credential);const before=await f.memory.read();
 f.auth.id=otherPrincipalId;assert.equal((await f.app.execute(cmd,f.credential)).reason,'actor-mismatch');f.auth.id=principalId;
 for(const changed of [{...cmd,expectedRevision:1},{...cmd,payload:{...cmd.payload,note:'changed'}},{...cmd,action:'approveIncidentResolution'}])assert.equal((await f.app.execute(changed,f.credential)).reason,'request-mismatch');
 assert.deepEqual(await f.memory.read(),before);
});
test('resolveIncident: stale revision remains terminal before employee resolution',async()=>{
 const f=fixture({resolver:false}),cmd=resolutionCommand('stale',1),result=await f.app.execute(cmd,f.credential);assert.equal(result.status,'revision-conflict');
 f.auth.permissions=[];assert.deepEqual(await f.app.execute(cmd,f.credential),result);assert.equal(f.executions(),0);const head=await f.memory.read();assert.equal(head.revision,0);assert.equal(head.audit.length,0);
});
test('resolveIncident: missing principal resolver, absent/copied context and direct domain bypass fail without demo fallback',async()=>{
 const missing=fixture({resolver:false});await assert.rejects(missing.app.execute(resolutionCommand(),missing.credential),TypeError);await unchanged(missing);
 const f=fixture();await f.app.execute(resolutionCommand(),f.credential);
 for(const context of [undefined,{...f.context()}]){
  assert.throws(()=>transact(f.state,'resolveIncident',resolutionCommand().payload,'direct',{mode:'trusted',context}),TypeError);
  assert.throws(()=>submitIncidentResolution(structuredClone(f.state),resolutionCommand().payload,'administrator','1900-01-01',{mode:'trusted',context}),TypeError);
 }
});
test('resolveIncident: unknown resolver/domain faults roll back without consuming key',async()=>{
 const f=fixture(),cmd=resolutionCommand('repair');f.failLookup(Error('synthetic lookup'));await assert.rejects(f.app.execute(cmd,f.credential),/synthetic lookup/);await unchanged(f);
 f.failLookup(null);assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');
 let fail=true;const domain=fixture({execute:(...args)=>{const next=transact(...args);if(fail)throw Error('synthetic after request');return next;}});
 await assert.rejects(domain.app.execute(cmd,domain.credential),/synthetic after request/);await unchanged(domain);fail=false;assert.equal((await domain.app.execute(cmd,domain.credential)).status,'committed');
});
test('resolveIncident: all remaining not-yet-migrated actions stay closed',async()=>{
 assert.ok(TRUSTED_ENABLED_ACTIONS.includes('resolveIncident'));
 const f=fixture({permissions:['incident.resolve','incident.resolve.approve','rounding.approve','payment.collect','payment.settle','procurement.create','handover','room.open']});
 for(const action of ['open']){
  await assert.rejects(f.app.execute({...resolutionCommand(action),action},f.credential),e=>denied(e)&&e.reason===(action==='open'?'missing-permission':'trusted-action-not-enabled'));
 }await unchanged(f);
});
