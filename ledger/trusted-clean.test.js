import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { cleanRoom, markRoomIssue, clearRoomIssue, cancelReservation } from '../rooms.js';
import { submitDeposit, withdrawDeposit } from '../deposits.js';
import { DEPOSIT_TEST_ACTIONS, depositTestPayload, seedStoredDeposits, invalidDepositPayloads } from '../test-support/trusted-deposits-fixture.js';
import { PERMISSION_IDS, AuthorizationDenied } from '../shared/identity.js';
import { BusinessRejection } from '../shared/business-error.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { createLedgerApplication, createTrustedLedgerApplication } from './application.js';
import { FORMAL_COMMAND_ACTIONS, DEMO_ONLY_ACTIONS } from './command-policy.js';
import { TRUSTED_ENABLED_ACTIONS } from './trusted-execution.js';
import { CATALOG_TEST_ACTIONS, catalogTestPayload, seedCatalogHistory, invalidCatalogPayloads } from '../test-support/trusted-catalog-fixture.js';

const dbNow = '2026-10-03T12:00:00.123456Z';
const request = (key = 'clean-1', revision = 0, payload = { room: 'V01' }, action = 'clean') =>
  ({ operationKey: key, expectedRevision: revision, action, payload });
const denied = error => error instanceof AuthorizationDenied &&
  error.status === 'authorization-denied' && !(error instanceof BusinessRejection);
const authenticationRequired = error => error.code === 'AUTHENTICATION_REQUIRED';

