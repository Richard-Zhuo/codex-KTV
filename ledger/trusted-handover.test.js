import test from 'node:test';
import assert from 'node:assert/strict';
import { transact } from '../rules.js';
import { submitHandover } from '../handover.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { TRUSTED_ENABLED_ACTIONS } from './trusted-execution.js';
import { handoverFixture, handoverCommand, drawerPay } from '../test-support/trusted-handover-fixture.js';

test('K04: first trusted handover bootstraps actual cash without historical income or demo boundary',async()=>{
 const f=handoverFixture(),result=await f.app.execute(handoverCommand(),f.credential),head=await f.memory.read(),h=head.state.handovers.at(-1);
 assert.equal(result.status,'committed');assert.equal(h.bootstrap,true);assert.equal(h.previousHandoverId,null);
 assert.equal(h.actualCash,50000);assert.equal(h.expectedCash,50000);assert.equal(h.difference,0);
 assert.equal(h.submittedByPrincipalId,f.auth.id);assert.equal(h.occurredAt,f.context().dbNow);
 assert.match(h.handoverId,/^[0-9a-f-]{36}$/);assert.equal(h.cashBoundary.version,'payment-set-v1');
 assert.deepEqual(head.state.handovers[0],f.state.handovers[0]);assert.equal(head.revision,1);assert.equal(head.audit.length,1);
});

test('K04: continuous intervals count cash once and carry actual cash after a discrepancy',async()=>{
 const f=handoverFixture();
 await f.app.execute(handoverCommand('bootstrap'),f.credential);
 await f.app.execute(drawerPay(),f.credential);
 await f.app.execute(handoverCommand('second',2,58000),f.credential);
 let h=(await f.memory.read()).state.handovers.at(-1);
 assert.equal(h.expectedCash,60000);assert.equal(h.actualCash,58000);assert.equal(h.difference,-2000);
 assert.equal(h.bootstrap,false);assert.equal(h.intervalCashIn,10000);assert.equal(h.intervalCashOut,0);
 await f.app.execute(drawerPay('drawer-2','wechat',3,'微信'),f.credential);
 await f.app.execute(handoverCommand('third',4,58000),f.credential);
 h=(await f.memory.read()).state.handovers.at(-1);
 assert.equal(h.expectedCash,58000);assert.equal(h.difference,0);assert.equal(h.intervalCashIn,0);
 assert.deepEqual(h.intervalByChannel,{'微信':10000});
 await f.app.execute(drawerPay('drawer-3','cash-next',5),f.credential);
 await f.app.execute(handoverCommand('fourth',6,68000),f.credential);
 const {state}=await f.memory.read(),chain=state.handovers.slice(1);
 assert.equal(chain.at(-1).expectedCash,68000);
 assert.deepEqual(chain.map(h=>h.previousHandoverId),[null,...chain.slice(0,-1).map(h=>h.handoverId)]);
 assert.equal(new Set(chain.map(h=>h.handoverId)).size,4);
 assert.equal(new Set(chain.map(h=>h.occurredAt)).size,1,'equal timestamps must not lose interval payments');
});

const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
const last = head => head.state.handovers.at(-1);

test('handover: forged payload and demo identity/clock cannot set actor, expected or the previous boundary',async()=>{
 const f=handoverFixture(); const request=handoverCommand('forged',0,0,{actorId:'fake',principalId:'fake',person:'fake',permissions:['*'],
  role:'administrator',clock:'1900-01-01',expectedCash:123456,previousHandoverId:'fake',bootstrap:false,cashBoundary:{version:'fake'}});
 await f.app.execute(request,f.credential);
 const h=last(await f.memory.read());assert.equal(h.actualCash,0);assert.equal(h.expectedCash,0);assert.equal(h.difference,0);
 assert.equal(h.submittedByPrincipalId,f.auth.id);assert.equal(h.person,null);assert.equal(h.previousHandoverId,null);
 assert.equal(h.occurredAt,f.context().dbNow);assert.equal(h.cashBoundary.version,'payment-set-v1');
 const state=structuredClone(f.state);
 for(const field of ['user','permissions','capabilities','administrator','clock'])Object.defineProperty(state,field,{get(){throw Error('demo fact read '+field);}});
 submitHandover(state,{actualCash:50000},undefined,undefined,{mode:'trusted',context:f.context()});
 assert.equal(state.handovers.at(-1).actualCash,50000);
});

test('handover: bootstrap absorbs existing trusted receipts, retaining their IDs without inventing prior expected cash',async()=>{
 const f=handoverFixture(); await f.app.execute(drawerPay('drawer-1','before',0),f.credential);
 await f.app.execute(handoverCommand('bootstrap',1,50000),f.credential);
 await f.app.execute(handoverCommand('empty',2,50000),f.credential);
 const head=await f.memory.read();assert.equal(last(head).expectedCash,50000);assert.equal(last(head).intervalCashIn,0);
 assert.equal(last(head).cashBoundary.payments.length,1);assert.equal(head.state.orders.find(o=>o.id==='drawer-1').payments.length,1);
});

