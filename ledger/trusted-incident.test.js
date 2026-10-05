import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { submitIncident } from '../incidents.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTransactionBoundEmployeeResolver } from '../employees/employee-resolver.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { createTrustedLedgerApplication } from './application.js';
import { incidentCommand, incidentEmployeeId as employeeId, otherIncidentEmployeeId, incidentDbNow as dbNow } from '../test-support/trusted-incident-fixture.js';

const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
function fixture({ permissions = ['incident.create'], resolver = true, execute = transact } = {}) {
  const state = initialState(); state.user = 'not-a-demo-user'; state.clock = 'invalid-demo-clock';
  state.permissions = { administrator: ['管理员'] }; state.capabilities = { administrator: ['*'] }; state.administrator = true;
  state.inventory.bw.count = 0; state.orders = [{ id: 'history', kind: 'retail', room: null,
    sales: [{ productNameSnapshot: 'historical', pricePerSaleUnitCents: null }], payments: [{ method: '现金', amount: 100 }] }];
  const memory = createMemoryLedgerStore(state, { ledgerId: 'incident-unit' }), digest = Buffer.alloc(32, 9), events = [];
  const auth = { id: 'synthetic-incident-actor', permissions, enabled: true, revoked: false, version: 1, sessionVersion: 1,
    idle: '2099-01-01T00:00:00.000000Z', absolute: '2099-01-02T00:00:00.000000Z' };
  const employees = new Map([[employeeId, { employeeId, displayName: 'Synthetic Same Name', enabled: true }],
    [otherIncidentEmployeeId, { employeeId: otherIncidentEmployeeId, displayName: 'Synthetic Same Name', enabled: true }]]);
  let context, executionCount = 0, resolverError = null, hasResolver = resolver;
  const port = {
    locateSessionByDigest: async () => ({ principalId: auth.id, sessionId: 'synthetic-session' }),
    lockAccount: async () => { events.push('account'); return { principalId: auth.id, enabled: auth.enabled, credentialVersion: auth.version, policyAttributesConfigured: false }; },
    lockSessionById: async () => { events.push('session'); return { principalId: auth.id, sessionId: 'synthetic-session', tokenDigest: digest,
      revoked: auth.revoked, credentialVersion: auth.sessionVersion, idleExpiresAt: auth.idle, absoluteExpiresAt: auth.absolute }; },
    listGrants: async () => { events.push('grants'); return auth.permissions; }, listPolicyAttributes: async () => [],
    readDbNow: async () => { events.push('db-now'); return dbNow; }
  };
  const store = { ledgerId: memory.ledgerId, runAtomic: work => memory.runAtomic(tx => {
    events.push('head'); const lookup = tx.findOperationResult;
    tx.findOperationResult = async key => { events.push('operation'); return lookup(key); };
    tx.sessionRevalidation = { revalidateSessionInTransaction: credential => revalidateSessionInTransaction({ port, ...credential }) };
    if (hasResolver) tx.employeeResolver = createTransactionBoundEmployeeResolver({ port: { lockEmployeeForAttribution: async id => {
      events.push('employee'); if (resolverError) throw resolverError; return employees.get(id) ?? null;
    } } });
    return work(tx);
  }) };
  const app = createTrustedLedgerApplication({ store, transactCommand: (...args) => { executionCount++; events.push('transact'); context = args[4].context; return execute(...args); } });
  return { app, state, memory, auth, employees, events, credential: { tokenDigest: digest }, context: () => context,
    executions: () => executionCount, failResolver: error => { resolverError = error; }, setResolver: value => { hasResolver = value; } };
}
async function unchanged(f) {
  const head = await f.memory.read(); assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0);
  assert.equal(head.operationResults.size, 0); assert.equal(head.audit.length, 0);
}