function fixture({ permissions = ['room.clean'], transactCommand = transact, setup = () => {} } = {}) {
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
  setup(state);
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

test('trusted-enabled commands are independent from all other eligible and demo actions', async () => {
  assert.deepEqual(TRUSTED_ENABLED_ACTIONS, ['clean', 'markRoomIssue', 'clearRoomIssue',
    'createCatalogProduct', 'updateCatalogProduct', 'updateCatalogPackage', 'cancelReservation', 'deposit', 'withdraw', 'reserve', 'sale', 'retailSale', 'serveExtra', 'otherCharge', 'exchange',
    'approveRoomIssue', 'rejectRoomIssue', 'stock', 'consumableStock', 'approveInventory', 'rejectInventory']);
  assert.equal(Object.isFrozen(TRUSTED_ENABLED_ACTIONS), true);
  for (const action of [...FORMAL_COMMAND_ACTIONS.filter(action => !TRUSTED_ENABLED_ACTIONS.includes(action)), ...DEMO_ONLY_ACTIONS, 'unknown']) {
    const f = fixture({ permissions: [...PERMISSION_IDS] });
    await assert.rejects(f.app.execute(request('blocked', 0, {}, action), f.credential),
      error => denied(error) && error.reason === 'trusted-action-not-enabled');
    await emptyEffects(f); assert.equal(f.executions(), 0);
    assert.throws(() => transact(f.state, action, {}, 'blocked', { mode: 'trusted', context: f.context() }), denied);
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

// Stage 2C.3 first batch: two submissions, no trusted review/approval commands.
const issueActions = ['markRoomIssue', 'clearRoomIssue'];
const issuePayload = action => ({ room: 'V01', ...(action === 'markRoomIssue' ? { issueType: '维护中' } : {}), evidenceText: 'synthetic repair evidence' });
function issueFixture(action, { setup = () => {}, permissions = ['room.issue'], ...options } = {}) {
  return fixture({ ...options, permissions, setup: state => {
    if (action === 'clearRoomIssue') {
      state.rooms[0].status = '故障/维护中'; state.rooms[0].issueType = '维护中';
      state.rooms[0].issueBy = 'unknown historical name'; state.rooms[0].issueAt = 'unknown historical time';
    }
    setup(state);
  } });
}

for (const action of issueActions) {
  test(action + ': trusted submission uses only session actor, room.issue and frozen DB time', async () => {
    const f = issueFixture(action);
    const payload = { ...issuePayload(action), actorId: 'administrator', principalId: 'fake',
      user: 'fake', permissions: ['*'], role: 'administrator', clock: '1900-01-01',
      person: 'fake', submittedById: 'fake', submittedByPrincipalId: 'fake' };
    const first = await f.app.execute(request('issue-first', 0, payload, action), f.credential);
    assert.equal(first.status, 'committed'); assert.equal(first.actorId, f.auth.principalId);
    assert.equal(first.revision, 1); assert.deepEqual(f.context().permissionIds, ['room.issue']);
    const head = await f.memory.read(), submission = head.state.roomIssueReviews.at(-1);
    assert.equal(submission.submittedBy, f.auth.principalId);
    assert.equal(submission.submittedByPrincipalId, f.auth.principalId);
    assert.equal(submission.submittedById, '', 'never guess a legacy demo ID');
    assert.equal(submission.submittedAt, dbNow);
    assert.equal(submission.status, action === 'markRoomIssue' ? '无需审核' : '待审核');
    if (action === 'markRoomIssue') {
      assert.equal(head.state.rooms[0].status, '故障/维护中');
      assert.equal(head.state.rooms[0].issueBy, f.auth.principalId);
      assert.equal(head.state.rooms[0].issueAt, dbNow); assert.equal(submission.decidedAt, dbNow);
    } else {
      assert.deepEqual(head.state.rooms[0], f.state.rooms[0], 'restore submission does not clear or approve room');
      assert.equal(submission.decidedAt, '');
    }
    assert.equal(head.audit[0].actorId, f.auth.principalId);
    assert.deepEqual(head.state.orders, f.state.orders); assert.deepEqual(head.state.inventory, f.state.inventory);
    for (const field of ['user', 'clock', 'permissions', 'capabilities', 'administrator']) assert.deepEqual(head.state[field], f.state[field]);
  });

  test(action + ': backend/review permission and forged request cannot authorize; denied key remains reusable', async () => {
    const f = issueFixture(action, { permissions: ['backend.view', 'room.issue.approve'] });
    const cmd = request('issue-denied', 0, { ...issuePayload(action), permissions: ['room.issue'], role: 'administrator' }, action);
    await assert.rejects(f.app.execute(cmd, f.credential), denied); await emptyEffects(f);
    assert.equal(f.executions(), 0);
    f.auth.permissions = ['room.issue'];
    assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed');
    assert.equal(f.executions(), 1);
  });

  test(action + ': revoked grant preserves old terminal and actor/fingerprint conflicts; new key is denied', async () => {
    const f = issueFixture(action), cmd = request('issue-replay', 0, issuePayload(action), action);
    const first = await f.app.execute(cmd, f.credential), before = await f.memory.read();
    f.auth.permissions = [];
    assert.deepEqual(await f.app.execute(cmd, f.credential), first);
    for (const changed of [ { ...cmd, expectedRevision: 1 }, { ...cmd, payload: { ...cmd.payload, evidenceText: 'different' } },
      { ...cmd, action: action === 'markRoomIssue' ? 'clearRoomIssue' : 'markRoomIssue' } ]) {
      const conflict = await f.app.execute(changed, f.credential);
      assert.equal(conflict.status, 'idempotency-conflict'); assert.equal(conflict.reason, 'request-mismatch');
    }
    f.auth.principalId = 'synthetic-other';
    const conflict = await f.app.execute(cmd, f.credential);
    assert.equal(conflict.status, 'idempotency-conflict'); assert.equal(conflict.reason, 'actor-mismatch');
    f.auth.principalId = first.actorId;
    await assert.rejects(f.app.execute({ ...cmd, operationKey: 'issue-new', expectedRevision: 1 }, f.credential), denied);
    assert.equal(f.executions(), 1); assert.deepEqual(await f.memory.read(), before);
  });

  test(action + ': disabled/revoked/expired/version-changed session cannot read a previous terminal', async () => {
    for (const change of [auth => { auth.enabled = false; }, auth => { auth.revoked = true; },
      auth => { auth.idleExpiresAt = dbNow; }, auth => { auth.absoluteExpiresAt = dbNow; },
      auth => { auth.credentialVersion++; }]) {
      const f = issueFixture(action), cmd = request('issue-private', 0, issuePayload(action), action);
      await f.app.execute(cmd, f.credential); const before = await f.memory.read();
      change(f.auth); await assert.rejects(f.app.execute(cmd, f.credential), authenticationRequired);
      assert.equal(f.executions(), 1); assert.deepEqual(await f.memory.read(), before);
    }
  });

  test(action + ': original evidence, room-state and pending-request rules remain business terminal rejections', async () => {
    const cases = [
      { payload: { ...issuePayload(action), room: 'missing' } },
      { payload: { ...issuePayload(action), evidenceText: '' } },
      { payload: { ...issuePayload(action), evidencePhoto: 'not-an-image' } },
      { setup: state => { state.roomIssueReviews.push({ id: 99, room: 'V01', status: '待审核' }); } },
      { setup: state => { state.rooms[0].status = action === 'markRoomIssue' ? '营业中' : '空闲'; } }
    ];
    if (action === 'markRoomIssue') cases.push({ payload: { ...issuePayload(action), issueType: 'invalid' } });
    for (const item of cases) {
      const f = issueFixture(action, { setup: item.setup }), cmd = request('issue-business', 0, item.payload || issuePayload(action), action);
      const result = await f.app.execute(cmd, f.credential);
      assert.equal(result.status, 'business-rejected');
      const head = await f.memory.read(); assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0);
      assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 0);
      f.auth.permissions = []; assert.deepEqual(await f.app.execute(cmd, f.credential), result);
      assert.deepEqual(await f.memory.read(), head);
    }
  });

  test(action + ': domain entry rejects missing/copied context and ignores caller person/time in trusted mode', async () => {
    const f = issueFixture(action), fn = action === 'markRoomIssue' ? markRoomIssue : clearRoomIssue;
    await f.app.execute(request('context', 0, issuePayload(action), action), f.credential);
    for (const context of [null, structuredClone(f.context())]) {
      assert.throws(() => fn(f.state, f.state.rooms[0], issuePayload(action), 'fake', 'fake', { mode: 'trusted', context }), TypeError);
      assert.throws(() => transact(f.state, action, issuePayload(action), 'direct', { mode: 'trusted', context }), TypeError);
    }
    const state = structuredClone(f.state);
    fn(state, state.rooms[0], issuePayload(action), 'fake', 'fake', { mode: 'trusted', context: f.context() });
    assert.equal(state.roomIssueReviews.at(-1).submittedByPrincipalId, f.auth.principalId);
    assert.equal(state.roomIssueReviews.at(-1).submittedAt, dbNow);
    const noGrant = issueFixture(action, { permissions: [] });
    await assert.rejects(noGrant.app.execute(request('context', 0, issuePayload(action), action), noGrant.credential), denied);
    assert.throws(() => fn(noGrant.state, noGrant.state.rooms[0], issuePayload(action), 'fake', 'fake',
      { mode: 'trusted', context: noGrant.context() }), denied);
  });
}

// Stage 2C.3 catalog batch: original mutations, session-only authority.
for (const action of CATALOG_TEST_ACTIONS) {
  const makeFixture = (options = {}) => fixture({ permissions: ['catalog.manage'], setup: seedCatalogHistory, ...options });
  test(action + ': trusted authority ignores demo/payload facts and preserves original catalog/history semantics', async () => {
    const f = makeFixture(), payload = { ...catalogTestPayload(action), actorId: 'administrator', principalId: 'fake',
      permissions: ['*'], role: 'administrator', user: 'fake', clock: '1900-01-01', person: 'fake' };
    const result = await f.app.execute(request('catalog-first', 0, payload, action), f.credential);
    assert.equal(result.status, 'committed'); assert.equal(result.actorId, f.auth.principalId); assert.equal(result.revision, 1);
    assert.equal(result.committedAt, dbNow); assert.equal(f.context().dbNow, dbNow);
    assert.deepEqual(f.context().permissionIds, ['catalog.manage']);
    const head = await f.memory.read();
    const demo = structuredClone(f.state); demo.user = 'administrator'; demo.clock = dbNow;
    const expected = transact(demo, action, payload, 'catalog-first'); expected.user = f.state.user; expected.clock = f.state.clock;
    assert.deepEqual(head.state, expected, 'same domain behavior in both modes');
    assert.deepEqual(head.state.orders, f.state.orders, 'known and unknown historical facts are immutable');
    assert.equal(head.state.orders[1].room, null); assert.equal(head.state.inventory.bw.count, 0); assert.equal(head.state.inventory.qd.count, null);
    if (action === 'createCatalogProduct') assert.deepEqual(head.state.inventory.synthetic_pack, { count: null, threshold: 10, unit: '包' });
    else assert.deepEqual(head.state.inventory, f.state.inventory);
    assert.equal(head.audit[0].actorId, f.auth.principalId); assert.equal(head.audit[0].action, action);
  });

  test(action + ': backend.view and forged permissions do not authorize; denied key remains available', async () => {
    const f = makeFixture({ permissions: ['backend.view'] }), cmd = request('catalog-denied', 0,
      { ...catalogTestPayload(action), permissions: ['catalog.manage'], role: 'administrator' }, action);
    await assert.rejects(f.app.execute(cmd, f.credential), denied); await emptyEffects(f); assert.equal(f.executions(), 0);
    f.auth.permissions = ['catalog.manage'];
    assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed'); assert.equal(f.executions(), 1);
  });

  test(action + ': replay after revoke is unchanged; new key denied; actor/request/revision conflicts preserved', async () => {
    const f = makeFixture(), cmd = request('catalog-replay', 0, catalogTestPayload(action), action);
    const first = await f.app.execute(cmd, f.credential), before = await f.memory.read(); f.auth.permissions = [];
    assert.deepEqual(await f.app.execute(cmd, f.credential), first);
    for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, payload: { ...cmd.payload, name: 'changed' } }]) {
      const result = await f.app.execute(changed, f.credential);
      assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'request-mismatch');
    }
    f.auth.principalId = 'synthetic-other';
    const other = await f.app.execute(cmd, f.credential); assert.equal(other.status, 'idempotency-conflict'); assert.equal(other.reason, 'actor-mismatch');
    f.auth.principalId = first.actorId;
    await assert.rejects(f.app.execute({ ...cmd, operationKey: 'new', expectedRevision: 1 }, f.credential), denied);
    assert.equal(f.executions(), 1); assert.deepEqual(await f.memory.read(), before);
  });

  test(action + ': original invalid ID/name/spec/price rules reject atomically as persistent business terminals', async () => {
    for (const payload of invalidCatalogPayloads(action)) {
      const f = makeFixture(), cmd = request('catalog-business', 0, payload, action);
      const result = await f.app.execute(cmd, f.credential); assert.equal(result.status, 'business-rejected');
      const head = await f.memory.read(); assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0);
      assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 0);
      f.auth.permissions = []; assert.deepEqual(await f.app.execute(cmd, f.credential), result);
      assert.deepEqual(await f.memory.read(), head);
    }
  });

  test(action + ': direct trusted transact requires real context and current catalog.manage; no demo fallback', async () => {
    const f = makeFixture(); await f.app.execute(request('context', 0, catalogTestPayload(action), action), f.credential);
    for (const context of [null, structuredClone(f.context())]) assert.throws(() =>
      transact(f.state, action, catalogTestPayload(action), 'direct', { mode: 'trusted', context }), TypeError);
    const noGrant = makeFixture({ permissions: [] });
    await assert.rejects(noGrant.app.execute(request('context', 0, catalogTestPayload(action), action), noGrant.credential), denied);
    assert.throws(() => transact(noGrant.state, action, catalogTestPayload(action), 'direct',
      { mode: 'trusted', context: noGrant.context() }), denied);
  });
}

