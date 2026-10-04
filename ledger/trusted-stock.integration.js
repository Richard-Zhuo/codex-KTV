import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact } from '../rules.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { STOCK_ACTIONS, stockProduct, stockBalance, seedTrustedStock, stockCommand } from '../test-support/trusted-stock-fixture.js';

const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
const sqlAt = (run, name, verb) => run.calls.findIndex(call => call.kind === 'sql' && call.sql.includes(name) &&
  (verb.startsWith('FOR ') ? call.sql.endsWith(verb) : call.sql.startsWith(verb + ' ')));
const spoofed = { submittedBy: 'fake', submittedById: 'administrator', submittedByPrincipalId: 'fake', applicant: 'fake',
  actualActorPrincipalId: 'fake', actorId: 'administrator', principalId: 'fake', user: 'administrator',
  permissions: ['inventory.opening', 'inventory.adjust'], role: 'administrator', clock: '1900-01-01', submittedAt: 'fake', dbNow: 'fake' };

// Uses the existing strictly guarded ten-table fixture; owns no DDL/cleanup lifecycle.
export async function testTrustedStock({ t, pool, setup, auth, table, provision, seed, inspect, application,
  assertUnchanged, wrapConnection, poolOptions, database }) {
  const runFor = (id, options = {}) => application(id, { employeeBind: null, ...options });
  const seedFor = (id, action, count = null, prepare = () => {}) => seed(id, state => { seedTrustedStock(state, action, count); prepare(state); });

  for (const action of STOCK_ACTIONS) {
    await t.test(action + ': null/zero/positive round-trip preserves inventory and history; one connection commits trusted request/result/audit', async () => {
      for (const count of [null, 0, 9]) {
        const login = await provision([count === null ? 'inventory.opening' : 'inventory.adjust']), id = 'stock-first-' + action + '-' + count;
        const original = await seedFor(id, action, count), connection = await pool.getConnection(); let borrows = 0;
        const [[activity]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [login.sessionId]);
        try {
          const run = runFor(id, { connectionPool: { getConnection: async () => { borrows++; return wrapConnection(connection, [], false); } } });
          const cmd = stockCommand(action, 'first', 0, spoofed), result = await run.app.execute(cmd, login.credential), actual = await inspect(id);
          assert.equal(result.status, 'committed'); assert.equal(result.actorId, login.principalId); assert.equal(actual.head.revision, 1);
          const review = actual.head.state.inventoryReviews[0]; assert.equal(review.submittedByPrincipalId, login.principalId);
          assert.equal(review.submittedBy, null); assert.equal(review.submittedById, ''); assert.equal(review.submittedAt, run.context().dbNow);
          assert.equal(review.before, count); assert.equal(review.after, 17); assert.equal(review.status, '待审核');
          assert.equal(review.kind, action === 'stock' ? 'drink' : 'consumable'); assert.equal(review.product, stockProduct(action));
          assert.equal(review.source, (action === 'consumableStock' ? '消耗品' : '') + (count === null ? '期初建账' : '盘点调整'));
          if (action === 'consumableStock') { assert.equal(review.openedBefore, 3); assert.equal(review.openedAfter, 2); }
          for (const field of ['orders', 'inventory', 'consumables', 'ledger', 'notices', 'user', 'clock', 'permissions', 'capabilities', 'administrator'])
            assert.deepEqual(actual.head.state[field], original[field]);
          assert.equal(stockBalance(actual.head.state, action).count, count); assert.equal(actual.head.state.inventory.qd.count, null);
          assert.equal(actual.head.state.orders[0].room, null); assert.equal(actual.head.state.orders[0].sales[0].pricePerSaleUnitCents, null);
          assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
          assert.equal(actual.operations[0].actor_principal_id, login.principalId); assert.deepEqual(actual.operations[0].terminal_result, result);
          assert.equal(actual.audit[0].actor_principal_id, login.principalId); assert.equal(actual.audit[0].action, action);
          assert.equal(actual.audit[0].before_revision, '0'); assert.equal(actual.audit[0].after_revision, '1');
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
      }
    });

    await t.test(action + ': locked count selects opening versus adjustment; payload cannot choose grant and denied key is reusable', async () => {
      for (const count of [null, 0, 9]) {
        const required = count === null ? 'inventory.opening' : 'inventory.adjust', wrong = count === null ? 'inventory.adjust' : 'inventory.opening';
        const login = await provision([wrong]), id = 'stock-selection-' + action + '-' + count; await seedFor(id, action, count);
        const before = await inspect(id), run = runFor(id);
        const cmd = stockCommand(action, 'selection', 0, { ...spoofed, before: count === null ? 0 : null,
          inventory: { count: count === null ? 0 : null }, source: 'forged-source' });
        await assert.rejects(run.app.execute(cmd, login.credential), denied); assert.equal(run.executions(), 1);
        await assertUnchanged(id, before); assert.ok(run.calls.some(call => call.kind === 'rollback'));
        await auth.revokePermission({ principalId: login.principalId, permissionId: wrong });
        await auth.grantPermission({ principalId: login.principalId, permissionId: required });
        assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed');
        const actual = await inspect(id); assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
        assert.equal(actual.head.state.inventoryReviews[0].before, count); assert.equal(stockBalance(actual.head.state, action).count, count);
      }
    });

    await t.test(action + ': backend/approve/self grants and demo administrator do not authorize; later grant can reuse key', async () => {
      const login = await provision(['backend.view', 'inventory.approve', 'review.self']), id = 'stock-no-grant-' + action;
      await seedFor(id, action); const before = await inspect(id), run = runFor(id), cmd = stockCommand(action, 'denied', 0, spoofed);
      await assert.rejects(run.app.execute(cmd, login.credential), denied); await assertUnchanged(id, before); assert.equal(run.executions(), 0);
      await auth.grantPermission({ principalId: login.principalId, permissionId: 'inventory.opening' });
      assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed');
    });

    await t.test(action + ': reconnect after revoke returns original terminal without duplicate request; new key denied and conflicts unchanged', async () => {
      const login = await provision(['inventory.opening']), other = await provision([]), id = 'stock-replay-' + action;
      await seedFor(id, action); const run = runFor(id), cmd = stockCommand(action), first = await run.app.execute(cmd, login.credential);
      await auth.revokePermission({ principalId: login.principalId, permissionId: 'inventory.opening' });
      const before = await inspect(id), reconnect = mysql.createPool(poolOptions);
      try {
        const again = runFor(id, { connectionPool: reconnect, bind: createMySqlAuthStore({ pool: reconnect, database }).bindSessionRevalidation,
          transactCommand: () => assert.fail('replay must not add another inventory request or check current inventory permission') });
        assert.deepEqual(await again.app.execute(cmd, login.credential), first);
        const actor = await again.app.execute(cmd, other.credential); assert.equal(actor.status, 'idempotency-conflict'); assert.equal(actor.reason, 'actor-mismatch');
        for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, payload: { ...cmd.payload, count: 18 } },
          { ...cmd, action: action === 'stock' ? 'consumableStock' : 'stock' }]) {
          const conflict = await again.app.execute(changed, login.credential); assert.equal(conflict.status, 'idempotency-conflict'); assert.equal(conflict.reason, 'request-mismatch');
        }
        await assert.rejects(again.app.execute({ ...cmd, operationKey: 'new', expectedRevision: 1 }, login.credential), denied);
        assert.equal(again.executions(), 0); await assertUnchanged(id, before); assert.equal(before.head.state.inventoryReviews.length, 1);
      } finally { await reconnect.end(); }
    });

    await t.test(action + ': disabled/revoked/idle/absolute/credential invalidation refuses existing operation before lookup', async () => {
      for (const invalidation of ['disabled', 'revoked', 'idle', 'absolute', 'version']) {
        const login = await provision(['inventory.opening']), id = 'stock-auth-' + action + '-' + invalidation; await seedFor(id, action);
        const run = runFor(id), cmd = stockCommand(action); await run.app.execute(cmd, login.credential); const before = await inspect(id);
        if (invalidation === 'disabled') await auth.disableAccount({ principalId: login.principalId });
        else if (invalidation === 'revoked') await auth.logout(login.token);
        else if (invalidation === 'version') await auth.rotateCredential({ principalId: login.principalId, password: 'synthetic-stock-rotated' });
        else if (invalidation === 'idle') await pool.execute('UPDATE ' + table('auth_sessions') + ' SET idle_expires_at=created_at WHERE session_id=?', [login.sessionId]);
        else await pool.execute('UPDATE ' + table('auth_sessions') +
          ' SET idle_expires_at=created_at, absolute_expires_at=created_at+INTERVAL 1 MICROSECOND WHERE session_id=?', [login.sessionId]);
        run.calls.length = 0; await assert.rejects(run.app.execute(cmd, login.credential), error => error.code === 'AUTHENTICATION_REQUIRED');
        assert.equal(sqlAt(run, 'ledger_operations', 'SELECT'), -1); assert.equal(run.executions(), 1); await assertUnchanged(id, before);
      }
    });

    await t.test(action + ': stale revision and original business rejections persist terminal without half inventory/request changes', async () => {
      const login = await provision(['inventory.opening']); let index = 0;
      const cases = [[{ count: -1 }, 'business-rejected'], [{ count: 0.5 }, 'business-rejected'], [{ count: Number.MAX_SAFE_INTEGER + 1 }, 'business-rejected'],
        [{ reason: '  ' }, 'business-rejected'], [{ product: 'unknown' }, 'business-rejected'], [{}, 'revision-conflict'],
        ...(action === 'consumableStock' ? [[{ opened: -1 }, 'business-rejected'], [{ opened: 0.5 }, 'business-rejected']] : [])];
      for (const [payload, status] of cases) {
        const id = 'stock-terminal-' + action + '-' + (++index); await seedFor(id, action); const before = await inspect(id), run = runFor(id);
        const cmd = stockCommand(action, 'terminal', status === 'revision-conflict' ? 5 : 0, payload), result = await run.app.execute(cmd, login.credential);
        assert.equal(result.status, status); const actual = await inspect(id); assert.deepEqual(actual.head, before.head);
        assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 0);
        await auth.revokePermission({ principalId: login.principalId, permissionId: 'inventory.opening' });
        assert.deepEqual(await run.app.execute(cmd, login.credential), result); await assertUnchanged(id, actual);
        await auth.grantPermission({ principalId: login.principalId, permissionId: 'inventory.opening' });
      }
      const id = 'stock-pending-' + action; await seedFor(id, action); const run = runFor(id);
      await run.app.execute(stockCommand(action, 'first'), login.credential); const before = await inspect(id);
      const rejection = await run.app.execute(stockCommand(action, 'second', 1), login.credential);
      assert.equal(rejection.status, 'business-rejected'); assert.match(rejection.reason, /已有库存盘点待审核/);
      const actual = await inspect(id); assert.deepEqual(actual.head, before.head); assert.equal(actual.operations.length, 2); assert.equal(actual.audit.length, 1);
    });

    await t.test(action + ': unknown failure after request mutation rolls back all effects and original key retries after repair', async () => {
      const login = await provision(['inventory.opening']), id = 'stock-unknown-' + action; await seedFor(id, action);
      const before = await inspect(id); let broken = true;
      const run = runFor(id, { transactCommand: (...args) => { const state = transact(...args); if (broken) throw Error('synthetic unknown stock fault'); return state; } });
      const cmd = stockCommand(action); await assert.rejects(run.app.execute(cmd, login.credential), /synthetic unknown stock fault/);
      await assertUnchanged(id, before); assert.ok(run.calls.some(call => call.kind === 'rollback'));
      broken = false; assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed');
    });

    await t.test(action + ': audit SQL failure after state and terminal writes rolls back inventory/request/revision/result/audit', async () => {
      const login = await provision(['inventory.opening']), id = 'stock-sql-' + action; await seedFor(id, action);
      const before = await inspect(id), run = runFor(id); const cmd = stockCommand(action);
      await setup.query('ALTER TABLE ' + table('ledger_success_audit') +
        " ADD CONSTRAINT chk_stock_slice_fault CHECK (ledger_id <> '" + id + "')");
      try {
        await assert.rejects(run.app.execute(cmd, login.credential), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
        assert.ok(sqlAt(run, 'ledger_heads', 'UPDATE') >= 0); assert.ok(sqlAt(run, 'ledger_operations', 'INSERT') >= 0);
        assert.ok(run.calls.some(call => call.kind === 'rollback')); await assertUnchanged(id, before);
      } finally { await setup.query('ALTER TABLE ' + table('ledger_success_audit') + ' DROP CHECK chk_stock_slice_fault'); }
      assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed');
      const actual = await inspect(id); assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
      assert.equal(actual.head.state.inventoryReviews.length, 1); assert.equal(stockBalance(actual.head.state, action).count, null);
    });

    await t.test(action + ': two independent connections on the same old revision commit at most one request', async () => {
      const login = await provision(['inventory.opening']), id = 'stock-revision-race-' + action; await seedFor(id, action);
      const a = await pool.getConnection(), b = await pool.getConnection();
      try {
        const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id'), [[bId]] = await b.query('SELECT CONNECTION_ID() AS id'); assert.notEqual(aId.id, bId.id);
        await a.query('SET SESSION innodb_lock_wait_timeout=5'); await b.query('SET SESSION innodb_lock_wait_timeout=5');
        const first = runFor(id, { connectionPool: { getConnection: async () => wrapConnection(a, [], false) } });
        const second = runFor(id, { connectionPool: { getConnection: async () => wrapConnection(b, [], false) } });
        const results = await Promise.all([first.app.execute(stockCommand(action, 'a'), login.credential), second.app.execute(stockCommand(action, 'b', 0, { count: 18 }), login.credential)]);
        assert.deepEqual(results.map(result => result.status).sort(), ['committed', 'revision-conflict']); assert.equal(first.executions() + second.executions(), 1);
        const actual = await inspect(id); assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 2); assert.equal(actual.audit.length, 1);
        assert.equal(actual.head.state.inventoryReviews.length, 1); assert.equal(stockBalance(actual.head.state, action).count, null);
        const winner = results[0].status === 'committed' ? 17 : 18; assert.equal(actual.head.state.inventoryReviews[0].after, winner);
        t.diagnostic(action + ' revision race verified two independent CONNECTION_ID values');
      } finally { try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); } }
    });

    await t.test(action + ': same key on two independent connections creates one request/result/audit and increments once', async () => {
      const login = await provision(['inventory.adjust']), id = 'stock-key-race-' + action; await seedFor(id, action, 0);
      const a = await pool.getConnection(), b = await pool.getConnection();
      try {
        const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id'), [[bId]] = await b.query('SELECT CONNECTION_ID() AS id'); assert.notEqual(aId.id, bId.id);
        const first = runFor(id, { connectionPool: { getConnection: async () => wrapConnection(a, [], false) } });
        const second = runFor(id, { connectionPool: { getConnection: async () => wrapConnection(b, [], false) } });
        const cmd = stockCommand(action, 'same'), results = await Promise.all([first.app.execute(cmd, login.credential), second.app.execute(cmd, login.credential)]);
        assert.deepEqual(results[0], results[1]); assert.equal(results[0].status, 'committed'); assert.equal(first.executions() + second.executions(), 1);
        const actual = await inspect(id); assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
        assert.equal(actual.head.state.inventoryReviews.length, 1); assert.equal(stockBalance(actual.head.state, action).count, 0);
        t.diagnostic(action + ' same-key race verified two independent CONNECTION_ID values');
      } finally { try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); } }
    });
  }

  await t.test('stock submissions: inventory grants cannot authorize gift review; other approvals remain disabled', async () => {
    const login = await provision(['inventory.opening', 'inventory.adjust', 'inventory.approve', 'review.self']), id = 'stock-approval-blocked';
    await seedFor(id, 'stock'); const run = runFor(id); await run.app.execute(stockCommand('stock'), login.credential); const before = await inspect(id);
    for (const action of ['approveGift', 'rejectGift', 'approveExpense', 'rejectExpense', 'approveIncidentResolution', 'rejectIncidentResolution', 'approve', 'reject', 'approveRepayment', 'rejectRepayment', 'approveRounding', 'rejectRounding']) {
      await assert.rejects(run.app.execute({ operationKey: action, expectedRevision: 1, action,
        payload: { request: before.head.state.inventoryReviews[0].id, decisionNote: 'fake', submittedByPrincipalId: 'fake' } }, login.credential),
        error => denied(error) && error.reason === (['approveGift', 'rejectGift'].includes(action) ? 'missing-permission' : 'trusted-action-not-enabled'));
      await assertUnchanged(id, before);
    }
  });
}