test('incident: session actor, resolved assignee snapshot and frozen DB time are independent', async () => {
  const f = fixture(), result = await f.app.execute(incidentCommand('first'), f.credential), head = await f.memory.read(), row = head.state.incidents.at(-1);
  assert.equal(result.status, 'committed'); assert.equal(result.actorId, f.auth.id);
  assert.equal(row.submittedByPrincipalId, f.auth.id); assert.equal(row.actualActorPrincipalId, f.auth.id);
  assert.equal(row.assigneeEmployeeId, employeeId); assert.equal(row.assignee, 'Synthetic Same Name');
  assert.equal(row.assigneeEmployeeNameSnapshot, 'Synthetic Same Name'); assert.equal(row.assigneeId, employeeId);
  assert.notEqual(row.assigneeEmployeeId, row.submittedByPrincipalId); assert.equal(row.person, null);
  assert.equal(row.createdAt, dbNow); assert.equal(row.date, '2026-10-03'); assert.equal(row.status, '待处理');
  assert.equal(row.description, 'Synthetic incident'); assert.deepEqual(row.resolutionReviews, []);
  assert.equal(Object.hasOwn(f.context(), 'creditedEmployeeId'), false);
  assert.deepEqual(f.events, ['head', 'account', 'session', 'grants', 'db-now', 'operation', 'employee', 'transact']);
  assert.equal(head.revision, 1); assert.equal(head.audit.length, 1);
  const expected = structuredClone(f.state); expected.serial++; expected.incidents.push(row); expected.processed.push('first');
  assert.deepEqual(head.state, expected);
});

test('incident: canonical assignee UUID and matching alias distinguish same-name employees', async () => {
  const f = fixture(); const canonical = incidentCommand('a', otherIncidentEmployeeId); delete canonical.payload.assignee;
  canonical.payload.assigneeEmployeeId = otherIncidentEmployeeId;
  assert.equal((await f.app.execute(canonical, f.credential)).status, 'committed');
  assert.equal((await f.app.execute(incidentCommand('b', employeeId, 1, { assigneeEmployeeId: employeeId }), f.credential)).status, 'committed');
  const rows = (await f.memory.read()).state.incidents;
  assert.deepEqual(rows.map(r => r.assigneeEmployeeId), [otherIncidentEmployeeId, employeeId]);
  assert.equal(rows[0].assignee, rows[1].assignee); assert.ok(rows.every(r => r.submittedByPrincipalId === f.auth.id));
});

test('incident: only incident.create authorizes actor, and denied key can succeed after grant', async () => {
  for (const permissions of [[], ['staff.record'], ['backend.view'], ['incident.resolve'], ['incident.resolve.approve']]) {
    const f = fixture({ permissions }); const cmd = incidentCommand('denied', employeeId, 0, {
      actorId: 'administrator', principalId: 'forged', actualActorPrincipalId: employeeId,
      permissions: ['incident.create'], role: 'administrator', clock: '2099-01-01', submittedByPrincipalId: employeeId });
    await assert.rejects(f.app.execute(cmd, f.credential), denied); await unchanged(f);
    assert.equal(f.events.includes('employee'), false); assert.equal(f.executions(), 0);
    f.auth.permissions = ['incident.create']; assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed');
    const row = (await f.memory.read()).state.incidents.at(-1); assert.equal(row.submittedByPrincipalId, f.auth.id);
    assert.equal(row.createdAt, dbNow); assert.equal(row.person, null);
  }
});

test('incident: forged actor, assignee display and time cannot replace trusted facts', async () => {
  const f = fixture(), cmd = incidentCommand('spoof', employeeId, 0, {
    actorId: 'administrator', principalId: 'forged', user: 'administrator', submittedByPrincipalId: 'forged',
    actualActorPrincipalId: 'forged', permissions: ['*'], role: 'administrator', clock: '1900-01-01',
    createdAt: '1900-01-01', person: 'forged', assigneeEmployeeNameSnapshot: 'forged', assigneeName: 'forged' });
  assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed');
  const row = (await f.memory.read()).state.incidents.at(-1);
  assert.equal(row.submittedByPrincipalId, f.auth.id); assert.equal(row.actualActorPrincipalId, f.auth.id);
  assert.equal(row.person, null); assert.equal(row.assignee, 'Synthetic Same Name'); assert.equal(row.createdAt, dbNow);
});

for (const unavailable of ['disabled', 'unknown']) {
  test('incident: ' + unavailable + ' assignee is terminal with no incident or revision change', async () => {
    const f = fixture(); if (unavailable === 'disabled') f.employees.get(employeeId).enabled = false; else f.employees.delete(employeeId);
    const cmd = incidentCommand(unavailable), result = await f.app.execute(cmd, f.credential);
    assert.equal(result.status, 'business-rejected'); const before = await f.memory.read();
    assert.deepEqual(before.state, f.state); assert.equal(before.revision, 0); assert.equal(before.audit.length, 0); assert.equal(f.executions(), 0);
    f.employees.set(employeeId, { employeeId, displayName: 'Enabled Later', enabled: true }); f.auth.permissions = [];
    assert.deepEqual(await f.app.execute(cmd, f.credential), result); assert.deepEqual(await f.memory.read(), before);
  });
}

