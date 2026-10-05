import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { submitExpense } from '../expenses.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { expenseCommand, seedTrustedExpense } from '../test-support/trusted-expense-fixture.js';

const dbNow = '2026-10-04T12:00:00.123456Z';
const denied = e => e instanceof AuthorizationDenied && e.status === 'authorization-denied';
function fixture({ permissions = ['expense.create'], prepare = () => {}, execute = transact, bind = true } = {}) {
  const state = initialState(); state.user = 'unmapped-demo-user'; state.clock = 'invalid-demo-clock';
  state.permissions = { administrator: ['管理员'] }; state.capabilities = { administrator: ['*'] }; state.administrator = true;
  state.orders = [{ id: 'historical-retail', kind: 'retail', room: null,
    sales: [{ productNameSnapshot: null, pricePerSaleUnitCents: null, baseQuantityPerSaleUnit: 12, totalBaseQuantity: 24 }],
    payments: [{ method: '现金', amount: 10 }, { method: '微信', amount: 20 }] }];
  seedTrustedExpense(state); prepare(state);
  const memory = createMemoryLedgerStore(state, { ledgerId: 'expense-unit' }), events = [], digest = Buffer.alloc(32, 19);
  const auth = { id: 'synthetic-expense-actor', permissions, enabled: true, revoked: false, version: 1, sessionVersion: 1,
    idle: '2099-01-01T00:00:00.000000Z', absolute: '2099-01-02T00:00:00.000000Z' };
  const port = {
    locateSessionByDigest: async () => ({ principalId: auth.id, sessionId: 'synthetic-expense-session' }),
    lockAccount: async () => { events.push('account'); return { principalId: auth.id, enabled: auth.enabled, credentialVersion: auth.version, policyAttributesConfigured: false }; },
    lockSessionById: async () => { events.push('session'); return { principalId: auth.id, sessionId: 'synthetic-expense-session', tokenDigest: digest,
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
    return work(tx); // Original expense creation has no employee attribution.
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

test('expense: session principal creates application with frozen DB time and unchanged explicit business date', async () => {
  const f = fixture(), result = await f.app.execute(expenseCommand(), f.credential), head = await f.memory.read();
  const record = head.state.expenses.at(-1);
  assert.equal(result.status, 'committed'); assert.equal(result.actorId, f.auth.id); assert.equal(head.revision, 1);
  assert.equal(record.submittedByPrincipalId, f.auth.id); assert.equal(record.submittedById, ''); assert.equal(record.person, null);
  assert.equal(record.time, dbNow); assert.equal(record.date, '2026-01-02'); assert.equal(record.amount, 60000); assert.equal(record.status, '待老板审批');
  assert.equal(record.description, 'Synthetic maintenance expense'); assert.equal(record.approver, ''); assert.equal(record.approvedAt, '');
  assert.deepEqual(head.state.expenses.slice(0, -1), f.state.expenses); assert.deepEqual(head.state.procurements, f.state.procurements);
  assert.deepEqual(head.state.orders, f.state.orders); assert.deepEqual(head.state.inventory, f.state.inventory);
  assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 1); assert.equal(head.audit[0].actorId, f.auth.id);
  assert.deepEqual(f.events, ['head','account','session','grants','db-now','operation','transact']);
});

test('expense: original types, payment methods, threshold, nature, proof and date fields match demo business results', async () => {
  const cases = [
    { type: '报销', amount: 50000, status: '已记录' }, { type: '报销', amount: 50001, status: '待老板审批' },
    { type: '支出', amount: 60000, status: '已记录' }, { type: '', amount: 1, status: '已记录' },
    { method: '微信', nature: '固定支出', status: '待老板审批' },
    { method: '支付宝', nature: '资金周转', status: '待老板审批' },
    { method: '美团', status: '待老板审批' }, { method: '抖音', status: '待老板审批' }
  ];
  for (const c of cases) {
    const f = fixture(), cmd = expenseCommand('original', 0, { ...c, date: ' 2026-01-02 ',
      description: '  ' + 'purpose'.repeat(40) + '  ', proof: ' data:image/png;base64,synthetic ', proofName: '  ' + 'proof'.repeat(40) + '  ' });
    await f.app.execute(cmd, f.credential); const head = await f.memory.read(), actual = head.state.expenses.at(-1);
    const legacy = transact({ ...f.state, user: 'administrator', clock: dbNow }, 'expense', cmd.payload, 'demo').expenses.at(-1);
    for (const key of ['id','date','type','amount','method','nature','description','proof','proofName','status','approver','approvedAt'])
      assert.deepEqual(actual[key], legacy[key], key);
    assert.equal(actual.status, c.status); assert.equal(actual.description.length, 200); assert.equal(actual.proofName.length, 120);
    assert.equal(actual.submittedByPrincipalId, f.auth.id); assert.equal(Object.hasOwn(actual, 'creditedEmployeeId'), false);
  }
});

test('expense: forged state and payload identity, permissions and clocks cannot override trusted facts', async () => {
  const f = fixture({ prepare: s => { s.user = 'administrator'; s.clock = '1900-01-01'; } });
  const cmd = expenseCommand('forged', 0, { actorId: 'fake', principalId: 'fake', actualActorPrincipalId: 'fake',
    user: 'administrator', permissions: ['*'], role: 'administrator', clock: '1900-01-01', person: 'Fake Applicant',
    submittedBy: 'Fake Applicant', submittedById: 'administrator', submittedByPrincipalId: 'fake', approver: 'Fake Approver' });
  const result = await f.app.execute(cmd, f.credential), head = await f.memory.read(), row = head.state.expenses.at(-1);
  assert.equal(result.actorId, f.auth.id); assert.equal(row.submittedByPrincipalId, f.auth.id); assert.equal(row.submittedById, '');
  assert.equal(row.person, null); assert.equal(row.approver, ''); assert.equal(row.time, dbNow);
  for (const field of ['user','permissions','clock','capabilities','administrator']) assert.deepEqual(head.state[field], f.state[field]);
});

test('expense: only expense.create authorizes; denied key stays unused and can succeed after current grant', async () => {
  for (const permissions of [[], ['backend.view'], ['expense.approve','review.self'], ['staff.record','procurement.create']]) {
    const f = fixture({ permissions }), cmd = expenseCommand('denied', 0, { permissions: ['expense.create'], role: 'administrator' });
    await assert.rejects(f.app.execute(cmd, f.credential), denied); await assertNoEffects(f); assert.equal(f.executions(), 0);
    f.auth.permissions.push('expense.create'); assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed');
    assert.equal((await f.memory.read()).state.expenses.length, f.state.expenses.length + 1);
  }
});

test('expense: employee attribution cannot replace actor or gain delegated authorization', async () => {
  const f = fixture({ permissions: ['expense.create','staff.record'] });
  await assert.rejects(f.app.execute(expenseCommand('employee', 0, { creditedEmployeeId: '10000000-0000-4000-8000-000000000001' }), f.credential),
    e => denied(e) && e.reason === 'invalid-attribution'); await assertNoEffects(f);
});

test('expense: direct domain path never reads demo identity, permissions or clock and enforces trusted permission', async () => {
  const f = fixture(); await f.app.execute(expenseCommand(), f.credential);
  const state = { serial: 0, expenses: [] };
  for (const field of ['user','permissions','clock','capabilities','administrator'])
    Object.defineProperty(state, field, { get() { assert.fail('trusted expense read demo ' + field); } });
  submitExpense(state, expenseCommand().payload, 'fake', '1900-01-01', { mode: 'trusted', context: f.context() });
  assert.equal(state.expenses[0].submittedByPrincipalId, f.auth.id); assert.equal(state.expenses[0].person, null); assert.equal(state.expenses[0].time, dbNow);
  const noGrant = fixture({ permissions: [] }); await assert.rejects(noGrant.app.execute(expenseCommand(), noGrant.credential), denied);
  assert.throws(() => submitExpense(state, expenseCommand().payload, undefined, undefined, { mode: 'trusted', context: noGrant.context() }), denied);
  assert.equal(state.expenses.length, 1);
});

test('expense: terminal replay after revoke never resubmits; new key uses current grants', async () => {
  const f = fixture(), cmd = expenseCommand(), first = await f.app.execute(cmd, f.credential);
  f.auth.permissions = []; const before = await f.memory.read();
  assert.deepEqual(await f.app.execute(cmd, f.credential), first); assert.equal(f.executions(), 1);
  await assert.rejects(f.app.execute(expenseCommand('new', 1), f.credential), denied);
  assert.deepEqual(await f.memory.read(), before);
});

test('expense: actor, action, payload and expectedRevision mismatch stay idempotency conflicts after revoke', async () => {
  const f = fixture(), cmd = expenseCommand(); await f.app.execute(cmd, f.credential);
  f.auth.permissions = []; const before = await f.memory.read(), actor = f.auth.id;
  f.auth.id = 'another-synthetic-principal'; const conflict = await f.app.execute(cmd, f.credential);
  assert.equal(conflict.status, 'idempotency-conflict'); assert.equal(conflict.reason, 'actor-mismatch'); f.auth.id = actor;
  for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, action: 'approveExpense' },
    { ...cmd, payload: { ...cmd.payload, amount: 50000 } }]) {
    const result = await f.app.execute(changed, f.credential);
    assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'request-mismatch');
  }
  assert.equal(f.executions(), 1); assert.deepEqual(await f.memory.read(), before);
});