// Stage 2C.3: cancellation consumes trusted permission/time, with no employee mapping.
const reservationTime = hours => new Date(Date.parse(dbNow) + hours * 3600000).toISOString();
const cancelRequest = (key = 'cancel-1', revision = 0, payload = { room: 'V01', id: 101 }) =>
  request(key, revision, payload, 'cancelReservation');
function cancelFixture({ setup = () => {}, permissions = ['room.reserve'], ...options } = {}) {
  return fixture({ ...options, permissions, setup: state => {
    state.rooms[0].status = '已预订';
    state.reservations = [
      { id: 101, room: 'V01', at: reservationTime(-1), session: 'night', status: '已预订',
        person: 'unknown historical employee', employeeId: 'unmapped-demo-id', recordedBy: 'original recorder',
        source: '线下', note: 'original reservation' },
      { id: 102, room: 'V02', at: reservationTime(24), session: 'afternoon', status: '已预订' },
      { id: 103, room: 'V01', at: reservationTime(-24), session: 'night', status: '已取消' }
    ];
    setup(state);
  } });
}

test('cancelReservation: session actor and permission cancel only the selected booking; demo/payload facts stay inert', async () => {
  const f = cancelFixture(), payload = { room: 'V01', id: 101, actorId: 'administrator',
    principalId: 'forged', user: 'forged', person: 'forged', employee: 'forged',
    permissions: ['*'], role: 'administrator', clock: '1900-01-01' };
  const result = await f.app.execute(cancelRequest('cancel-first', 0, payload), f.credential);
  assert.equal(result.status, 'committed'); assert.equal(result.actorId, f.auth.principalId);
  assert.equal(result.revision, 1); assert.deepEqual(f.context().permissionIds, ['room.reserve']);
  const head = await f.memory.read(), expected = structuredClone(f.state);
  expected.reservations[0].status = '已取消'; expected.rooms[0].status = '空闲'; expected.processed.push('cancel-first');
  assert.deepEqual(head.state, expected); assert.equal(head.audit[0].actorId, f.auth.principalId);
  assert.equal(head.operationResults.get('cancel-first').actorId, f.auth.principalId);
  assert.deepEqual(f.events, ['head', 'account', 'session', 'grants', 'db-now', 'operation', 'transact']);
});

