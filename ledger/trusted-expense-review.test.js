import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { decideExpense } from '../expenses.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { EXPENSE_REVIEW_ACTIONS, expenseReview, expenseReviewCommand, seedExpenseReview } from '../test-support/trusted-expense-review-fixture.js';

const dbNow = '2026-10-04T12:00:00.123456Z';
const denied = e => e instanceof AuthorizationDenied && e.status === 'authorization-denied';
function fixture({ permissions = ['expense.approve'], applicant = 'synthetic-expense-applicant', amount = 50000, configured = false, attributes = [], prepare = () => {}, execute = transact, bind = true } = {}) {
  const state = initialState(); state.user = 'unmapped-demo-user'; state.clock = 'invalid-demo-clock';
  state.permissions = { administrator: ['管理员'] }; state.capabilities = { administrator: ['*'] }; state.administrator = true;
  state.orders = [{ id: 'historical-retail', kind: 'retail', room: null,
    sales: [{ productNameSnapshot: null, pricePerSaleUnitCents: null, baseQuantityPerSaleUnit: 12, totalBaseQuantity: 24 }],
    payments: [{ method: '现金', amount: 10 }, { method: '微信', amount: 20 }] }];
  seedExpenseReview(state, applicant, amount); prepare(state);
  const memory = createMemoryLedgerStore(state, { ledgerId: 'expense-review-unit' }), events = [], digest = Buffer.alloc(32, 19);
  const auth = { id: 'synthetic-expense-reviewer', permissions, configured, attributes, enabled: true, revoked: false, version: 1, sessionVersion: 1,
    idle: '2099-01-01T00:00:00.000000Z', absolute: '2099-01-02T00:00:00.000000Z' };
  const port = {
    locateSessionByDigest: async () => ({ principalId: auth.id, sessionId: 'synthetic-expense-session' }),
    lockAccount: async () => { events.push('account'); return { principalId: auth.id, enabled: auth.enabled, credentialVersion: auth.version, policyAttributesConfigured: auth.configured }; },
    lockSessionById: async () => { events.push('session'); return { principalId: auth.id, sessionId: 'synthetic-expense-session', tokenDigest: digest,
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
    return work(tx); // Expense review has no employee attribution.
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

test('expense review: non-applicant with expense.approve accepts pending <=500 without boss attribute', async () => {
  const f=fixture(), result=await f.app.execute(expenseReviewCommand(),f.credential),head=await f.memory.read(),record=expenseReview(head.state);
  assert.equal(result.status,'committed');assert.equal(result.actorId,f.auth.id);assert.equal(head.revision,1);
  assert.equal(record.status,'已审批');assert.equal(record.decidedByPrincipalId,f.auth.id);assert.equal(record.selfReviewAuthorized,false);
  assert.equal(record.approver,null);assert.equal(record.approvedAt,dbNow);assert.equal(record.submittedByPrincipalId,'synthetic-expense-applicant');
  assert.equal(record.amount,50000);assert.equal(record.date,'2026-01-02');assert.equal(head.audit[0].actorId,f.auth.id);
  assert.equal(head.state.procurements.at(-1).status,'已关联支出');
  assert.deepEqual(head.state.orders,f.state.orders);assert.deepEqual(head.state.inventory,f.state.inventory);
});

test('expense review: configured current boss attribute admits >500 without any demo boss role', async () => {
  const f=fixture({amount:50001,configured:true,attributes:['expense.approval.boss']});
  const result=await f.app.execute(expenseReviewCommand(),f.credential),head=await f.memory.read();
  assert.equal(result.status,'committed');assert.equal(expenseReview(head.state).amount,50001);
  assert.equal(expenseReview(head.state).decidedByPrincipalId,f.auth.id);assert.deepEqual(f.context().policyAttributeIds,['expense.approval.boss']);
});

const boss = 'expense.approval.boss';
const addSecondPending = state => state.expenses.push({ ...expenseReview(state), id: 904, description: 'Another pending expense' });
for (const action of EXPENSE_REVIEW_ACTIONS) {
  test(action + ': original decision and linked procurement status change without rewriting historical business facts', async () => {
    const f=fixture({amount:60000,configured:true,attributes:[boss]}),cmd=expenseReviewCommand(action,'result',0,{id:'902'});
    const result=await f.app.execute(cmd,f.credential),head=await f.memory.read(),row=expenseReview(head.state),linked=head.state.procurements.at(-1);
    assert.equal(result.status,'committed');assert.equal(row.status,action==='approveExpense'?'已审批':'已驳回');
    assert.equal(linked.status,action==='approveExpense'?'已关联支出':'报销已驳回');assert.equal(linked.decisionBy,null);assert.equal(linked.decisionAt,dbNow);
    assert.equal(row.decidedByPrincipalId,f.auth.id);assert.equal(row.approver,null);assert.equal(row.approvedAt,dbNow);assert.equal(row.selfReviewAuthorized,false);
    for(const field of ['id','date','type','amount','method','nature','description','proof','proofName','submittedById','submittedByPrincipalId','person','time'])
      assert.deepEqual(row[field],expenseReview(f.state)[field]);
    assert.deepEqual(head.state.expenses[0],f.state.expenses[0]);assert.deepEqual(head.state.procurements[0],f.state.procurements[0]);
    for(const field of ['orders','rooms','inventory','consumables','ledger','user','clock','permissions','capabilities','administrator'])assert.deepEqual(head.state[field],f.state[field]);
    assert.equal(head.revision,1);assert.equal(head.operationResults.size,1);assert.equal(head.audit.length,1);
  });

  test(action + ': self-review requires expense.approve AND review.self; denied key succeeds after the missing grant', async () => {
    for(const amount of [50000,50001]){
      const f=fixture({applicant:'synthetic-expense-reviewer',amount,configured:true,attributes:[boss]}),cmd=expenseReviewCommand(action);
      await assert.rejects(f.app.execute(cmd,f.credential),denied);await assertNoEffects(f);
      f.auth.permissions.push('review.self');assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');
      assert.equal(expenseReview((await f.memory.read()).state).selfReviewAuthorized,true);
    }
  });

  test(action + ': backend, self-review and boss attribute cannot replace the base approval permission', async () => {
    for(const permissions of [[],['backend.view'],['review.self'],['expense.create'],['review.self','backend.view']]){
      const f=fixture({permissions,applicant:'synthetic-expense-reviewer',amount:60000,configured:true,attributes:[boss]}),cmd=expenseReviewCommand(action);
      await assert.rejects(f.app.execute(cmd,f.credential),e=>denied(e)&&e.reason==='missing-permission');await assertNoEffects(f);
    }
  });

  test(action + ': >500 needs configured current boss attribute; unconfigured/empty/rounding-only deny without consuming key', async () => {
    for(const [configured,attributes] of [[false,[]],[true,[]],[true,['rounding.self.excess']]]){
      const f=fixture({amount:50001,configured,attributes}),cmd=expenseReviewCommand(action);
      await assert.rejects(f.app.execute(cmd,f.credential),e=>denied(e)&&e.reason===(configured?'missing-policy-attribute':'policy-attributes-unconfigured'));
      await assertNoEffects(f);f.auth.configured=true;f.auth.attributes.push(boss);
      assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');
    }
    for(const amount of [1,49999,50000])for(const [configured,attributes] of [[false,[]],[true,[]],[true,['rounding.self.excess']]]){
      const f=fixture({amount,configured,attributes});assert.equal((await f.app.execute(expenseReviewCommand(action),f.credential)).status,'committed');
    }
  });

  test(action + ': payload applicant/selfReview/role/attribute/amount cannot override locked state or trusted context', async () => {
    const forged={actorId:'administrator',principalId:'fake',user:'administrator',permissions:['expense.approve','review.self'],
      role:'老板',clock:'1900-01-01',applicant:'fake',submittedBy:'fake',submittedByPrincipalId:'fake',approver:'fake',
      decidedByPrincipalId:'fake',selfReview:false,policyAttributesConfigured:true,policyAttributeIds:[boss],attributes:[boss],amount:1};
    const self=fixture({applicant:'synthetic-expense-reviewer',configured:true,attributes:[boss]});
    await assert.rejects(self.app.execute(expenseReviewCommand(action,'self',0,forged),self.credential),denied);await assertNoEffects(self);
    const high=fixture({amount:60000,prepare:s=>{s.user='boss';s.clock='1900-01-01';}});
    await assert.rejects(high.app.execute(expenseReviewCommand(action,'high',0,forged),high.credential),denied);await assertNoEffects(high);
    const allowed=fixture({amount:60000,configured:true,attributes:[boss]});
    await allowed.app.execute(expenseReviewCommand(action,'allowed',0,forged),allowed.credential);
    const row=expenseReview((await allowed.memory.read()).state);assert.equal(row.amount,60000);assert.equal(row.decidedByPrincipalId,allowed.auth.id);
    assert.equal(row.submittedByPrincipalId,'synthetic-expense-applicant');assert.equal(row.selfReviewAuthorized,false);assert.equal(row.approver,null);assert.equal(row.approvedAt,dbNow);
  });

  test(action + ': legacy applicants, including procurement-created records, fail closed without name or employee inference', async () => {
    for(const applicant of [undefined,null,'',' ',' synthetic ',123,{},'x'.repeat(192)]){
      const f=fixture({configured:true,attributes:[boss],prepare:s=>{expenseReview(s).submittedByPrincipalId=applicant;s.user='boss';}});
      await assert.rejects(f.app.execute(expenseReviewCommand(action,'legacy',0,{submittedByPrincipalId:'synthetic-expense-applicant',applicant:'synthetic-expense-applicant',selfReview:false}),f.credential),
        e=>denied(e)&&e.reason==='untrusted-expense-applicant');await assertNoEffects(f);
    }
    const f=fixture(),cmd=expenseReviewCommand(action,'procurement',0,{id:900,submittedByPrincipalId:'synthetic-expense-applicant'});
    await assert.rejects(f.app.execute(cmd,f.credential),e=>denied(e)&&e.reason==='untrusted-expense-applicant');await assertNoEffects(f);
  });

  test(action + ': permission/attribute revoke preserves old terminal; fresh pending target is denied and key stays reusable', async () => {
    for(const revoke of ['permission','attribute']){
      const f=fixture({amount:60000,configured:true,attributes:[boss],prepare:addSecondPending}),cmd=expenseReviewCommand(action);
      const first=await f.app.execute(cmd,f.credential);if(revoke==='permission')f.auth.permissions=[];else f.auth.attributes=[];
      const before=await f.memory.read();assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.equal(f.executions(),1);
      const fresh=expenseReviewCommand(action,'new',1,{id:904});await assert.rejects(f.app.execute(fresh,f.credential),denied);assert.deepEqual(await f.memory.read(),before);
      f.auth.permissions=['expense.approve'];f.auth.attributes=[boss];assert.equal((await f.app.execute(fresh,f.credential)).status,'committed');
      assert.equal((await f.memory.read()).revision,2);
    }
  });

  test(action + ': disabled/revoked/expired/version-invalid session cannot read saved decisions', async () => {
    for(const invalid of ['disabled','revoked','idle','absolute','version']){
      const f=fixture(),cmd=expenseReviewCommand(action);await f.app.execute(cmd,f.credential);const before=await f.memory.read();
      if(invalid==='disabled')f.auth.enabled=false;else if(invalid==='revoked')f.auth.revoked=true;else if(invalid==='version')f.auth.version++;
      else if(invalid==='idle')f.auth.idle=dbNow;else {f.auth.idle=dbNow;f.auth.absolute=dbNow;}
      f.events.length=0;await assert.rejects(f.app.execute(cmd,f.credential),e=>e.code==='AUTHENTICATION_REQUIRED');
      assert.equal(f.events.includes('operation'),false);assert.deepEqual(await f.memory.read(),before);
    }
  });

  test(action + ': actor/action/payload/revision conflicts still precede current permission and attribute checks', async () => {
    const f=fixture({amount:60000,configured:true,attributes:[boss]}),cmd=expenseReviewCommand(action);await f.app.execute(cmd,f.credential);
    f.auth.permissions=[];f.auth.attributes=[];const before=await f.memory.read(),original=f.auth.id;f.auth.id='different-synthetic-reviewer';
    const actor=await f.app.execute(cmd,f.credential);assert.equal(actor.status,'idempotency-conflict');assert.equal(actor.reason,'actor-mismatch');f.auth.id=original;
    for(const changed of [{...cmd,expectedRevision:1},{...cmd,action:action==='approveExpense'?'rejectExpense':'approveExpense'},
      {...cmd,payload:{...cmd.payload,id:900}},{...cmd,payload:{...cmd.payload,selfReview:true}}]){
      const result=await f.app.execute(changed,f.credential);assert.equal(result.status,'idempotency-conflict');assert.equal(result.reason,'request-mismatch');
    }
    assert.equal(f.executions(),1);assert.deepEqual(await f.memory.read(),before);
  });

  test(action + ': original missing/already-decided and stale-revision results stay terminal after revoke', async () => {
    for(const c of [{payload:{id:999}},{prepare:s=>expenseReview(s).status='已审批'}, {prepare:s=>expenseReview(s).status='已记录'}]){
      const f=fixture({prepare:c.prepare}),cmd=expenseReviewCommand(action,'business',0,c.payload),result=await f.app.execute(cmd,f.credential),head=await f.memory.read();
      assert.equal(result.status,'business-rejected');assert.equal(head.revision,0);assert.deepEqual(head.state,f.state);assert.equal(head.audit.length,0);
      f.auth.permissions=[];assert.deepEqual(await f.app.execute(cmd,f.credential),result);assert.deepEqual(await f.memory.read(),head);
    }
    const f=fixture(),cmd=expenseReviewCommand(action,'stale',9),first=await f.app.execute(cmd,f.credential);assert.equal(first.status,'revision-conflict');
    await f.app.execute(expenseReviewCommand(action,'valid'),f.credential);f.auth.permissions=[];const head=await f.memory.read();
    assert.deepEqual(await f.app.execute(cmd,f.credential),first);assert.deepEqual(await f.memory.read(),head);
  });

  test(action + ': direct trusted entry enforces context/base/self/attributes and never reads demo facts', async () => {
    const f=fixture({amount:60000,configured:true,attributes:[boss]});await f.app.execute(expenseReviewCommand(action),f.credential);
    const state={expenses:structuredClone(f.state.expenses),procurements:structuredClone(f.state.procurements)};
    for(const field of ['user','permissions','clock','capabilities','administrator'])Object.defineProperty(state,field,{get(){assert.fail('Read demo '+field);}});
    decideExpense(state,action,{id:902},'fake','1900-01-01',()=>assert.fail('Demo reviewer invoked'),{mode:'trusted',context:f.context()});
    assert.equal(expenseReview(state).decidedByPrincipalId,f.auth.id);assert.equal(expenseReview(state).approvedAt,dbNow);
    for(const context of [undefined,{...f.context()}])assert.throws(()=>decideExpense(f.state,action,{id:902},undefined,undefined,undefined,{mode:'trusted',context}),/可信认证上下文/);
    const self=fixture({applicant:'synthetic-expense-reviewer'});await assert.rejects(self.app.execute(expenseReviewCommand(action),self.credential),denied);
    assert.throws(()=>transact(self.state,action,{id:902},'direct',{mode:'trusted',context:self.context()}),denied);
    const unbound=fixture({bind:false});await assert.rejects(unbound.app.execute(expenseReviewCommand(action),unbound.credential),/revalidation port/);await assertNoEffects(unbound);
  });

  test(action + ': demo behavior and linked procurement effects retain original business rules', async () => {
    const f=fixture({amount:60000,configured:true,attributes:[boss]});await f.app.execute(expenseReviewCommand(action),f.credential);
    const trusted=(await f.memory.read()).state,demo=transact({...f.state,user:'boss',clock:dbNow},action,{id:902},'demo');
    for(const field of ['status','amount','date','type','method','nature','description','proof','proofName','selfReviewAuthorized'])assert.deepEqual(expenseReview(trusted)[field],expenseReview(demo)[field]);
    assert.equal(trusted.procurements.at(-1).status,demo.procurements.at(-1).status);assert.equal(trusted.procurements.at(-1).amount,demo.procurements.at(-1).amount);
    assert.equal(expenseReview(demo).approver,'老板');assert.equal(Object.hasOwn(expenseReview(demo),'decidedByPrincipalId'),false);
  });
}

test('expense review: malformed saved amount cannot silently bypass boss authorization', async () => {
  for(const action of EXPENSE_REVIEW_ACTIONS)for(const amount of [undefined,null,0,-1,1.5,'50000',Number.MAX_SAFE_INTEGER+1]){
    const f=fixture({prepare:s=>expenseReview(s).amount=amount});await assert.rejects(f.app.execute(expenseReviewCommand(action),f.credential),
      e=>denied(e)&&e.reason==='untrusted-expense-amount');await assertNoEffects(f);
  }
});

test('expense review: unknown fault after decision/procurement mutations rolls back and repaired original key retries', async () => {
  for(const action of EXPENSE_REVIEW_ACTIONS){
    let broken=true;const f=fixture({execute:(...args)=>{const next=transact(...args);if(broken)throw Error('synthetic expense review fault');return next;}}),cmd=expenseReviewCommand(action);
    await assert.rejects(f.app.execute(cmd,f.credential),/synthetic expense review fault/);await assertNoEffects(f);
    broken=false;assert.equal((await f.app.execute(cmd,f.credential)).status,'committed');const head=await f.memory.read();
    assert.equal(head.revision,1);assert.equal(head.operationResults.size,1);assert.equal(head.audit.length,1);
  }
});

test('expense review: same-key and competing approve/reject requests decide exactly once', async () => {
  for(const sameKey of [false,true]){
    const f=fixture(),a=expenseReviewCommand('approveExpense','a'),b=expenseReviewCommand(sameKey?'approveExpense':'rejectExpense',sameKey?'a':'b');
    const results=await Promise.all([f.app.execute(a,f.credential),f.app.execute(b,f.credential)]);
    if(sameKey)assert.deepEqual(results[0],results[1]);else assert.deepEqual(results.map(r=>r.status).sort(),['committed','revision-conflict']);
    const head=await f.memory.read();assert.equal(head.revision,1);assert.equal(head.audit.length,1);assert.equal(f.executions(),1);
  }
});

test('expense review: boss attribute and review grants do not enable remaining business actions', async () => {
  const f=fixture({permissions:['expense.approve','review.self','procurement.create','credit.approve','credit.repay.approve',
    'rounding.approve','incident.create','incident.resolve.approve','payment.collect','payment.settle','handover','room.open'],configured:true,attributes:[boss]});
  for(const action of ['repay','approveRounding','rejectRounding',
    'open','settle','handover']){
    await assert.rejects(f.app.execute({...expenseReviewCommand(action),action},f.credential),e=>denied(e)&&e.reason===(action==='repay'?'missing-permission':'trusted-action-not-enabled'));await assertNoEffects(f);
  }
});
