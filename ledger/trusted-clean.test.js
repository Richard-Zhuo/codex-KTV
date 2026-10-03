import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { cleanRoom } from '../rooms.js';
import { PERMISSION_IDS, AuthorizationDenied } from '../shared/identity.js';
import { BusinessRejection } from '../shared/business-error.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { createLedgerApplication, createTrustedLedgerApplication } from './application.js';
import { FORMAL_COMMAND_ACTIONS, DEMO_ONLY_ACTIONS } from './command-policy.js';
import { TRUSTED_ENABLED_ACTIONS } from './trusted-execution.js';

const dbNow = '2026-10-03T12:00:00.123456Z';
const request = (key = 'clean-1', revision = 0, payload = { room: 'V01' }, action = 'clean') =>
  ({ operationKey: key, expectedRevision: revision, action, payload });
const denied = error => error instanceof AuthorizationDenied &&
  error.status === 'authorization-denied' && !(error instanceof BusinessRejection);
const authenticationRequired = error => error.code === 'AUTHENTICATION_REQUIRED';

function fixture({ permissions = ['room.clean'], transactCommand = transact } = {}) {
  const state = initialState();
  state.user = 'not-a-demo-account';
  state.clock = 'not-a-business-clock';
  state.permissions = { administrator: ['administrator'] };
  state.capabilities = { administrator: ['*'] };
  state.administrator = true;
  state.rooms[0].status = state.rooms[1].status = '待清洁';
  state.inventory.bw.count = 0;
  state.orders.push({ id: 'historical-retail', kind: 'retail', room: null,
    sales: [{ productNameSnapshot: 'historical-name', pricePerSaleUnitCents: null }],
    payments: [{ method: '现金', amount: 100 }, { method: '微信', amount: 200 }] });
  const memory = createMemoryLedgerStore(state, { ledgerId: 'trusted-unit' });
  const tokenDigest = Buffer.alloc(32, 7);
  const auth = { principalId: 'synthetic-actor', permissions, enabled: true, revoked: false,
    credentialVersion: 1, sessionVersion: 1, idleExpiresAt: '2099-01-01T00:00:00.000000Z',
    absoluteExpiresAt: '2099-01-02T00:00:00.000000Z' };
  const events = [];
  let latestContext, executions = 0;
  const port = {
    locateSessionByDigest: async () => ({ principalId: auth.principalId, sessionId: 'synthetic-session' }),
    lockAccount: async () => { events.push('account'); return { principalId: auth.principalId,
      enabled: auth.enabled, credentialVersion: auth.credentialVersion }; },
    lockSessionById: async () => { events.push('session'); return { principalId: auth.principalId,
      sessionId: 'synthetic-session', tokenDigest, revoked: auth.revoked,
      credentialVersion: auth.sessionVersion, idleExpiresAt: auth.idleExpiresAt,
      absoluteExpiresAt: auth.absoluteExpiresAt }; },
    listGrants: async () => { events.push('grants'); return [...auth.permissions]; },
    readDbNow: async () => { events.push('db-now'); return dbNow; }
  };
  const store = { ledgerId: memory.ledgerId, read: memory.read, runAtomic: work =>
    memory.runAtomic(async tx => {
      events.push('head');
      const find = tx.findOperationResult;
      tx.findOperationResult = async key => { events.push('operation'); return find(key); };
      tx.sessionRevalidation = { async revalidateSessionInTransaction(credential) {
        latestContext = await revalidateSessionInTransaction({ port, ...credential });
        return latestContext;
      } };
      return work(tx);
    }) };
  const app = createTrustedLedgerApplication({ store, transactCommand: (...args) => {
    executions++; events.push('transact'); return transactCommand(...args);
  } });
  return { app, store, memory, auth, state, events, credential: { tokenDigest },
    context: () => latestContext, executions: () => executions };
}

async function emptyEffects(f) {
  const head = await f.memory.read();
  assert.deepEqual(head.state, f.state);
  assert.equal(head.revision, 0);
  assert.equal(head.operationResults.size, 0);
  assert.equal(head.audit.length, 0);
}

