import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { submitRepay } from '../sales.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { repayCommand, seedTrustedRepay, repayOrder } from '../test-support/trusted-repay-fixture.js';

const dbNow = '2026-10-05T12:00:00.123456Z';
const denied = e => e instanceof AuthorizationDenied && e.status === 'authorization-denied';
function fixture({ permissions = ['credit.repay'], prepare = () => {}, execute = transact, bind = true } = {}) {
  const state = initialState(); state.user = 'unmapped-demo-user'; state.clock = 'invalid-demo-clock';
  state.permissions = { administrator: ['管理员'] }; state.capabilities = { administrator: ['*'] }; state.administrator = true;
  state.orders = [{ id: 'historical-retail', kind: 'retail', room: null,
    sales: [{ productNameSnapshot: null, pricePerSaleUnitCents: null, baseQuantityPerSaleUnit: 12, totalBaseQuantity: 24 }],
    payments: [{ method: '现金', amount: 10 }, { method: '微信', amount: 20 }] }];
  seedTrustedRepay(state); prepare(state);
  const memory = createMemoryLedgerStore(state, { ledgerId: 'repay-unit' }), events = [], digest = Buffer.alloc(32, 19);
  const auth = { id: 'synthetic-repay-actor', permissions, enabled: true, revoked: false, version: 1, sessionVersion: 1,
    idle: '2099-01-01T00:00:00.000000Z', absolute: '2099-01-02T00:00:00.000000Z' };
  const port = {
    locateSessionByDigest: async () => ({ principalId: auth.id, sessionId: 'synthetic-repay-session' }),
    lockAccount: async () => { events.push('account'); return { principalId: auth.id, enabled: auth.enabled, credentialVersion: auth.version, policyAttributesConfigured: false }; },
    lockSessionById: async () => { events.push('session'); return { principalId: auth.id, sessionId: 'synthetic-repay-session', tokenDigest: digest,
      revoked: auth.revoked, credentialVersion: auth.sessionVersion, idleExpiresAt: auth.idle, absoluteExpiresAt: auth.absolute }; },
    listGrants: async () => { events.push('grants'); return auth.permissions; }, listPolicyAttributes: async () => [],
    readDbNow: async () => { events.push('db-now'); return dbNow; }
  };
  let executions = 0, context;
  const store = { ledgerId: memory.ledgerId, runAtomic: work => memory.runAtomic(tx => {
    events.push('head'); const find = tx.findOperationResult; tx.findOperationResult = key => { events.push('operation'); return find(key); };
    if (bind) tx.sessionRevalidation = { revalidateSessionInTransaction: async credential => {
      context = await revalidateSessionInTransaction({ port, ...credential }); return context;
    } };
    return work(tx); // Repayment request creation has no employee attribution.
  }) };
  const app = createTrustedLedgerApplication({ store, transactCommand: (...args) => {
    executions++; context = args[4].context; events.push('transact'); return execute(...args);
  } });
  return { state, memory, app, auth, events, credential: { tokenDigest: digest }, executions: () => executions, context: () => context };
}
async function assertNoEffects(f) {
  const head = await f.memory.read(); assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0);
  assert.equal(head.operationResults.size, 0); assert.equal(head.audit.length, 0);
}

test('repay: session principal creates one pending request with DB time and never confirms payment',async()=>{
 const f=fixture(),result=await f.app.execute(repayCommand(),f.credential),head=await f.memory.read(),order=repayOrder(head.state),row=order.credit.repaymentRequests.at(-1);
 assert.equal(result.status,'committed');assert.equal(result.actorId,f.auth.id);assert.equal(head.revision,1);
 assert.equal(row.id,1101);assert.equal(row.amount,20000);assert.equal(row.method,'微信');assert.equal(row.status,'待审核');
 assert.equal(row.submittedByPrincipalId,f.auth.id);assert.equal(row.submittedById,'');assert.equal(row.submittedBy,null);assert.equal(row.submittedAt,dbNow);
 assert.equal(row.decidedBy,'');assert.equal(row.decidedAt,'');assert.equal(row.decisionNote,'');
 assert.equal(order.status,'已挂账');assert.equal(order.credit.remaining,69500);assert.equal(order.credit.amount,104500);
 assert.deepEqual(order.payments,repayOrder(f.state).payments);assert.deepEqual(order.credit.repayments,repayOrder(f.state).credit.repayments);
 assert.deepEqual(order.credit.repaymentRequests.slice(0,-1),repayOrder(f.state).credit.repaymentRequests);
 assert.equal(head.audit[0].actorId,f.auth.id);assert.equal(head.operationResults.size,1);assert.equal(head.audit.length,1);
});