test('cancelReservation: backend/open permission and forged payload deny without occupying key; same key can follow a grant', async () => {
  const f = cancelFixture({ permissions: ['backend.view', 'room.open'] });
  const cmd = cancelRequest('cancel-grant', 0, { room: 'V01', id: 101, actorId: 'administrator', permissions: ['room.reserve'] });
  await assert.rejects(f.app.execute(cmd, f.credential), denied); await emptyEffects(f); assert.equal(f.executions(), 0);
  f.auth.permissions = ['room.reserve'];
  assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed'); assert.equal(f.executions(), 1);
});

test('cancelReservation: revoke preserves old terminal; actor/payload/action/revision changes still conflict, new key is denied', async () => {
  const f = cancelFixture(), cmd = cancelRequest('cancel-replay');
  const first = await f.app.execute(cmd, f.credential), before = await f.memory.read();
  f.auth.permissions = [];
  assert.deepEqual(await f.app.execute(cmd, f.credential), first);
  for (const changed of [{ ...cmd, payload: { ...cmd.payload, id: 102 } },
    { ...cmd, expectedRevision: 1 }, { ...cmd, action: 'reserve' }]) {
    const result = await f.app.execute(changed, f.credential);
    assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'request-mismatch');
  }
  f.auth.principalId = 'synthetic-other';
  const other = await f.app.execute(cmd, f.credential);
  assert.equal(other.status, 'idempotency-conflict'); assert.equal(other.reason, 'actor-mismatch');
  f.auth.principalId = first.actorId;
  await assert.rejects(f.app.execute({ ...cmd, operationKey: 'cancel-new', expectedRevision: 1 }, f.credential), denied);
  assert.equal(f.executions(), 1); assert.deepEqual(await f.memory.read(), before);
});

