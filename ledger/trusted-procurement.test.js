import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { submitProcurement } from '../procurement.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { procurementCommand, seedTrustedProcurement, procurementPrincipalId as principalId,
  otherProcurementPrincipalId as otherPrincipalId, procurementDbNow as dbNow } from '../test-support/trusted-procurement-fixture.js';

const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
function fixture({ permissions = ['procurement.create'], prepare = () => {}, execute = transact, bind = true } = {}) {
  const state = initialState(); state.user = 'unmapped-demo-user'; state.clock = 'invalid-demo-clock';
  state.permissions = { administrator: ['管理员'] }; state.capabilities = { administrator: ['*'] }; state.administrator = true;
  state.orders = [{ id: 'historical-retail', kind: 'retail', room: null,
    sales: [{ productNameSnapshot: null, pricePerSaleUnitCents: null, baseQuantityPerSaleUnit: 12, totalBaseQuantity: 24 }],
    payments: [{ method: '现金', amount: 10 }, { method: '微信', amount: 20 }] }];
  seedTrustedProcurement(state); prepare(state);
  const memory = createMemoryLedgerStore(state, { ledgerId: 'procurement-unit' }), digest = Buffer.alloc(32, 21);
  const auth = { id: principalId, permissions, enabled: true, revoked: false, version: 1, sessionVersion: 1,
    idle: '2099-01-01T00:00:00.000000Z', absolute: '2099-01-02T00:00:00.000000Z' };
  const port = {
    locateSessionByDigest: async () => ({ principalId: auth.id, sessionId: 'synthetic-procurement-session' }),
    lockAccount: async () => ({ principalId: auth.id, enabled: auth.enabled, credentialVersion: auth.version, policyAttributesConfigured: false }),
    lockSessionById: async () => ({ principalId: auth.id, sessionId: 'synthetic-procurement-session', tokenDigest: digest,
      revoked: auth.revoked, credentialVersion: auth.sessionVersion, idleExpiresAt: auth.idle, absoluteExpiresAt: auth.absolute }),
    listGrants: async () => auth.permissions, listPolicyAttributes: async () => [], readDbNow: async () => dbNow
  };
  let context;
  const store = { ledgerId: memory.ledgerId, runAtomic: work => memory.runAtomic(tx => {
    if (bind) tx.sessionRevalidation = { revalidateSessionInTransaction: async credential => {
      context = await revalidateSessionInTransaction({ port, ...credential }); return context;
    } };
    return work(tx);
  }) };
  const app = createTrustedLedgerApplication({ store, transactCommand: execute });
  return { state, memory, app, auth, credential: { tokenDigest: digest }, context: () => context };
}
async function noEffects(f) {
  const head = await f.memory.read(); assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0);
  assert.equal(head.operationResults.size, 0); assert.equal(head.audit.length, 0);
}

test('procurement: one request creates linked procurement and expense with the same session applicant and frozen DB time', async () => {
  const f = fixture(), result = await f.app.execute(procurementCommand(), f.credential), head = await f.memory.read();
  const procurement = head.state.procurements.at(-1), expense = head.state.expenses.at(-1);
  assert.equal(result.status, 'committed'); assert.equal(result.actorId, principalId); assert.equal(head.revision, 1);
  assert.equal(procurement.submittedByPrincipalId, principalId); assert.equal(expense.submittedByPrincipalId, principalId);
  assert.equal(expense.submittedById, ''); assert.equal(procurement.person, null); assert.equal(expense.person, null);
  assert.equal(procurement.time, dbNow); assert.equal(expense.time, dbNow);
  assert.equal(procurement.expenseId, expense.id); assert.equal(procurement.id, 1002); assert.equal(expense.id, 1001);
  assert.equal(procurement.status, '报销待老板审批'); assert.equal(expense.status, '待老板审批');
  assert.equal(head.state.procurements.length, 2); assert.equal(head.state.expenses.length, 2);
  assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 1);
});

