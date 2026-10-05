import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact } from '../rules.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';

// Reuse the guarded eight-table fixture; no database/table creation or cleanup here.
export async function runTrustedCancelReservationIntegration(t, {
  pool, poolOptions, setup, table, seed, provision, auth, application, inspect, assertUnchanged, wrapConnection
}) {
  const action = 'cancelReservation';
  const command = (key, revision = 0, payload = { room: 'V01', id: 101 }) =>
    ({ operationKey: key, expectedRevision: revision, action, payload });
  const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
  const authRequired = error => error.code === 'AUTHENTICATION_REQUIRED';
  const prepare = state => {
    state.rooms[0].status = '已预订';
    state.reservations = [
      { id: 101, room: 'V01', at: '2020-01-01T20:00:00.000Z', session: 'night', status: '已预订',
        person: 'unknown historical employee', employeeId: 'unmapped-demo-id', recordedBy: 'original recorder',
        source: '线下', note: 'original reservation' },
      { id: 102, room: 'V02', at: '2099-01-01T20:00:00.000Z', session: 'night', status: '已预订' },
      { id: 103, room: 'V01', at: '2020-01-01T14:00:00.000Z', session: 'afternoon', status: '已取消' }
    ];
  };
  const title = name => action + ': ' + name;

  await t.test(title('session actor cancels only selected reservation; state/result/revision/audit commit together'), async () => {
    const login = await provision(['room.reserve']), id = 'cancel-first';
    const original = await seed(id, prepare), run = application(id);
    const payload = { room: 'V01', id: 101, actorId: 'administrator', principalId: 'fake', user: 'fake',
      person: 'fake', employee: 'fake', permissions: ['*'], role: 'administrator', clock: '1900-01-01' };
    const result = await run.app.execute(command('first', 0, payload), login.credential);
    assert.equal(result.status, 'committed'); assert.equal(result.actorId, login.principalId); assert.equal(result.revision, 1);
    assert.equal(run.executions(), 1); assert.deepEqual(run.context().permissionIds, ['room.reserve']);
    const actual = await inspect(id), expected = structuredClone(original);
    expected.reservations[0].status = '已取消'; expected.rooms[0].status = '空闲'; expected.processed.push('first');
    assert.deepEqual(actual.head.state, expected); assert.equal(actual.head.revision, 1);
    assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
    assert.equal(actual.operations[0].actor_principal_id, login.principalId); assert.equal(actual.operations[0].action, action);
    assert.deepEqual(actual.operations[0].terminal_result, result); assert.equal(actual.audit[0].actor_principal_id, login.principalId);
    assert.equal(actual.audit[0].action, action); assert.equal(Number(actual.audit[0].before_revision), 0);
    assert.equal(Number(actual.audit[0].after_revision), 1);
    const dbCalls = run.calls.filter(call => call.kind === 'db-now'); assert.equal(dbCalls.length, 1);
    assert.equal(run.context().dbNow, dbCalls[0].value);
    const sqlAt = (name, extra) => run.calls.findIndex(call => call.kind === 'sql' && call.sql.includes(name) &&
      (extra === 'FOR UPDATE' ? call.sql.includes(extra) : call.sql.startsWith(extra + ' ')));
    const order = [run.calls.findIndex(call => call.kind === 'begin'), sqlAt('ledger_heads', 'FOR UPDATE'),
      sqlAt('auth_accounts', 'FOR UPDATE'), sqlAt('auth_sessions', 'FOR UPDATE'), sqlAt('auth_grants', 'FOR UPDATE'),
      sqlAt('AS db_now', 'SELECT'), sqlAt('ledger_operations', 'SELECT'), run.calls.findIndex(call => call.kind === 'transact'),
      run.calls.findIndex(call => call.kind === 'commit')];
    assert.ok(order.every(index => index >= 0)); assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });

  await t.test(title('room release uses frozen DB time; active/future/ended bookings preserve original rules'), async () => {
    const login = await provision(['room.reserve']);
    for (const [label, hours, session, active] of [
      ['active', -1, 'afternoon', true], ['ended', -5, 'afternoon', false], ['future', 24, 'night', false]
    ]) {
      const [[time]] = await pool.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%dT%H:%i:%s.%fZ') AS test_now");
      const at = new Date(Date.parse(time.test_now) + hours * 3600000).toISOString(), id = 'cancel-time-' + label;
      const original = await seed(id, state => {
        prepare(state); state.clock = active ? '2099-01-01T00:00:00.000Z' : at;
        state.reservations.push({ id: 104, room: 'V01', at, session, status: '已预订' });
      });
      const run = application(id), result = await run.app.execute(command('time', 0,
        { room: 'V01', id: 101, clock: '1900-01-01' }), login.credential);
      assert.equal(result.status, 'committed'); assert.equal(run.calls.filter(call => call.kind === 'db-now').length, 1);
      const actual = await inspect(id); assert.equal(actual.head.state.rooms[0].status, active ? '已预订' : '空闲');
      assert.deepEqual(actual.head.state.reservations.slice(1), original.reservations.slice(1));
      assert.deepEqual(actual.head.state.orders, original.orders); assert.deepEqual(actual.head.state.inventory, original.inventory);
      assert.equal(actual.head.state.orders[0].room, null); assert.equal(actual.head.state.inventory.bw.count, 0);
      assert.ok(Object.values(actual.head.state.inventory).some(item => item.count === null));
    }
  });

  await t.test(title('unique omitted/empty ID and explicit multiple-booking selection retain original semantics'), async () => {
    const login = await provision(['room.reserve']);
    for (const [index, payload] of [{ room: 'V01' }, { room: 'V01', id: '' }, { room: 'V01', id: '101' }].entries()) {
      const id = 'cancel-unique-' + index; await seed(id, prepare);
      const result = await application(id).app.execute(command('unique', 0, payload), login.credential);
      assert.equal(result.status, 'committed'); const actual = await inspect(id);
      assert.equal(actual.head.state.reservations[0].status, '已取消'); assert.equal(actual.head.state.reservations[1].status, '已预订');
    }
    const id = 'cancel-ambiguous'; await seed(id, state => {
      prepare(state); state.reservations.push({ ...state.reservations[0], id: 104, at: '2099-01-02T20:00:00.000Z' });
    });
    const before = await inspect(id), run = application(id);
    for (const [index, payload] of [{ room: 'V01' }, { room: 'V01', id: '' },
      { room: 'missing', id: 101 }, { room: 'V01', id: 102 }, { room: 'V01', id: 'not-a-number' }].entries()) {
      const result = await run.app.execute(command('ambiguous-' + index, 0, payload), login.credential);
      assert.equal(result.status, 'business-rejected');
      const actual = await inspect(id); assert.deepEqual(actual.head, before.head); assert.equal(actual.audit.length, 0);
    }
    assert.equal((await run.app.execute(command('explicit', 0, { room: 'V01', id: 104 }), login.credential)).status, 'committed');
    const after = await inspect(id); assert.equal(after.head.state.reservations[0].status, '已预订');
    assert.equal(after.head.state.reservations.at(-1).status, '已取消'); assert.equal(after.head.revision, 1);
  });

  await t.test(title('authorization denial has no terminal or audit and the original key works after grant'), async () => {
    const login = await provision(['backend.view', 'room.open']), id = 'cancel-denied';
    await seed(id, prepare); const before = await inspect(id), run = application(id);
    const request = command('denied', 0, { room: 'V01', id: 101, actorId: 'administrator', permissions: ['room.reserve'] });
    await assert.rejects(run.app.execute(request, login.credential), denied);
    assert.equal(run.executions(), 0); await assertUnchanged(id, before);
    await auth.grantPermission({ principalId: login.principalId, permissionId: 'room.reserve' });
    assert.equal((await run.app.execute(request, login.credential)).status, 'committed'); assert.equal(run.executions(), 1);
  });

  await t.test(title('reconnect after revoke returns original terminal; actor/action/payload/revision conflicts still precede new-key authorization'), async () => {
    const login = await provision(['room.reserve']), other = await provision([]), id = 'cancel-replay';
    await seed(id, prepare); const run = application(id), request = command('original');
    const first = await run.app.execute(request, login.credential);
    await auth.revokePermission({ principalId: login.principalId, permissionId: 'room.reserve' });
    const before = await inspect(id), reconnect = mysql.createPool(poolOptions);
    try {
      const again = application(id, { connectionPool: reconnect,
        bind: createMySqlAuthStore({ pool: reconnect, database: 'jbhh_ktv_test' }).bindSessionRevalidation,
        transactCommand: () => assert.fail('replay/conflict must not execute domain') });
      assert.deepEqual(await again.app.execute(request, login.credential), first);
      const conflict = await again.app.execute(request, other.credential);
      assert.equal(conflict.status, 'idempotency-conflict'); assert.equal(conflict.reason, 'actor-mismatch');
      for (const changed of [{ ...request, expectedRevision: 1 }, { ...request, payload: { ...request.payload, id: 102 } },
        { ...request, action: 'reserve' }]) {
        const result = await again.app.execute(changed, login.credential);
        assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'request-mismatch');
      }
      await assert.rejects(again.app.execute({ ...request, operationKey: 'new', expectedRevision: 1 }, login.credential), denied);
      assert.equal(again.executions(), 0);
    } finally { await reconnect.end(); }
    await assertUnchanged(id, before);
  });

  for (const state of ['disabled', 'revoked', 'idle-expired', 'absolute-expired', 'credential-version']) {
    await t.test(title(state + ' authentication blocks old terminal access before operation lookup'), async () => {
      const login = await provision(['room.reserve']), id = 'cancel-auth-' + state;
      await seed(id, prepare); const run = application(id), request = command('private');
      await run.app.execute(request, login.credential); const before = await inspect(id);
      if (state === 'disabled') await auth.disableAccount({ principalId: login.principalId });
      else if (state === 'revoked') await auth.logout(login.token);
      else if (state === 'credential-version') await auth.rotateCredential({ principalId: login.principalId, password: 'synthetic-cancel-rotated' });
      else if (state === 'idle-expired') await pool.execute('UPDATE ' + table('auth_sessions') +
        ' SET idle_expires_at = created_at WHERE session_id = ?', [login.sessionId]);
      else await pool.execute('UPDATE ' + table('auth_sessions') +
        ' SET idle_expires_at = created_at, absolute_expires_at = created_at + INTERVAL 1 MICROSECOND WHERE session_id = ?', [login.sessionId]);
      run.calls.length = 0; await assert.rejects(run.app.execute(request, login.credential), authRequired);
      assert.ok(!run.calls.some(call => call.kind === 'sql' && call.sql.includes('ledger_operations')));
      assert.equal(run.executions(), 1); await assertUnchanged(id, before);
    });
  }

  await t.test(title('revision conflict and business rejection remain original terminals after state change and revoke'), async () => {
    for (const status of ['revision-conflict', 'business-rejected']) {
      const login = await provision(['room.reserve']), id = 'cancel-terminal-' + status;
      const original = await seed(id, prepare), run = application(id);
      const request = command('terminal', status === 'revision-conflict' ? 9 : 0,
        { room: 'V01', id: status === 'business-rejected' ? 999 : 101 });
      const result = await run.app.execute(request, login.credential); assert.equal(result.status, status);
      const rejected = await inspect(id); assert.deepEqual(rejected.head.state, original); assert.equal(rejected.head.revision, 0);
      assert.equal(rejected.operations.length, 1); assert.equal(rejected.audit.length, 0);
      assert.equal((await run.app.execute(command('later'), login.credential)).status, 'committed');
      await auth.revokePermission({ principalId: login.principalId, permissionId: 'room.reserve' });
      const before = await inspect(id); assert.deepEqual(await run.app.execute(request, login.credential), result);
      await assertUnchanged(id, before);
    }
  });

  await t.test(title('unknown exception rolls back and leaves original operation key reusable after repair'), async () => {
    const login = await provision(['room.reserve']), id = 'cancel-unknown';
    await seed(id, prepare); const before = await inspect(id); let fail = true;
    const run = application(id, { transactCommand: (...args) => {
      const next = transact(...args); if (fail) throw Error('synthetic cancellation infrastructure failure'); return next;
    } });
    await assert.rejects(run.app.execute(command('repair'), login.credential), /synthetic cancellation infrastructure failure/);
    assert.ok(run.calls.some(call => call.kind === 'rollback')); await assertUnchanged(id, before); fail = false;
    assert.equal((await run.app.execute(command('repair'), login.credential)).status, 'committed');
  });

  await t.test(title('audit SQL failure rolls back changed state/revision/operation; repaired key can retry'), async () => {
    const login = await provision(['room.reserve']), id = 'cancel-sql';
    await seed(id, prepare); const before = await inspect(id), run = application(id);
    await setup.query('ALTER TABLE ' + table('ledger_success_audit') +
      " ADD CONSTRAINT chk_cancel_slice_fault CHECK (ledger_id <> 'cancel-sql')");
    try {
      await assert.rejects(run.app.execute(command('sql-repair'), login.credential), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
      assert.ok(run.calls.some(call => call.kind === 'sql' && call.sql.includes('ledger_heads') && call.sql.startsWith('UPDATE ')));
      assert.ok(run.calls.some(call => call.kind === 'sql' && call.sql.includes('ledger_operations') && call.sql.startsWith('INSERT ')));
      assert.ok(run.calls.some(call => call.kind === 'rollback')); await assertUnchanged(id, before);
    } finally { await setup.query('ALTER TABLE ' + table('ledger_success_audit') + ' DROP CHECK chk_cancel_slice_fault'); }
    assert.equal((await run.app.execute(command('sql-repair'), login.credential)).status, 'committed');
  });

  await t.test(title('two independent connections serialize revision competition and same-key cancellation'), async () => {
    const login = await provision(['room.reserve']);
    await seed('cancel-race', state => { prepare(state); state.rooms[1].status = '已预订'; });
    const a = await pool.getConnection(), b = await pool.getConnection();
    try {
      const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id'), [[bId]] = await b.query('SELECT CONNECTION_ID() AS id');
      assert.notEqual(aId.id, bId.id, 'requires two independent real MySQL connections');
      await a.query('SET SESSION innodb_lock_wait_timeout = 5'); await b.query('SET SESSION innodb_lock_wait_timeout = 5');
      const aPool = { getConnection: async () => wrapConnection(a, [], false) }, bPool = { getConnection: async () => wrapConnection(b, [], false) };
      const first = application('cancel-race', { connectionPool: aPool }), second = application('cancel-race', { connectionPool: bPool });
      const results = await Promise.all([first.app.execute(command('a'), login.credential),
        second.app.execute(command('b', 0, { room: 'V02', id: 102 }), login.credential)]);
      assert.deepEqual(results.map(result => result.status).sort(), ['committed', 'revision-conflict']);
      const actual = await inspect('cancel-race'); assert.equal(actual.head.revision, 1);
      assert.equal(actual.operations.length, 2); assert.equal(actual.audit.length, 1);
      assert.equal(actual.head.state.reservations.filter(item => item.status === '已取消').length, 2);
      assert.equal(first.executions() + second.executions(), 1);
      await seed('cancel-key-race', prepare);
      const retryA = application('cancel-key-race', { connectionPool: aPool }), retryB = application('cancel-key-race', { connectionPool: bPool });
      const repeated = await Promise.all([retryA.app.execute(command('same'), login.credential), retryB.app.execute(command('same'), login.credential)]);
      assert.deepEqual(repeated[0], repeated[1]); assert.equal(repeated[0].status, 'committed');
      assert.equal(retryA.executions() + retryB.executions(), 1);
      const saved = await inspect('cancel-key-race'); assert.equal(saved.head.revision, 1);
      assert.equal(saved.operations.length, 1); assert.equal(saved.audit.length, 1);
      assert.equal(saved.head.state.reservations[0].status, '已取消');
      t.diagnostic('cancellation races used two verified independent CONNECTION_ID values');
    } finally { try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); } }
  });

  await t.test(title('eligible open still fails closed instead of falling back to demo execution'), async () => {
    const login = await provision(['room.reserve']), id = 'cancel-not-reserve';
    await seed(id, prepare); const before = await inspect(id), run = application(id);
    await assert.rejects(run.app.execute({ ...command('blocked'), action: 'open' }, login.credential),
      error => denied(error) && error.reason === 'missing-permission');
    assert.equal(run.executions(), 0); await assertUnchanged(id, before);
  });
}