test('cancelReservation: disabled/revoked/idle/absolute/credential invalidation prevents terminal access', async () => {
  for (const change of [auth => { auth.enabled = false; }, auth => { auth.revoked = true; },
    auth => { auth.idleExpiresAt = dbNow; }, auth => { auth.absoluteExpiresAt = dbNow; },
    auth => { auth.credentialVersion++; }]) {
    const f = cancelFixture(), cmd = cancelRequest('cancel-private');
    await f.app.execute(cmd, f.credential); const before = await f.memory.read();
    change(f.auth); await assert.rejects(f.app.execute(cmd, f.credential), authenticationRequired);
    assert.equal(f.executions(), 1); assert.deepEqual(await f.memory.read(), before);
  }
});

test('cancelReservation: original room/booking/ambiguous-ID rejections leave state and revision unchanged', async () => {
  for (const item of [
    { payload: { room: 'missing', id: 101 } }, { payload: { room: 'V01', id: 999 } },
    { payload: { room: 'V01', id: 'not-a-number' } }, { payload: { room: 'V01', id: 102 } },
    { setup: state => { state.reservations[0].status = '已取消'; } },
    { setup: state => { state.reservations[0].status = '已到店'; } },
    ...[undefined, ''].map(id => ({ payload: { room: 'V01', ...(id === undefined ? {} : { id }) },
      setup: state => { state.reservations.push({ ...state.reservations[0], id: 104, at: reservationTime(24) }); } }))
  ]) {
    const f = cancelFixture({ setup: item.setup }), cmd = cancelRequest('cancel-business', 0, item.payload || { room: 'V01', id: 101 });
    const result = await f.app.execute(cmd, f.credential); assert.equal(result.status, 'business-rejected');
    const head = await f.memory.read(); assert.equal(head.revision, 0); assert.deepEqual(head.state, f.state);
    assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 0);
    f.auth.permissions = []; assert.deepEqual(await f.app.execute(cmd, f.credential), result);
    assert.deepEqual(await f.memory.read(), head);
  }
});

test('cancelReservation: omitted/empty ID selects only a unique pending booking, numeric ID remains compatible', async () => {
  for (const payload of [{ room: 'V01' }, { room: 'V01', id: '' }, { room: 'V01', id: '101' }]) {
    const f = cancelFixture();
    assert.equal((await f.app.execute(cancelRequest('cancel-select', 0, payload), f.credential)).status, 'committed');
    const head = await f.memory.read(); assert.equal(head.state.reservations[0].status, '已取消');
    assert.deepEqual(head.state.reservations.slice(1), f.state.reservations.slice(1));
  }
});

test('cancelReservation: original afternoon/night active-window boundaries use only frozen DB time', async () => {
  const cases = [
    ['afternoon', 0, true], ['afternoon', -3, true], ['afternoon', -4, false],
    ['afternoon', -4 + 1 / 3600000, true], ['afternoon', 1, false],
    ['night', 0, true], ['night', -5, true], ['night', -6, false],
    ['night', -6 + 1 / 3600000, true], ['night', 1, false]
  ];
  for (const [session, hours, active] of cases) {
    const f = cancelFixture({ setup: state => {
      state.clock = reservationTime(72);
      state.reservations.push({ id: 104, room: 'V01', at: reservationTime(hours), session, status: '已预订' });
    } });
    const result = await f.app.execute(cancelRequest('cancel-window', 0,
      { room: 'V01', id: 101, clock: reservationTime(-72) }), f.credential);
    assert.equal(result.status, 'committed'); assert.equal(f.context().dbNow, dbNow);
    const head = await f.memory.read();
    assert.equal(head.state.rooms[0].status, active ? '已预订' : '空闲', session + ' ' + hours);
    assert.equal(head.state.reservations[1].status, '已预订'); assert.equal(head.state.reservations.at(-1).status, '已预订');
  }
});