test('trusted clean uses session actor and frozen DB context; all demo facts are inert', async () => {
  const f = fixture();
  const result = await f.app.execute(request(), f.credential);
  assert.equal(result.status, 'committed');
  assert.equal(result.actorId, f.auth.principalId);
  assert.equal(result.revision, 1);
  assert.equal(result.committedAt, dbNow);
  const head = await f.memory.read();
  const expected = structuredClone(f.state);
  expected.rooms[0].status = '空闲'; expected.processed.push('clean-1');
  assert.deepEqual(head.state, expected);
  assert.equal(head.operationResults.get('clean-1').actorId, f.auth.principalId);
  assert.equal(head.audit[0].actorId, f.auth.principalId);
  assert.deepEqual(f.events, ['head', 'account', 'session', 'grants', 'db-now', 'operation', 'transact']);
  assert.equal(f.context().policyAttributesConfigured, false);
  assert.equal(f.context().policyAttributeIds, null);
});

test('trusted-enabled clean is independent from all other eligible and demo actions', async () => {
  assert.deepEqual(TRUSTED_ENABLED_ACTIONS, ['clean']);
  assert.equal(Object.isFrozen(TRUSTED_ENABLED_ACTIONS), true);
  for (const action of [...FORMAL_COMMAND_ACTIONS.filter(action => action !== 'clean'), ...DEMO_ONLY_ACTIONS, 'unknown']) {
    const f = fixture({ permissions: [...PERMISSION_IDS] });
    await assert.rejects(f.app.execute(request('blocked', 0, {}, action), f.credential),
      error => denied(error) && error.reason === 'trusted-action-not-enabled');
    await emptyEffects(f); assert.equal(f.executions(), 0);
  }
});

test('payload actor, role, permissions and clock cannot grant access or replace context', async () => {
  const forged = { room: 'V01', actorId: 'administrator', principalId: 'forged',
    permissions: ['*', 'room.clean'], role: 'administrator', clock: '1900-01-01' };
  const noGrant = fixture({ permissions: ['backend.view'] });
  await assert.rejects(noGrant.app.execute(request('forged', 0, forged), noGrant.credential), denied);
  await emptyEffects(noGrant);
  const allowed = fixture();
  const result = await allowed.app.execute(request('forged', 0, forged), allowed.credential);
  assert.equal(result.actorId, 'synthetic-actor');
  assert.equal(allowed.context().dbNow, dbNow);
  assert.deepEqual(allowed.context().permissionIds, ['room.clean']);
});

test('authorization denial leaves key reusable after a current grant is added', async () => {
  const f = fixture({ permissions: [] });
  await assert.rejects(f.app.execute(request(), f.credential), denied);
  await emptyEffects(f); assert.equal(f.executions(), 0);
  f.auth.permissions = ['room.clean'];
  assert.equal((await f.app.execute(request(), f.credential)).status, 'committed');
  assert.equal(f.executions(), 1);
});

test('permission revoke preserves original replay; only a new key checks current policy', async () => {
  const f = fixture();
  const first = await f.app.execute(request(), f.credential);
  f.auth.permissions = [];
  assert.deepEqual(await f.app.execute(request(), f.credential), first);
  await assert.rejects(f.app.execute(request('new-key', 1, { room: 'V02' }), f.credential), denied);
  const head = await f.memory.read();
  assert.equal(head.revision, 1); assert.equal(head.audit.length, 1);
  assert.equal(head.operationResults.has('new-key'), false); assert.equal(f.executions(), 1);
});

test('disabled, revoked, expired and rotated identities fail before existing-operation lookup', async () => {
  for (const patch of [{ enabled: false }, { revoked: true }, { idleExpiresAt: dbNow },
    { absoluteExpiresAt: dbNow }, { credentialVersion: 2 }]) {
    const f = fixture(); await f.app.execute(request(), f.credential);
    Object.assign(f.auth, patch); f.events.length = 0;
    await assert.rejects(f.app.execute(request(), f.credential), authenticationRequired);
    assert.equal(f.events.includes('operation'), false);
    assert.equal(f.executions(), 1);
    assert.equal((await f.memory.read()).revision, 1);
  }
});

test('saved actor and fingerprint conflicts precede fresh action authorization', async () => {
  const f = fixture(); await f.app.execute(request(), f.credential);
  f.auth.permissions = [];
  for (const changed of [request('clean-1', 1), request('clean-1', 0, { room: 'V02' })]) {
    const result = await f.app.execute(changed, f.credential);
    assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'request-mismatch');
  }
  f.auth.principalId = 'synthetic-other-actor';
  const result = await f.app.execute(request(), f.credential);
  assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'actor-mismatch');
  assert.equal(f.executions(), 1);
});