test('procurement: original purchase fields, expense threshold, methods and nature match demo without changing inventory or history', async () => {
  const cases = [
    { type: '报销', amount: 50000, expenseStatus: '已记录', purchaseStatus: '已关联支出' },
    { type: '报销', amount: 50001, expenseStatus: '待老板审批', purchaseStatus: '报销待老板审批' },
    { type: '支出', amount: 60000, expenseStatus: '已记录', purchaseStatus: '已关联支出' },
    { type: '', amount: 1, expenseStatus: '已记录', purchaseStatus: '已关联支出' },
    { method: '微信', nature: '固定支出', expenseStatus: '待老板审批', purchaseStatus: '报销待老板审批' },
    { method: '支付宝', nature: '资金周转', expenseStatus: '待老板审批', purchaseStatus: '报销待老板审批' },
    { method: '美团', expenseStatus: '待老板审批', purchaseStatus: '报销待老板审批' },
    { method: '抖音', expenseStatus: '待老板审批', purchaseStatus: '报销待老板审批' }
  ];
  for (const c of cases) {
    const f = fixture(), cmd = procurementCommand('original', 0, { ...c, date: ' 2026-01-02 ', item: ' ' + 'x'.repeat(90) + ' ',
      unit: ' ' + 'y'.repeat(30) + ' ', description: ' ' + 'z'.repeat(220) + ' ' });
    assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed'); const actual = (await f.memory.read()).state;
    const expected = transact({ ...f.state, user: 'administrator', clock: dbNow }, 'procurement', cmd.payload, cmd.operationKey);
    const purchase = actual.procurements.at(-1), expense = actual.expenses.at(-1);
    assert.equal(purchase.status, c.purchaseStatus); assert.equal(expense.status, c.expenseStatus);
    assert.equal(purchase.date, '2026-01-02'); assert.equal(expense.date, '2026-01-02');
    assert.equal(purchase.item.length, 80); assert.equal(purchase.unit.length, 20); assert.equal(purchase.description.length, 200);
    assert.equal(expense.source, '采购'); assert.equal(expense.proof, ''); assert.equal(expense.proofName, '');
    assert.equal(purchase.submittedByPrincipalId, principalId); assert.equal(expense.submittedByPrincipalId, principalId);
    actual.user = expected.user; actual.clock = expected.clock;
    delete purchase.submittedByPrincipalId; delete expense.submittedByPrincipalId;
    purchase.person = expected.procurements.at(-1).person; expense.person = expected.expenses.at(-1).person;
    expense.submittedById = expected.expenses.at(-1).submittedById;
    assert.deepEqual(actual, expected);
  }
});

test('procurement: blank description retains the original purchase-item fallback and missing lists initialize together', async () => {
  const f = fixture({ prepare: s => { delete s.expenses; delete s.procurements; } });
  await f.app.execute(procurementCommand('fallback', 0, { description: ' ' }), f.credential); const head = await f.memory.read();
  assert.equal(head.state.expenses.length, 1); assert.equal(head.state.procurements.length, 1);
  assert.equal(head.state.expenses[0].description, '采购Synthetic supplies'); assert.equal(head.state.procurements[0].description, '采购Synthetic supplies');
  assert.equal(head.state.procurements[0].expenseId, head.state.expenses[0].id);
});

test('procurement: only procurement.create authorizes; denial leaves the identical key reusable after grant', async () => {
  for (const permissions of [[], ['backend.view'], ['expense.create'], ['expense.approve', 'review.self'], ['staff.record']]) {
    const f = fixture({ permissions }), cmd = procurementCommand('denied', 0, { permissions: ['procurement.create'], actorId: 'administrator', role: 'administrator' });
    await assert.rejects(f.app.execute(cmd, f.credential), denied); await noEffects(f);
    f.auth.permissions = ['procurement.create']; assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed');
    const head = await f.memory.read(); assert.equal(head.state.procurements.length, 2); assert.equal(head.state.expenses.length, 2); assert.equal(head.revision, 1);
  }
});