test('repay: original method/amount and pending request fields match demo while every prior business fact remains unchanged',async()=>{
 for(const changes of [{amount:1,method:'现金'},{amount:54500,method:'支付宝'},{method:'美团'},{method:'抖音'}]){
  const f=fixture(),cmd=repayCommand('fields',0,changes);await f.app.execute(cmd,f.credential);const head=await f.memory.read(),order=repayOrder(head.state),original=repayOrder(f.state);
  const demo=repayOrder(transact({...f.state,user:'boss',clock:dbNow},'repay',cmd.payload,'demo')).credit.repaymentRequests.at(-1),row=order.credit.repaymentRequests.at(-1);
  for(const field of ['id','amount','method','status','submittedAt','decidedBy','decidedAt','decisionNote'])assert.deepEqual(row[field],demo[field]);
  assert.equal(Object.hasOwn(demo,'submittedByPrincipalId'),false);assert.equal(demo.submittedBy,'老板');assert.equal(row.submittedBy,null);
  const {repaymentRequests,...credit}=order.credit,{repaymentRequests:oldRequests,...oldCredit}=original.credit;assert.deepEqual(credit,oldCredit);
  const {credit:newCredit,...rest}=order,{credit:previousCredit,...previous}=original;assert.deepEqual(rest,previous);
  assert.deepEqual(repaymentRequests.slice(0,-1),oldRequests);assert.deepEqual(head.state.orders[0],f.state.orders[0]);
  for(const field of ['rooms','inventory','consumables','ledger','user','permissions','clock','capabilities','administrator'])assert.deepEqual(head.state[field],f.state[field]);
  assert.equal(head.state.orders[0].room,null);assert.equal(head.state.inventory.qd.count,null);assert.equal(head.state.inventory.bw.count,0);
 }
});

test('repay: forged payload/demo identities cannot replace session applicant, permissions, pending status, balance or time',async()=>{
 const f=fixture({prepare:s=>{s.user='administrator';s.clock='1900-01-01';}}),cmd=repayCommand('forged',0,{actorId:'fake',principalId:'fake',actualActorPrincipalId:'fake',
  person:'Fake',submittedBy:'Fake',submittedById:'administrator',submittedByPrincipalId:'fake',permissions:['*'],role:'老板',clock:'1900-01-01',
  status:'已批准',remaining:0,approvedBy:'fake',decidedByPrincipalId:'fake',submittedAt:'1900-01-01',policyAttributeIds:['credit.approval.boss']});
 const result=await f.app.execute(cmd,f.credential),head=await f.memory.read(),order=repayOrder(head.state),row=order.credit.repaymentRequests.at(-1);
 assert.equal(result.actorId,f.auth.id);assert.equal(row.submittedByPrincipalId,f.auth.id);assert.equal(row.submittedBy,null);assert.equal(row.submittedById,'');
 assert.equal(row.submittedAt,dbNow);assert.equal(row.status,'待审核');assert.equal(row.amount,20000);assert.equal(row.decidedBy,'');
 assert.equal(Object.hasOwn(row,'decidedByPrincipalId'),false);assert.equal(order.credit.remaining,69500);
 assert.deepEqual(order.payments,repayOrder(f.state).payments);assert.deepEqual(order.credit.repayments,repayOrder(f.state).credit.repayments);
 for(const field of ['user','clock','permissions','capabilities','administrator'])assert.deepEqual(head.state[field],f.state[field]);
});