test('revision conflict and room-state rejection remain terminal after a grant is revoked', async () => {
  for (const command of [request('terminal', 3), request('terminal', 0, { room: 'V03' })]) {
    const f = fixture();
    const result = await f.app.execute(command, f.credential);
    assert.ok(['revision-conflict', 'business-rejected'].includes(result.status));
    f.auth.permissions = [];
    assert.deepEqual(await f.app.execute(command, f.credential), result);
    const head = await f.memory.read();
    assert.equal(head.revision, 0); assert.equal(head.audit.length, 0);
    assert.equal(head.operationResults.size, 1);
  }
});

test('unknown failure rolls back and repaired trusted clean can use the same key', async () => {
  let fault = true;
  const f = fixture({ transactCommand: (...args) => {
    if (fault) { args[0].rooms[0].status = '空闲'; throw Error('synthetic-program-failure'); }
    return transact(...args);
  } });
  await assert.rejects(f.app.execute(request(), f.credential), /synthetic-program-failure/);
  await emptyEffects(f); fault = false;
  assert.equal((await f.app.execute(request(), f.credential)).status, 'committed');
});

test('trusted entry refuses caller principal and extra authentication or command fields', async () => {
  const f = fixture();
  assert.throws(() => createTrustedLedgerApplication({ store: f.store, principal: { id: 'forged' } }), TypeError);
  assert.throws(() => createLedgerApplication({ store: f.store, executionMode: 'trusted', principal: { id: 'forged' } }), TypeError);
  await assert.rejects(f.app.execute({ ...request(), principalId: 'forged' }, f.credential), TypeError);
  await assert.rejects(f.app.execute(request(), { ...f.credential, permissions: ['*'] }), authenticationRequired);
  await assert.rejects(f.app.execute(request()), authenticationRequired);
  await emptyEffects(f);
});

test('missing revalidation or a JSON lookalike context never calls demo transact', async () => {
  const f = fixture();
  const absent = createTrustedLedgerApplication({ store: f.memory });
  await assert.rejects(absent.execute(request(), f.credential), /revalidation port/);
  for (const context of [null, Object.freeze({ mode: 'trusted', principalId: 'forged',
    permissionIds: ['room.clean'], dbNow })]) {
    const store = { ledgerId: f.memory.ledgerId, runAtomic: work => f.memory.runAtomic(tx => {
      tx.sessionRevalidation = { revalidateSessionInTransaction: async () => context }; return work(tx);
    }) };
    await assert.rejects(createTrustedLedgerApplication({ store }).execute(request(), f.credential));
  }
  await emptyEffects(f);
});

test('trusted transact and cleanRoom require a branded context, valid DB time and explicit mode', async () => {
  const f = fixture(); await f.app.execute(request(), f.credential);
  for (const context of [undefined, JSON.parse(JSON.stringify(f.context())),
    Object.freeze({ ...f.context(), dbNow: undefined })]) {
    assert.throws(() => transact(f.state, 'clean', { room: 'V01' }, 'direct', { mode: 'trusted', context }), TypeError);
    assert.throws(() => cleanRoom(f.state, f.state.rooms[0], { mode: 'trusted', context }), TypeError);
  }
  assert.throws(() => transact(f.state, 'open', {}, 'direct', { mode: 'trusted', context: f.context() }), denied);
  assert.throws(() => transact(f.state, 'clean', {}, 'direct', {}), TypeError);
  const noGrant = fixture({ permissions: [] });
  await assert.rejects(noGrant.app.execute(request(), noGrant.credential), denied);
  assert.throws(() => cleanRoom(noGrant.state, noGrant.state.rooms[0], { mode: 'trusted', context: noGrant.context() }), denied);
  for (const status of ['空闲', '营业中', '故障', '维护中', '预约']) {
    const original = structuredClone(f.state); original.rooms[0].status = status;
    assert.throws(() => transact(original, 'clean', { room: 'V01' }, 'direct',
      { mode: 'trusted', context: f.context() }), BusinessRejection);
    assert.equal(original.rooms[0].status, status);
  }
  const demo = initialState(); demo.user = 'staff'; demo.rooms[0].status = '待清洁';
  assert.deepEqual(transact(demo, 'clean', { room: 'V01' }, 'demo'),
    transact(demo, 'clean', { room: 'V01' }, 'demo', { mode: 'demo' }));
});