test('incident: missing, legacy, name, principal or conflicting aliases never infer an employee', async () => {
  for (const changes of [{ assignee: null }, { assignee: 'wife' }, { assignee: 'Synthetic Same Name' },
    { assignee: 'synthetic-incident-actor' }, { assigneeEmployeeId: otherIncidentEmployeeId }]) {
    const f = fixture(), result = await f.app.execute(incidentCommand('bad-assignee', employeeId, 0, changes), f.credential);
    assert.equal(result.status, 'business-rejected'); const head = await f.memory.read();
    assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0); assert.equal(head.audit.length, 0); assert.equal(f.executions(), 0);
  }
  const f = fixture(), cmd = incidentCommand(); delete cmd.payload.assignee;
  assert.equal((await f.app.execute(cmd, f.credential)).status, 'business-rejected');
});

test('incident: revoke, rename and disable cannot rewrite replay; fresh keys use current permission', async () => {
  const f = fixture(), cmd = incidentCommand('replay'), first = await f.app.execute(cmd, f.credential), before = await f.memory.read();
  f.auth.permissions = []; f.employees.get(employeeId).enabled = false; f.employees.get(employeeId).displayName = 'Later Name';
  f.events.length = 0; f.setResolver(false);
  assert.deepEqual(await f.app.execute(cmd, f.credential), first); assert.equal(f.events.includes('employee'), false);
  await assert.rejects(f.app.execute({ ...cmd, operationKey: 'new', expectedRevision: 1 }, f.credential), denied);
  assert.deepEqual(await f.memory.read(), before); assert.equal(f.executions(), 1);
});

test('incident: actor and fingerprint conflicts precede current permission or assignee lookup', async () => {
  const f = fixture(), cmd = incidentCommand('key'); await f.app.execute(cmd, f.credential); const before = await f.memory.read(); f.auth.permissions = [];
  for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, payload: { ...cmd.payload, description: 'changed' } },
    { ...cmd, payload: { ...cmd.payload, assignee: otherIncidentEmployeeId } }, { ...cmd, action: 'resolveIncident' }]) {
    assert.equal((await f.app.execute(changed, f.credential)).reason, 'request-mismatch');
  }
  f.auth.id = 'synthetic-other'; assert.equal((await f.app.execute(cmd, f.credential)).reason, 'actor-mismatch');
  assert.deepEqual(await f.memory.read(), before); assert.equal(f.executions(), 1);
});

test('incident: disabled, revoked, expired or credential-changed session cannot read terminal', async () => {
  for (const change of [a => { a.enabled = false; }, a => { a.revoked = true; }, a => { a.idle = dbNow; },
    a => { a.absolute = dbNow; }, a => { a.version++; }]) {
    const f = fixture(), cmd = incidentCommand('private'); await f.app.execute(cmd, f.credential); const before = await f.memory.read(); change(f.auth);
    await assert.rejects(f.app.execute(cmd, f.credential), e => e.code === 'AUTHENTICATION_REQUIRED'); assert.deepEqual(await f.memory.read(), before);
  }
});

test('incident: stale revision persists before employee lookup and remains terminal', async () => {
  const f = fixture(), cmd = incidentCommand('stale', otherIncidentEmployeeId, 99), result = await f.app.execute(cmd, f.credential);
  assert.equal(result.status, 'revision-conflict'); assert.equal(f.events.includes('employee'), false); assert.equal(f.executions(), 0);
  const before = await f.memory.read(); f.auth.permissions = []; assert.deepEqual(await f.app.execute(cmd, f.credential), result);
  assert.deepEqual(await f.memory.read(), before);
});

test('incident: original date, room, type and description validations are atomic business rejections', async () => {
  for (const changes of [{ date: '2026-13-01' }, { date: '' }, { room: 'missing' }, { type: 'unknown' }, { description: '  ' }]) {
    const f = fixture(); assert.equal((await f.app.execute(incidentCommand('invalid', employeeId, 0, changes), f.credential)).status, 'business-rejected');
    const before = await f.memory.read(); assert.deepEqual(before.state, f.state); assert.equal(before.revision, 0); assert.equal(before.audit.length, 0);
  }
  const f = fixture(); assert.equal((await f.app.execute(incidentCommand('long', employeeId, 0, { description: 'x'.repeat(350) }), f.credential)).status, 'committed');
  assert.equal((await f.memory.read()).state.incidents.at(-1).description, 'x'.repeat(300));
});