test('repay: only credit.repay permits request creation; denied key becomes reusable after the current grant',async()=>{
 for(const permissions of [[],['backend.view'],['credit.approve','review.self'],['credit.repay.approve'],['payment.collect','payment.settle','staff.record']]){
  const f=fixture({permissions}),cmd=repayCommand('denied',0,{permissions:['credit.repay'],role:'老板'});
  await assert.rejects(f.app.execute(cmd,f.credential),e=>denied(e)&&e.reason==='missing-permission');await assertNoEffects(f);assert.equal(f.executions(),0);
  f.auth.permissions.push('credit.repay');assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');
  assert.equal(repayOrder((await f.memory.read()).state).credit.repaymentRequests.at(-1).submittedByPrincipalId,f.auth.id);
 }
});

test('repay: no employee/principal guessing or attribute qualification is needed for a new request',async()=>{
 const f=fixture({permissions:['credit.repay','staff.record'],prepare:s=>{delete repayOrder(s).credit.submittedByPrincipalId;}});
 await assert.rejects(f.app.execute(repayCommand('employee',0,{creditedEmployeeId:'10000000-0000-4000-8000-000000000001'}),f.credential),e=>denied(e)&&e.reason==='invalid-attribution');await assertNoEffects(f);
 await f.app.execute(repayCommand('plain',0,{employee:'legacy-id',applicant:'original-credit-applicant'}),f.credential);
 const row=repayOrder((await f.memory.read()).state).credit.repaymentRequests.at(-1);assert.equal(row.submittedByPrincipalId,f.auth.id);
 assert.equal(Object.hasOwn(row,'creditedEmployeeId'),false);assert.equal(f.context().policyAttributesConfigured,false);assert.equal(f.context().policyAttributeIds,null);
});

test('repay: direct domain uses only branded context and rejects missing/copied contexts without demo fallback',async()=>{
 const f=fixture();await f.app.execute(repayCommand(),f.credential);const state={serial:1100},order=structuredClone(repayOrder(f.state));
 for(const field of ['user','permissions','clock','capabilities','administrator'])Object.defineProperty(state,field,{get(){assert.fail('trusted repay read demo '+field);}});
 submitRepay(state,order,repayCommand().payload,'fake','1900-01-01',{mode:'trusted',context:f.context()});
 assert.equal(order.credit.repaymentRequests.at(-1).submittedByPrincipalId,f.auth.id);assert.equal(order.credit.repaymentRequests.at(-1).submittedAt,dbNow);
 for(const context of [undefined,{...f.context()}])assert.throws(()=>submitRepay(f.state,repayOrder(f.state),repayCommand().payload,undefined,undefined,{mode:'trusted',context}),/可信认证上下文/);
 const noGrant=fixture({permissions:[]});await assert.rejects(noGrant.app.execute(repayCommand(),noGrant.credential),denied);
 assert.throws(()=>submitRepay(noGrant.state,repayOrder(noGrant.state),repayCommand().payload,undefined,undefined,{mode:'trusted',context:noGrant.context()}),denied);
 assert.throws(()=>transact(f.state,'repay',repayCommand().payload,'bad-context',{mode:'trusted',context:undefined}),/可信认证上下文/);
 const unbound=fixture({bind:false});await assert.rejects(unbound.app.execute(repayCommand(),unbound.credential),/revalidation port/);await assertNoEffects(unbound);
});

test('repay: approved legacy credit initializes a missing request list without confirming money or inferring the credit applicant',async()=>{
 for(const value of [undefined,null]){
  const f=fixture({prepare:s=>{repayOrder(s).credit.repaymentRequests=value;delete repayOrder(s).credit.submittedByPrincipalId;}});
  await f.app.execute(repayCommand('initialize',0,{amount:69500}),f.credential);const order=repayOrder((await f.memory.read()).state);
  assert.equal(order.credit.repaymentRequests.length,1);assert.equal(order.credit.repaymentRequests[0].submittedByPrincipalId,f.auth.id);
  assert.equal(order.credit.remaining,69500);assert.equal(order.status,'已挂账');assert.deepEqual(order.payments,repayOrder(f.state).payments);
 }
});

