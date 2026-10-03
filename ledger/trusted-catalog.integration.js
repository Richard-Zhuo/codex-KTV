// Invoked by the existing isolated auth+ledger fixture; owns no DDL lifecycle.
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { AuthorizationDenied } from '../shared/identity.js';
import { CATALOG_TEST_ACTIONS, catalogTestPayload, seedCatalogHistory } from '../test-support/trusted-catalog-fixture.js';

const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
const authRequired = error => error.code === 'AUTHENTICATION_REQUIRED';
const command = (key, action, payload = catalogTestPayload(action), revision = 0) =>
  ({ operationKey: key, expectedRevision: revision, action, payload });

export async function testTrustedCatalogCommands({ t, pool, setup, auth, table, provision, seed, inspect,
  application, assertUnchanged, wrapConnection, poolOptions, database }) {
  for (const action of CATALOG_TEST_ACTIONS) {
    await t.test(action + ': session authority commits current catalog and preserves history/null/zero', async () => {
      const login = await provision(['catalog.manage']), id = 'catalog-first-' + action;
      const original = await seed(id, seedCatalogHistory), run = application(id);
      const payload = { ...catalogTestPayload(action), actorId: 'administrator', principalId: 'fake', user: 'fake',
        permissions: ['*'], role: 'administrator', clock: '1900-01-01', person: 'fake' };
      const result = await run.app.execute(command('first', action, payload), login.credential);
      assert.equal(result.status, 'committed'); assert.equal(result.actorId, login.principalId); assert.equal(result.revision, 1);
      assert.equal(run.executions(), 1); assert.deepEqual(run.context().permissionIds, ['catalog.manage']);
      assert.equal(run.calls.filter(call => call.kind === 'db-now').length, 1);
      assert.equal(run.context().dbNow, run.calls.find(call => call.kind === 'db-now').value);
      const actual = await inspect(id), state = actual.head.state;
      assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
      assert.equal(actual.operations[0].actor_principal_id, login.principalId); assert.equal(actual.operations[0].action, action);
      assert.equal(actual.audit[0].actor_principal_id, login.principalId); assert.equal(actual.audit[0].action, action);
      assert.deepEqual(state.orders, original.orders); assert.equal(state.orders[1].room, null);
      assert.equal(state.inventory.bw.count, 0); assert.equal(state.inventory.qd.count, null);
      if (action === 'createCatalogProduct') {
        const product = state.catalog.products.find(item => item.id === 'synthetic_pack');
        assert.equal(product.name, payload.name); assert.deepEqual(product.saleOptions, payload.saleOptions);
        assert.deepEqual(state.inventory.synthetic_pack, { count: null, threshold: 10, unit: '包' });
      } else {
        assert.deepEqual(state.inventory, original.inventory);
        if (action === 'updateCatalogProduct') {
          const product = state.catalog.products.find(item => item.id === 'bw');
          assert.equal(product.name, payload.name); assert.deepEqual(product.saleOptions, payload.saleOptions);
          assert.equal(product.baseUnit, '支'); assert.equal(product.inventoryManaged, true);
        } else {
          const updated = state.catalog.packages.find(item => item.id === payload.id), before = original.catalog.packages.find(item => item.id === payload.id);
          assert.equal(updated.name, payload.name); assert.equal(updated.priceCents, 17000);
          assert.equal(updated.priceCents, updated.basePriceCents + updated.includedValueCents);
          assert.deepEqual(updated.openingGift, before.openingGift); assert.deepEqual(updated.components, before.components);
        }
      }
      for (const field of ['user', 'clock', 'permissions', 'capabilities', 'administrator', 'rooms', 'ledger', 'roomIssueReviews']) assert.deepEqual(state[field], original[field]);
    });

    await t.test(action + ': denied key has no effects and succeeds after the current grant is added', async () => {
      const login = await provision(['backend.view']), id = 'catalog-denied-' + action;
      await seed(id, seedCatalogHistory); const before = await inspect(id), run = application(id);
      const request = command('denied', action, { ...catalogTestPayload(action), actorId: 'administrator',
        principalId: 'fake', permissions: ['catalog.manage'], role: 'administrator', clock: '1900-01-01' });
      await assert.rejects(run.app.execute(request, login.credential), denied);
      await assertUnchanged(id, before); assert.equal(run.executions(), 0);
      await auth.grantPermission({ principalId: login.principalId, permissionId: 'catalog.manage' });
      const result = await run.app.execute(request, login.credential);
      assert.equal(result.status, 'committed'); assert.equal(result.actorId, login.principalId); assert.equal(result.revision, 1);
    });

    await t.test(action + ': reconnect after revoke replays original; new key denied; actor/fingerprint conflicts preserved', async () => {
      const login = await provision(['catalog.manage']), other = await provision([]), id = 'catalog-replay-' + action;
      await seed(id, seedCatalogHistory); const run = application(id), request = command('original', action);
      const first = await run.app.execute(request, login.credential);
      await auth.revokePermission({ principalId: login.principalId, permissionId: 'catalog.manage' });
      const before = await inspect(id), reconnect = mysql.createPool(poolOptions);
      try {
        // The binder needs no new store: the existing authStore binder binds the supplied connection.
        const again = application(id, { connectionPool: reconnect, transactCommand: () => assert.fail('must not execute on terminal replay/conflict') });
        assert.deepEqual(await again.app.execute(request, login.credential), first);
        const conflict = await again.app.execute(request, other.credential);
        assert.equal(conflict.status, 'idempotency-conflict'); assert.equal(conflict.reason, 'actor-mismatch');
        for (const changed of [{ ...request, expectedRevision: 1 }, { ...request, payload: { ...request.payload, name: 'changed name' } }]) {
          const result = await again.app.execute(changed, login.credential);
          assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'request-mismatch');
        }
        await assert.rejects(again.app.execute({ ...request, operationKey: 'new', expectedRevision: 1 }, login.credential), denied);
        assert.equal(again.executions(), 0);
      } finally { await reconnect.end(); }
      await assertUnchanged(id, before);
    });

    await t.test(action + ': disabled/revoked/idle/absolute/version invalidation blocks old terminal access', async () => {
      for (const state of ['disabled', 'revoked', 'idle-expired', 'absolute-expired', 'credential-version']) {
        const login = await provision(['catalog.manage']), id = 'catalog-auth-' + action + '-' + state;
        await seed(id, seedCatalogHistory); const run = application(id), request = command('private', action);
        await run.app.execute(request, login.credential); const before = await inspect(id);
        if (state === 'disabled') await auth.disableAccount({ principalId: login.principalId });
        else if (state === 'revoked') await auth.logout(login.token);
        else if (state === 'credential-version') await auth.rotateCredential({ principalId: login.principalId, password: 'synthetic-rotated-only' });
        else if (state === 'idle-expired') await pool.execute('UPDATE ' + table('auth_sessions') + ' SET idle_expires_at = created_at WHERE session_id = ?', [login.sessionId]);
        else await pool.execute('UPDATE ' + table('auth_sessions') +
          ' SET idle_expires_at = created_at, absolute_expires_at = created_at + INTERVAL 1 MICROSECOND WHERE session_id = ?', [login.sessionId]);
        run.calls.length = 0; await assert.rejects(run.app.execute(request, login.credential), authRequired);
        assert.ok(!run.calls.some(call => call.kind === 'sql' && call.sql.includes('ledger_operations')));
        assert.equal(run.executions(), 1); await assertUnchanged(id, before);
      }
    });

    await t.test(action + ': stale revision and original business validation are persistent terminals without success effects', async () => {
      for (const status of ['revision-conflict', 'business-rejected']) {
        const login = await provision(['catalog.manage']), id = 'catalog-terminal-' + action + '-' + status;
        const original = await seed(id, seedCatalogHistory), run = application(id);
        const request = command('terminal', action, { ...catalogTestPayload(action), ...(status === 'business-rejected' ? { name: '' } : {}) }, status === 'revision-conflict' ? 9 : 0);
        const result = await run.app.execute(request, login.credential); assert.equal(result.status, status);
        const before = await inspect(id); assert.deepEqual(before.head.state, original); assert.equal(before.head.revision, 0);
        assert.equal(before.operations.length, 1); assert.equal(before.audit.length, 0);
        await auth.revokePermission({ principalId: login.principalId, permissionId: 'catalog.manage' });
        assert.deepEqual(await run.app.execute(request, login.credential), result); await assertUnchanged(id, before);
      }
    });

    await t.test(action + ': audit SQL failure rolls back state/revision/operation and leaves the same key reusable', async () => {
      const login = await provision(['catalog.manage']), id = 'catalog-sql-' + action;
      await seed(id, seedCatalogHistory); const before = await inspect(id), run = application(id);
      await setup.query('ALTER TABLE ' + table('ledger_success_audit') + " ADD CONSTRAINT chk_catalog_slice_fault CHECK (ledger_id <> '" + id + "')");
      const request = command('sql-retry', action);
      try {
        await assert.rejects(run.app.execute(request, login.credential), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
        assert.ok(run.calls.some(call => call.kind === 'sql' && call.sql.includes('ledger_heads') && call.sql.startsWith('UPDATE ')));
        assert.ok(run.calls.some(call => call.kind === 'sql' && call.sql.includes('ledger_operations') && call.sql.startsWith('INSERT ')));
        assert.ok(run.calls.some(call => call.kind === 'rollback')); await assertUnchanged(id, before);
      } finally { await setup.query('ALTER TABLE ' + table('ledger_success_audit') + ' DROP CHECK chk_catalog_slice_fault'); }
      assert.equal((await run.app.execute(request, login.credential)).status, 'committed');
    });
  }

  await t.test('catalog commands: two independent connections keep revision competition and same-key single execution', async () => {
    const login = await provision(['catalog.manage']); await seed('catalog-race', seedCatalogHistory);
    const a = await pool.getConnection(), b = await pool.getConnection();
    try {
      const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id'), [[bId]] = await b.query('SELECT CONNECTION_ID() AS id');
      assert.notEqual(aId.id, bId.id, 'two independent real MySQL connections required');
      await a.query('SET SESSION innodb_lock_wait_timeout = 5'); await b.query('SET SESSION innodb_lock_wait_timeout = 5');
      const aPool = { getConnection: async () => wrapConnection(a, [], false) }, bPool = { getConnection: async () => wrapConnection(b, [], false) };
      const first = application('catalog-race', { connectionPool: aPool }), second = application('catalog-race', { connectionPool: bPool });
      const result = await Promise.all([first.app.execute(command('create', 'createCatalogProduct'), login.credential),
        second.app.execute(command('update', 'updateCatalogProduct'), login.credential)]);
      assert.deepEqual(result.map(item => item.status).sort(), ['committed', 'revision-conflict']);
      const actual = await inspect('catalog-race'); assert.equal(actual.head.revision, 1);
      assert.equal(actual.operations.length, 2); assert.equal(actual.audit.length, 1); assert.equal(first.executions() + second.executions(), 1);
      await seed('catalog-key-race', seedCatalogHistory);
      const retryA = application('catalog-key-race', { connectionPool: aPool }), retryB = application('catalog-key-race', { connectionPool: bPool });
      const request = command('same', 'updateCatalogPackage');
      const repeated = await Promise.all([retryA.app.execute(request, login.credential), retryB.app.execute(request, login.credential)]);
      assert.deepEqual(repeated[0], repeated[1]); assert.equal(repeated[0].status, 'committed');
      assert.equal(retryA.executions() + retryB.executions(), 1);
      const saved = await inspect('catalog-key-race'); assert.equal(saved.head.revision, 1); assert.equal(saved.operations.length, 1); assert.equal(saved.audit.length, 1);
      t.diagnostic('catalog races used two verified independent CONNECTION_ID values');
    } finally { try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); } }
  });
}