test('incident: missing resolver and unknown resolver fault fail closed without consuming key', async () => {
  const f = fixture({ resolver: false }), cmd = incidentCommand('repair');
  await assert.rejects(f.app.execute(cmd, f.credential), TypeError); await unchanged(f);
  f.setResolver(true); const fault = new Error('synthetic resolver fault'); f.failResolver(fault);
  await assert.rejects(f.app.execute(cmd, f.credential), fault); await unchanged(f);
  f.failResolver(null); assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed');
});

test('incident: unknown fault after domain mutation rolls everything back and key may retry', async () => {
  let fail = true; const f = fixture({ execute: (...args) => { const after = transact(...args); if (fail) throw Error('synthetic incident fault'); return after; } });
  const cmd = incidentCommand('repair'); await assert.rejects(f.app.execute(cmd, f.credential), /synthetic incident fault/); await unchanged(f);
  fail = false; assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed'); assert.equal((await f.memory.read()).state.incidents.length, 1);
});

test('incident: trusted domain never reads demo authority or time and ignores direct forged arguments', async () => {
  const f = fixture(); await f.app.execute(incidentCommand(), f.credential); const state = structuredClone(f.state);
  for (const field of ['user', 'permissions', 'capabilities', 'clock']) Object.defineProperty(state, field, { get() { throw Error('demo ' + field); } });
  submitIncident(state, incidentCommand().payload, 'forged person', '1900-01-01', { mode: 'trusted', context: f.context() });
  assert.equal(state.incidents[0].submittedByPrincipalId, f.auth.id); assert.equal(state.incidents[0].createdAt, dbNow);
  for (const context of [undefined, structuredClone(f.context()), { ...f.context() }]) {
    assert.throws(() => transact(f.state, 'incident', incidentCommand().payload, 'direct', { mode: 'trusted', context }), TypeError);
  }
  assert.throws(() => submitIncident(f.state, incidentCommand('changed', otherIncidentEmployeeId).payload,
    'forged', 'forged', { mode: 'trusted', context: f.context() }), TypeError);
});

test('incident: demo registration retains old USERS fields and behavior', () => {
  const before = initialState(); before.user = 'shaoBoss'; before.clock = '2026-10-05T20:00:00+08:00';
  const after = transact(before, 'incident', incidentCommand('demo', 'wife').payload, 'demo'); const row = after.incidents[0];
  assert.equal(row.assigneeId, 'wife'); assert.equal(row.assignee, '老板娘'); assert.equal(row.person, '邵老板');
  assert.equal(row.createdAt, before.clock); assert.equal(Object.hasOwn(row, 'submittedByPrincipalId'), false);
});

test('incident: competing keys and same-key retry keep one old-revision incident effect', async () => {
  for (const sameKey of [false, true]) {
    const f = fixture(), outcomes = await Promise.all([f.app.execute(incidentCommand('a'), f.credential),
      f.app.execute(incidentCommand(sameKey ? 'a' : 'b'), f.credential)]);
    if (sameKey) assert.deepEqual(outcomes[0], outcomes[1]); else assert.deepEqual(outcomes.map(x => x.status).sort(), ['committed', 'revision-conflict']);
    const head = await f.memory.read(); assert.equal(head.revision, 1); assert.equal(head.state.incidents.length, 1); assert.equal(head.audit.length, 1);
    assert.equal(f.executions(), 1);
  }
});

test('incident: review, rounding, payments and other remaining actions still fail closed', async () => {
  const f = fixture({ permissions: ['incident.create', 'incident.resolve', 'incident.resolve.approve', 'rounding.approve',
    'payment.collect', 'payment.settle', 'procurement.create', 'handover', 'room.open'] });
  for (const action of [ 'open']) {
    await assert.rejects(f.app.execute({ ...incidentCommand(action), action }, f.credential), e => denied(e) && e.reason === (action==='open'?'missing-permission':'trusted-action-not-enabled'));
  }
  await unchanged(f);
});