test('repay: only pending requests reserve balance; exact available amount stays pending and never reduces remaining',async()=>{
 const f=fixture();await f.app.execute(repayCommand('all-available',0,{amount:54500}),f.credential);const before=await f.memory.read();
 assert.equal(repayOrder(before.state).credit.repaymentRequests.at(-1).amount,54500);assert.equal(repayOrder(before.state).credit.remaining,69500);
 const result=await f.app.execute(repayCommand('over',1,{amount:1}),f.credential),after=await f.memory.read();
 assert.equal(result.status,'business-rejected');assert.equal(after.revision,1);assert.deepEqual(after.state,before.state);assert.equal(after.audit.length,1);
});

test('repay: invalid amount/channel/order and pending-balance conflicts are original terminal business rejections with no partial request',async()=>{
 for(const c of [{amount:0},{amount:-1},{amount:1.5},{amount:'20000'},{amount:Number.MAX_SAFE_INTEGER+1},{amount:54501},{method:'invalid'},
  {order:'missing'},{status:'营业中'},{status:'待审批挂账'},{status:'已回款'},{zero:true}]){
  const f=fixture({prepare:s=>{if(c.status)repayOrder(s).status=c.status;if(c.zero)repayOrder(s).credit.remaining=0;}}),cmd=repayCommand('invalid',0,c);
  const first=await f.app.execute(cmd,f.credential),head=await f.memory.read();assert.equal(first.status,'business-rejected');assert.deepEqual(head.state,f.state);
  assert.equal(head.revision,0);assert.equal(head.operationResults.size,1);assert.equal(head.audit.length,0);
  f.auth.permissions=[];assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.deepEqual(await f.memory.read(),head);
 }
});

test('repay: duplicate same-key retry returns original request result after later requests without creating payment',async()=>{
 const f=fixture(),cmd=repayCommand(),first=await f.app.execute(cmd,f.credential);await f.app.execute(repayCommand('later',1),f.credential);
 const before=await f.memory.read();assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.deepEqual(await f.memory.read(),before);assert.equal(f.executions(),2);
 const order=repayOrder(before.state);assert.equal(order.credit.repaymentRequests.length,5);assert.equal(order.credit.remaining,69500);
 assert.deepEqual(order.payments,repayOrder(f.state).payments);assert.deepEqual(order.credit.repayments,repayOrder(f.state).credit.repayments);
});

test('repay: revoked grant still returns old terminal; new key denies without consumption and succeeds after regrant',async()=>{
 const f=fixture(),cmd=repayCommand(),first=await f.app.execute(cmd,f.credential);f.auth.permissions=[];const before=await f.memory.read();
 assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.equal(f.executions(),1);
 const fresh=repayCommand('fresh',1);await assert.rejects(f.app.execute(fresh,f.credential),denied);assert.deepEqual(await f.memory.read(),before);
 f.auth.permissions.push('credit.repay');assert.equal((await f.app.execute(fresh,f.credential)).status,'committed');assert.equal((await f.memory.read()).revision,2);
});

test('repay: disabled/revoked/idle/absolute/version-invalid session cannot read saved request result',async()=>{
 for(const invalid of ['disabled','revoked','idle','absolute','version']){
  const f=fixture(),cmd=repayCommand();await f.app.execute(cmd,f.credential);const before=await f.memory.read();
  if(invalid==='disabled')f.auth.enabled=false;else if(invalid==='revoked')f.auth.revoked=true;else if(invalid==='version')f.auth.version++;
  else if(invalid==='idle')f.auth.idle=dbNow;else {f.auth.idle=dbNow;f.auth.absolute=dbNow;}
  f.events.length=0;await assert.rejects(f.app.execute(cmd,f.credential),e=>e.code==='AUTHENTICATION_REQUIRED');
  assert.equal(f.events.includes('operation'),false);assert.deepEqual(await f.memory.read(),before);
 }
});

