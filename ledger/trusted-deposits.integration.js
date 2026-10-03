// Storage tests reuse the guarded eight-table fixture and own no DDL lifecycle.
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact } from '../rules.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { DEPOSIT_TEST_ACTIONS, depositTestPayload, seedStoredDeposits, invalidDepositPayloads } from '../test-support/trusted-deposits-fixture.js';

const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
const authRequired = error => error.code === 'AUTHENTICATION_REQUIRED';
const command = (key, action, payload = depositTestPayload(action), revision = 0) =>
  ({ operationKey: key, expectedRevision: revision, action, payload });

export async function testTrustedDeposits({ t, pool, setup, auth, table, provision, seed, inspect,
  application, assertUnchanged, wrapConnection, poolOptions, database }) {
  for (const action of DEPOSIT_TEST_ACTIONS) {
    await t.test(action + ': session operator and DB time commit storage/state/result/audit; customer identity stays business data', async () => {
      const login = await provision(['deposit.manage']), id = 'storage-first-' + action;
      const original = await seed(id, seedStoredDeposits), run = application(id);
      const payload = { ...depositTestPayload(action), actorId: 'administrator', principalId: 'fake', user: 'fake',
        person: 'fake', permissions: ['*'], role: 'administrator', clock: '1900-01-01', time: 'fake' };
      const result = await run.app.execute(command('first', action, payload), login.credential);
      assert.equal(result.status, 'committed'); assert.equal(result.actorId, login.principalId); assert.equal(result.revision, 1);
      assert.equal(run.executions(), 1); assert.deepEqual(run.context().permissionIds, ['deposit.manage']);
      const now = run.calls.filter(call => call.kind === 'db-now'); assert.equal(now.length, 1); assert.equal(run.context().dbNow, now[0].value);
      const actual = await inspect(id), state = actual.head.state;
      const records = action === 'deposit' ? state.deposits.slice(original.deposits.length) : state.withdrawals.slice(original.withdrawals.length);
      for (const record of records) { assert.equal(record.person, login.principalId); assert.equal(record.time, run.context().dbNow); }
      if (action === 'deposit') {
        assert.equal(records.length, 2); assert.equal(new Set(records.map(row => row.group)).size, 1);
        assert.deepEqual(records.map(row => row.count), [6, 3]); assert.deepEqual(records.map(row => row.initial), [6, 3]);
        for (const row of records) {
          assert.equal(row.name, 'Synthetic Guest'); assert.equal(row.phone, '13800001234'); assert.notEqual(row.name, row.person);
          assert.equal(row.productNameSnapshot, original.catalog.products.find(product => product.id === row.productId).name);
        }
        assert.deepEqual(state.deposits.slice(0, original.deposits.length), original.deposits);
        assert.deepEqual(state.withdrawals, original.withdrawals);
      } else {
        const expected = structuredClone(original.deposits); expected[0].count = 4;
        assert.deepEqual(state.deposits, expected); assert.equal(records.length, 1); assert.equal(records[0].deposit, 101);
        assert.equal(records[0].count, 2); assert.deepEqual(state.withdrawals.slice(0, original.withdrawals.length), original.withdrawals);
      }
      for (const field of ['orders','inventory','consumables','ledger','rooms','reservations','roomIssueReviews','user','clock','permissions','capabilities','administrator']) {
        assert.deepEqual(state[field], original[field], field + ' must not change');
      }
      assert.equal(state.orders[0].room, null); assert.equal(state.inventory.bw.count, 0);
      assert.ok(Object.values(state.inventory).some(row => row.count === null));
      assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
      assert.equal(actual.operations[0].actor_principal_id, login.principalId); assert.equal(actual.operations[0].action, action);
      assert.deepEqual(actual.operations[0].terminal_result, result); assert.equal(actual.audit[0].actor_principal_id, login.principalId);
      assert.equal(actual.audit[0].action, action); assert.equal(Number(actual.audit[0].before_revision), 0); assert.equal(Number(actual.audit[0].after_revision), 1);
    });

    await t.test(action + ': customer data and forged permissions cannot authorize; denied key works after grant', async () => {
      const login = await provision(['backend.view']), id = 'storage-denied-' + action;
      await seed(id, seedStoredDeposits); const before = await inspect(id), run = application(id);
      const request = command('denied', action, { ...depositTestPayload(action), actorId: 'administrator', permissions: ['deposit.manage'], role: 'administrator' });
      await assert.rejects(run.app.execute(request, login.credential), denied); await assertUnchanged(id, before); assert.equal(run.executions(), 0);
      await auth.grantPermission({ principalId: login.principalId, permissionId: 'deposit.manage' });
      assert.equal((await run.app.execute(request, login.credential)).status, 'committed'); assert.equal(run.executions(), 1);
    });

    await t.test(action + ': reconnect after revoke replays original without duplicate storage; actor/payload/action/revision conflicts persist', async () => {
      const login = await provision(['deposit.manage']), other = await provision([]), id = 'storage-replay-' + action;
      await seed(id, seedStoredDeposits); const run = application(id), request = command('original', action);
      const first = await run.app.execute(request, login.credential);
      await auth.revokePermission({ principalId: login.principalId, permissionId: 'deposit.manage' });
      const before = await inspect(id), reconnect = mysql.createPool(poolOptions);
      try {
        const again = application(id, { connectionPool: reconnect, bind: createMySqlAuthStore({ pool: reconnect, database }).bindSessionRevalidation,
          transactCommand: () => assert.fail('terminal replay must never execute storage domain') });
        assert.deepEqual(await again.app.execute(request, login.credential), first);
        const different = await again.app.execute(request, other.credential);
        assert.equal(different.status, 'idempotency-conflict'); assert.equal(different.reason, 'actor-mismatch');
        for (const changed of [{ ...request, expectedRevision: 1 },
          { ...request, payload: { ...request.payload, ...(action === 'deposit' ? { name: 'Changed Guest' } : { count: 1 }) } },
          { ...request, action: action === 'deposit' ? 'withdraw' : 'deposit' }]) {
          const result = await again.app.execute(changed, login.credential);
          assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'request-mismatch');
        }
        await assert.rejects(again.app.execute({ ...request, operationKey: 'new', expectedRevision: 1 }, login.credential), denied);
        assert.equal(again.executions(), 0);
      } finally { await reconnect.end(); }
      await assertUnchanged(id, before);
    });

    await t.test(action + ': disabled/revoked/idle/absolute/credential invalidation denies terminal access before lookup', async () => {
      for (const state of ['disabled','revoked','idle-expired','absolute-expired','credential-version']) {
        const login = await provision(['deposit.manage']), id = 'storage-auth-' + action + '-' + state;
        await seed(id, seedStoredDeposits); const run = application(id), request = command('private', action);
        await run.app.execute(request, login.credential); const before = await inspect(id);
        if (state === 'disabled') await auth.disableAccount({ principalId: login.principalId });
        else if (state === 'revoked') await auth.logout(login.token);
        else if (state === 'credential-version') await auth.rotateCredential({ principalId: login.principalId, password: 'synthetic-storage-rotated' });
        else if (state === 'idle-expired') await pool.execute('UPDATE ' + table('auth_sessions') + ' SET idle_expires_at = created_at WHERE session_id = ?', [login.sessionId]);
        else await pool.execute('UPDATE ' + table('auth_sessions') + ' SET idle_expires_at = created_at, absolute_expires_at = created_at + INTERVAL 1 MICROSECOND WHERE session_id = ?', [login.sessionId]);
        run.calls.length = 0; await assert.rejects(run.app.execute(request, login.credential), authRequired);
        assert.ok(!run.calls.some(call => call.kind === 'sql' && call.sql.includes('ledger_operations')));
        assert.equal(run.executions(), 1); await assertUnchanged(id, before);
      }
    });

    await t.test(action + ': original business checks and stale revisions persist terminals; later state changes never re-execute old keys', async () => {
      const login = await provision(['deposit.manage']);
      for (const [index, payload] of invalidDepositPayloads(action).entries()) {
        const id = 'storage-validation-' + action + '-' + index, original = await seed(id, seedStoredDeposits), run = application(id);
        const result = await run.app.execute(command('business', action, payload), login.credential);
        assert.equal(result.status, 'business-rejected'); const actual = await inspect(id);
        assert.deepEqual(actual.head.state, original); assert.equal(actual.head.revision, 0);
        assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 0);
      }
      for (const status of ['revision-conflict','business-rejected']) {
        const id = 'storage-terminal-' + action + '-' + status;
        await seed(id, seedStoredDeposits); const run = application(id);
        const request = command('terminal', action, status === 'business-rejected' ? invalidDepositPayloads(action)[0] : depositTestPayload(action), status === 'revision-conflict' ? 9 : 0);
        const first = await run.app.execute(request, login.credential); assert.equal(first.status, status);
        assert.equal((await run.app.execute(command('later', action), login.credential)).status, 'committed');
        const before = await inspect(id);
        await auth.revokePermission({ principalId: login.principalId, permissionId: 'deposit.manage' });
        assert.deepEqual(await run.app.execute(request, login.credential), first); await assertUnchanged(id, before);
        await auth.grantPermission({ principalId: login.principalId, permissionId: 'deposit.manage' });
      }
    });

    await t.test(action + ': unknown failure rolls back without terminal or audit and same key can retry after repair', async () => {
      const login = await provision(['deposit.manage']), id = 'storage-unknown-' + action;
      await seed(id, seedStoredDeposits); const before = await inspect(id); let fail = true;
      const run = application(id, { transactCommand: (...args) => {
        const next = transact(...args); if (fail) throw Error('synthetic storage fault'); return next;
      } });
      await assert.rejects(run.app.execute(command('repair', action), login.credential), /synthetic storage fault/);
      assert.ok(run.calls.some(call => call.kind === 'rollback')); await assertUnchanged(id, before); fail = false;
      assert.equal((await run.app.execute(command('repair', action), login.credential)).status, 'committed');
    });

    await t.test(action + ': mid-commit audit SQL failure rolls back state/serial/revision/operation and preserves original key', async () => {
      const login = await provision(['deposit.manage']), id = 'storage-sql-' + action;
      await seed(id, seedStoredDeposits); const before = await inspect(id), run = application(id);
      await setup.query('ALTER TABLE ' + table('ledger_success_audit') + " ADD CONSTRAINT chk_storage_slice_fault CHECK (ledger_id <> '" + id + "')");
      try {
        await assert.rejects(run.app.execute(command('sql-repair', action), login.credential), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
        assert.ok(run.calls.some(call => call.kind === 'sql' && call.sql.includes('ledger_heads') && call.sql.startsWith('UPDATE ')));
        assert.ok(run.calls.some(call => call.kind === 'sql' && call.sql.includes('ledger_operations') && call.sql.startsWith('INSERT ')));
        assert.ok(run.calls.some(call => call.kind === 'rollback')); await assertUnchanged(id, before);
      } finally { await setup.query('ALTER TABLE ' + table('ledger_success_audit') + ' DROP CHECK chk_storage_slice_fault'); }
      assert.equal((await run.app.execute(command('sql-repair', action), login.credential)).status, 'committed');
    });
  }

  await t.test('storage workflow: different session actors can store/take the same customer without employee mapping or retry duplication', async () => {
    const storing = await provision(['deposit.manage']), taking = await provision(['deposit.manage']), id = 'storage-workflow';
    const original = await seed(id, seedStoredDeposits), run = application(id), deposit = command('store', 'deposit');
    const first = await run.app.execute(deposit, storing.credential), stored = (await inspect(id)).head.state.deposits.at(-2);
    const withdraw = command('take', 'withdraw', { id: stored.id, identity: stored.name, count: 2 }, 1);
    const second = await run.app.execute(withdraw, taking.credential), before = await inspect(id);
    assert.notEqual(first.actorId, second.actorId); assert.equal(first.actorId, storing.principalId); assert.equal(second.actorId, taking.principalId);
    assert.equal(before.head.revision, 2); assert.equal(before.head.state.deposits.find(row => row.id === stored.id).count, 4);
    assert.equal(before.head.state.deposits.find(row => row.id === stored.id).person, storing.principalId);
    assert.equal(before.head.state.withdrawals.at(-1).person, taking.principalId);
    assert.deepEqual(before.head.state.inventory, original.inventory); assert.deepEqual(before.head.state.ledger, original.ledger);
    assert.deepEqual(await run.app.execute(deposit, storing.credential), first);
    assert.deepEqual(await run.app.execute(withdraw, taking.credential), second); await assertUnchanged(id, before);
    assert.equal(run.executions(), 2);
  });

  await t.test('storage customer inputs retain name-only/phone-only/single-item and complete-name/4-11-digit lookup rules', async () => {
    const login = await provision(['deposit.manage']);
    const deposits = [{ room: 'V01', name: 'administrator', product: 'bw', count: 1 }, { room: 'V01', phone: '13800001234', product: 'bw', count: 1 }];
    for (const [index, payload] of deposits.entries()) {
      const id = 'storage-customer-deposit-' + index; await seed(id, seedStoredDeposits);
      const result = await application(id).app.execute(command('customer', 'deposit', payload), login.credential);
      assert.equal(result.status, 'committed'); const stored = (await inspect(id)).head.state.deposits.at(-1);
      assert.equal(stored.name, payload.name || ''); assert.equal(stored.phone, payload.phone || ''); assert.equal(stored.person, login.principalId);
    }
    for (const [index, identity] of ['1234','13800001234',' Historic Guest '].entries()) {
      const id = 'storage-customer-withdraw-' + index; await seed(id, seedStoredDeposits);
      assert.equal((await application(id).app.execute(command('customer', 'withdraw', { id: 101, identity, count: 6 }), login.credential)).status, 'committed');
      const state = (await inspect(id)).head.state; assert.equal(state.deposits[0].count, 0);
      assert.equal(state.deposits[0].productNameSnapshot, null); assert.equal(state.deposits[0].productId, 'retired-product');
      assert.equal(state.withdrawals.at(-1).person, login.principalId);
    }
  });

  await t.test('storage races: two independent connections commit at most one old revision and execute same-key store/take once', async () => {
    const login = await provision(['deposit.manage']); await seed('storage-race', seedStoredDeposits);
    const a = await pool.getConnection(), b = await pool.getConnection();
    try {
      const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id'), [[bId]] = await b.query('SELECT CONNECTION_ID() AS id');
      assert.notEqual(aId.id, bId.id, 'requires two independent real MySQL connections');
      await a.query('SET SESSION innodb_lock_wait_timeout = 5'); await b.query('SET SESSION innodb_lock_wait_timeout = 5');
      const aPool = { getConnection: async () => wrapConnection(a, [], false) }, bPool = { getConnection: async () => wrapConnection(b, [], false) };
      const first = application('storage-race', { connectionPool: aPool }), second = application('storage-race', { connectionPool: bPool });
      const results = await Promise.all([first.app.execute(command('store', 'deposit'), login.credential), second.app.execute(command('take', 'withdraw'), login.credential)]);
      assert.deepEqual(results.map(result => result.status).sort(), ['committed','revision-conflict']);
      const actual = await inspect('storage-race'); assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 2); assert.equal(actual.audit.length, 1);
      assert.equal(first.executions() + second.executions(), 1);
      if (results[0].status === 'committed') { assert.equal(actual.head.state.deposits.length, 4); assert.equal(actual.head.state.deposits[0].count, 6); }
      else { assert.equal(actual.head.state.deposits.length, 2); assert.equal(actual.head.state.deposits[0].count, 4); }
      for (const action of DEPOSIT_TEST_ACTIONS) {
        const id = 'storage-key-race-' + action; await seed(id, seedStoredDeposits);
        const retryA = application(id, { connectionPool: aPool }), retryB = application(id, { connectionPool: bPool });
        const request = command('same', action), repeated = await Promise.all([retryA.app.execute(request, login.credential), retryB.app.execute(request, login.credential)]);
        assert.deepEqual(repeated[0], repeated[1]); assert.equal(repeated[0].status, 'committed');
        assert.equal(retryA.executions() + retryB.executions(), 1); const saved = await inspect(id);
        assert.equal(saved.head.revision, 1); assert.equal(saved.operations.length, 1); assert.equal(saved.audit.length, 1);
        if (action === 'deposit') assert.equal(saved.head.state.deposits.length, 4);
        else { assert.equal(saved.head.state.deposits[0].count, 4); assert.equal(saved.head.state.withdrawals.length, 2); }
      }
      t.diagnostic('storage races used two verified independent CONNECTION_ID values');
    } finally { try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); } }
  });
}
