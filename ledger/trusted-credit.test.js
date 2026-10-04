import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { applyCredit } from '../sales.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { creditCommand, seedTrustedCredit, creditOrder } from '../test-support/trusted-credit-fixture.js';

const dbNow = '2026-10-05T12:00:00.123456Z';
const denied = e => e instanceof AuthorizationDenied && e.status === 'authorization-denied';
function fixture({ permissions = ['credit.apply'], prepare = () => {}, execute = transact, bind = true } = {}) {
  const state = initialState(); state.user = 'unmapped-demo-user'; state.clock = 'invalid-demo-clock';
  state.permissions = { administrator: ['管理员'] }; state.capabilities = { administrator: ['*'] }; state.administrator = true;
  state.orders = [{ id: 'historical-retail', kind: 'retail', room: null,
    sales: [{ productNameSnapshot: null, pricePerSaleUnitCents: null, baseQuantityPerSaleUnit: 12, totalBaseQuantity: 24 }],
    payments: [{ method: '现金', amount: 10 }, { method: '微信', amount: 20 }] }];
  seedTrustedCredit(state); prepare(state);
  const memory = createMemoryLedgerStore(state, { ledgerId: 'credit-unit' }), events = [], digest = Buffer.alloc(32, 19);
  const auth = { id: 'synthetic-credit-actor', permissions, enabled: true, revoked: false, version: 1, sessionVersion: 1,
    idle: '2099-01-01T00:00:00.000000Z', absolute: '2099-01-02T00:00:00.000000Z' };
  const port = {
    locateSessionByDigest: async () => ({ principalId: auth.id, sessionId: 'synthetic-credit-session' }),
    lockAccount: async () => { events.push('account'); return { principalId: auth.id, enabled: auth.enabled, credentialVersion: auth.version, policyAttributesConfigured: false }; },
    lockSessionById: async () => { events.push('session'); return { principalId: auth.id, sessionId: 'synthetic-credit-session', tokenDigest: digest,
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
    return work(tx); // Credit creation has no employee attribution.
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

test('credit: session principal creates pending request and releases room using frozen DB time',async()=>{
 const f=fixture(),cmd=creditCommand(),result=await f.app.execute(cmd,f.credential),head=await f.memory.read(),order=creditOrder(head.state);
 assert.equal(result.status,'committed');assert.equal(result.actorId,f.auth.id);assert.equal(head.revision,1);
 assert.equal(order.credit.submittedByPrincipalId,f.auth.id);assert.equal(order.credit.submittedById,'');assert.equal(order.credit.person,null);
 assert.equal(order.credit.amount,104500);assert.equal(order.credit.remaining,104500);assert.equal(order.status,'待审批挂账');
 assert.equal(order.credit.submittedAt,dbNow);assert.equal(order.credit.due,'2026-10-06T12:00:00.123Z');assert.equal(order.credit.approver,'老板');
 assert.equal(head.state.rooms[0].status,'待清洁');assert.equal(head.state.rooms[0].order,null);
 assert.equal(order.credit.name,'Synthetic Customer');assert.equal(order.credit.phone,'13800000000');assert.equal(order.credit.note,'Synthetic credit note');
 assert.deepEqual(order.payments,creditOrder(f.state).payments);assert.deepEqual(head.state.inventory,f.state.inventory);
 assert.equal(head.operationResults.size,1);assert.equal(head.audit.length,1);assert.equal(head.audit[0].actorId,f.auth.id);
});


test('credit: original customer fields, balance, approval routing, deadline and historical attribution match demo',async()=>{
 for(const c of [{phone:'',name:' Customer only '},{phone:'13800000000',name:''},{phone:' 13800000000 ',name:' '+ 'n'.repeat(40)+' ',note:' '+ 'x'.repeat(220)+' '}]){
  const f=fixture(),cmd=creditCommand('fields',0,c);await f.app.execute(cmd,f.credential);const order=creditOrder((await f.memory.read()).state);
  const demo=creditOrder(transact({...f.state,user:'administrator',clock:dbNow},'credit',cmd.payload,'demo'));
  for(const field of ['id','amount','remaining','phone','name','note','openedBy','openSource','reservedBy','reservationSource','signature','submittedAt','due','approver','repayments','repaymentRequests'])assert.deepEqual(order.credit[field],demo.credit[field],field);
  const {credit,status,...rest}=order;const {credit:oldCredit,status:oldStatus,...oldRest}=creditOrder(f.state);assert.deepEqual(rest,oldRest);
 }
 for(const [amount,approver] of [[1,'店长'],[100000,'店长'],[100001,'老板']]){
  const f=fixture({prepare:s=>{Object.assign(creditOrder(s),{packageBaseCents:amount,packageGiftValueCents:0,sales:[],otherCharges:[],payments:[]});}});
  await f.app.execute(creditCommand(),f.credential);const row=creditOrder((await f.memory.read()).state).credit;assert.equal(row.amount,amount);assert.equal(row.approver,approver);
  assert.equal(f.context().policyAttributesConfigured,false);assert.equal(f.context().policyAttributeIds,null);
 }
});

test('credit: forged payload and demo identities cannot overwrite session applicant, permissions or time',async()=>{
 const f=fixture({prepare:s=>{s.user='administrator';s.clock='1900-01-01';}}),cmd=creditCommand('forged',0,{actorId:'fake',principalId:'fake',actualActorPrincipalId:'fake',
  person:'Fake Applicant',submittedBy:'Fake Applicant',submittedById:'administrator',submittedByPrincipalId:'fake',permissions:['*'],role:'老板',clock:'1900-01-01',
  amount:1,remaining:1,due:'1900-01-01',approver:'Fake Approver',policyAttributesConfigured:true,policyAttributeIds:['expense.approval.boss']});
 const result=await f.app.execute(cmd,f.credential),head=await f.memory.read(),row=creditOrder(head.state).credit;
 assert.equal(result.actorId,f.auth.id);assert.equal(row.submittedByPrincipalId,f.auth.id);assert.equal(row.submittedById,'');assert.equal(row.person,null);
 assert.equal(row.amount,104500);assert.equal(row.remaining,104500);assert.equal(row.approver,'老板');assert.equal(row.submittedAt,dbNow);assert.equal(row.due,'2026-10-06T12:00:00.123Z');
 for(const field of ['user','permissions','clock','capabilities','administrator'])assert.deepEqual(head.state[field],f.state[field]);
 assert.equal(row.name,'Synthetic Customer');assert.equal(row.phone,'13800000000');assert.equal(row.signature,cmd.payload.signature);
});

test('credit: only credit.apply authorizes; denial leaves key unused and current grant permits same-key retry',async()=>{
 for(const permissions of [[],['backend.view'],['credit.approve','review.self'],['payment.settle','staff.record']]){
  const f=fixture({permissions}),cmd=creditCommand('denied',0,{permissions:['credit.apply'],role:'老板',person:'Fake'});
  await assert.rejects(f.app.execute(cmd,f.credential),denied);await assertNoEffects(f);assert.equal(f.executions(),0);
  f.auth.permissions.push('credit.apply');assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');
  assert.equal(creditOrder((await f.memory.read()).state).credit.submittedByPrincipalId,f.auth.id);
 }
});

test('credit: customer identity is business input; employee attribution cannot authorize or become applicant',async()=>{
 const f=fixture({permissions:['credit.apply','staff.record']});
 await assert.rejects(f.app.execute(creditCommand('employee',0,{creditedEmployeeId:'10000000-0000-4000-8000-000000000001'}),f.credential),e=>denied(e)&&e.reason==='invalid-attribution');await assertNoEffects(f);
 await f.app.execute(creditCommand('customer',0,{name:'Different customer',phone:'',employee:'unmapped-legacy-id'}),f.credential);
 const row=creditOrder((await f.memory.read()).state).credit;assert.equal(row.name,'Different customer');assert.equal(row.submittedByPrincipalId,f.auth.id);
 assert.equal(Object.hasOwn(row,'creditedEmployeeId'),false);
});

test('credit: direct domain path rejects untrusted context and never reads demo identity or clock',async()=>{
 const f=fixture();await f.app.execute(creditCommand(),f.credential);const state={serial:1000},order=structuredClone(creditOrder(f.state));
 for(const field of ['user','permissions','clock','capabilities','administrator'])Object.defineProperty(state,field,{get(){assert.fail('trusted credit read demo '+field);}});
 applyCredit(state,order,creditCommand().payload,'fake','1900-01-01',{mode:'trusted',context:f.context()});
 assert.equal(order.credit.submittedByPrincipalId,f.auth.id);assert.equal(order.credit.person,null);assert.equal(order.credit.submittedAt,dbNow);
 const noGrant=fixture({permissions:[]});await assert.rejects(noGrant.app.execute(creditCommand(),noGrant.credential),denied);
 const unchanged=structuredClone(order);assert.throws(()=>applyCredit(state,order,creditCommand().payload,undefined,undefined,{mode:'trusted',context:noGrant.context()}),denied);assert.deepEqual(order,unchanged);
});

test('credit: permission revoke preserves original terminal replay and new key uses current grant',async()=>{
 const f=fixture(),cmd=creditCommand(),first=await f.app.execute(cmd,f.credential);f.auth.permissions=[];const before=await f.memory.read();
 assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.equal(f.executions(),1);
 await assert.rejects(f.app.execute(creditCommand('new',1),f.credential),denied);assert.deepEqual(await f.memory.read(),before);
});

test('credit: actor/action/payload/revision changes stay Stage 1 idempotency conflicts after permission revoke',async()=>{
 const f=fixture(),cmd=creditCommand();await f.app.execute(cmd,f.credential);f.auth.permissions=[];const before=await f.memory.read(),actor=f.auth.id;
 f.auth.id='another-synthetic-principal';const conflict=await f.app.execute(cmd,f.credential);assert.equal(conflict.status,'idempotency-conflict');assert.equal(conflict.reason,'actor-mismatch');f.auth.id=actor;
 for(const changed of [{...cmd,expectedRevision:1},{...cmd,action:'approve'},{...cmd,payload:{...cmd.payload,name:'Changed customer'}}]){
  const result=await f.app.execute(changed,f.credential);assert.equal(result.status,'idempotency-conflict');assert.equal(result.reason,'request-mismatch');
 }
 assert.equal(f.executions(),1);assert.deepEqual(await f.memory.read(),before);
});

test('credit: disabled/revoked/idle/absolute/credential invalidation blocks old terminal before lookup',async()=>{
 for(const invalid of ['disabled','revoked','idle','absolute','version']){
  const f=fixture(),cmd=creditCommand();await f.app.execute(cmd,f.credential);const before=await f.memory.read();
  if(invalid==='disabled')f.auth.enabled=false;else if(invalid==='revoked')f.auth.revoked=true;else if(invalid==='version')f.auth.version++;else if(invalid==='idle')f.auth.idle=dbNow;else {f.auth.idle=dbNow;f.auth.absolute=dbNow;}
  f.events.length=0;await assert.rejects(f.app.execute(cmd,f.credential),e=>e.code==='AUTHENTICATION_REQUIRED');assert.equal(f.events.includes('operation'),false);assert.equal(f.executions(),1);assert.deepEqual(await f.memory.read(),before);
 }
});

test('credit: original business validation is terminal and leaves order, room, money and inventory unchanged',async()=>{
 const cases=[{payload:{order:'missing'}},{status:'已结账'},{status:'待审批挂账'},{gift:true},{paid:true},
  {payload:{phone:'',name:''}},{payload:{phone:'123'}},{payload:{note:'  '}},...[null,123,'data:image/png;base64,short','data:image/jpeg;base64,'+'s'.repeat(100)].map(signature=>({payload:{signature}}))];
 for(const c of cases){
  const f=fixture({prepare:s=>{const o=creditOrder(s);if(c.status)o.status=c.status;if(c.gift)o.giftRequests=[{status:'待确认'}];if(c.paid)o.payments=[{amount:107500,method:'现金'}];}}),cmd=creditCommand('invalid',0,c.payload);
  const result=await f.app.execute(cmd,f.credential),before=await f.memory.read();assert.equal(result.status,'business-rejected');assert.deepEqual(before.state,f.state);assert.equal(before.revision,0);assert.equal(before.operationResults.size,1);assert.equal(before.audit.length,0);
  f.auth.permissions=[];assert.deepEqual(await f.app.execute(cmd,f.credential),result);assert.equal(f.executions(),1);assert.deepEqual(await f.memory.read(),before);
 }
});

test('credit: stale revision stays original terminal after ledger advances and permission is revoked',async()=>{
 const f=fixture(),cmd=creditCommand('stale',9),first=await f.app.execute(cmd,f.credential);assert.equal(first.status,'revision-conflict');assert.equal(f.executions(),0);
 await f.app.execute(creditCommand('valid'),f.credential);f.auth.permissions=[];const before=await f.memory.read();assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.equal(f.executions(),1);assert.deepEqual(await f.memory.read(),before);
});

test('credit: unknown failure after request and room mutation fully rolls back; repaired original key retries',async()=>{
 let broken=true;const f=fixture({execute:(...args)=>{const next=transact(...args);if(broken)throw Error('synthetic credit fault');return next;}}),cmd=creditCommand();
 await assert.rejects(f.app.execute(cmd,f.credential),/synthetic credit fault/);await assertNoEffects(f);broken=false;
 assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');const head=await f.memory.read();assert.equal(head.revision,1);assert.equal(head.operationResults.size,1);assert.equal(head.audit.length,1);
 assert.equal(creditOrder(head.state).credit.id,1001);assert.equal(head.state.rooms[0].status,'待清洁');
});

test('credit: same-key replay and two competing keys create one credit and release room once',async()=>{
 for(const sameKey of [false,true]){const f=fixture(),results=await Promise.all([f.app.execute(creditCommand('a'),f.credential),f.app.execute(creditCommand(sameKey?'a':'b'),f.credential)]);
  if(sameKey)assert.deepEqual(results[0],results[1]);else assert.deepEqual(results.map(r=>r.status).sort(),['committed','revision-conflict']);
  const head=await f.memory.read();assert.equal(head.revision,1);assert.equal(head.audit.length,1);assert.equal(f.executions(),1);assert.equal(creditOrder(head.state).credit.id,1001);assert.equal(head.state.serial,1001);
 }
});

test('credit: missing context or connection-bound auth fails closed without demo fallback',async()=>{
 const f=fixture({bind:false});await assert.rejects(f.app.execute(creditCommand(),f.credential),/session revalidation port/);await assertNoEffects(f);
 for(const context of [undefined,{principalId:'fake',permissionIds:['credit.apply'],dbNow}]){
  assert.throws(()=>transact(f.state,'credit',creditCommand().payload,'context',{mode:'trusted',context}),/可信认证上下文/);
  assert.throws(()=>applyCredit(f.state,creditOrder(f.state),creditCommand().payload,'fake',dbNow,{mode:'trusted',context}),/可信认证上下文/);
 }
 assert.throws(()=>applyCredit(f.state,creditOrder(f.state),creditCommand().payload,'fake',dbNow,{mode:'unknown'}),/执行模式/);
});

test('credit: rounding, money and remaining business actions stay closed despite grants',async()=>{
 const f=fixture({permissions:['credit.apply','credit.approve','credit.repay','credit.repay.approve','rounding.approve','payment.collect','payment.settle','incident.create','incident.resolve','incident.resolve.approve','procurement.create','handover','room.open','review.self']});
 for(const action of ['approveRounding','rejectRounding','collect','settle','pay','resolveIncident','approveIncidentResolution','rejectIncidentResolution','procurement','handover','open']){
  await assert.rejects(f.app.execute({...creditCommand(action),action},f.credential),e=>denied(e)&&e.reason==='trusted-action-not-enabled');await assertNoEffects(f);
 }
});

test('credit: historical snapshots and existing room-release ownership remain unchanged; demo still uses demo identity',async()=>{
 const f=fixture({prepare:s=>{s.rooms[0].order='another-order';const o=creditOrder(s);delete o.openedBy;delete o.person;delete o.openSource;delete o.reservedBy;delete o.reservationSource;}});
 await f.app.execute(creditCommand(),f.credential);const head=await f.memory.read(),o=creditOrder(head.state);
 assert.deepEqual(head.state.rooms,f.state.rooms);assert.equal(o.credit.openedBy,'未记录');assert.equal(o.credit.openSource,'线下');assert.equal(o.credit.reservedBy,'');assert.equal(o.credit.reservationSource,'');
 assert.deepEqual(o.creditHistory,creditOrder(f.state).creditHistory);assert.deepEqual(head.state.orders[0],f.state.orders[0]);
 const demo=creditOrder(transact({...f.state,user:'administrator',clock:dbNow},'credit',creditCommand().payload,'demo')).credit;
 assert.equal(demo.person,'管理员');assert.equal(demo.submittedById,'administrator');assert.equal(Object.hasOwn(demo,'submittedByPrincipalId'),false);
});
