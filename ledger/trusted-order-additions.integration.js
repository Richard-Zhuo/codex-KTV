import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact, OTHER_CHARGE_CATEGORIES } from '../rules.js';
import { total } from '../sales.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { ORDER_ADDITION_TEST_ACTIONS, orderAdditionPermission, seedOrderAdditions,
  orderAdditionCommand, additionOrder } from '../test-support/trusted-order-additions-fixture.js';

const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
const sqlAt = (run, name, clause) => run.calls.findIndex(call => call.kind === 'sql' && call.sql.includes(name) &&
  (clause.startsWith('FOR ') ? call.sql.endsWith(clause) : call.sql.startsWith(clause + ' ')));

// Shares the existing strictly guarded fixture; no additional tables or cleanup scope.
export async function testTrustedOrderAdditions({ t, pool, setup, auth, table, provision, seed, inspect,
  application, assertUnchanged, wrapConnection, poolOptions, database }) {
  for (const action of ORDER_ADDITION_TEST_ACTIONS) {
    const permissionId = orderAdditionPermission(action);
    const request = (key = 'first', revision = 0, changes = {}) => orderAdditionCommand(action, key, revision, changes);
    const runFor = (id, options = {}) => application(id, { employeeBind: null, ...options });

    await t.test(action + ': one connection commits only original order effects with session actor and frozen DB time', async () => {
      const login = await provision([permissionId]), id = 'additions-first-' + action;
      const original = await seed(id, seedOrderAdditions);
      const [[activity]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') +
        ' WHERE session_id = ?', [login.sessionId]);
      const connection = await pool.getConnection();
      let borrows = 0;
      try {
        const run = runFor(id, { connectionPool: { getConnection: async () => { borrows++; return wrapConnection(connection, [], false); } } });
        const cmd = request('first', 0, { actorId: 'administrator', principalId: 'forged', user: 'administrator', role: 'administrator',
          permissions: ['*'], clock: '1900-01-01', person: 'forged', actualActorPrincipalId: 'forged', servedBy: 'forged',
          servedByPrincipalId: 'forged', employee: '10000000-0000-4000-8000-000000000001' });
        const result = await run.app.execute(cmd, login.credential), actual = await inspect(id);
        assert.equal(result.status, 'committed'); assert.equal(result.actorId, login.principalId);
        assert.equal(actual.head.revision, 1); assert.equal(run.executions(), 1);
        const expected = structuredClone(original), order = additionOrder(actual.head.state), dbNow = run.context().dbNow;
        if (action === 'serveExtra') {
          assert.equal(order.extras[0].servedBy, login.principalId);
          assert.equal(order.extras[0].servedByPrincipalId, login.principalId);
          assert.equal(order.extras[0].servedAt, dbNow); assert.equal(order.extras[0].served, true);
          Object.assign(additionOrder(expected).extras[0], { served: true, servedBy: login.principalId,
            servedByPrincipalId: login.principalId, servedAt: dbNow });
          assert.equal(total(order), 36300);
        } else {
          const line = order.otherCharges.at(-1);
          assert.equal(line.actualActorPrincipalId, login.principalId); assert.equal(line.person, login.principalId);
          assert.equal(line.time, dbNow); assert.equal(line.amount, 8800); assert.equal(line.category, '其他');
          assert.equal(line.item, 'Synthetic Room Service'); assert.equal(Object.hasOwn(line, 'creditedEmployeeId'), false);
          expected.serial += 2; additionOrder(expected).otherCharges.push(line); assert.equal(total(order), 45100);
        }
        expected.processed.push('first'); assert.deepEqual(actual.head.state, expected);
        assert.equal(actual.head.state.inventory.bw.count, 0); assert.equal(actual.head.state.inventory.qd.count, null);
        assert.equal(actual.head.state.orders[0].room, null); assert.deepEqual(order.payments, additionOrder(original).payments);
        assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
        assert.equal(actual.operations[0].actor_principal_id, login.principalId);
        assert.deepEqual(actual.operations[0].terminal_result, result);
        assert.equal(actual.audit[0].actor_principal_id, login.principalId); assert.equal(actual.audit[0].action, action);
        const sequence = [run.calls.findIndex(call => call.kind === 'begin'), sqlAt(run, 'ledger_heads', 'FOR UPDATE'),
          sqlAt(run, 'auth_accounts', 'FOR UPDATE'), sqlAt(run, 'auth_sessions', 'FOR UPDATE'), sqlAt(run, 'auth_grants', 'FOR UPDATE'),
          sqlAt(run, 'AS db_now', 'SELECT'), sqlAt(run, 'ledger_operations', 'SELECT'), run.calls.findIndex(call => call.kind === 'transact'),
          sqlAt(run, 'ledger_heads', 'UPDATE'), sqlAt(run, 'ledger_operations', 'INSERT'), sqlAt(run, 'ledger_success_audit', 'INSERT'),
          run.calls.findIndex(call => call.kind === 'commit')];
        assert.ok(sequence.every(index => index >= 0)); assert.deepEqual(sequence, [...sequence].sort((a, b) => a - b));
        assert.equal(borrows, 1); assert.equal(run.calls.filter(call => call.kind === 'begin').length, 1);
        assert.equal(run.calls.filter(call => call.kind === 'commit').length, 1); assert.equal(run.calls.filter(call => call.kind === 'rollback').length, 0);
        assert.equal(run.calls.filter(call => call.kind === 'db-now').length, 1);
        assert.equal(dbNow, run.calls.find(call => call.kind === 'db-now').value);
        assert.equal(sqlAt(run, table('employees'), 'FOR SHARE'), -1);
        assert.equal(Object.hasOwn(run.context(), 'creditedEmployeeId'), false);
        const [[after]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') +
          ' WHERE session_id = ?', [login.sessionId]);
        assert.deepEqual(after, activity);
      } finally { try { await connection.rollback(); } finally { connection.release(); } }
    });

    await t.test(action + ': backend/demo/payload cannot grant authority; authorization-denied leaves the same key available', async () => {
      const login = await provision(['backend.view', 'staff.record', action === 'serveExtra' ? 'order.sale' : 'order.serveExtra']);
      const id = 'additions-denied-' + action;
      await seed(id, state => { seedOrderAdditions(state); state.user = 'administrator'; state.clock = 'invalid-demo-clock'; });
      const before = await inspect(id), run = runFor(id), cmd = request('denied', 0, { permissions: [permissionId], role: 'administrator', actorId: 'administrator' });
      await assert.rejects(run.app.execute(cmd, login.credential), denied); await assertUnchanged(id, before);
      assert.equal(run.executions(), 0);
      await auth.grantPermission({ principalId: login.principalId, permissionId });
      assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed');
      const actual = await inspect(id); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1); assert.equal(actual.head.revision, 1);
    });

    await t.test(action + ': unsupported credited employee cannot replace actor or introduce a new attribution rule', async () => {
      const login = await provision([permissionId]), id = 'additions-attribution-' + action;
      await seed(id, seedOrderAdditions); const before = await inspect(id), run = runFor(id);
      await assert.rejects(run.app.execute(request('attribution', 0, { creditedEmployeeId: '10000000-0000-4000-8000-000000000001' }), login.credential),
        error => denied(error) && error.reason === 'invalid-attribution');
      await assertUnchanged(id, before); assert.equal(run.executions(), 0);
      assert.equal((await run.app.execute(request('attribution'), login.credential)).status, 'committed');
    });

    await t.test(action + ': reconnect and revoked permission replay the persisted result without duplicate effects; new key denied', async () => {
      const login = await provision([permissionId]), id = 'additions-replay-' + action;
      await seed(id, seedOrderAdditions); const run = runFor(id), cmd = request('original');
      const first = await run.app.execute(cmd, login.credential), before = await inspect(id);
      await auth.revokePermission({ principalId: login.principalId, permissionId });
      const reconnect = mysql.createPool(poolOptions);
      try {
        const again = runFor(id, { connectionPool: reconnect, bind: createMySqlAuthStore({ pool: reconnect, database }).bindSessionRevalidation,
          transactCommand: () => assert.fail('terminal replay must not execute domain') });
        assert.deepEqual(await again.app.execute(cmd, login.credential), first); assert.equal(again.executions(), 0);
        await assert.rejects(again.app.execute({ ...cmd, operationKey: 'new', expectedRevision: 1 }, login.credential), denied);
        await assertUnchanged(id, before);
      } finally { await reconnect.end(); }
    });

    await t.test(action + ': disabled/revoked/idle/absolute/credential invalidation blocks terminal access before operation lookup', async () => {
      for (const invalid of ['disabled', 'revoked', 'idle', 'absolute', 'credential']) {
        const login = await provision([permissionId]), id = 'additions-auth-' + action + '-' + invalid;
        await seed(id, seedOrderAdditions); const run = runFor(id), cmd = request('private');
        await run.app.execute(cmd, login.credential); const before = await inspect(id);
        if (invalid === 'disabled') await auth.disableAccount({ principalId: login.principalId });
        else if (invalid === 'revoked') assert.equal(await auth.logout(login.token), true);
        else if (invalid === 'credential') await auth.rotateCredential({ principalId: login.principalId, password: 'synthetic-additions-rotation' });
        else if (invalid === 'idle') await pool.execute('UPDATE ' + table('auth_sessions') + ' SET idle_expires_at = created_at WHERE session_id = ?', [login.sessionId]);
        else await pool.execute('UPDATE ' + table('auth_sessions') +
          ' SET idle_expires_at = created_at, absolute_expires_at = created_at + INTERVAL 1 MICROSECOND WHERE session_id = ?', [login.sessionId]);
        run.calls.length = 0;
        await assert.rejects(run.app.execute(cmd, login.credential), error => error.code === 'AUTHENTICATION_REQUIRED');
        assert.equal(sqlAt(run, 'ledger_operations', 'SELECT'), -1); assert.equal(run.executions(), 1); await assertUnchanged(id, before);
      }
    });

    await t.test(action + ': actor/action/payload/expectedRevision conflicts remain conflicts after revoke', async () => {
      const login = await provision([permissionId]), other = await provision([]), id = 'additions-conflicts-' + action;
      await seed(id, seedOrderAdditions); const run = runFor(id), cmd = request('same');
      await run.app.execute(cmd, login.credential); const before = await inspect(id);
      await auth.revokePermission({ principalId: login.principalId, permissionId });
      const actorConflict = await run.app.execute(cmd, other.credential);
      assert.equal(actorConflict.status, 'idempotency-conflict'); assert.equal(actorConflict.reason, 'actor-mismatch');
      for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, action: 'open' }, { ...cmd, payload: { ...cmd.payload, note: 'changed' } }]) {
        const result = await run.app.execute(changed, login.credential);
        assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'request-mismatch');
      }
      assert.equal(run.executions(), 1); await assertUnchanged(id, before);
    });

    await t.test(action + ': stale revision stays a persisted terminal before domain and replays after revoke', async () => {
      const login = await provision([permissionId]), id = 'additions-stale-' + action;
      const original = await seed(id, seedOrderAdditions), run = runFor(id), cmd = request('stale', 99);
      const result = await run.app.execute(cmd, login.credential); assert.equal(result.status, 'revision-conflict');
      const before = await inspect(id); assert.deepEqual(before.head.state, original); assert.equal(before.head.revision, 0);
      assert.equal(before.operations.length, 1); assert.equal(before.audit.length, 0); assert.equal(run.executions(), 0);
      await auth.revokePermission({ principalId: login.principalId, permissionId });
      assert.deepEqual(await run.app.execute(cmd, login.credential), result); await assertUnchanged(id, before);
    });

    await t.test(action + ': original room/amount/category/extra business rejections leave no partial order or inventory changes', async () => {
      const cases = [['missing-order', { order: 'missing' }, () => {}, /账单已变化/],
        ['closed-order', {}, state => additionOrder(state).status = '已结账', /账单已变化/]];
      if (action === 'serveExtra') cases.push(['missing-extra', { product: 'unknown' }, () => {}, /没有这项配品/],
        ['already-served', { product: 'already-served' }, () => {}, /已经标记已上/]);
      else cases.push(['category', { category: 'invalid' }, () => {}, /类别/], ['zero', { amount: 0 }, () => {}, /金额/],
        ['negative', { amount: -1 }, () => {}, /金额/], ['fraction', { amount: 0.01 }, () => {}, /金额/],
        ['overflow', { amount: Number.MAX_SAFE_INTEGER + 1 }, () => {}, /金额/], ['empty-item', { item: '  ' }, () => {}, /项目/]);
      const login = await provision([permissionId]);
      for (const [label, changes, prepare, message] of cases) {
        const id = 'additions-business-' + action + '-' + label;
        const original = await seed(id, state => { seedOrderAdditions(state); prepare(state); }), run = runFor(id), cmd = request('rejected', 0, changes);
        const result = await run.app.execute(cmd, login.credential); assert.equal(result.status, 'business-rejected'); assert.match(result.reason, message);
        const actual = await inspect(id); assert.deepEqual(actual.head.state, original); assert.equal(actual.head.revision, 0);
        assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 0);
        await auth.revokePermission({ principalId: login.principalId, permissionId });
        assert.deepEqual(await run.app.execute(cmd, login.credential), result); await assertUnchanged(id, actual);
        await auth.grantPermission({ principalId: login.principalId, permissionId });
      }
    });

    await t.test(action + ': removed/inactive catalog and original category behavior cannot rewrite historical snapshots or deduct inventory', async () => {
      const login = await provision([permissionId]), id = 'additions-history-' + action;
      const original = await seed(id, state => { seedOrderAdditions(state);
        state.catalog.products.find(product => product.id === 'water').name = 'Current Rename';
        state.catalog.products.find(product => product.id === 'water').active = false; });
      const run = runFor(id);
      if (action === 'serveExtra') {
        assert.equal((await run.app.execute(request('water'), login.credential)).status, 'committed');
        assert.equal((await run.app.execute(request('removed', 1, { product: 'removed-extra' }), login.credential)).status, 'committed');
        const { head } = await inspect(id), order = additionOrder(head.state);
        assert.equal(head.revision, 2); assert.equal(order.extras[0].productNameSnapshot, 'Historical Water');
        assert.equal(order.extras[1].productNameSnapshot, null); assert.equal(order.extras[1].served, true);
        assert.equal(total(order), total(additionOrder(original)));
      } else {
        let revision = 0;
        for (const category of OTHER_CHARGE_CATEGORIES) assert.equal((await run.app.execute(request(category, revision++,
          { category: '  ' + category + '  ', item: ' ' + 'x'.repeat(70) + ' ', amount: 1 }), login.credential)).status, 'committed');
        const { head } = await inspect(id), order = additionOrder(head.state), lines = order.otherCharges.slice(1);
        assert.deepEqual(lines.map(line => line.category), OTHER_CHARGE_CATEGORIES); assert.equal(lines.at(-1).item, 'x'.repeat(50));
        assert.ok(lines.slice(0, -1).every(line => line.item === line.category));
        assert.equal(total(order), total(additionOrder(original)) + OTHER_CHARGE_CATEGORIES.length);
      }
      const { head } = await inspect(id), order = additionOrder(head.state);
      for (const field of ['inventory', 'ledger', 'rooms']) assert.deepEqual(head.state[field], original[field]);
      for (const field of ['sales', 'payments', 'resolvedComponents', 'credit', 'packageBaseCents', 'packageGiftValueCents', 'packageNameSnapshot'])
        assert.deepEqual(order[field], additionOrder(original)[field]);
      assert.deepEqual(head.state.orders[0], original.orders[0]);
    });

    await t.test(action + ': unknown exception after domain mutation rolls back and repaired original key remains available', async () => {
      const login = await provision([permissionId]), id = 'additions-program-fault-' + action;
      await seed(id, seedOrderAdditions); const before = await inspect(id), cmd = request('retry'); let fail = true;
      const run = runFor(id, { transactCommand: (...args) => { const next = transact(...args); if (fail) throw Error('synthetic additions unknown fault'); return next; } });
      await assert.rejects(run.app.execute(cmd, login.credential), /synthetic additions unknown fault/);
      assert.ok(run.calls.some(call => call.kind === 'rollback')); await assertUnchanged(id, before);
      fail = false; assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed');
    });

    await t.test(action + ': audit SQL fault after head and operation writes rolls everything back and does not consume the key', async () => {
      const login = await provision([permissionId]), id = 'additions-sql-fault-' + action;
      await seed(id, seedOrderAdditions); const before = await inspect(id), key = 'additions-audit-fault-' + action, cmd = request(key), run = runFor(id);
      await setup.query('ALTER TABLE ' + table('ledger_success_audit') +
        " ADD CONSTRAINT trusted_additions_fault CHECK (operation_key <> '" + key + "')");
      try {
        await assert.rejects(run.app.execute(cmd, login.credential), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
        assert.ok(sqlAt(run, 'ledger_heads', 'UPDATE') >= 0); assert.ok(sqlAt(run, 'ledger_operations', 'INSERT') >= 0);
        assert.ok(run.calls.some(call => call.kind === 'rollback')); await assertUnchanged(id, before);
      } finally { await setup.query('ALTER TABLE ' + table('ledger_success_audit') + ' DROP CHECK trusted_additions_fault'); }
      assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed'); const actual = await inspect(id);
      assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
    });

    await t.test(action + ': two independent InnoDB connections preserve revision and same-key single execution', async () => {
      const login = await provision([permissionId]), a = await pool.getConnection(), b = await pool.getConnection();
      try {
        const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id'), [[bId]] = await b.query('SELECT CONNECTION_ID() AS id');
        assert.notEqual(aId.id, bId.id, 'requires two independent real MySQL connections');
        const aPool = { getConnection: async () => wrapConnection(a, [], false) }, bPool = { getConnection: async () => wrapConnection(b, [], false) };
        const id = 'additions-race-' + action; await seed(id, seedOrderAdditions);
        const first = runFor(id, { connectionPool: aPool }), second = runFor(id, { connectionPool: bPool });
        const results = await Promise.all([first.app.execute(request('a'), login.credential), second.app.execute(request('b'), login.credential)]);
        assert.deepEqual(results.map(result => result.status).sort(), ['committed', 'revision-conflict']);
        const actual = await inspect(id); assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 2); assert.equal(actual.audit.length, 1);
        assert.equal(first.executions() + second.executions(), 1);
        const sameId = 'additions-same-key-' + action; await seed(sameId, seedOrderAdditions);
        const retryA = runFor(sameId, { connectionPool: aPool }), retryB = runFor(sameId, { connectionPool: bPool }), cmd = request('same');
        const repeated = await Promise.all([retryA.app.execute(cmd, login.credential), retryB.app.execute(cmd, login.credential)]);
        assert.deepEqual(repeated[0], repeated[1]); assert.equal(repeated[0].status, 'committed');
        assert.equal(retryA.executions() + retryB.executions(), 1);
        const saved = await inspect(sameId); assert.equal(saved.head.revision, 1); assert.equal(saved.operations.length, 1); assert.equal(saved.audit.length, 1);
        for (const state of [actual.head.state, saved.head.state]) {
          assert.equal(state.ledger.length, 1); assert.equal(state.inventory.bw.count, 0); assert.equal(state.inventory.qd.count, null);
          assert.equal(additionOrder(state).payments.length, 2);
          if (action === 'otherCharge') { assert.equal(additionOrder(state).otherCharges.length, 2); assert.equal(total(additionOrder(state)), 45100); }
          else { assert.equal(additionOrder(state).extras[0].served, true); assert.equal(total(additionOrder(state)), 36300); }
        }
        t.diagnostic(action + ' races used two verified independent CONNECTION_ID values');
      } finally { try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); } }
    });
  }
}