test('handover: crossing noon does not reset cash or rewrite payment occurredAt',async()=>{
 const f=handoverFixture();f.setClock('2026-10-05T03:59:59.000000Z');
 await f.app.execute(handoverCommand('before-noon'),f.credential);
 f.setClock('2026-10-05T04:00:00.000000Z');await f.app.execute(drawerPay(),f.credential);
 f.setClock('2026-10-05T10:00:00.000000Z');await f.app.execute(handoverCommand('after-noon',2,60000),f.credential);
 const head=await f.memory.read();assert.equal(last(head).expectedCash,60000);
 assert.equal(head.state.orders.find(o=>o.id==='drawer-1').payments[0].occurredAt,'2026-10-05T04:00:00.000000Z');
 assert.equal(last(head).occurredAt,'2026-10-05T10:00:00.000000Z');assert.equal(Object.hasOwn(last(head),'businessDate'),false);
});

test('handover: wine deposit/withdraw and cash-labelled expenses/procurements do not invent drawer movements',async()=>{
 const f=handoverFixture();await f.app.execute(handoverCommand('bootstrap'),f.credential);
 await f.app.execute({operationKey:'wine-in',expectedRevision:1,action:'deposit',payload:{name:'Synthetic customer',room:f.state.rooms[0].id,product:'qd',count:3}},f.credential);
 const deposit=(await f.memory.read()).state.deposits.at(-1);
 await f.app.execute({operationKey:'wine-out',expectedRevision:2,action:'withdraw',payload:{id:deposit.id,identity:'Synthetic customer',count:1}},f.credential);
 const details={date:'2026-10-05',amount:5000,method:'现金',nature:'一次性支出',description:'Funding source unproven'};
 await f.app.execute({operationKey:'expense',expectedRevision:3,action:'expense',payload:details},f.credential);
 await f.app.execute({operationKey:'procurement',expectedRevision:4,action:'procurement',payload:{...details,item:'Synthetic supplies',quantity:1,unit:'box'}},f.credential);
 const result=await f.app.execute(handoverCommand('unchanged-drawer',5),f.credential),head=await f.memory.read();
 assert.equal(result.status,'committed');assert.equal(last(head).expectedCash,50000);assert.equal(last(head).intervalCashOut,0);
 assert.equal(head.state.withdrawals.length,1);assert.equal(head.state.expenses.length,2);assert.equal(head.state.procurements.length,1);
});

for(const actualCash of [-1,0.5,Number.MAX_SAFE_INTEGER+1,null,'500'])test('handover: rejects invalid actual cash '+JSON.stringify(actualCash),async()=>{
 const f=handoverFixture(),before=await f.memory.read(),request=handoverCommand('bad',0,actualCash);
 const result=await f.app.execute(request,f.credential),after=await f.memory.read();
 assert.equal(result.status,'business-rejected');assert.equal(after.revision,0);assert.deepEqual(after.state,before.state);assert.deepEqual(after.audit,[]);
 assert.deepEqual(await f.app.execute(request,f.credential),result);assert.equal(f.executions(),1);
});

test('handover: exact permission is required, denial consumes no key and same request succeeds after grant',async()=>{
 const f=handoverFixture({permissions:['backend.view']}),before=await f.memory.read(),request=handoverCommand('grant-later',0,50000,{permissions:['handover'],role:'administrator'});
 await assert.rejects(f.app.execute(request,f.credential),denied);assert.deepEqual(await f.memory.read(),before);assert.equal(f.executions(),0);
 f.auth.permissions.push('handover');assert.equal((await f.app.execute(request,f.credential)).status,'committed');
});

test('handover: revoke preserves old terminal replay, new key is denied and actor/fingerprint conflicts stay unchanged',async()=>{
 const f=handoverFixture(),request=handoverCommand('original'),result=await f.app.execute(request,f.credential);
 f.auth.permissions=[];const before=await f.memory.read();
 assert.deepEqual(await f.app.execute(request,f.credential),result);
 await assert.rejects(f.app.execute(handoverCommand('new',1),f.credential),denied);
 for(const changed of [{...request,expectedRevision:1},{...request,payload:{actualCash:49999}}])assert.equal((await f.app.execute(changed,f.credential)).reason,'request-mismatch');
 f.auth.id='other-synthetic-principal';assert.equal((await f.app.execute(request,f.credential)).reason,'actor-mismatch');
 assert.deepEqual(await f.memory.read(),before);assert.equal(f.executions(),1);
});

for(const status of ['disabled','revoked','idle','absolute','version'])test('handover: '+status+' cannot read an existing terminal',async()=>{
 const f=handoverFixture(),request=handoverCommand('private');await f.app.execute(request,f.credential);const before=await f.memory.read();
 if(status==='disabled')f.auth.enabled=false;else if(status==='revoked')f.auth.revoked=true;
 else if(status==='idle')f.auth.idle='2026-01-01T00:00:00.000000Z';else if(status==='absolute')f.auth.absolute='2026-01-01T00:00:00.000000Z';else f.auth.version++;
 await assert.rejects(f.app.execute(request,f.credential),e=>e.code==='AUTHENTICATION_REQUIRED');assert.deepEqual(await f.memory.read(),before);
});