test('expense: disabled, revoked, expired or credential-invalid sessions cannot access old terminal results', async () => {
  for (const invalid of ['disabled','revoked','idle','absolute','version']) {
    const f = fixture(), cmd = expenseCommand(); await f.app.execute(cmd, f.credential); const before = await f.memory.read();
    if (invalid === 'disabled') f.auth.enabled = false;
    else if (invalid === 'revoked') f.auth.revoked = true;
    else if (invalid === 'version') f.auth.version++;
    else if (invalid === 'idle') f.auth.idle = dbNow;
    else { f.auth.idle = dbNow; f.auth.absolute = dbNow; }
    f.events.length = 0;
    await assert.rejects(f.app.execute(cmd, f.credential), e => e.code === 'AUTHENTICATION_REQUIRED');
    assert.equal(f.events.includes('operation'), false); assert.equal(f.executions(), 1); assert.deepEqual(await f.memory.read(), before);
  }
});

test('expense: original validation rejects atomically and remains terminal after permission revoke', async () => {
  const invalid = [{ date: 'invalid' }, { date: '2026-13-01' },
    ...[0,-1,1.5,'1',Number.MAX_SAFE_INTEGER + 1].map(amount => ({ amount })),
    { method: 'invalid' }, { type: 'invalid' }, { nature: 'invalid' }, { description: '   ' },
    { proof: 'not-an-image' }, { proof: 'data:image/' + 'x'.repeat(800001) }];
  for (const changes of invalid) {
    const f = fixture(), cmd = expenseCommand('invalid', 0, changes), result = await f.app.execute(cmd, f.credential), before = await f.memory.read();
    assert.equal(result.status, 'business-rejected'); assert.deepEqual(before.state, f.state); assert.equal(before.revision, 0);
    assert.equal(before.operationResults.size, 1); assert.equal(before.audit.length, 0);
    f.auth.permissions = []; assert.deepEqual(await f.app.execute(cmd, f.credential), result); assert.equal(f.executions(), 1);
    assert.deepEqual(await f.memory.read(), before);
  }
});

