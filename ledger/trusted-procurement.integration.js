import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact } from '../rules.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createPolicyAttributeService } from '../auth/policy-attributes.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMySqlLedgerStore } from './mysql-store.js';
import { procurementCommand, seedTrustedProcurement } from '../test-support/trusted-procurement-fixture.js';

const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
const sqlAt = (run, name, verb) => run.calls.findIndex(call => call.kind === 'sql' && call.sql.includes(name) &&
  (verb.startsWith('FOR ') ? call.sql.endsWith(verb) : call.sql.startsWith(verb + ' ')));

// The guarded parent owns migration/cleanup; this helper uses only its known test tables.
export async function testTrustedProcurement({ t, pool, setup, auth, table, provision, seed, inspect, application,
  assertUnchanged, wrapConnection, poolOptions, database }) {
  const runFor = (id, options = {}) => application(id, { employeeBind: null, ...options });
  const pending = (id, prepare = () => {}) => seed(id, state => { seedTrustedProcurement(state); prepare(state); });
  const authStore = createMySqlAuthStore({ pool, database });
  const unchangedFields = ['rooms', 'orders', 'inventory', 'consumables', 'ledger', 'catalog', 'user', 'clock',
    'permissions', 'capabilities', 'administrator', 'reservations', 'deposits', 'withdrawals', 'incidents', 'handovers'];
  const assertPair = (actual, principalId, dbNow) => {
    const purchase = actual.head.state.procurements.at(-1), expense = actual.head.state.expenses.at(-1);
    assert.equal(actual.head.state.procurements.length, 2); assert.equal(actual.head.state.expenses.length, 2);
    assert.equal(purchase.id, 1002); assert.equal(expense.id, 1001); assert.equal(purchase.expenseId, expense.id);
    assert.equal(actual.head.state.serial, 1002); assert.equal(actual.head.revision, 1);
    for (const record of [purchase, expense]) {
      assert.equal(record.submittedByPrincipalId, principalId); assert.equal(record.person, null); assert.equal(record.time, dbNow);
    }
    assert.equal(expense.submittedById, '');
    return { purchase, expense };
  };

  await t.test('procurement: one connection atomically commits both session-owned records, revision, operation and audit', async () => {
    const login = await provision(['procurement.create']), id = 'procurement-first';
    const original = await pending(id), connection = await pool.getConnection(); let borrows = 0;
    const [[activity]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [login.sessionId]);
    try {
      const run = runFor(id, { connectionPool: { getConnection: async () => { borrows++; return wrapConnection(connection, [], false); } } });
      const cmd = procurementCommand('first', 0, { actorId: 'administrator', principalId: 'fake', actualActorPrincipalId: 'fake',
        submittedByPrincipalId: 'fake', submittedById: 'administrator', person: 'Fake Buyer', submittedBy: 'Fake Buyer',
        user: 'administrator', permissions: ['*'], role: 'administrator', principal: { id: 'fake' }, clock: '1900-01-01',
        expenseId: 900, approver: 'fake', status: '已审批' });
      const result = await run.app.execute(cmd, login.credential), actual = await inspect(id);
      assert.equal(result.status, 'committed'); assert.equal(result.actorId, login.principalId);
      const { purchase, expense } = assertPair(actual, login.principalId, run.context().dbNow);
      assert.equal(purchase.status, '报销待老板审批'); assert.equal(expense.status, '待老板审批');
      assert.equal(expense.source, '采购'); assert.equal(expense.approver, ''); assert.equal(expense.approvedAt, '');
      for (const field of unchangedFields) assert.deepEqual(actual.head.state[field], original[field]);
      assert.deepEqual(actual.head.state.procurements[0], original.procurements[0]); assert.deepEqual(actual.head.state.expenses[0], original.expenses[0]);
      assert.equal(actual.head.state.orders[0].room, null); assert.equal(actual.head.state.inventory.qd.count, null); assert.equal(actual.head.state.inventory.bw.count, 0);
      assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
      assert.equal(actual.operations[0].actor_principal_id, login.principalId); assert.deepEqual(actual.operations[0].terminal_result, result);
      assert.equal(actual.audit[0].actor_principal_id, login.principalId); assert.equal(actual.audit[0].action, 'procurement');
      const order = [run.calls.findIndex(call => call.kind === 'begin'), sqlAt(run, 'ledger_heads', 'FOR UPDATE'),
        sqlAt(run, 'auth_accounts', 'FOR UPDATE'), sqlAt(run, 'auth_sessions', 'FOR UPDATE'), sqlAt(run, 'auth_grants', 'FOR UPDATE'),
        sqlAt(run, 'AS db_now', 'SELECT'), sqlAt(run, 'ledger_operations', 'SELECT'), run.calls.findIndex(call => call.kind === 'transact'),
        sqlAt(run, 'ledger_heads', 'UPDATE'), sqlAt(run, 'ledger_operations', 'INSERT'), sqlAt(run, 'ledger_success_audit', 'INSERT'),
        run.calls.findIndex(call => call.kind === 'commit')];
      assert.ok(order.every(index => index >= 0)); assert.deepEqual(order, [...order].sort((a, b) => a - b));
      assert.equal(borrows, 1); assert.equal(run.calls.filter(call => call.kind === 'begin').length, 1);
      assert.equal(run.calls.filter(call => call.kind === 'commit').length, 1); assert.equal(run.calls.filter(call => call.kind === 'db-now').length, 1);
      assert.equal(run.context().dbNow, run.calls.find(call => call.kind === 'db-now').value);
      assert.equal(run.context().policyAttributesConfigured, false); assert.equal(run.context().policyAttributeIds, null);
      assert.equal(sqlAt(run, 'employees', 'FOR SHARE'), -1);
      const [[afterActivity]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [login.sessionId]);
      assert.deepEqual(afterActivity, activity);
    } finally { try { await connection.rollback(); } finally { connection.release(); } }
  });

  await t.test('procurement: original thresholds, business date, methods and field snapshots match demo with no stock/payment effect', async () => {
    const login = await provision(['procurement.create']);
    const cases = [{ amount: 50000 }, { amount: 50001 }, { type: '支出' }, { type: '', amount: 1 },
      { method: '微信', nature: '固定支出' }, { method: '支付宝', nature: '资金周转' }, { method: '美团' }, { method: '抖音' }];
    for (const [i, change] of cases.entries()) {
      const id = 'procurement-fields-' + i, original = await pending(id), run = runFor(id);
      const cmd = procurementCommand('fields', 0, { ...change, date: ' 2026-01-02 ', item: ' ' + 'x'.repeat(90) + ' ',
        unit: ' ' + 'y'.repeat(30) + ' ', description: ' ' + 'z'.repeat(220) + ' ' });
      assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed'); const actual = await inspect(id);
      const { purchase, expense } = assertPair(actual, login.principalId, run.context().dbNow);
      const expected = transact({ ...original, user: 'administrator', clock: run.context().dbNow }, 'procurement', cmd.payload, cmd.operationKey);
      const needsApproval = purchase.type === '报销' && purchase.amount > 50000;
      assert.equal(purchase.status, needsApproval ? '报销待老板审批' : '已关联支出'); assert.equal(expense.status, needsApproval ? '待老板审批' : '已记录');
      assert.equal(purchase.date, '2026-01-02'); assert.equal(purchase.item.length, 80); assert.equal(purchase.unit.length, 20); assert.equal(purchase.description.length, 200);
      delete purchase.submittedByPrincipalId; delete expense.submittedByPrincipalId;
      purchase.person = expected.procurements.at(-1).person; expense.person = expected.expenses.at(-1).person;
      expense.submittedById = expected.expenses.at(-1).submittedById; actual.head.state.user = expected.user; actual.head.state.clock = expected.clock;
      assert.deepEqual(actual.head.state, expected);
    }
  });

  await t.test('procurement: blank description and absent arrays keep original fallback and create exactly one linked pair', async () => {
    const login = await provision(['procurement.create']), id = 'procurement-initialize';
    await pending(id, state => { delete state.expenses; delete state.procurements; }); const run = runFor(id);
    assert.equal((await run.app.execute(procurementCommand('fallback', 0, { description: ' ' }), login.credential)).status, 'committed');
    const actual = await inspect(id), purchase = actual.head.state.procurements[0], expense = actual.head.state.expenses[0];
    assert.equal(actual.head.state.procurements.length, 1); assert.equal(actual.head.state.expenses.length, 1); assert.equal(purchase.expenseId, expense.id);
    assert.equal(purchase.description, '采购Synthetic supplies'); assert.equal(expense.description, purchase.description);
    assert.equal(purchase.submittedByPrincipalId, login.principalId); assert.equal(expense.submittedByPrincipalId, login.principalId);
  });

  await t.test('procurement: expense/backend permissions and forged role cannot authorize; denied key is reusable after procurement grant', async () => {
    const login = await provision(['backend.view', 'expense.create', 'expense.approve', 'review.self']), id = 'procurement-permission';
    await pending(id); const before = await inspect(id), run = runFor(id);
    const cmd = procurementCommand('denied', 0, { permissions: ['procurement.create'], actorId: 'administrator', role: 'administrator', clock: '1900-01-01' });
    await assert.rejects(run.app.execute(cmd, login.credential), denied); await assertUnchanged(id, before); assert.equal(run.executions(), 0);
    assert.ok(run.calls.some(call => call.kind === 'rollback'));
    await auth.grantPermission({ principalId: login.principalId, permissionId: 'procurement.create' });
    assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed');
    assertPair(await inspect(id), login.principalId, run.context().dbNow);
  });

  await t.test('procurement: non-delegated credited employee never replaces actual session actor or consumes a denied key', async () => {
    const login = await provision(['procurement.create', 'staff.record']), id = 'procurement-attribution'; await pending(id);
    const before = await inspect(id), run = runFor(id);
    await assert.rejects(run.app.execute(procurementCommand('employee', 0, { creditedEmployeeId: 'fake-employee' }), login.credential),
      error => denied(error) && error.reason === 'invalid-attribution'); await assertUnchanged(id, before);
  });

  await t.test('procurement: invalid business inputs persist rejection with neither partial record nor serial change; terminal replays after revoke', async () => {
    const login = await provision(['procurement.create']);
    const changes = [{ date: '' }, { item: ' ' }, { quantity: 0 }, { quantity: 1.5 }, { unit: '' }, { amount: 0 },
      { amount: 1.5 }, { method: '银行卡' }, { type: '未知' }, { nature: '未知' }];
    for (const [i, change] of changes.entries()) {
      const id = 'procurement-business-' + i; const original = await pending(id), run = runFor(id), cmd = procurementCommand('business', 0, change);
      const result = await run.app.execute(cmd, login.credential), before = await inspect(id);
      assert.equal(result.status, 'business-rejected'); assert.deepEqual(before.head.state, original); assert.equal(before.head.revision, 0);
      assert.equal(before.operations.length, 1); assert.equal(before.audit.length, 0);
      await auth.revokePermission({ principalId: login.principalId, permissionId: 'procurement.create' });
      assert.deepEqual(await run.app.execute(cmd, login.credential), result); await assertUnchanged(id, before);
      await auth.grantPermission({ principalId: login.principalId, permissionId: 'procurement.create' });
    }
  });

  await t.test('procurement: revoke then new connection returns the original pair terminal; new key denied and actor/fingerprint conflicts unchanged', async () => {
    const login = await provision(['procurement.create']), other = await provision([]), id = 'procurement-reconnect';
    await pending(id); const run = runFor(id), cmd = procurementCommand('original'), first = await run.app.execute(cmd, login.credential);
    await auth.revokePermission({ principalId: login.principalId, permissionId: 'procurement.create' }); const before = await inspect(id);
    const reconnect = mysql.createPool(poolOptions);
    try {
      const reconnectAuth = createMySqlAuthStore({ pool: reconnect, database });
      const again = runFor(id, { connectionPool: reconnect, bind: reconnectAuth.bindSessionRevalidation,
        transactCommand: () => assert.fail('replay must not create either domain record') });
      assert.deepEqual(await again.app.execute(cmd, login.credential), first);
      await assert.rejects(again.app.execute(procurementCommand('new', 1), login.credential), denied);
      const actorConflict = await again.app.execute(cmd, other.credential);
      assert.equal(actorConflict.status, 'idempotency-conflict'); assert.equal(actorConflict.reason, 'actor-mismatch');
      for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, payload: { ...cmd.payload, amount: 60001 } },
        { ...cmd, payload: { ...cmd.payload, item: 'Changed' } }, { ...cmd, action: 'expense' }]) {
        const conflict = await again.app.execute(changed, login.credential);
        assert.equal(conflict.status, 'idempotency-conflict'); assert.equal(conflict.reason, 'request-mismatch');
      }
      assert.equal(again.executions(), 0); await assertUnchanged(id, before);
      assertPair(before, login.principalId, run.context().dbNow);
    } finally { await reconnect.end(); }
  });

  await t.test('procurement: disabled/revoked/idle/absolute/version invalidation denies prior terminal access before operation lookup', async () => {
    for (const state of ['disabled', 'revoked', 'idle', 'absolute', 'version']) {
      const login = await provision(['procurement.create']), id = 'procurement-auth-' + state; await pending(id);
      const run = runFor(id), cmd = procurementCommand('private'); await run.app.execute(cmd, login.credential); const before = await inspect(id);
      if (state === 'disabled') await auth.disableAccount({ principalId: login.principalId });
      else if (state === 'revoked') await auth.logout(login.token);
      else if (state === 'version') await auth.rotateCredential({ principalId: login.principalId, password: 'synthetic-rotated-only' });
      else if (state === 'idle') await pool.execute('UPDATE ' + table('auth_sessions') + ' SET idle_expires_at=created_at WHERE session_id=?', [login.sessionId]);
      else await pool.execute('UPDATE ' + table('auth_sessions') + ' SET idle_expires_at=created_at, absolute_expires_at=created_at+INTERVAL 1 MICROSECOND WHERE session_id=?', [login.sessionId]);
      run.calls.length = 0; await assert.rejects(run.app.execute(cmd, login.credential), error => error.code === 'AUTHENTICATION_REQUIRED');
      assert.equal(sqlAt(run, 'ledger_operations', 'SELECT'), -1); assert.equal(run.executions(), 1); await assertUnchanged(id, before);
    }
  });

  await t.test('procurement: stale terminal never executes later even when the revision becomes equal', async () => {
    const login = await provision(['procurement.create']), id = 'procurement-stale'; await pending(id); const run = runFor(id);
    const cmd = procurementCommand('stale', 1), terminal = await run.app.execute(cmd, login.credential);
    assert.equal(terminal.status, 'revision-conflict'); assert.equal((await run.app.execute(procurementCommand('advance'), login.credential)).status, 'committed');
    const before = await inspect(id); await auth.revokePermission({ principalId: login.principalId, permissionId: 'procurement.create' });
    assert.deepEqual(await run.app.execute(cmd, login.credential), terminal); await assertUnchanged(id, before);
    assert.equal(before.operations.length, 2); assert.equal(before.audit.length, 1); assertPair(before, login.principalId, run.context().dbNow);
  });

  await t.test('procurement: actual TypeError between linked expense append and purchase append rolls back both and leaves key free', async () => {
    const login = await provision(['procurement.create']), id = 'procurement-mid-domain'; await pending(id, state => { state.procurements = {}; });
    const before = await inspect(id), run = runFor(id);
    await assert.rejects(run.app.execute(procurementCommand('midway'), login.credential), TypeError);
    await assertUnchanged(id, before); assert.equal(before.operations.length, 0); assert.equal(before.audit.length, 0);
    assert.equal(sqlAt(run, 'ledger_heads', 'UPDATE'), -1); assert.ok(run.calls.some(call => call.kind === 'rollback'));
  });

  await t.test('procurement: unknown error after both records rolls back completely; repaired fault allows original key', async () => {
    const login = await provision(['procurement.create']), id = 'procurement-unknown'; await pending(id); const before = await inspect(id); let broken = true;
    const run = runFor(id, { transactCommand: (...args) => { const next = transact(...args); if (broken) throw Error('synthetic unknown procurement fault'); return next; } });
    const cmd = procurementCommand('repair'); await assert.rejects(run.app.execute(cmd, login.credential), /synthetic unknown procurement fault/);
    await assertUnchanged(id, before); assert.ok(run.calls.some(call => call.kind === 'rollback'));
    broken = false; assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed'); assertPair(await inspect(id), login.principalId, run.context().dbNow);
  });

  for (const name of ['ledger_operations', 'ledger_success_audit']) {
    await t.test('procurement: real ' + name + ' SQL failure rolls back pair, head, operation and audit; same key retries', async () => {
      const login = await provision(['procurement.create']), id = 'procurement-sql-' + (name === 'ledger_operations' ? 'operation' : 'audit');
      await pending(id); const before = await inspect(id), run = runFor(id), constraint = 'chk_procurement_slice_fault';
      await setup.query('ALTER TABLE ' + table(name) + ' ADD CONSTRAINT ' + constraint + " CHECK (ledger_id <> '" + id + "')");
      const cmd = procurementCommand('sql-retry');
      try {
        await assert.rejects(run.app.execute(cmd, login.credential), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
        assert.ok(sqlAt(run, 'ledger_heads', 'UPDATE') >= 0); assert.ok(sqlAt(run, 'ledger_operations', 'INSERT') >= 0);
        if (name === 'ledger_success_audit') assert.ok(sqlAt(run, 'ledger_success_audit', 'INSERT') >= 0);
        assert.ok(run.calls.some(call => call.kind === 'rollback')); await assertUnchanged(id, before);
      } finally { await setup.query('ALTER TABLE ' + table(name) + ' DROP CHECK ' + constraint); }
      assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed');
      assertPair(await inspect(id), login.principalId, run.context().dbNow);
    });
  }

  await t.test('procurement: missing revalidation and copied trusted context cannot fall back to demo', async () => {
    const login = await provision(['procurement.create']), id = 'procurement-closed'; await pending(id); const before = await inspect(id);
    const missing = createTrustedLedgerApplication({ store: createMySqlLedgerStore({ pool, ledgerId: id, database }) });
    await assert.rejects(missing.execute(procurementCommand('missing'), login.credential), /revalidation port/);
    const fake = runFor(id, { bind: connection => {
      const inner = authStore.bindSessionRevalidation(connection);
      return { revalidateSessionInTransaction: async credential => ({ ...await inner.revalidateSessionInTransaction(credential) }) };
    } });
    await assert.rejects(fake.app.execute(procurementCommand('fake'), login.credential), TypeError);
    assert.equal(fake.executions(), 0); await assertUnchanged(id, before);
  });

  const compete = async (id, sameKey = false) => {
    const firstActor = await provision(['procurement.create']), secondActor = sameKey ? firstActor : await provision(['procurement.create']);
    await pending(id); const a = await pool.getConnection(), b = await pool.getConnection();
    let unlock, signalLocked, firstWork, secondWork, timer;
    const held = new Promise(resolve => { unlock = resolve; }), locked = new Promise(resolve => { signalLocked = resolve; });
    try {
      const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id'), [[bId]] = await b.query('SELECT CONNECTION_ID() AS id');
      assert.notEqual(aId.id, bId.id); await a.query('SET SESSION innodb_lock_wait_timeout=5'); await b.query('SET SESSION innodb_lock_wait_timeout=5');
      const bind = connection => {
        const inner = authStore.bindSessionRevalidation(connection);
        return { async revalidateSessionInTransaction(credential) {
          const context = await inner.revalidateSessionInTransaction(credential); signalLocked(); await held; return context;
        } };
      };
      const first = runFor(id, { connectionPool: { getConnection: async () => wrapConnection(a, [], false) }, bind });
      const second = runFor(id, { connectionPool: { getConnection: async () => wrapConnection(b, [], false) } });
      firstWork = first.app.execute(procurementCommand('first'), firstActor.credential);
      await Promise.race([locked, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('procurement head lock timeout')), 5000); })]);
      clearTimeout(timer); let secondFinished = false;
      secondWork = second.app.execute(procurementCommand(sameKey ? 'first' : 'second'), secondActor.credential).finally(() => { secondFinished = true; });
      await new Promise(resolve => setTimeout(resolve, 35));
      assert.equal(secondFinished, false); assert.ok(sqlAt(second, 'ledger_heads', 'FOR UPDATE') >= 0);
      assert.equal(sqlAt(second, 'auth_accounts', 'FOR UPDATE'), -1); unlock(); const results = await Promise.all([firstWork, secondWork]);
      if (sameKey) assert.deepEqual(results[0], results[1]); else assert.deepEqual(results.map(result => result.status), ['committed', 'revision-conflict']);
      const actual = await inspect(id); assertPair(actual, firstActor.principalId, first.context().dbNow);
      assert.equal(actual.operations.length, sameKey ? 1 : 2); assert.equal(actual.audit.length, 1); assert.equal(first.executions() + second.executions(), 1);
      t.diagnostic('procurement race verified independent CONNECTION_ID ' + aId.id + ' / ' + bId.id + '; second waited on ledger head; one linked pair');
    } finally {
      clearTimeout(timer); unlock(); await Promise.allSettled([firstWork, secondWork].filter(Boolean));
      try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); }
    }
  };
  await t.test('procurement: two independent connections competing old revision create only one purchase/expense pair', { timeout: 10000 }, () => compete('procurement-race'));
  await t.test('procurement: two independent connections retrying the same key create only one purchase/expense pair', { timeout: 10000 }, () => compete('procurement-same-key', true));

  for (const action of ['approveExpense', 'rejectExpense']) {
    await t.test('procurement: existing ' + action + ' consumes the trusted applicant and preserves linked status synchronization', async () => {
      const applicant = await provision(['procurement.create']), reviewer = await provision(['expense.approve']);
      const attributes = createPolicyAttributeService({ store: authStore }), context = { actorPrincipalId: reviewer.principalId };
      await attributes.configurePolicyAttributes({ principalId: reviewer.principalId }, context);
      await attributes.grantPolicyAttribute({ principalId: reviewer.principalId, attributeId: 'expense.approval.boss' }, context);
      const id = 'procurement-existing-' + action, original = await pending(id), run = runFor(id);
      assert.equal((await run.app.execute(procurementCommand('create'), applicant.credential)).status, 'committed');
      const review = { operationKey: 'existing-review', expectedRevision: 1, action, payload: { id: 1001 } };
      assert.equal((await run.app.execute(review, reviewer.credential)).status, 'committed'); const actual = await inspect(id);
      const purchase = actual.head.state.procurements.at(-1), expense = actual.head.state.expenses.at(-1);
      assert.equal(expense.submittedByPrincipalId, applicant.principalId); assert.equal(purchase.submittedByPrincipalId, applicant.principalId);
      assert.equal(expense.decidedByPrincipalId, reviewer.principalId); assert.equal(expense.approver, null); assert.equal(expense.approvedAt, run.context().dbNow);
      assert.equal(expense.status, action === 'approveExpense' ? '已审批' : '已驳回');
      assert.equal(purchase.status, action === 'approveExpense' ? '已关联支出' : '报销已驳回');
      assert.equal(purchase.decisionAt, run.context().dbNow); assert.equal(purchase.decisionBy, null);
      assert.equal(actual.head.revision, 2); assert.equal(actual.operations.length, 2); assert.equal(actual.audit.length, 2);
      assert.deepEqual(actual.head.state.expenses[0], original.expenses[0]); assert.deepEqual(actual.head.state.procurements[0], original.procurements[0]);
      for (const field of unchangedFields) assert.deepEqual(actual.head.state[field], original[field]);
    });
  }

  await t.test('procurement: the seven remaining eligible actions still fail closed despite concrete permissions', async () => {
    const login = await provision(['procurement.create', 'room.open', 'rounding.approve', 'payment.collect', 'payment.settle', 'handover']);
    const id = 'procurement-not-enabled'; await pending(id); const before = await inspect(id), run = runFor(id);
    for (const action of ['open', 'collect', 'settle', 'pay', 'approveRounding', 'rejectRounding', 'handover'])
      await assert.rejects(run.app.execute({ ...procurementCommand(action), action }, login.credential), error => denied(error) && error.reason === 'trusted-action-not-enabled');
    await assertUnchanged(id, before); assert.equal(run.executions(), 0);
  });
}
