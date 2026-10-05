import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { decideCredit } from '../sales.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { CREDIT_REVIEW_ACTIONS, creditDecision, creditReviewCommand, seedCreditReview } from '../test-support/trusted-credit-review-fixture.js';

const dbNow = '2026-10-05T12:00:00.123456Z';
const denied = e => e instanceof AuthorizationDenied && e.status === 'authorization-denied';
function fixture({ permissions = ['credit.approve'], applicant = 'synthetic-credit-applicant', amount = 100000, configured = true, attributes = ['credit.approval.manager'], prepare = () => {}, execute = transact, bind = true } = {}) {
  const state = initialState(); state.user = 'unmapped-demo-user'; state.clock = 'invalid-demo-clock';
  state.permissions = { administrator: ['管理员'] }; state.capabilities = { administrator: ['*'] }; state.administrator = true;
  state.orders = [{ id: 'historical-retail', kind: 'retail', room: null,
    sales: [{ productNameSnapshot: null, pricePerSaleUnitCents: null, baseQuantityPerSaleUnit: 12, totalBaseQuantity: 24 }],
    payments: [{ method: '现金', amount: 10 }, { method: '微信', amount: 20 }] }];
  seedCreditReview(state, applicant, amount); prepare(state);
  const memory = createMemoryLedgerStore(state, { ledgerId: 'credit-review-unit' }), events = [], digest = Buffer.alloc(32, 19);
  const auth = { id: 'synthetic-credit-reviewer', permissions, configured, attributes, enabled: true, revoked: false, version: 1, sessionVersion: 1,
    idle: '2099-01-01T00:00:00.000000Z', absolute: '2099-01-02T00:00:00.000000Z' };
  const port = {
    locateSessionByDigest: async () => ({ principalId: auth.id, sessionId: 'synthetic-credit-session' }),
    lockAccount: async () => { events.push('account'); return { principalId: auth.id, enabled: auth.enabled, credentialVersion: auth.version, policyAttributesConfigured: auth.configured }; },
    lockSessionById: async () => { events.push('session'); return { principalId: auth.id, sessionId: 'synthetic-credit-session', tokenDigest: digest,
      revoked: auth.revoked, credentialVersion: auth.sessionVersion, idleExpiresAt: auth.idle, absoluteExpiresAt: auth.absolute }; },
    listGrants: async () => { events.push('grants'); return auth.permissions; }, listPolicyAttributes: async () => auth.attributes,
    readDbNow: async () => { events.push('db-now'); return dbNow; }
  };
  let executions = 0, context;
  const store = { ledgerId: memory.ledgerId, runAtomic: work => memory.runAtomic(tx => {
    events.push('head'); const find = tx.findOperationResult; tx.findOperationResult = key => { events.push('operation'); return find(key); };
    if (bind) tx.sessionRevalidation = { revalidateSessionInTransaction: async credential => {
      context = await revalidateSessionInTransaction({ port, ...credential }); return context;
    } };
    return work(tx); // Credit review has no employee attribution.
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

test('credit decision: non-applicant with manager attribute approves <=1000 and saves session decider', async () => {
  const f=fixture(),result=await f.app.execute(creditReviewCommand(),f.credential),head=await f.memory.read(),record=creditDecision(head.state);
  assert.equal(result.status,'committed');assert.equal(result.actorId,f.auth.id);assert.equal(head.revision,1);
  assert.equal(record.decidedByPrincipalId,f.auth.id);assert.equal(record.decisionBy,null);assert.equal(record.decisionAt,dbNow);
  assert.equal(record.approver,'店长');assert.equal(record.selfReviewAuthorized,false);assert.equal(record.decisionStatus,'已批准');
  assert.equal(record.amount,100000);assert.equal(head.audit[0].actorId,f.auth.id);
});

const manager='credit.approval.manager',boss='credit.approval.boss';
const orderOf=state=>state.orders.find(o=>o.id==='synthetic-credit-order');
const secondPending=state=>state.orders.push({...structuredClone(orderOf(state)),id:'second-credit-order'});
for(const action of CREDIT_REVIEW_ACTIONS){
  test('credit '+action+': preserves the original decision, archived rejection, saved routing level and historical facts',async()=>{
    const f=fixture({amount:100001,attributes:[boss]}),original=structuredClone(orderOf(f.state));
    const result=await f.app.execute(creditReviewCommand(action),f.credential),head=await f.memory.read(),order=orderOf(head.state),record=creditDecision(head.state,action);
    assert.equal(result.status,'committed');assert.equal(order.status,action==='approve'?'已挂账':'营业中');
    assert.equal(record.decisionStatus,action==='approve'?'已批准':'已驳回');assert.equal(record.decidedByPrincipalId,f.auth.id);
    assert.equal(record.decisionBy,null);assert.equal(record.decisionAt,dbNow);assert.equal(record.selfReviewAuthorized,false);
    for(const [field,value] of Object.entries(original.credit))assert.deepEqual(record[field],value);
    assert.equal(record.approver,'老板');
    if(action==='reject'){assert.equal(order.credit,null);assert.deepEqual(order.creditHistory.slice(0,-1),original.creditHistory);}
    else assert.deepEqual(order.creditHistory,original.creditHistory);
    for(const [field,value] of Object.entries(original))if(!['status','credit','creditHistory'].includes(field))assert.deepEqual(order[field],value);
    for(const field of ['rooms','inventory','consumables','ledger','user','permissions','clock','capabilities','administrator'])assert.deepEqual(head.state[field],f.state[field]);
    assert.deepEqual(head.state.orders[0],f.state.orders[0]);assert.equal(head.state.orders[0].room,null);
    assert.equal(head.state.inventory.qd.count,null);assert.equal(head.state.inventory.bw.count,0);
    assert.equal(head.revision,1);assert.equal(head.operationResults.size,1);assert.equal(head.audit.length,1);
  });

  test('credit '+action+': <=1000 admits manager OR boss, >1000 admits only boss for both decisions',async()=>{
    for(const amount of [1,99999,100000])for(const attributes of [[manager],[boss],[manager,boss]]){
      const f=fixture({amount,attributes});assert.equal((await f.app.execute(creditReviewCommand(action),f.credential)).status,'committed');
      assert.equal(creditDecision((await f.memory.read()).state,action).approver,'店长');
    }
    for(const attributes of [[boss],[manager,boss]]){
      const f=fixture({amount:100001,attributes});assert.equal((await f.app.execute(creditReviewCommand(action),f.credential)).status,'committed');
    }
    const f=fixture({amount:100001,attributes:[manager]}),cmd=creditReviewCommand(action);
    await assert.rejects(f.app.execute(cmd,f.credential),e=>denied(e)&&e.reason==='missing-policy-attribute');await assertNoEffects(f);
    f.auth.attributes.push(boss);assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');
  });

  test('credit '+action+': unconfigured, empty and unrelated attributes deny every tier without consuming key',async()=>{
    for(const amount of [100000,100001])for(const [configured,attributes] of [[false,[]],[true,[]],[true,['rounding.self.excess','expense.approval.boss']]]){
      const f=fixture({amount,configured,attributes}),cmd=creditReviewCommand(action);
      await assert.rejects(f.app.execute(cmd,f.credential),e=>denied(e)&&e.reason===(configured?'missing-policy-attribute':'policy-attributes-unconfigured'));
      await assertNoEffects(f);f.auth.configured=true;f.auth.attributes=[boss];
      assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');
    }
  });

  test('credit '+action+': self decision requires credit.approve plus review.self and the correct current tier',async()=>{
    for(const amount of [100000,100001]){
      const f=fixture({applicant:'synthetic-credit-reviewer',amount,attributes:[boss]}),cmd=creditReviewCommand(action);
      await assert.rejects(f.app.execute(cmd,f.credential),e=>denied(e)&&e.reason==='missing-permission');await assertNoEffects(f);
      f.auth.permissions.push('review.self');assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');
      assert.equal(creditDecision((await f.memory.read()).state,action).selfReviewAuthorized,true);
    }
  });

  test('credit '+action+': review.self, backend or boss attribute cannot replace credit.approve',async()=>{
    for(const permissions of [[],['review.self'],['backend.view'],['credit.apply'],['review.self','backend.view']]){
      const f=fixture({permissions,applicant:'synthetic-credit-reviewer',attributes:[boss]});
      await assert.rejects(f.app.execute(creditReviewCommand(action),f.credential),e=>denied(e)&&e.reason==='missing-permission');await assertNoEffects(f);
    }
  });

  test('credit '+action+': payload cannot override applicant, actor, saved tier/amount, grants, attributes or time',async()=>{
    const forged={actorId:'administrator',principalId:'fake',user:'boss',permissions:['credit.approve','review.self'],role:'老板',clock:'1900-01-01',
      applicant:'fake',submittedBy:'fake',submittedByPrincipalId:'fake',approver:'店长',decidedByPrincipalId:'fake',selfReview:false,
      attributes:[boss],policyAttributeIds:[boss],policyAttributesConfigured:true,amount:1};
    const self=fixture({applicant:'synthetic-credit-reviewer'});await assert.rejects(self.app.execute(creditReviewCommand(action,'self',0,forged),self.credential),denied);await assertNoEffects(self);
    const high=fixture({amount:100001,attributes:[manager],prepare:s=>{s.user='boss';s.clock='1900-01-01';}});
    await assert.rejects(high.app.execute(creditReviewCommand(action,'high',0,forged),high.credential),denied);await assertNoEffects(high);
    const allowed=fixture({amount:100001,attributes:[boss]});await allowed.app.execute(creditReviewCommand(action,'valid',0,forged),allowed.credential);
    const row=creditDecision((await allowed.memory.read()).state,action);assert.equal(row.amount,100001);assert.equal(row.approver,'老板');
    assert.equal(row.decidedByPrincipalId,allowed.auth.id);assert.equal(row.submittedByPrincipalId,'synthetic-credit-applicant');
    assert.equal(row.selfReviewAuthorized,false);assert.equal(row.decisionBy,null);assert.equal(row.decisionAt,dbNow);
  });

  test('credit '+action+': legacy lacks trusted applicant and cannot infer it from name, old ID or routing label',async()=>{
    for(const applicant of [undefined,null,'',' ',' synthetic ',123,{},'x'.repeat(192)]){
      const f=fixture({attributes:[boss],prepare:s=>{const c=orderOf(s).credit;if(applicant===undefined)delete c.submittedByPrincipalId;else c.submittedByPrincipalId=applicant;c.person='老板';c.submittedById='boss';s.user='boss';}});
      await assert.rejects(f.app.execute(creditReviewCommand(action,'legacy',0,{submittedByPrincipalId:'synthetic-credit-applicant',applicant:'fake',selfReview:false}),f.credential),
        e=>denied(e)&&e.reason==='untrusted-credit-applicant');await assertNoEffects(f);
    }
  });

  test('credit '+action+': permission or tier revoke preserves old terminal; new pending key denies and remains reusable',async()=>{
    for(const revoke of ['permission','manager','boss']){
      const attr=revoke==='manager'?manager:boss,f=fixture({attributes:[attr],prepare:secondPending}),cmd=creditReviewCommand(action);
      const first=await f.app.execute(cmd,f.credential);if(revoke==='permission')f.auth.permissions=[];else f.auth.attributes=[];
      const before=await f.memory.read();assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.equal(f.executions(),1);
      const fresh=creditReviewCommand(action,'new',1,{order:'second-credit-order'});await assert.rejects(f.app.execute(fresh,f.credential),denied);assert.deepEqual(await f.memory.read(),before);
      f.auth.permissions=['credit.approve'];f.auth.attributes=[attr];assert.equal((await f.app.execute(fresh,f.credential)).status,'committed');assert.equal((await f.memory.read()).revision,2);
    }
  });

  test('credit '+action+': disabled/revoked/expired/version-invalid session cannot read an old terminal',async()=>{
    for(const invalid of ['disabled','revoked','idle','absolute','version']){
      const f=fixture(),cmd=creditReviewCommand(action);await f.app.execute(cmd,f.credential);const before=await f.memory.read();
      if(invalid==='disabled')f.auth.enabled=false;else if(invalid==='revoked')f.auth.revoked=true;else if(invalid==='version')f.auth.version++;
      else if(invalid==='idle')f.auth.idle=dbNow;else {f.auth.idle=dbNow;f.auth.absolute=dbNow;}
      f.events.length=0;await assert.rejects(f.app.execute(cmd,f.credential),e=>e.code==='AUTHENTICATION_REQUIRED');
      assert.equal(f.events.includes('operation'),false);assert.deepEqual(await f.memory.read(),before);
    }
  });

  test('credit '+action+': actor, action, payload and expectedRevision conflicts still precede current authorization',async()=>{
    const f=fixture(),cmd=creditReviewCommand(action);await f.app.execute(cmd,f.credential);f.auth.permissions=[];f.auth.attributes=[];
    const before=await f.memory.read(),original=f.auth.id;f.auth.id='different-synthetic-reviewer';
    const actor=await f.app.execute(cmd,f.credential);assert.equal(actor.status,'idempotency-conflict');assert.equal(actor.reason,'actor-mismatch');f.auth.id=original;
    for(const changed of [{...cmd,expectedRevision:1},{...cmd,action:action==='approve'?'reject':'approve'},
      {...cmd,payload:{order:'other-order'}},{...cmd,payload:{...cmd.payload,selfReview:true}}]){
      const result=await f.app.execute(changed,f.credential);assert.equal(result.status,'idempotency-conflict');assert.equal(result.reason,'request-mismatch');
    }
    assert.equal(f.executions(),1);assert.deepEqual(await f.memory.read(),before);
  });

  test('credit '+action+': original missing/processed and stale revision stay terminal after revoke',async()=>{
    for(const c of [{payload:{order:'missing'}},{prepare:s=>orderOf(s).status='已挂账'},{prepare:s=>orderOf(s).status='营业中'}]){
      const f=fixture({prepare:c.prepare}),cmd=creditReviewCommand(action,'business',0,c.payload),result=await f.app.execute(cmd,f.credential),head=await f.memory.read();
      assert.equal(result.status,'business-rejected');assert.equal(head.revision,0);assert.deepEqual(head.state,f.state);assert.equal(head.audit.length,0);
      f.auth.permissions=[];f.auth.attributes=[];assert.deepEqual(await f.app.execute(cmd,f.credential),result);assert.deepEqual(await f.memory.read(),head);
    }
    const f=fixture(),cmd=creditReviewCommand(action,'stale',9),first=await f.app.execute(cmd,f.credential);assert.equal(first.status,'revision-conflict');
    await f.app.execute(creditReviewCommand(action,'valid'),f.credential);f.auth.permissions=[];f.auth.attributes=[];const head=await f.memory.read();
    assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.deepEqual(await f.memory.read(),head);
  });

  test('credit '+action+': direct trusted domain enforces branded context without reading demo identity or clock',async()=>{
    const f=fixture({amount:100001,attributes:[boss]});await f.app.execute(creditReviewCommand(action),f.credential);
    const state={};for(const field of ['user','permissions','clock','capabilities','administrator'])Object.defineProperty(state,field,{get(){assert.fail('Read demo '+field);}});
    const order=structuredClone(orderOf(f.state));decideCredit(state,order,action,'fake','1900-01-01',()=>assert.fail('Demo reviewer invoked'),{mode:'trusted',context:f.context()});
    const row=action==='reject'?order.creditHistory.at(-1):order.credit;assert.equal(row.decidedByPrincipalId,f.auth.id);assert.equal(row.decisionAt,dbNow);
    for(const context of [undefined,{...f.context()}])assert.throws(()=>decideCredit(f.state,orderOf(f.state),action,undefined,undefined,undefined,{mode:'trusted',context}),/可信认证上下文/);
    const self=fixture({applicant:'synthetic-credit-reviewer'});await assert.rejects(self.app.execute(creditReviewCommand(action),self.credential),denied);
    assert.throws(()=>transact(self.state,action,{order:'synthetic-credit-order'},'direct',{mode:'trusted',context:self.context()}),denied);
    const unbound=fixture({bind:false});await assert.rejects(unbound.app.execute(creditReviewCommand(action),unbound.credential),/revalidation port/);await assertNoEffects(unbound);
  });

  test('credit '+action+': demo uses the original role tier and identical amount/status/history/room effects',async()=>{
    for(const amount of [100000,100001]){
      const f=fixture({amount,attributes:[boss]});await f.app.execute(creditReviewCommand(action),f.credential);
      const trusted=(await f.memory.read()).state,demo=transact({...f.state,user:amount>100000?'boss':'wife',clock:dbNow},action,{order:'synthetic-credit-order'},'demo');
      const a=creditDecision(trusted,action),b=creditDecision(demo,action);
      for(const [field,value] of Object.entries(b))if(field!=='decisionBy')assert.deepEqual(a[field],value);
      assert.equal(a.decidedByPrincipalId,f.auth.id);assert.equal(Object.hasOwn(b,'decidedByPrincipalId'),false);
      assert.equal(orderOf(trusted).status,orderOf(demo).status);assert.deepEqual(trusted.rooms,demo.rooms);
      if(amount>100000)assert.throws(()=>transact({...f.state,user:'wife',clock:dbNow},action,{order:'synthetic-credit-order'},'demo-manager'),/老板岗位审批/);
    }
  });
}

test('credit decisions: unsafe or inconsistent saved amount/routing level fails closed without guessing or consuming key',async()=>{
  for(const action of CREDIT_REVIEW_ACTIONS)for(const patch of [{amount:undefined},{amount:null},{amount:0},{amount:-1},{amount:1.5},{amount:'100000'},
    {amount:Number.MAX_SAFE_INTEGER+1},{approver:undefined},{approver:'fake-reviewer'},{amount:100001,approver:'店长'},{approver:'老板'}]){
    const f=fixture({attributes:[boss],prepare:s=>Object.assign(orderOf(s).credit,patch)});
    await assert.rejects(f.app.execute(creditReviewCommand(action),f.credential),e=>denied(e)&&e.reason==='untrusted-credit-approval-level');await assertNoEffects(f);
  }
});

test('credit decisions: unknown fault after state/history mutation rolls back; repaired original key retries',async()=>{
  for(const action of CREDIT_REVIEW_ACTIONS){
    let broken=true;const f=fixture({execute:(...args)=>{const next=transact(...args);if(broken)throw Error('synthetic credit decision fault');return next;}}),cmd=creditReviewCommand(action);
    await assert.rejects(f.app.execute(cmd,f.credential),/synthetic credit decision fault/);await assertNoEffects(f);
    broken=false;assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');const head=await f.memory.read();
    assert.equal(head.revision,1);assert.equal(head.operationResults.size,1);assert.equal(head.audit.length,1);
  }
});

test('credit decisions: same key retries or competing approve/reject decide once',async()=>{
  for(const sameKey of [false,true]){
    const f=fixture(),a=creditReviewCommand('approve','a'),b=creditReviewCommand(sameKey?'approve':'reject',sameKey?'a':'b');
    const results=await Promise.all([f.app.execute(a,f.credential),f.app.execute(b,f.credential)]);
    if(sameKey)assert.deepEqual(results[0],results[1]);else assert.deepEqual(results.map(r=>r.status).sort(),['committed','revision-conflict']);
    const head=await f.memory.read();assert.equal(head.revision,1);assert.equal(head.audit.length,1);assert.equal(f.executions(),1);
  }
});

test('credit decisions: approval grants and attributes do not enable the remaining unmigrated actions',async()=>{
  const f=fixture({permissions:['credit.approve','review.self','credit.repay','credit.repay.approve','rounding.approve','room.open',
    'payment.collect','payment.settle','procurement.create','incident.create','incident.resolve','incident.resolve.approve','handover'],attributes:[manager,boss]});
  for(const action of ['open']){
    await assert.rejects(f.app.execute(creditReviewCommand(action),f.credential),e=>denied(e)&&e.reason==='trusted-action-not-enabled');await assertNoEffects(f);
  }
});
