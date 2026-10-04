import test from 'node:test';
import assert from 'node:assert/strict';
import { revalidateSessionInTransaction, assertTrustedExecutionContext,
  requireConfiguredPolicyAttributes } from './session-revalidation.js';
import { createMySqlAuthStore } from './mysql-store.js';
import { createMemoryLedgerStore } from '../ledger/memory-store.js';
import { createLedgerApplication } from '../ledger/application.js';
import { createTrustedPrincipal, authorizeCommand } from '../ledger/command-policy.js';
import { BusinessRejection } from '../shared/business-error.js';

const dbNow = '2026-10-03T08:00:00.123456Z';
const tokenDigest = Buffer.alloc(32, 7);
function fixture() {
  const calls = [];
  const account = { principalId: 'synthetic-a', enabled: true, credentialVersion: '1', policyAttributesConfigured: false };
  const session = { principalId: account.principalId, sessionId: 'synthetic-session',
    tokenDigest, credentialVersion: '1', revoked: false,
    idleExpiresAt: '2026-10-03T09:00:00.000000Z',
    absoluteExpiresAt: '2026-10-03T12:00:00.000000Z' };
  const current = { grants: ['room.clean'], attributes: [], now: dbNow };
  const port = {
    async locateSessionByDigest() { calls.push('locate'); return {
      principalId: account.principalId, sessionId: 'synthetic-session' }; },
    async lockAccount(id) { calls.push('account:' + id); return account; },
    async lockSessionById(id) { calls.push('session:' + id); return session; },
    async listGrants(id) { calls.push('grants:' + id); return [...current.grants]; },
    async listPolicyAttributes(id) { calls.push('attributes:' + id); return [...current.attributes]; },
    async readDbNow() { calls.push('dbNow'); return current.now; }
  };
  return { port, account, session, calls, current,
    revalidate: () => revalidateSessionInTransaction({ port, tokenDigest }) };
}

test('revalidation locks account then session then current grants and freezes one DB time', async () => {
  const f = fixture();
  const context = await f.revalidate();
  assert.deepEqual(f.calls, ['locate', 'account:synthetic-a', 'session:synthetic-session',
    'grants:synthetic-a', 'attributes:synthetic-a', 'dbNow']);
  assert.equal(context.principalId, f.account.principalId);
  assert.equal(context.sessionId, f.session.sessionId);
  assert.equal(context.dbNow, dbNow);
  assert.deepEqual(context.permissionIds, ['room.clean']);
  assert.equal(authorizeCommand({ principal: context.principal, action: 'clean' }).allowed, true);
  assert.equal(assertTrustedExecutionContext(context), context);
  assert.ok(Object.isFrozen(context) && Object.isFrozen(context.permissionIds));
  assert.equal(context.actorSnapshot, null);
  assert.equal(context.policyAttributesConfigured, false);
  assert.equal(context.policyAttributeIds, null);
  assert.throws(() => requireConfiguredPolicyAttributes(context),
    error => error.code === 'AUTH_POLICY_ATTRIBUTES_UNCONFIGURED');
  assert.throws(() => assertTrustedExecutionContext({ ...context }), /可信/);
  assert.throws(() => assertTrustedExecutionContext(null), /可信/);
  assert.throws(() => authorizeCommand({ principal: JSON.parse(JSON.stringify(context.principal)),
    action: 'clean' }), /可信/);
});

test('nonlocking locator is not authentication; locked identity and digest must match again', async t => {
  for (const [name, mutate] of [
    ['account mismatch', f => { f.port.lockAccount = async () => ({ ...f.account, principalId: 'other' }); }],
    ['session principal mismatch', f => { f.session.principalId = 'other'; }],
    ['session ID mismatch', f => { f.session.sessionId = 'other'; }],
    ['digest mismatch', f => { f.session.tokenDigest = Buffer.alloc(32, 8); }],
    ['missing account', f => { f.port.lockAccount = async () => null; }],
    ['missing session', f => { f.port.lockSessionById = async () => null; }]
  ]) {
    await t.test(name, async () => {
      const f = fixture(); mutate(f);
      assert.equal(await f.revalidate(), null);
      assert.ok(!f.calls.includes('dbNow'));
    });
  }
  assert.equal(await revalidateSessionInTransaction({ port: {}, tokenDigest: null }), null);
});

test('disabled, revoked and credential mismatch cannot mint trusted context', async t => {
  for (const [name, mutate] of [
    ['disabled', f => { f.account.enabled = false; }],
    ['revoked', f => { f.session.revoked = true; }],
    ['credential version', f => { f.session.credentialVersion = '2'; }]
  ]) {
    await t.test(name, async () => {
      const f = fixture(); mutate(f);
      assert.equal(await f.revalidate(), null);
      assert.ok(!f.calls.some(call => call.startsWith('grants:')));
    });
  }
});

