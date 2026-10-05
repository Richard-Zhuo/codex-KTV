import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { transact } from '../rules.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlEmployeeStore } from '../employees/mysql-store.js';
import { createEmployeeService } from '../employees/service.js';
import { incidentCommand } from '../test-support/trusted-incident-fixture.js';

// Only the guarded parent fixture owns its eleven known tables and cleanup.
export async function testTrustedIncident({ t, pool, setup, auth, table, provision, seed, inspect, application, roster,
  assertUnchanged, wrapConnection, poolOptions, database }) {
  const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
  const employee = (login, displayName = 'Synthetic Incident Assignee') => roster.createEmployee({ displayName }, { actorPrincipalId: login.principalId });
  const sqlAt = (run, name, clause) => run.calls.findIndex(call => call.kind === 'sql' && call.sql.includes(name) &&
    (clause.startsWith('FOR ') ? call.sql.endsWith(clause) : call.sql.startsWith(clause + ' ')));

  await t.test('incident: one caller connection resolves assignee after session revalidation; principal, DB time and audit commit together', async () => {
    const login = await provision(['incident.create']), assignee = await employee(login), id = 'incident-first';
    assert.equal(assignee.principalId, null); assert.notEqual(assignee.employeeId, login.principalId);
    const original = await seed(id), connection = await pool.getConnection(); let borrows = 0;
    const [[activity]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [login.sessionId]);
    try {
      const run = application(id, { connectionPool: { getConnection: async () => { borrows++; return wrapConnection(connection, [], false); } } });
      const cmd = incidentCommand('first', assignee.employeeId, 0, { actorId: 'administrator', principalId: 'forged',
        actualActorPrincipalId: 'forged', submittedByPrincipalId: 'forged', permissions: ['*'], role: 'administrator',
        clock: '1900-01-01', person: 'forged', assigneeEmployeeNameSnapshot: 'forged', createdAt: '1900-01-01' });
      const result = await run.app.execute(cmd, login.credential), actual = await inspect(id), row = actual.head.state.incidents.at(-1);
      assert.equal(result.status, 'committed'); assert.equal(result.actorId, login.principalId);
      assert.equal(row.submittedByPrincipalId, login.principalId); assert.equal(row.actualActorPrincipalId, login.principalId);
      assert.equal(row.assigneeEmployeeId, assignee.employeeId); assert.equal(row.assigneeId, assignee.employeeId);
      assert.equal(row.assignee, assignee.displayName); assert.equal(row.assigneeEmployeeNameSnapshot, assignee.displayName);
      assert.equal(row.person, null); assert.equal(row.createdAt, run.context().dbNow); assert.equal(row.date, '2026-10-03');
      assert.equal(row.description, 'Synthetic incident'); assert.equal(row.status, '待处理'); assert.deepEqual(row.resolutionReviews, []);
      assert.equal(Object.hasOwn(run.context(), 'creditedEmployeeId'), false); assert.equal(run.context().policyAttributesConfigured, false);
      const expected = structuredClone(original); expected.serial++; expected.incidents.push(row); expected.processed.push('first');
      assert.deepEqual(actual.head.state, expected); assert.equal(actual.head.state.orders[0].room, null);
      assert.equal(actual.head.state.inventory.bw.count, 0); assert.equal(actual.head.state.inventory.qd.count, null);
      assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
      assert.equal(actual.operations[0].actor_principal_id, login.principalId); assert.equal(actual.audit[0].actor_principal_id, login.principalId);
      const order = [run.calls.findIndex(c => c.kind === 'begin'), sqlAt(run, 'ledger_heads', 'FOR UPDATE'),
        sqlAt(run, 'auth_accounts', 'FOR UPDATE'), sqlAt(run, 'auth_sessions', 'FOR UPDATE'), sqlAt(run, 'auth_grants', 'FOR UPDATE'),
        sqlAt(run, 'AS db_now', 'SELECT'), sqlAt(run, 'ledger_operations', 'SELECT'), sqlAt(run, table('employees'), 'FOR SHARE'),
        run.calls.findIndex(c => c.kind === 'transact'), sqlAt(run, 'ledger_heads', 'UPDATE'), sqlAt(run, 'ledger_operations', 'INSERT'),
        sqlAt(run, 'ledger_success_audit', 'INSERT'), run.calls.findIndex(c => c.kind === 'commit')];
      assert.ok(order.every(i => i >= 0)); assert.deepEqual(order, [...order].sort((a, b) => a - b));
      assert.equal(borrows, 1); assert.equal(run.calls.filter(c => c.kind === 'begin').length, 1);
      assert.equal(run.calls.filter(c => c.kind === 'commit').length, 1); assert.equal(run.calls.filter(c => c.kind === 'db-now').length, 1);
      assert.equal(run.context().dbNow, run.calls.find(c => c.kind === 'db-now').value);
      const [[afterActivity]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [login.sessionId]);
      assert.deepEqual(afterActivity, activity);
    } finally { await connection.rollback(); connection.release(); }
  });

  await t.test('incident: same names, no principal link and a linked disabled account do not replace employee identity or actor', async () => {
    const login = await provision(['incident.create']), other = await provision([]), a = await employee(login, 'Synthetic Same Name'), b = await employee(login, 'Synthetic Same Name');
    await roster.linkPrincipal({ employeeId: b.employeeId, principalId: other.principalId }, { actorPrincipalId: login.principalId });
    await auth.disableAccount({ principalId: other.principalId }); const id = 'incident-names'; await seed(id); const run = application(id);
    const cmd = incidentCommand('a', a.employeeId); delete cmd.payload.assignee; cmd.payload.assigneeEmployeeId = a.employeeId;
    assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed');
    assert.equal((await run.app.execute(incidentCommand('b', b.employeeId, 1, { assigneeEmployeeId: b.employeeId }), login.credential)).status, 'committed');
    const rows = (await inspect(id)).head.state.incidents; assert.deepEqual(rows.map(r => r.assigneeEmployeeId), [a.employeeId, b.employeeId]);
    assert.equal(rows[0].assignee, rows[1].assignee); assert.ok(rows.every(r => r.submittedByPrincipalId === login.principalId));
  });

  await t.test('incident: backend, staff or resolution grants and forged fields cannot authorize; denied key follows a real grant', async () => {
    const login = await provision(['backend.view', 'staff.record', 'incident.resolve.approve']), assignee = await employee(login), id = 'incident-denied';
    await seed(id, s => { s.user = 'administrator'; s.clock = '2099-01-01'; }); const run = application(id), before = await inspect(id);
    const cmd = incidentCommand('same-key', assignee.employeeId, 0, { permissions: ['incident.create'], role: 'administrator', actorId: assignee.employeeId });
    await assert.rejects(run.app.execute(cmd, login.credential), denied); await assertUnchanged(id, before);
    assert.equal(run.executions(), 0); assert.equal(sqlAt(run, table('employees'), 'FOR SHARE'), -1);
    await auth.grantPermission({ principalId: login.principalId, permissionId: 'incident.create' });
    assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed');
  });

  for (const unavailable of ['disabled', 'unknown']) {
    await t.test('incident: ' + unavailable + ' assignee rejects without incident/state/audit mutation and stays terminal', async () => {
      const login = await provision(['incident.create']), assignee = await employee(login), id = 'incident-' + unavailable;
      if (unavailable === 'disabled') await roster.disableEmployee({ employeeId: assignee.employeeId }, { actorPrincipalId: login.principalId });
      const employeeId = unavailable === 'unknown' ? randomUUID() : assignee.employeeId;
      const original = await seed(id), run = application(id), cmd = incidentCommand('invalid', employeeId), result = await run.app.execute(cmd, login.credential);
      assert.equal(result.status, 'business-rejected'); const before = await inspect(id);
      assert.deepEqual(before.head.state, original); assert.equal(before.head.revision, 0); assert.equal(before.operations.length, 1); assert.equal(before.audit.length, 0);
      assert.equal(run.executions(), 0); await auth.revokePermission({ principalId: login.principalId, permissionId: 'incident.create' });
      assert.deepEqual(await run.app.execute(cmd, login.credential), result); await assertUnchanged(id, before);
    });
  }

  await t.test('incident: malformed, missing, old demo/name/principal or conflicting assignee IDs never infer staff', async () => {
    const login = await provision(['incident.create']), assignee = await employee(login);
    for (const [label, changes] of [['missing', { assignee: null }], ['demo', { assignee: 'wife' }], ['name', { assignee: assignee.displayName }],
      ['principal', { assignee: login.principalId }], ['aliases', { assigneeEmployeeId: randomUUID() }]]) {
      const id = 'incident-invalid-assignee-' + label; const original = await seed(id), run = application(id);
      const result = await run.app.execute(incidentCommand('invalid', assignee.employeeId, 0, changes), login.credential);
      assert.equal(result.status, 'business-rejected'); const after = await inspect(id); assert.deepEqual(after.head.state, original);
      assert.equal(after.head.revision, 0); assert.equal(after.audit.length, 0); assert.equal(run.executions(), 0);
    }
  });

  await t.test('incident: permission revoke, employee rename/disable and reconnect preserve old terminal; fresh key uses current grant', async () => {
    const login = await provision(['incident.create']), assignee = await employee(login), id = 'incident-replay'; await seed(id);
    const run = application(id), cmd = incidentCommand('replay', assignee.employeeId), first = await run.app.execute(cmd, login.credential), before = await inspect(id);
    await auth.revokePermission({ principalId: login.principalId, permissionId: 'incident.create' });
    await pool.execute('UPDATE ' + table('employees') + ' SET display_name=? WHERE employee_id=?', ['Later Name', assignee.employeeId]);
    await roster.disableEmployee({ employeeId: assignee.employeeId }, { actorPrincipalId: login.principalId });
    const fresh = mysql.createPool({ ...poolOptions, connectionLimit: 1 });
    try {
      const retry = application(id, { connectionPool: fresh, employeeBind: null, transactCommand: () => { throw Error('must not register twice'); } });
      assert.deepEqual(await retry.app.execute(cmd, login.credential), first);
      assert.equal(sqlAt(retry, table('employees'), 'FOR SHARE'), -1);
      await assert.rejects(retry.app.execute({ ...cmd, operationKey: 'new', expectedRevision: 1 }, login.credential), denied); await assertUnchanged(id, before);
    } finally { await fresh.end(); }
  });

  await t.test('incident: disabled/revoked/idle/absolute/credential changes block old-result access before operation lookup', async () => {
    for (const invalid of ['disabled', 'revoked', 'idle', 'absolute', 'credential']) {
      const login = await provision(['incident.create']), assignee = await employee(login), id = 'incident-auth-' + invalid;
      await seed(id); const run = application(id), cmd = incidentCommand('private', assignee.employeeId); await run.app.execute(cmd, login.credential); const before = await inspect(id);
      if (invalid === 'disabled') await auth.disableAccount({ principalId: login.principalId });
      else if (invalid === 'revoked') await auth.revokeSession({ sessionId: login.sessionId });
      else if (invalid === 'credential') await auth.rotateCredential({ principalId: login.principalId, password: 'synthetic-incident-rotated-password' });
      else if (invalid === 'idle') await pool.execute('UPDATE ' + table('auth_sessions') + ' SET idle_expires_at=created_at WHERE session_id=?', [login.sessionId]);
      else await pool.execute('UPDATE ' + table('auth_sessions') + ' SET idle_expires_at=created_at,absolute_expires_at=created_at+INTERVAL 1 MICROSECOND WHERE session_id=?', [login.sessionId]);
      run.calls.length = 0; await assert.rejects(run.app.execute(cmd, login.credential), e => e.code === 'AUTHENTICATION_REQUIRED');
      await assertUnchanged(id, before); assert.equal(sqlAt(run, 'ledger_operations', 'SELECT'), -1); assert.equal(sqlAt(run, table('employees'), 'FOR SHARE'), -1);
    }
  });

  await t.test('incident: actor/request/revision/assignee conflicts precede current grant and employee lookup', async () => {
    const login = await provision(['incident.create']), other = await provision([]), assignee = await employee(login), id = 'incident-conflicts'; await seed(id);
    const run = application(id), cmd = incidentCommand('same', assignee.employeeId); await run.app.execute(cmd, login.credential); const before = await inspect(id);
    await auth.revokePermission({ principalId: login.principalId, permissionId: 'incident.create' });
    assert.equal((await run.app.execute(cmd, other.credential)).reason, 'actor-mismatch');
    for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, payload: { ...cmd.payload, assignee: randomUUID() } },
      { ...cmd, payload: { ...cmd.payload, description: 'changed' } }, { ...cmd, action: 'resolveIncident' }]) {
      assert.equal((await run.app.execute(changed, login.credential)).reason, 'request-mismatch');
    }
    await assertUnchanged(id, before); assert.equal(run.executions(), 1);
  });

  await t.test('incident: original invalid date/room/type/description rejects atomically, description still truncates at 300', async () => {
    const login = await provision(['incident.create']), assignee = await employee(login);
    for (const [label, changes] of [['date', { date: '2026-13-01' }], ['room', { room: 'missing' }], ['type', { type: 'unknown' }], ['description', { description: '  ' }]]) {
      const id = 'incident-domain-' + label, original = await seed(id), result = await application(id).app.execute(incidentCommand('invalid', assignee.employeeId, 0, changes), login.credential);
      assert.equal(result.status, 'business-rejected'); const after = await inspect(id); assert.deepEqual(after.head.state, original); assert.equal(after.head.revision, 0); assert.equal(after.audit.length, 0);
    }
    const id = 'incident-long'; await seed(id); assert.equal((await application(id).app.execute(incidentCommand('long', assignee.employeeId, 0, { description: 'x'.repeat(350) }), login.credential)).status, 'committed');
    assert.equal((await inspect(id)).head.state.incidents.at(-1).description.length, 300);
  });

  await t.test('incident: missing employee port cannot fall back to USERS or principal linkage', async () => {
    const login = await provision(['incident.create']), assignee = await employee(login), id = 'incident-no-resolver'; await seed(id); const before = await inspect(id);
    await assert.rejects(application(id, { employeeBind: null }).app.execute(incidentCommand('blocked', assignee.employeeId), login.credential), TypeError); await assertUnchanged(id, before);
  });

  await t.test('incident: real employee SELECT SQL failure rolls back without reserving key', async () => {
    const login = await provision(['incident.create']), assignee = await employee(login), id = 'incident-resolver-sql'; await seed(id); const before = await inspect(id);
    const store = createMySqlEmployeeStore({ pool, database });
    const bind = connection => store.bindEmployeeResolver({ query: (...args) => connection.query(...args), execute: (sql, values) => connection.execute(
      sql.startsWith('SELECT employee_id, display_name, enabled') ? sql.replace('employee_id,', 'missing_incident_column,') : sql, values) });
    const cmd = incidentCommand('repair', assignee.employeeId), run = application(id, { employeeBind: bind });
    await assert.rejects(run.app.execute(cmd, login.credential), e => e.code === 'ER_BAD_FIELD_ERROR');
    assert.ok(run.calls.some(c => c.kind === 'rollback')); await assertUnchanged(id, before);
    assert.equal((await application(id).app.execute(cmd, login.credential)).status, 'committed');
  });

  await t.test('incident: unknown fault after creation rolls back all state and the same key can retry', async () => {
    const login = await provision(['incident.create']), assignee = await employee(login), id = 'incident-program-fault'; await seed(id); const before = await inspect(id); let fail = true;
    const run = application(id, { transactCommand: (...args) => { const next = transact(...args); if (fail) throw Error('synthetic incident unknown fault'); return next; } });
    const cmd = incidentCommand('repair', assignee.employeeId); await assert.rejects(run.app.execute(cmd, login.credential), /synthetic incident unknown fault/); await assertUnchanged(id, before);
    fail = false; assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed');
  });

  await t.test('incident: audit SQL fault after head/operation writes rolls incident, revision, result and audit back', async () => {
    const login = await provision(['incident.create']), assignee = await employee(login), id = 'incident-sql'; await seed(id); const before = await inspect(id), run = application(id);
    const cmd = incidentCommand('repair', assignee.employeeId);
    await setup.query('ALTER TABLE ' + table('ledger_success_audit') + " ADD CONSTRAINT chk_incident_fault CHECK (ledger_id <> 'incident-sql')");
    try {
      await assert.rejects(run.app.execute(cmd, login.credential), e => e.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
      assert.ok(sqlAt(run, 'ledger_heads', 'UPDATE') >= 0); assert.ok(sqlAt(run, 'ledger_operations', 'INSERT') >= 0);
      assert.ok(run.calls.some(c => c.kind === 'rollback')); await assertUnchanged(id, before);
    } finally { await setup.query('ALTER TABLE ' + table('ledger_success_audit') + ' DROP CHECK chk_incident_fault'); }
    assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed');
  });

  await t.test('incident: two real independent connections yield one old-revision effect and one same-key execution', async () => {
    const login = await provision(['incident.create']), assignee = await employee(login), a = await pool.getConnection(), b = await pool.getConnection();
    try {
      const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id'), [[bId]] = await b.query('SELECT CONNECTION_ID() AS id'); assert.notEqual(aId.id, bId.id);
      const aPool = { getConnection: async () => wrapConnection(a, [], false) }, bPool = { getConnection: async () => wrapConnection(b, [], false) };
      for (const sameKey of [false, true]) {
        const id = 'incident-race-' + sameKey; await seed(id); const first = application(id, { connectionPool: aPool }), second = application(id, { connectionPool: bPool });
        const results = await Promise.all([first.app.execute(incidentCommand('a', assignee.employeeId), login.credential),
          second.app.execute(incidentCommand(sameKey ? 'a' : 'b', assignee.employeeId), login.credential)]);
        if (sameKey) assert.deepEqual(results[0], results[1]); else assert.deepEqual(results.map(r => r.status).sort(), ['committed', 'revision-conflict']);
        const after = await inspect(id); assert.equal(after.head.revision, 1); assert.equal(after.head.state.incidents.length, 1);
        assert.equal(after.audit.length, 1); assert.equal(after.operations.length, sameKey ? 1 : 2); assert.equal(first.executions() + second.executions(), 1);
      }
      t.diagnostic('incident races used two verified distinct CONNECTION_ID values');
    } finally { try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); } }
  });

  await t.test('incident: employee shared lock orders an independent employee disable after the command', async () => {
    const login = await provision(['incident.create']), admin = await provision([]), assignee = await employee(login), id = 'incident-disable-race'; await seed(id);
    const a = await pool.getConnection(), b = await pool.getConnection(); let releaseLookup, lookupLocked;
    const held = new Promise(resolve => { releaseLookup = resolve; }), locked = new Promise(resolve => { lookupLocked = resolve; });
    let commandWork, disableWork;
    try {
      const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id'), [[bId]] = await b.query('SELECT CONNECTION_ID() AS id'); assert.notEqual(aId.id, bId.id);
      const store = createMySqlEmployeeStore({ pool, database });
      const bind = connection => { const inner = store.bindEmployeeResolver(connection); return {
        async resolveCreditedEmployeeInTransaction(input) { const result = await inner.resolveCreditedEmployeeInTransaction(input); lookupLocked(); await held; return result; }
      }; };
      const run = application(id, { connectionPool: { getConnection: async () => wrapConnection(a, [], false) }, employeeBind: bind });
      commandWork = run.app.execute(incidentCommand('before-disable', assignee.employeeId), login.credential);
      let timeout; try { await Promise.race([locked, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('employee lock timeout')), 5000); })]); } finally { clearTimeout(timeout); }
      const disableStore = createMySqlEmployeeStore({ pool: { getConnection: async () => wrapConnection(b, [], false) }, database });
      const disableRoster = createEmployeeService({ store: disableStore }); let disabled = false;
      disableWork = disableRoster.disableEmployee({ employeeId: assignee.employeeId }, { actorPrincipalId: admin.principalId }).then(r => { disabled = true; return r; });
      await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(disabled, false);
      releaseLookup(); assert.equal((await commandWork).status, 'committed'); assert.equal((await disableWork).employee.enabled, false);
      const retry = await application(id).app.execute(incidentCommand('after-disable', assignee.employeeId, 1), login.credential);
      assert.equal(retry.status, 'business-rejected'); assert.equal((await inspect(id)).head.state.incidents.length, 1);
      t.diagnostic('incident resolver/employee-disable order used two verified distinct CONNECTION_ID values');
    } finally {
      releaseLookup(); await Promise.allSettled([commandWork, disableWork].filter(Boolean));
      try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); }
    }
  });

  await t.test('incident: review and all other untrusted actions remain closed even with their grants', async () => {
    const login = await provision(['incident.create', 'incident.resolve', 'incident.resolve.approve', 'rounding.approve',
      'payment.collect', 'payment.settle', 'procurement.create', 'handover', 'room.open']), id = 'incident-closed'; await seed(id); const before = await inspect(id);
    for (const action of ['handover', 'open']) {
      await assert.rejects(application(id).app.execute({ ...incidentCommand(action, randomUUID()), action }, login.credential), e => denied(e) && e.reason === 'trusted-action-not-enabled');
    }
    await assertUnchanged(id, before);
  });
}