test('repay: actor/action/amount/method/revision fingerprint conflicts precede current permission checks',async()=>{
 const f=fixture(),cmd=repayCommand();await f.app.execute(cmd,f.credential);f.auth.permissions=[];const before=await f.memory.read(),id=f.auth.id;
 f.auth.id='different-synthetic-actor';const actor=await f.app.execute(cmd,f.credential);assert.equal(actor.status,'idempotency-conflict');assert.equal(actor.reason,'actor-mismatch');f.auth.id=id;
 for(const changed of [{...cmd,expectedRevision:1},{...cmd,action:'approveRepayment'},{...cmd,payload:{...cmd.payload,amount:20001}},
  {...cmd,payload:{...cmd.payload,method:'现金'}},{...cmd,payload:{...cmd.payload,submittedByPrincipalId:'fake'}}]){
  const result=await f.app.execute(changed,f.credential);assert.equal(result.status,'idempotency-conflict');assert.equal(result.reason,'request-mismatch');
 }
 assert.equal(f.executions(),1);assert.deepEqual(await f.memory.read(),before);
});

test('repay: stale revision stays terminal after a later request and permission revoke',async()=>{
 const f=fixture(),cmd=repayCommand('stale',9),first=await f.app.execute(cmd,f.credential);assert.equal(first.status,'revision-conflict');assert.equal(f.executions(),0);
 await f.app.execute(repayCommand('valid'),f.credential);f.auth.permissions=[];const head=await f.memory.read();
 assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.deepEqual(await f.memory.read(),head);
});

test('repay: unknown fault after request append rolls back all facts and repaired original key can retry',async()=>{
 let broken=true;const f=fixture({execute:(...args)=>{const state=transact(...args);if(broken)throw Error('synthetic repayment request fault');return state;}}),cmd=repayCommand();
 await assert.rejects(f.app.execute(cmd,f.credential),/synthetic repayment request fault/);await assertNoEffects(f);
 broken=false;assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');const head=await f.memory.read();
 assert.equal(head.revision,1);assert.equal(head.operationResults.size,1);assert.equal(head.audit.length,1);
 assert.equal(repayOrder(head.state).credit.repaymentRequests.length,4);assert.deepEqual(repayOrder(head.state).payments,repayOrder(f.state).payments);
});

test('repay: competing keys and same-key retries append at most once per old revision and never create payment',async()=>{
 for(const sameKey of [false,true]){
  const f=fixture(),a=repayCommand('a'),b=repayCommand(sameKey?'a':'b'),results=await Promise.all([f.app.execute(a,f.credential),f.app.execute(b,f.credential)]);
  if(sameKey)assert.deepEqual(results[0],results[1]);else assert.deepEqual(results.map(r=>r.status).sort(),['committed','revision-conflict']);
  const head=await f.memory.read();assert.equal(head.revision,1);assert.equal(head.audit.length,1);assert.equal(f.executions(),1);
  const order=repayOrder(head.state);assert.equal(order.credit.repaymentRequests.length,4);assert.equal(order.credit.remaining,69500);assert.deepEqual(order.payments,repayOrder(f.state).payments);
 }
});

test('repay: request grant does not open repayment decisions, money actions or remaining unmigrated commands',async()=>{
 const f=fixture({permissions:['credit.repay','credit.repay.approve','review.self','rounding.approve','payment.collect','payment.settle',
  'incident.create','incident.resolve','incident.resolve.approve','procurement.create','handover','room.open']});
 for(const action of ['approveRepayment','rejectRepayment','approveRounding','rejectRounding','collect','settle','pay','incident','resolveIncident',
  'approveIncidentResolution','rejectIncidentResolution','procurement','handover','open']){
  await assert.rejects(f.app.execute({...repayCommand(action),action},f.credential),e=>denied(e)&&e.reason==='trusted-action-not-enabled');await assertNoEffects(f);
 }
});