test('idle and absolute expiry use the same UTC microsecond boundary', async () => {
  for (const expiry of ['idleExpiresAt', 'absoluteExpiresAt']) {
    const f = fixture();
    f.session[expiry] = dbNow;
    assert.equal(await f.revalidate(), null);
    assert.equal(f.calls.filter(call => call === 'dbNow').length, 1);
    f.session[expiry] = '2026-10-03T08:00:00.123457Z';
    assert.ok(await f.revalidate()); // One microsecond later, not truncated to Date milliseconds.
  }
  const f = fixture();
  f.current.now = 'not-a-database-time';
  await assert.rejects(f.revalidate(), /UTC/);
});

test('each revalidation uses current grants and never request permissions or roles', async () => {
  const f = fixture();
  const context = await f.revalidate();
  f.current.grants = [];
  const next = await revalidateSessionInTransaction({
    port: f.port, tokenDigest, permissions: ['*'], role: 'administrator', actorId: 'forged'
  });
  assert.deepEqual(next.permissionIds, []);
  assert.equal(next.principalId, f.account.principalId);
  assert.equal(authorizeCommand({ principal: next.principal, action: 'clean' }).allowed, false);
  assert.deepEqual(context.permissionIds, ['room.clean']);
});

function mysqlFixture(active = true) {
  const f = fixture();
  const calls = [];
  const connection = {
    async execute(sql) {
      calls.push(sql);
      if (sql === 'DO 0') return [{ serverStatus: active ? 3 : 2 }];
      if (sql.startsWith('SELECT session_id, principal_id FROM')) {
        return [[{ session_id: f.session.sessionId, principal_id: f.account.principalId }]];
      }
      if (sql.includes('FROM `auth_unit`.`auth_accounts`')) {
        return [[{ principal_id: f.account.principalId, enabled: 1, credential_version: '1', policy_attributes_configured: 0 }]];
      }
      if (sql.includes('FROM `auth_unit`.`auth_sessions`')) {
        return [[{ session_id: f.session.sessionId, principal_id: f.account.principalId,
          token_digest: tokenDigest, credential_version: '1', revoked_at: null,
          idle_expiry: f.session.idleExpiresAt, absolute_expiry: f.session.absoluteExpiresAt }]];
      }
      if (sql.includes('FROM `auth_unit`.`auth_grants`')) return [[{ permission_id: 'room.clean' }]];
      if (sql.includes('FROM `auth_unit`.`auth_policy_attributes`')) return [[]];
      if (sql.includes('AS db_now')) return [[{ db_now: dbNow }]];
      throw Error('unexpected test SQL');
    },
    beginTransaction() { assert.fail('port must not BEGIN'); },
    commit() { assert.fail('port must not COMMIT'); },
    rollback() { assert.fail('port must not ROLLBACK'); },
    release() { assert.fail('port must not release'); }
  };
  const store = createMySqlAuthStore({
    pool: { getConnection() { assert.fail('port must not borrow a connection'); } },
    database: 'auth_unit'
  });
  return { calls, capability: store.bindSessionRevalidation(connection) };
}

test('MySQL binding uses only caller connection, current reads and no activity or lifecycle writes', async () => {
  const f = mysqlFixture();
  assert.ok(await f.capability.revalidateSessionInTransaction({ tokenDigest }));
  const locked = f.calls.filter(sql => sql.includes('FOR UPDATE'));
  assert.ok(locked[0].includes('auth_accounts'));
  assert.ok(locked[1].includes('auth_sessions'));
  assert.ok(locked[2].includes('auth_grants'));
  assert.match(locked[2], /ORDER BY permission_id FOR UPDATE$/);
  assert.ok(locked[3].includes('auth_policy_attributes'));
  assert.match(locked[3], /ORDER BY attribute_id FOR UPDATE$/);
  assert.equal(f.calls.filter(sql => sql.includes('AS db_now')).length, 1);
  assert.ok(f.calls.every(sql => sql.startsWith('SELECT ') || sql === 'DO 0'));
});

test('binding refuses autocommit and propagates SQL failure without owning rollback', async () => {
  const f = mysqlFixture(false);
  await assert.rejects(f.capability.revalidateSessionInTransaction({ tokenDigest }), /事务/);
  assert.deepEqual(f.calls, ['DO 0']);
  const failure = Error('unknown SQL failure');
  const store = createMySqlAuthStore({ database: 'auth_unit',
    pool: { getConnection() { assert.fail('no pool borrowing'); } } });
  const capability = store.bindSessionRevalidation({ async execute() { throw failure; } });
  await assert.rejects(capability.revalidateSessionInTransaction({ tokenDigest }),
    error => error === failure);
});