test('expense: stale revision is terminal and never executes after ledger advances', async () => {
  const f = fixture(), cmd = expenseCommand('stale', 9), result = await f.app.execute(cmd, f.credential);
  assert.equal(result.status, 'revision-conflict'); assert.equal(f.executions(), 0);
  await f.app.execute(expenseCommand('valid'), f.credential); f.auth.permissions = []; const before = await f.memory.read();
  assert.deepEqual(await f.app.execute(cmd, f.credential), result); assert.equal(f.executions(), 1); assert.deepEqual(await f.memory.read(), before);
});

test('expense: unknown failure after domain mutation fully rolls back and original key can retry after repair', async () => {
  let broken = true; const f = fixture({ execute: (...args) => { const next = transact(...args); if (broken) throw Error('synthetic expense fault'); return next; } });
  const cmd = expenseCommand(); await assert.rejects(f.app.execute(cmd, f.credential), /synthetic expense fault/); await assertNoEffects(f);
  broken = false; assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed');
  const head = await f.memory.read(); assert.equal(head.revision, 1); assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 1);
  assert.equal(head.state.expenses.length, f.state.expenses.length + 1);
});

test('expense: two competing requests create once; identical retries have no additional effects', async () => {
  for (const sameKey of [false, true]) {
    const f = fixture(), results = await Promise.all([f.app.execute(expenseCommand('a'), f.credential), f.app.execute(expenseCommand(sameKey ? 'a' : 'b'), f.credential)]);
    if (sameKey) assert.deepEqual(results[0], results[1]);
    else assert.deepEqual(results.map(r => r.status).sort(), ['committed','revision-conflict']);
    const head = await f.memory.read(); assert.equal(head.revision, 1); assert.equal(f.executions(), 1); assert.equal(head.audit.length, 1);
    assert.equal(head.state.expenses.length, f.state.expenses.length + 1);
  }
});

