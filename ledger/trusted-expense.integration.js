import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact } from '../rules.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { expenseCommand, seedTrustedExpense } from '../test-support/trusted-expense-fixture.js';

const denied = e => e instanceof AuthorizationDenied && e.status === 'authorization-denied';
const sqlAt = (run, name, clause) => run.calls.findIndex(call => call.kind === 'sql' && call.sql.includes(name) &&
  (clause.startsWith('FOR ') ? call.sql.endsWith(clause) : call.sql.startsWith(clause + ' ')));

// Reuses the existing guarded jbhh_ktv_test fixture; owns no DDL or cleanup.
export async function testTrustedExpense({ t, pool, setup, auth, table, provision, seed, inspect,
  application, assertUnchanged, wrapConnection, poolOptions, database }) {
  const runFor = (id, options = {}) => application(id, { employeeBind: null, ...options });
  const seedFor = (id, prepare = () => {}) => seed(id, state => { seedTrustedExpense(state); prepare(state); });

  await t.test('expense: one connection commits session applicant, explicit date and frozen DB time with state/result/audit', async () => {
    const login = await provision(['expense.create']), id = 'expense-first', original = await seedFor(id);
    const [[activity]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [login.sessionId]);
    const connection = await pool.getConnection(); let borrows = 0;
    try {
      const run = runFor(id, { connectionPool: { getConnection: async () => { borrows++; return wrapConnection(connection, [], false); } } });
      const result = await run.app.execute(expenseCommand('first', 0, { actorId: 'fake', principalId: 'fake', actualActorPrincipalId: 'fake',
        user: 'administrator', role: 'administrator', permissions: ['*'], clock: '1900-01-01',
        person: 'Fake Applicant', submittedBy: 'Fake Applicant', submittedById: 'administrator', submittedByPrincipalId: 'fake', approver: 'Fake Approver' }), login.credential);
      const actual = await inspect(id), record = actual.head.state.expenses.at(-1);
      assert.equal(result.status, 'committed'); assert.equal(result.actorId, login.principalId); assert.equal(actual.head.revision, 1);
      assert.equal(record.submittedByPrincipalId, login.principalId); assert.equal(record.submittedById, ''); assert.equal(record.person, null);
      assert.equal(record.time, run.context().dbNow); assert.equal(record.date, '2026-01-02'); assert.equal(record.amount, 60000); assert.equal(record.status, '待老板审批');
      assert.equal(record.description, 'Synthetic maintenance expense'); assert.equal(record.approver, ''); assert.equal(record.approvedAt, '');
      assert.deepEqual(actual.head.state.expenses.slice(0,-1), original.expenses);
      for (const field of ['orders','rooms','inventory','consumables','ledger','procurements','user','clock','permissions','capabilities','administrator'])
        assert.deepEqual(actual.head.state[field], original[field], field);
      assert.equal(actual.head.state.orders[0].room, null); assert.equal(actual.head.state.inventory.qd.count, null); assert.equal(actual.head.state.inventory.bw.count, 0);
      assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1); assert.equal(actual.operations[0].actor_principal_id, login.principalId);
      assert.deepEqual(actual.operations[0].terminal_result, result); assert.equal(actual.audit[0].actor_principal_id, login.principalId); assert.equal(actual.audit[0].action, 'expense');
      const locks = [run.calls.findIndex(c => c.kind === 'begin'), sqlAt(run,'ledger_heads','FOR UPDATE'), sqlAt(run,'auth_accounts','FOR UPDATE'),
        sqlAt(run,'auth_sessions','FOR UPDATE'), sqlAt(run,'auth_grants','FOR UPDATE'), sqlAt(run,'AS db_now','SELECT'), sqlAt(run,'ledger_operations','SELECT'),
        run.calls.findIndex(c => c.kind === 'transact'), sqlAt(run,'ledger_heads','UPDATE'), sqlAt(run,'ledger_operations','INSERT'),
        sqlAt(run,'ledger_success_audit','INSERT'), run.calls.findIndex(c => c.kind === 'commit')];
      assert.ok(locks.every(index => index >= 0)); assert.deepEqual(locks, [...locks].sort((a,b) => a-b)); assert.equal(borrows, 1);
      assert.equal(run.calls.filter(c => c.kind === 'begin').length, 1); assert.equal(run.calls.filter(c => c.kind === 'commit').length, 1);
      assert.equal(run.calls.filter(c => c.kind === 'db-now').length, 1); assert.equal(run.context().dbNow, run.calls.find(c => c.kind === 'db-now').value);
      assert.deepEqual(run.context().permissionIds, ['expense.create']); assert.equal(run.context().policyAttributesConfigured, false);
      assert.equal(sqlAt(run,'employees','FOR SHARE'), -1); assert.equal(Object.hasOwn(record,'creditedEmployeeId'), false);
      const [[afterActivity]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [login.sessionId]);
      assert.deepEqual(afterActivity, activity);
    } finally { try { await connection.rollback(); } finally { connection.release(); } }
  });

  await t.test('expense: MySQL preserves original type/amount threshold, methods, nature, proof and date semantics', async () => {
    const login = await provision(['expense.create']); let index = 0;
    for (const c of [{ type: '报销', amount: 50000, status: '已记录' }, { type: '报销', amount: 50001, status: '待老板审批' },
      { type: '支出', amount: 60000, status: '已记录' }, { type: '', amount: 1, status: '已记录' },
      { method: '微信', nature: '固定支出', status: '待老板审批' }, { method: '支付宝', nature: '资金周转', status: '待老板审批' },
      { method: '美团', status: '待老板审批' }, { method: '抖音', status: '待老板审批' }]) {
      const id = 'expense-fields-' + (++index), original = await seedFor(id), run = runFor(id);
      const cmd = expenseCommand('fields', 0, { ...c, date: ' 2026-01-02 ', description: ' ' + 'purpose'.repeat(40) + ' ',
        proof: ' data:image/png;base64,synthetic ', proofName: ' ' + 'proof'.repeat(40) + ' ' });
      await run.app.execute(cmd, login.credential); const actual = await inspect(id), record = actual.head.state.expenses.at(-1);
      const demo = transact({ ...original, user: 'administrator', clock: run.context().dbNow }, 'expense', cmd.payload, 'demo').expenses.at(-1);
      for (const field of ['id','date','type','amount','method','nature','description','proof','proofName','status','approver','approvedAt'])
        assert.deepEqual(record[field], demo[field], field);
      assert.equal(record.status, c.status); assert.equal(record.description.length, 200); assert.equal(record.proofName.length, 120);
      assert.equal(record.submittedByPrincipalId, login.principalId); assert.deepEqual(actual.head.state.procurements, original.procurements);
    }
  });

  await t.test('expense: authorization denial persists nothing and same key succeeds after grant despite forged demo administrator', async () => {
    const login = await provision(['backend.view','expense.approve','review.self','procurement.create','staff.record']), id = 'expense-denied';
    await seedFor(id, state => { state.user = 'administrator'; state.clock = '1900-01-01'; });
    const run = runFor(id), before = await inspect(id), cmd = expenseCommand('denied', 0, { permissions: ['expense.create'], role: 'administrator', actorId: 'administrator' });
    await assert.rejects(run.app.execute(cmd, login.credential), denied); await assertUnchanged(id, before); assert.equal(run.executions(), 0);
    await auth.grantPermission({ principalId: login.principalId, permissionId: 'expense.create' });
    const result = await run.app.execute(cmd, login.credential), actual = await inspect(id);
    assert.equal(result.status, 'committed'); assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
    assert.equal(actual.head.state.expenses.at(-1).submittedByPrincipalId, login.principalId);
  });

  await t.test('expense: employee attribution remains non-delegated and cannot become applicant identity', async () => {
    const login = await provision(['expense.create','staff.record']), id = 'expense-attribution'; await seedFor(id); const before = await inspect(id);
    await assert.rejects(runFor(id).app.execute(expenseCommand('employee', 0, { creditedEmployeeId: '10000000-0000-4000-8000-000000000001' }), login.credential),
      e => denied(e) && e.reason === 'invalid-attribution'); await assertUnchanged(id, before);
  });

  await t.test('expense: permission revoke then reconnect returns original terminal without re-creating expense; new key denied', async () => {
    const login = await provision(['expense.create']), id = 'expense-replay'; await seedFor(id);
    const cmd = expenseCommand(), first = await runFor(id).app.execute(cmd, login.credential);
    await auth.revokePermission({ principalId: login.principalId, permissionId: 'expense.create' }); const before = await inspect(id), reconnect = mysql.createPool(poolOptions);
    try {
      const again = runFor(id, { connectionPool: reconnect, bind: createMySqlAuthStore({ pool: reconnect, database }).bindSessionRevalidation,
        transactCommand: () => assert.fail('terminal replay must not execute expense') });
      assert.deepEqual(await again.app.execute(cmd, login.credential), first); assert.equal(again.executions(), 0);
      await assert.rejects(again.app.execute(expenseCommand('new', 1), login.credential), denied); await assertUnchanged(id, before);
    } finally { await reconnect.end(); }
  });

  await t.test('expense: invalid auth state blocks existing terminal before lookup', async () => {
    for (const invalid of ['disabled','revoked','idle','absolute','version']) {
      const login = await provision(['expense.create']), id = 'expense-auth-' + invalid; await seedFor(id);
      const run = runFor(id), cmd = expenseCommand(); await run.app.execute(cmd, login.credential); const before = await inspect(id);
      if (invalid === 'disabled') await auth.disableAccount({ principalId: login.principalId });
      else if (invalid === 'revoked') await auth.logout(login.token);
      else if (invalid === 'version') await auth.rotateCredential({ principalId: login.principalId, password: 'synthetic-expense-rotation' });
      else if (invalid === 'idle') await pool.execute('UPDATE ' + table('auth_sessions') + ' SET idle_expires_at=created_at WHERE session_id=?', [login.sessionId]);
      else await pool.execute('UPDATE ' + table('auth_sessions') + ' SET idle_expires_at=created_at,absolute_expires_at=created_at+INTERVAL 1 MICROSECOND WHERE session_id=?', [login.sessionId]);
      run.calls.length = 0; await assert.rejects(run.app.execute(cmd, login.credential), e => e.code === 'AUTHENTICATION_REQUIRED');
      assert.equal(sqlAt(run,'ledger_operations','SELECT'), -1); assert.equal(run.executions(), 1); await assertUnchanged(id, before);
    }
  });

  await t.test('expense: actor, action, payload and revision conflicts precede current grant after revoke', async () => {
    const login = await provision(['expense.create']), other = await provision([]), id = 'expense-conflicts'; await seedFor(id);
    const run = runFor(id), cmd = expenseCommand(); await run.app.execute(cmd, login.credential); const before = await inspect(id);
    await auth.revokePermission({ principalId: login.principalId, permissionId: 'expense.create' });
    const actor = await run.app.execute(cmd, other.credential); assert.equal(actor.status, 'idempotency-conflict'); assert.equal(actor.reason, 'actor-mismatch');
    for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, action: 'approveExpense' }, { ...cmd, payload: { ...cmd.payload, amount: 50000 } }]) {
      const result = await run.app.execute(changed, login.credential); assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'request-mismatch');
    }
    assert.equal(run.executions(), 1); await assertUnchanged(id, before);
  });

  await t.test('expense: original business validation failures persist terminal without partial state or success audit', async () => {
    const login = await provision(['expense.create']); let index = 0;
    for (const changes of [{ date: 'invalid' }, { amount: 0 }, { amount: 1.5 }, { method: 'invalid' },
      { type: 'invalid' }, { nature: 'invalid' }, { description: '' }, { proof: 'not-an-image' }]) {
      const id = 'expense-invalid-' + (++index), original = await seedFor(id), run = runFor(id), cmd = expenseCommand('invalid', 0, changes);
      const result = await run.app.execute(cmd, login.credential), after = await inspect(id);
      assert.equal(result.status, 'business-rejected'); assert.deepEqual(after.head.state, original); assert.equal(after.head.revision, 0);
      assert.equal(after.operations.length, 1); assert.equal(after.audit.length, 0);
      await auth.revokePermission({ principalId: login.principalId, permissionId: 'expense.create' });
      assert.deepEqual(await run.app.execute(cmd, login.credential), result); assert.equal(run.executions(), 1); await assertUnchanged(id, after);
      await auth.grantPermission({ principalId: login.principalId, permissionId: 'expense.create' });
    }
  });

  await t.test('expense: stale revision remains original terminal after state advances and permission revocation', async () => {
    const login = await provision(['expense.create']), id = 'expense-stale'; await seedFor(id); const run = runFor(id), cmd = expenseCommand('stale', 9);
    const first = await run.app.execute(cmd, login.credential); assert.equal(first.status, 'revision-conflict'); assert.equal(run.executions(), 0);
    await run.app.execute(expenseCommand('valid'), login.credential); const before = await inspect(id);
    await auth.revokePermission({ principalId: login.principalId, permissionId: 'expense.create' });
    assert.deepEqual(await run.app.execute(cmd, login.credential), first); assert.equal(run.executions(), 1); await assertUnchanged(id, before);
  });

  await t.test('expense: creation never opens procurement or remaining unconverted actions', async () => {
    const login = await provision(['expense.create','expense.approve','review.self','procurement.create','incident.create','credit.apply','credit.repay','room.open','payment.collect','payment.settle','handover']);
    const id = 'expense-blocked'; await seedFor(id); const run = runFor(id); await run.app.execute(expenseCommand(), login.credential); const before = await inspect(id);
    for (const action of ['procurement','resolveIncident','approveRounding','rejectRounding','open','collect','settle','pay','handover']) {
      await assert.rejects(run.app.execute({ ...expenseCommand(action, 1), action }, login.credential),
        e => denied(e) && e.reason === 'trusted-action-not-enabled'); await assertUnchanged(id, before);
    }
  });

  for (const fault of ['unknown','sql']) await t.test('expense: ' + fault + ' mid-transaction failure rolls back state/revision/result/audit and permits original-key retry', async () => {
    const login = await provision(['expense.create']), id = 'expense-rollback-' + fault; await seedFor(id); const before = await inspect(id); let broken = true;
    const run = runFor(id, { transactCommand: (...args) => { const next = transact(...args); if (fault === 'unknown' && broken) throw Error('synthetic expense fault'); return next; } });
    const cmd = expenseCommand();
    if (fault === 'sql') await setup.query('ALTER TABLE ' + table('ledger_success_audit') + " ADD CONSTRAINT chk_expense_fault CHECK (ledger_id <> '" + id + "')");
    try {
      await assert.rejects(run.app.execute(cmd, login.credential), e => fault === 'unknown' ? e.message === 'synthetic expense fault' : e.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
      assert.ok(run.calls.some(c => c.kind === 'rollback'));
      if (fault === 'sql') { assert.ok(sqlAt(run,'ledger_heads','UPDATE') >= 0); assert.ok(sqlAt(run,'ledger_operations','INSERT') >= 0); }
      await assertUnchanged(id, before);
    } finally { if (fault === 'sql') await setup.query('ALTER TABLE ' + table('ledger_success_audit') + ' DROP CHECK chk_expense_fault'); }
    broken = false; assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed'); const actual = await inspect(id);
    assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
    assert.equal(actual.head.state.expenses.length, before.head.state.expenses.length + 1);
  });

  for (const sameKey of [false,true]) await t.test('expense: two independent connections ' + (sameKey ? 'replay same key exactly once' : 'compete old revision with one success'), async () => {
    const login = await provision(['expense.create']), id = 'expense-race-' + sameKey; await seedFor(id);
    const a = await pool.getConnection(), b = await pool.getConnection();
    try {
      const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id'), [[bId]] = await b.query('SELECT CONNECTION_ID() AS id'); assert.notEqual(aId.id,bId.id);
      await a.query('SET SESSION innodb_lock_wait_timeout=5'); await b.query('SET SESSION innodb_lock_wait_timeout=5');
      const first = runFor(id, { connectionPool: { getConnection: async () => wrapConnection(a, [], false) } });
      const second = runFor(id, { connectionPool: { getConnection: async () => wrapConnection(b, [], false) } });
      const results = await Promise.all([first.app.execute(expenseCommand('first'), login.credential), second.app.execute(expenseCommand(sameKey ? 'first' : 'second'), login.credential)]);
      if (sameKey) assert.deepEqual(results[0], results[1]); else assert.deepEqual(results.map(r => r.status).sort(), ['committed','revision-conflict']);
      assert.equal(first.executions() + second.executions(), 1); const actual = await inspect(id);
      assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, sameKey ? 1 : 2); assert.equal(actual.audit.length, 1); assert.equal(actual.head.state.expenses.length, 2);
      t.diagnostic('expense ' + (sameKey ? 'same-key' : 'revision') + ' race verified two independent CONNECTION_ID values');
    } finally { try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); } }
  });
}