test('procurement: poisoned demo identity and forged payload principal/role/time never override either applicant', async () => {
  const f = fixture({ prepare: s => { s.user = 'administrator'; s.clock = '1900-01-01'; } });
  const cmd = procurementCommand('spoof', 0, { actorId: 'administrator', principalId: otherPrincipalId, actualActorPrincipalId: otherPrincipalId,
    principal: { id: otherPrincipalId, permissions: ['*'] }, user: 'administrator', permissions: ['*'], role: 'administrator', clock: '1900-01-01',
    person: 'Fake Applicant', submittedBy: 'Fake Applicant', submittedById: 'administrator', submittedByPrincipalId: otherPrincipalId,
    approver: 'fake', expenseId: 900, status: '已审批' });
  assert.equal((await f.app.execute(cmd, f.credential)).actorId, principalId);
  const head = await f.memory.read(), purchase = head.state.procurements.at(-1), expense = head.state.expenses.at(-1);
  for (const record of [purchase, expense]) {
    assert.equal(record.submittedByPrincipalId, principalId); assert.equal(record.person, null); assert.equal(record.time, dbNow);
  }
  assert.equal(expense.submittedById, ''); assert.equal(expense.approver, ''); assert.equal(expense.approvedAt, '');
  assert.equal(purchase.expenseId, 1001); assert.equal(purchase.status, '报销待老板审批'); assert.equal(expense.status, '待老板审批');
  for (const key of ['user', 'permissions', 'clock', 'capabilities', 'administrator']) assert.deepEqual(head.state[key], f.state[key]);
});

test('procurement: original non-delegated attribution cannot turn a credited employee into actor authority', async () => {
  const f = fixture({ permissions: ['procurement.create', 'staff.record'] });
  await assert.rejects(f.app.execute(procurementCommand('employee', 0, { creditedEmployeeId: otherPrincipalId }), f.credential),
    e => denied(e) && e.reason === 'invalid-attribution'); await noEffects(f);
});

test('procurement: original invalid business inputs produce terminal rejection with neither record nor partial serial change', async () => {
  const invalid = [{ date: '' }, { date: '2026/01/02' }, { date: '2026-13-01' }, { item: ' ' }, { quantity: 0 }, { quantity: -1 },
    { quantity: 1.5 }, { quantity: Number.MAX_SAFE_INTEGER + 1 }, { unit: '' }, { amount: 0 }, { amount: -1 }, { amount: 1.5 },
    { amount: Number.MAX_SAFE_INTEGER + 1 }, { method: '银行卡' }, { type: '其他' }, { nature: '其他' }];
  for (const change of invalid) {
    const f = fixture(), cmd = procurementCommand('business', 0, change), first = await f.app.execute(cmd, f.credential);
    assert.equal(first.status, 'business-rejected'); const head = await f.memory.read();
    assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0); assert.equal(head.audit.length, 0); assert.equal(head.operationResults.size, 1);
    f.auth.permissions = []; assert.deepEqual(await f.app.execute(cmd, f.credential), first); assert.deepEqual(await f.memory.read(), head);
  }
});

test('procurement: revoke after success preserves original replay without duplicate purchase/expense; new key denied', async () => {
  const f = fixture(), cmd = procurementCommand(), first = await f.app.execute(cmd, f.credential), before = await f.memory.read();
  f.auth.permissions = []; assert.deepEqual(await f.app.execute(cmd, f.credential), first);
  await assert.rejects(f.app.execute({ ...cmd, operationKey: 'new', expectedRevision: 1 }, f.credential), denied);
  assert.deepEqual(await f.memory.read(), before); assert.equal(before.state.procurements.length, 2); assert.equal(before.state.expenses.length, 2);
  assert.equal(before.revision, 1); assert.equal(before.audit.length, 1); assert.equal(before.state.serial, 1002);
});

test('procurement: actor and fingerprint conflicts precede current grant checks and never change either record', async () => {
  const f = fixture(), cmd = procurementCommand(); await f.app.execute(cmd, f.credential); const before = await f.memory.read();
  f.auth.permissions = [];
  for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, payload: { ...cmd.payload, amount: 60001 } },
    { ...cmd, payload: { ...cmd.payload, item: 'Changed item' } }, { ...cmd, action: 'expense' }]) {
    const result = await f.app.execute(changed, f.credential); assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'request-mismatch');
  }
  f.auth.id = otherPrincipalId; const mismatch = await f.app.execute(cmd, f.credential);
  assert.equal(mismatch.status, 'idempotency-conflict'); assert.equal(mismatch.reason, 'actor-mismatch'); assert.deepEqual(await f.memory.read(), before);
});

test('procurement: disabled/revoked/expired/version-invalid sessions cannot read a prior terminal', async () => {
  for (const invalidate of [a => a.enabled = false, a => a.revoked = true, a => a.idle = dbNow, a => a.absolute = dbNow, a => a.sessionVersion = 0]) {
    const f = fixture(), cmd = procurementCommand(); await f.app.execute(cmd, f.credential); const before = await f.memory.read();
    invalidate(f.auth); await assert.rejects(f.app.execute(cmd, f.credential), e => e.code === 'AUTHENTICATION_REQUIRED');
    assert.deepEqual(await f.memory.read(), before);
  }
});