test('cancelReservation: other room states stay unchanged and non-pending bookings do not block release', async () => {
  for (const status of ['空闲', '营业中', '待清洁', '故障/维护中', '已预订']) {
    const f = cancelFixture({ setup: state => {
      state.rooms[0].status = status;
      state.reservations.push({ id: 104, room: 'V01', at: reservationTime(-1), session: 'night', status: '已到店' });
      state.reservations[1].at = reservationTime(-1);
    } });
    assert.equal((await f.app.execute(cancelRequest(), f.credential)).status, 'committed');
    const head = await f.memory.read(); assert.equal(head.state.rooms[0].status, status === '已预订' ? '空闲' : status);
    assert.deepEqual(head.state.orders, f.state.orders); assert.deepEqual(head.state.inventory, f.state.inventory);
    assert.deepEqual(head.state.roomIssueReviews, f.state.roomIssueReviews);
  }
});

test('cancelReservation: domain rejects missing/copied context, wrong mode and no grant without demo fallback', async () => {
  const f = cancelFixture(); await f.app.execute(cancelRequest('cancel-context'), f.credential);
  for (const context of [null, structuredClone(f.context())]) {
    assert.throws(() => cancelReservation(f.state, f.state.rooms[0], { id: 101 }, 'fake', { mode: 'trusted', context }), TypeError);
    assert.throws(() => transact(f.state, 'cancelReservation', { room: 'V01', id: 101 }, 'direct', { mode: 'trusted', context }), TypeError);
  }
  assert.throws(() => cancelReservation(f.state, f.state.rooms[0], { id: 101 }, dbNow, { mode: 'invalid' }), TypeError);
  const state = structuredClone(f.state);
  state.reservations.push({ id: 104, room: 'V01', at: reservationTime(-1), session: 'night', status: '已预订' });
  cancelReservation(state, state.rooms[0], { id: 101, clock: reservationTime(72) }, reservationTime(72), { mode: 'trusted', context: f.context() });
  assert.equal(state.rooms[0].status, '已预订', 'caller time must not replace context.dbNow');
  const noGrant = cancelFixture({ permissions: [] });
  await assert.rejects(noGrant.app.execute(cancelRequest(), noGrant.credential), denied);
  assert.throws(() => cancelReservation(noGrant.state, noGrant.state.rooms[0], { id: 101 }, dbNow,
    { mode: 'trusted', context: noGrant.context() }), denied);
});

test('cancelReservation: stale revision/business terminal never re-executes after later ledger changes or revoke', async () => {
  for (const status of ['revision-conflict', 'business-rejected']) {
    const f = cancelFixture(), cmd = cancelRequest('cancel-terminal', status === 'revision-conflict' ? 9 : 0,
      { room: 'V01', id: status === 'business-rejected' ? 999 : 101 });
    const first = await f.app.execute(cmd, f.credential); assert.equal(first.status, status);
    assert.equal((await f.app.execute(cancelRequest('cancel-later'), f.credential)).status, 'committed');
    const before = await f.memory.read(); f.auth.permissions = [];
    assert.deepEqual(await f.app.execute(cmd, f.credential), first); assert.deepEqual(await f.memory.read(), before);
    assert.equal(f.executions(), status === 'revision-conflict' ? 1 : 2);
  }
});

test('cancelReservation: unknown failure rolls back and the original key can retry after repair', async () => {
  let fail = true;
  const f = cancelFixture({ transactCommand: (...args) => {
    const next = transact(...args); if (fail) throw Error('synthetic unknown fault'); return next;
  } });
  await assert.rejects(f.app.execute(cancelRequest('cancel-fault'), f.credential), /synthetic unknown fault/);
  await emptyEffects(f); fail = false;
  assert.equal((await f.app.execute(cancelRequest('cancel-fault'), f.credential)).status, 'committed');
  assert.equal((await f.memory.read()).revision, 1);
});