test('handover: stale revision is terminal and cannot advance a boundary later',async()=>{
 const f=handoverFixture(),request=handoverCommand('stale',1),result=await f.app.execute(request,f.credential);
 assert.equal(result.status,'revision-conflict');await f.app.execute(handoverCommand('baseline'),f.credential);
 const before=await f.memory.read();assert.deepEqual(await f.app.execute(request,f.credential),result);assert.deepEqual(await f.memory.read(),before);
});

test('handover: unknown error after constructing a boundary rolls back; original key retries without consuming receipts',async()=>{
 let broken=false;const f=handoverFixture({execute:(...args)=>{const next=transact(...args);if(broken)throw Error('synthetic handover failure');return next;}});
 await f.app.execute(handoverCommand('baseline'),f.credential);await f.app.execute(drawerPay(),f.credential);
 broken=true;const before=await f.memory.read(),request=handoverCommand('retry',2,60000);
 await assert.rejects(f.app.execute(request,f.credential),/synthetic handover failure/);assert.deepEqual(await f.memory.read(),before);
 broken=false;await f.app.execute(request,f.credential);assert.equal(last(await f.memory.read()).expectedCash,60000);
});

for(const corruption of ['new-ambiguous','changed-legacy','removed-receipt','changed-receipt','duplicate-ID','fork'])test('handover: '+corruption+' fails closed instead of guessing cash',async()=>{
 const f=handoverFixture({execute:(...args)=>{
  const next=transact(...args);if(args[1]!=='pay'||args[2].order!=='drawer-1')return next;
  const receipts=next.orders.find(o=>o.id==='drawer-1').payments;
  if(corruption==='new-ambiguous')receipts.push({method:'现金',amount:200,time:'2026-10-05'});
  if(corruption==='changed-legacy')next.orders.find(o=>o.id==='legacy-payment').payments[0].amount++;
  if(corruption==='changed-receipt')next.orders.find(o=>o.id==='drawer-2').payments[0].amount++;
  if(corruption==='removed-receipt')next.orders.find(o=>o.id==='drawer-2').payments=[];
  if(corruption==='duplicate-ID')receipts.push({...receipts[0]});
  if(corruption==='fork')next.handovers.push({...next.handovers.at(-1),handoverId:globalThis.crypto.randomUUID(),previousHandoverId:'fake'});
  return next;
 }});
 // A prior known receipt must also remain immutable after it is absorbed at bootstrap.
 if(['changed-receipt','removed-receipt'].includes(corruption))await f.app.execute(drawerPay('drawer-2','prior',0),f.credential);
 const firstRevision=(await f.memory.read()).revision;await f.app.execute(handoverCommand('baseline',firstRevision),f.credential);
 await f.app.execute(drawerPay('drawer-1','corrupt',firstRevision+1),f.credential);
 const before=await f.memory.read(),result=await f.app.execute(handoverCommand('fail-safe',before.revision),f.credential),after=await f.memory.read();
 assert.equal(result.status,'business-rejected');assert.equal(after.revision,before.revision);assert.deepEqual(after.state,before.state);assert.deepEqual(after.audit,before.audit);
});

test('handover: missing port/context or copied context cannot fall back to demo, open remains disabled',async()=>{
 const unbound=handoverFixture({bind:false});await assert.rejects(unbound.app.execute(handoverCommand(),unbound.credential),/revalidation port/);
 const f=handoverFixture({permissions:['handover','room.open']});await f.app.execute(handoverCommand(),f.credential);
 assert.throws(()=>transact(f.state,'handover',{actualCash:1},'missing',{mode:'trusted'}),TypeError);
 assert.throws(()=>submitHandover(f.state,{actualCash:1},undefined,undefined,{mode:'trusted',context:{...f.context()}}),TypeError);
 await assert.rejects(f.app.execute({...handoverCommand('open',1),action:'open'},f.credential),e=>denied(e)&&e.reason==='missing-permission');
 assert.equal(TRUSTED_ENABLED_ACTIONS.includes('handover'),true);assert.equal(TRUSTED_ENABLED_ACTIONS.includes('open'),true);
});

test('handover: cash total cannot overflow safe integer cents or advance the previous boundary',async()=>{
 const f=handoverFixture();await f.app.execute(handoverCommand('max-baseline',0,Number.MAX_SAFE_INTEGER),f.credential);
 await f.app.execute(drawerPay(),f.credential);const before=await f.memory.read();
 const result=await f.app.execute(handoverCommand('overflow',2,0),f.credential),after=await f.memory.read();
 assert.equal(result.status,'business-rejected');assert.equal(after.revision,2);assert.deepEqual(after.state,before.state);assert.deepEqual(after.audit,before.audit);
});