test('expense: missing or forged context and session binding fail closed without demo fallback', async () => {
  const f = fixture({ bind: false }); await assert.rejects(f.app.execute(expenseCommand(), f.credential), /session revalidation port/); await assertNoEffects(f);
  for (const context of [undefined, { principalId: 'fake', permissionIds: ['expense.create'], dbNow }]) {
    assert.throws(() => transact(f.state, 'expense', expenseCommand().payload, 'context', { mode: 'trusted', context }), /可信认证上下文/);
    assert.throws(() => submitExpense(f.state, expenseCommand().payload, 'fake', dbNow, { mode: 'trusted', context }), /可信认证上下文/);
  }
  assert.throws(() => submitExpense(f.state, expenseCommand().payload, 'fake', dbNow, { mode: 'unknown' }), /执行模式/);
  assert.deepEqual(f.state.expenses.length, 1);
});

test('expense: remaining unconverted actions stay disabled despite specific grants', async () => {
  const f = fixture({ permissions: ['expense.create','expense.approve','procurement.create','incident.create','credit.apply',
    'credit.repay','rounding.approve','room.open','payment.collect','payment.settle','handover','review.self'] });
  for (const action of ['approveCredit', 'rejectCredit', 'approveRepay', 'rejectRepay', 'open', 'handover']) {
    await assert.rejects(f.app.execute({ ...expenseCommand(action), action }, f.credential), e => denied(e) && e.reason === 'trusted-action-not-enabled');
    await assertNoEffects(f);
  }
});

test('expense: legacy records without expense array retain existing initialization and demo identity behavior', async () => {
  const f = fixture({ prepare: s => { delete s.expenses; } }); await f.app.execute(expenseCommand(), f.credential);
  assert.equal((await f.memory.read()).state.expenses.length, 1);
  const demoState = initialState(), cmd = expenseCommand(); demoState.user = 'administrator';
  const next = transact(demoState, 'expense', cmd.payload, 'demo'); assert.equal(next.expenses[0].submittedById, demoState.user);
  assert.equal(next.expenses[0].person, '管理员'); assert.equal(next.expenses[0].time, demoState.clock);
  assert.equal(Object.hasOwn(next.expenses[0], 'submittedByPrincipalId'), false); assert.equal(demoState.expenses.length, 0);
});