// Stage 2C.3 storage batch: customer identity is data, operator identity is trusted.
for (const action of DEPOSIT_TEST_ACTIONS) {
  const makeFixture = (options = {}) => fixture({ permissions: ['deposit.manage'], setup: seedStoredDeposits, ...options });
  test(action + ': trusted actor/time ignore demo and payload identity; original storage mutations and history remain', async () => {
    const f = makeFixture(), payload = { ...depositTestPayload(action), actorId: 'administrator', principalId: 'fake',
      user: 'fake', person: 'fake', permissions: ['*'], role: 'administrator', clock: '1900-01-01', time: 'fake' };
    const result = await f.app.execute(request('storage-first', 0, payload, action), f.credential);
    assert.equal(result.status, 'committed'); assert.equal(result.actorId, f.auth.principalId); assert.equal(result.revision, 1);
    assert.deepEqual(f.context().permissionIds, ['deposit.manage']); assert.equal(f.context().dbNow, dbNow);
    const head = await f.memory.read(), demo = structuredClone(f.state);
    demo.user = 'administrator'; demo.clock = dbNow;
    const expected = transact(demo, action, payload, 'storage-first');
    expected.user = f.state.user; expected.clock = f.state.clock;
    const records = action === 'deposit' ? expected.deposits.slice(f.state.deposits.length) : expected.withdrawals.slice(f.state.withdrawals.length);
    for (const record of records) record.person = f.auth.principalId;
    assert.deepEqual(head.state, expected, 'domain behavior and all other facts are unchanged');
    const saved = action === 'deposit' ? head.state.deposits.slice(f.state.deposits.length) : head.state.withdrawals.slice(f.state.withdrawals.length);
    for (const record of saved) { assert.equal(record.person, f.auth.principalId); assert.equal(record.time, dbNow); }
    if (action === 'deposit') {
      assert.equal(saved.length, 2); assert.equal(new Set(saved.map(row => row.group)).size, 1);
      assert.deepEqual(saved.map(row => row.count), [6, 3]);
      for (const row of saved) { assert.equal(row.name, 'Synthetic Guest'); assert.equal(row.phone, '13800001234'); assert.notEqual(row.name, row.person); }
    } else { assert.equal(head.state.deposits[0].count, 4); assert.equal(saved[0].deposit, 101); }
    assert.deepEqual(head.state.orders, f.state.orders); assert.deepEqual(head.state.inventory, f.state.inventory);
    assert.deepEqual(head.state.ledger, f.state.ledger); assert.equal(head.audit[0].actorId, f.auth.principalId);
  });

  test(action + ': valid customer input and forged actor/permissions cannot authorize; denied key stays reusable', async () => {
    const f = makeFixture({ permissions: ['backend.view'] }), cmd = request('storage-grant', 0,
      { ...depositTestPayload(action), actorId: 'administrator', permissions: ['deposit.manage'], role: 'administrator' }, action);
    await assert.rejects(f.app.execute(cmd, f.credential), denied); await emptyEffects(f); assert.equal(f.executions(), 0);
    f.auth.permissions = ['deposit.manage'];
    assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed'); assert.equal(f.executions(), 1);
  });

  test(action + ': revoke preserves original terminal; actor/payload/action/revision conflicts persist, new key denied', async () => {
    const f = makeFixture(), cmd = request('storage-replay', 0, depositTestPayload(action), action);
    const first = await f.app.execute(cmd, f.credential), before = await f.memory.read(); f.auth.permissions = [];
    assert.deepEqual(await f.app.execute(cmd, f.credential), first);
    for (const changed of [{ ...cmd, expectedRevision: 1 },
      { ...cmd, payload: { ...cmd.payload, ...(action === 'deposit' ? { name: 'Different Guest' } : { count: 1 }) } },
      { ...cmd, action: action === 'deposit' ? 'withdraw' : 'deposit' }]) {
      const result = await f.app.execute(changed, f.credential);
      assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'request-mismatch');
    }
    f.auth.principalId = 'synthetic-other';
    const conflict = await f.app.execute(cmd, f.credential);
    assert.equal(conflict.status, 'idempotency-conflict'); assert.equal(conflict.reason, 'actor-mismatch');
    f.auth.principalId = first.actorId;
    await assert.rejects(f.app.execute({ ...cmd, operationKey: 'new', expectedRevision: 1 }, f.credential), denied);
    assert.equal(f.executions(), 1); assert.deepEqual(await f.memory.read(), before);
  });

  test(action + ': disabled/revoked/idle/absolute/credential invalidation blocks previous terminal access', async () => {
    for (const change of [auth => { auth.enabled = false; }, auth => { auth.revoked = true; },
      auth => { auth.idleExpiresAt = dbNow; }, auth => { auth.absoluteExpiresAt = dbNow; }, auth => { auth.credentialVersion++; }]) {
      const f = makeFixture(), cmd = request('storage-private', 0, depositTestPayload(action), action);
      await f.app.execute(cmd, f.credential); const before = await f.memory.read(); change(f.auth);
      await assert.rejects(f.app.execute(cmd, f.credential), authenticationRequired);
      assert.equal(f.executions(), 1); assert.deepEqual(await f.memory.read(), before);
    }
  });

  test(action + ': original customer/room/product/quantity checks reject atomically and occupy terminal keys', async () => {
    for (const payload of invalidDepositPayloads(action)) {
      const f = makeFixture(), cmd = request('storage-business', 0, payload, action);
      const result = await f.app.execute(cmd, f.credential); assert.equal(result.status, 'business-rejected');
      const head = await f.memory.read(); assert.equal(head.revision, 0); assert.deepEqual(head.state, f.state);
      assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 0);
      f.auth.permissions = []; assert.deepEqual(await f.app.execute(cmd, f.credential), result);
      assert.deepEqual(await f.memory.read(), head);
    }
  });

  test(action + ': domain entry requires real context and uses only its operator/time, never caller arguments', async () => {
    const f = makeFixture(), fn = action === 'deposit' ? submitDeposit : withdrawDeposit;
    await f.app.execute(request('storage-context', 0, depositTestPayload(action), action), f.credential);
    for (const context of [null, structuredClone(f.context())]) {
      assert.throws(() => fn(f.state, depositTestPayload(action), 'fake', 'fake', { mode: 'trusted', context }), TypeError);
      assert.throws(() => transact(f.state, action, depositTestPayload(action), 'direct', { mode: 'trusted', context }), TypeError);
    }
    assert.throws(() => fn(f.state, depositTestPayload(action), 'fake', 'fake', { mode: 'invalid' }), TypeError);
    const state = structuredClone(f.state);
    fn(state, depositTestPayload(action), 'fake', '1900-01-01', { mode: 'trusted', context: f.context() });
    const record = action === 'deposit' ? state.deposits.at(-1) : state.withdrawals.at(-1);
    assert.equal(record.person, f.auth.principalId); assert.equal(record.time, dbNow);
    const noGrant = makeFixture({ permissions: [] });
    await assert.rejects(noGrant.app.execute(request('storage-context', 0, depositTestPayload(action), action), noGrant.credential), denied);
    assert.throws(() => fn(noGrant.state, depositTestPayload(action), 'administrator', dbNow,
      { mode: 'trusted', context: noGrant.context() }), denied);
  });
}