test('procurement: stale revision stays terminal even after another purchase advances the ledger', async () => {
  const f = fixture(), cmd = procurementCommand('stale', 1), first = await f.app.execute(cmd, f.credential);
  assert.equal(first.status, 'revision-conflict');
  assert.equal((await f.app.execute(procurementCommand('advance'), f.credential)).status, 'committed');
  const before = await f.memory.read(); f.auth.permissions = [];
  assert.deepEqual(await f.app.execute(cmd, f.credential), first); assert.deepEqual(await f.memory.read(), before);
  assert.equal(before.state.procurements.length, 2); assert.equal(before.state.expenses.length, 2); assert.equal(before.revision, 1);
});

test('procurement: an actual TypeError between expense creation and purchase append leaves neither partial record nor terminal', async () => {
  const f = fixture({ prepare: s => { s.procurements = {}; } });
  await assert.rejects(f.app.execute(procurementCommand('midway'), f.credential), TypeError); await noEffects(f);
});

test('procurement: unknown error after both domain records fully rolls back; repaired original key retries', async () => {
  let broken = true;
  const f = fixture({ execute: (...args) => { const next = transact(...args); if (broken) throw Error('synthetic unknown procurement fault'); return next; } });
  const cmd = procurementCommand('repair'); await assert.rejects(f.app.execute(cmd, f.credential), /synthetic unknown procurement fault/); await noEffects(f);
  broken = false; assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed'); const head = await f.memory.read();
  assert.equal(head.state.procurements.length, 2); assert.equal(head.state.expenses.length, 2); assert.equal(head.revision, 1); assert.equal(head.audit.length, 1);
});

test('procurement: direct trusted domain ignores demo getters and direct caller person/time', async () => {
  const f = fixture(); await f.app.execute(procurementCommand(), f.credential); const state = structuredClone(f.state);
  for (const key of ['user', 'permissions', 'clock', 'capabilities', 'administrator']) Object.defineProperty(state, key, { get() { assert.fail('trusted read ' + key); } });
  submitProcurement(state, procurementCommand().payload, 'Fake Actor', '1900-01-01', { mode: 'trusted', context: f.context() });
  for (const record of [state.procurements.at(-1), state.expenses.at(-1)]) {
    assert.equal(record.submittedByPrincipalId, principalId); assert.equal(record.person, null); assert.equal(record.time, dbNow);
  }
});

test('procurement: missing/copied context, invalid mode and missing revalidation fail closed without demo fallback', async () => {
  const f = fixture(); await f.app.execute(procurementCommand(), f.credential);
  for (const context of [undefined, { ...f.context() }]) {
    assert.throws(() => transact(f.state, 'procurement', procurementCommand().payload, 'missing', { mode: 'trusted', context }), TypeError);
    assert.throws(() => submitProcurement(structuredClone(f.state), procurementCommand().payload, 'fake', 'fake', { mode: 'trusted', context }), TypeError);
  }
  assert.throws(() => submitProcurement(structuredClone(f.state), procurementCommand().payload, 'fake', 'fake', { mode: 'invalid' }), TypeError);
  const unbound = fixture({ bind: false }); await assert.rejects(unbound.app.execute(procurementCommand(), unbound.credential), /revalidation port/); await noEffects(unbound);
  const noGrant = fixture({ permissions: [] }); await assert.rejects(noGrant.app.execute(procurementCommand(), noGrant.credential), denied);
  assert.throws(() => submitProcurement(structuredClone(noGrant.state), procurementCommand().payload, 'fake', 'fake', { mode: 'trusted', context: noGrant.context() }), denied);
});

test('procurement: create and room.open cannot replace staff.record for trusted open', async () => {
  const f = fixture({ permissions: ['procurement.create', 'room.open', 'rounding.approve', 'payment.collect', 'payment.settle', 'handover'] });
  for (const action of ['open']) {
    await assert.rejects(f.app.execute({ ...procurementCommand(action), action }, f.credential), e => denied(e) && e.reason === (action==='open'?'missing-permission':'trusted-action-not-enabled'));
  }
  await noEffects(f);
});