// Test-only next-stage ordering composition; it does not wire a production domain action.
function replayFixture() {
  const auth = fixture();
  const store = createMemoryLedgerStore({ processed: [], effects: 0 }, { ledgerId: 'replay-contract' });
  const sequence = [];
  let executions = 0;
  async function execute(command, authFixture = auth) {
    const principal = createTrustedPrincipal({ id: authFixture.account.principalId });
    const gatedStore = { ledgerId: store.ledgerId, runAtomic: work => store.runAtomic(async tx => {
      const context = await authFixture.revalidate();
      sequence.push('session');
      if (!context) throw Object.assign(Error('invalid-session'), { code: 'invalid-session' });
      assert.equal(principal.id, context.principalId);
      return work({ ...tx, async findOperationResult(key) {
        sequence.push('operation');
        const saved = await tx.findOperationResult(key);
        if (!saved) {
          sequence.push('permission');
          if (!authorizeCommand({ principal: context.principal, action: command.action }).allowed) {
            throw Object.assign(Error('forbidden'), { code: 'forbidden' });
          }
        }
        return saved;
      } });
    }) };
    return createLedgerApplication({ store: gatedStore, principal, now: () => dbNow,
      transactCommand(state, action, payload, key) {
        executions++;
        if (payload.reject) throw new BusinessRejection('synthetic expected rejection');
        return { ...state, effects: state.effects + 1, processed: [...state.processed, key] };
      }
    }).execute(command);
  }
  return { auth, store, sequence, execute, executions: () => executions };
}
const command = (key, expectedRevision = 0, payload = {}) => ({
  operationKey: key, expectedRevision, action: 'clean', payload
});

test('replay contract: grant loss preserves original terminal result, new key needs current grant', async () => {
  const f = replayFixture();
  const original = await f.execute(command('original'));
  assert.equal(original.status, 'committed');
  f.auth.current.grants = [];
  f.sequence.length = 0;
  assert.deepEqual(await f.execute(command('original')), original);
  assert.deepEqual(f.sequence, ['session', 'operation']);
  assert.equal(f.executions(), 1);
  await assert.rejects(f.execute(command('new', 1)), error => error.code === 'forbidden');
  assert.equal((await f.store.read()).revision, 1);
  assert.equal((await f.store.read()).operationResults.size, 1);
  assert.equal((await f.execute(command('original', 0, { changed: true }))).reason, 'request-mismatch');
  const other = fixture(); other.account.principalId = 'synthetic-b';
  other.session.principalId = 'synthetic-b'; other.current.grants = [];
  assert.equal((await f.execute(command('original'), other)).reason, 'actor-mismatch');
});

test('replay contract: disabled, revoked or expired sessions fail before operation lookup', async t => {
  for (const [name, invalidate] of [
    ['disabled', f => { f.auth.account.enabled = false; }],
    ['revoked', f => { f.auth.session.revoked = true; }],
    ['idle expiry', f => { f.auth.session.idleExpiresAt = dbNow; }],
    ['absolute expiry', f => { f.auth.session.absoluteExpiresAt = dbNow; }]
  ]) {
    await t.test(name, async () => {
      const f = replayFixture();
      await f.execute(command('original'));
      invalidate(f); f.sequence.length = 0;
      await assert.rejects(f.execute(command('original')), error => error.code === 'invalid-session');
      assert.deepEqual(f.sequence, ['session']);
      assert.equal(f.executions(), 1);
      assert.equal((await f.store.read()).revision, 1);
    });
  }
});

test('replay contract preserves success, revision conflict and business rejection after grant loss', async () => {
  const f = replayFixture();
  const requests = [command('stale', 1), command('rejected', 0, { reject: true }), command('success')];
  const results = [];
  for (const request of requests) results.push(await f.execute(request));
  assert.deepEqual(results.map(result => result.status),
    ['revision-conflict', 'business-rejected', 'committed']);
  f.auth.current.grants = [];
  for (let index = 0; index < requests.length; index++) {
    assert.deepEqual(await f.execute(requests[index]), results[index]);
  }
  const data = await f.store.read();
  assert.equal(data.revision, 1);
  assert.equal(data.state.effects, 1);
  assert.equal(data.audit.length, 1);
  assert.equal(data.operationResults.size, 3);
  assert.equal(f.executions(), 2); // One explicit rejection and one success, never a replay.
});


test('configured attributes are immutable DB facts in principal/context; empty differs from unconfigured', async () => {
  const f = fixture(); f.account.policyAttributesConfigured = true;
  const empty = await f.revalidate();
  assert.equal(empty.policyAttributesConfigured, true);
  assert.deepEqual(empty.policyAttributeIds, []);
  assert.equal(requireConfiguredPolicyAttributes(empty), empty.policyAttributeIds);
  f.current.attributes = ['rounding.self.excess'];
  const granted = await revalidateSessionInTransaction({ port: f.port, tokenDigest,
    policyAttributeIds: ['forged'], role: 'administrator' });
  assert.deepEqual(granted.policyAttributeIds, ['rounding.self.excess']);
  assert.equal(granted.policyAttributeIds, granted.principal.policyAttributeIds);
  assert.ok(Object.isFrozen(granted.policyAttributeIds));
  f.current.attributes = [];
  assert.deepEqual((await f.revalidate()).policyAttributeIds, []);
  assert.deepEqual(granted.policyAttributeIds, ['rounding.self.excess']);
});

test('missing/corrupt configuration and attributes fail closed without inventing role attributes', async () => {
  for (const mutate of [f => { delete f.account.policyAttributesConfigured; },
    f => { f.account.policyAttributesConfigured = null; },
    f => { f.current.attributes = ['rounding.self.excess']; },
    f => { f.account.policyAttributesConfigured = true; f.current.attributes = ['unknown.attribute']; }]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.revalidate());
  }
});