test('storage workflow: different authorized actors handle the same customer, with no employee mapping or duplicate effects', async () => {
  const f = fixture({ permissions: ['deposit.manage'], setup: seedStoredDeposits });
  const deposit = request('storage-create', 0, depositTestPayload('deposit'), 'deposit');
  const first = await f.app.execute(deposit, f.credential), stored = (await f.memory.read()).state.deposits.at(-2);
  f.auth.principalId = 'synthetic-second-operator';
  const withdrawal = request('storage-take', 1, { id: stored.id, identity: stored.name, count: 2 }, 'withdraw');
  const taken = await f.app.execute(withdrawal, f.credential), before = await f.memory.read();
  assert.equal(taken.actorId, f.auth.principalId); assert.equal(before.revision, 2);
  assert.equal(before.state.deposits.find(row => row.id === stored.id).person, first.actorId);
  assert.equal(before.state.withdrawals.at(-1).person, taken.actorId);
  assert.equal(before.state.deposits.find(row => row.id === stored.id).count, 4);
  assert.deepEqual(await f.app.execute(withdrawal, f.credential), taken);
  f.auth.principalId = first.actorId; assert.deepEqual(await f.app.execute(deposit, f.credential), first);
  assert.deepEqual(await f.memory.read(), before); assert.deepEqual(before.state.inventory, f.state.inventory);
});

test('storage customer name/phone/identity remain business inputs, including name-only/phone-only and legacy single-item deposit', async () => {
  for (const payload of [
    { room: 'V01', name: 'administrator', product: 'bw', count: 1 },
    { room: 'V01', phone: '13800001234', product: 'bw', count: 1 }
  ]) {
    const f = fixture({ permissions: ['deposit.manage'], setup: seedStoredDeposits });
    assert.equal((await f.app.execute(request('customer', 0, payload, 'deposit'), f.credential)).status, 'committed');
    const stored = (await f.memory.read()).state.deposits.at(-1);
    assert.equal(stored.name, payload.name || ''); assert.equal(stored.phone, payload.phone || '');
    assert.equal(stored.person, 'synthetic-actor'); assert.equal(stored.initial, 1);
  }
  for (const identity of ['1234', '13800001234', ' Historic Guest ']) {
    const f = fixture({ permissions: ['deposit.manage'], setup: seedStoredDeposits });
    const result = await f.app.execute(request('customer', 0, { id: 101, identity, count: 6 }, 'withdraw'), f.credential);
    assert.equal(result.status, 'committed'); const state = (await f.memory.read()).state;
    assert.equal(state.deposits[0].count, 0); assert.equal(state.withdrawals.at(-1).person, f.auth.principalId);
    assert.equal(state.deposits[0].productNameSnapshot, null, 'unknown retired-product history is not filled from catalog');
  }
});
