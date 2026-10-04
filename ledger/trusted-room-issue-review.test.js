import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { decideRoomIssue } from '../rooms.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { BusinessRejection } from '../shared/business-error.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { authorizeReviewCommand, createTrustedReviewFacts } from './command-policy.js';
import { ROOM_ISSUE_REVIEW_ACTIONS, REVIEWER_PRINCIPAL, APPLICANT_PRINCIPAL, seedRoomIssueReview,
  roomIssueReviewCommand, pendingRoomIssueReview } from '../test-support/trusted-room-issue-review-fixture.js';

const dbNow = '2026-10-04T12:00:00.123456Z';
const denied = error => error instanceof AuthorizationDenied && !(error instanceof BusinessRejection);
function fixture({ permissions = ['room.issue.approve'], applicant = APPLICANT_PRINCIPAL,
  prepare = () => {}, execute = transact, bind = true } = {}) {
  const state = initialState(); state.user = 'not-a-demo-account'; state.clock = 'not-a-business-clock';
  state.permissions = { administrator: ['管理员'] }; state.capabilities = { administrator: ['*'] }; state.administrator = true;
  state.inventory.bw.count = 0;
  state.orders.push({ id: 'historical-retail', kind: 'retail', room: null,
    sales: [{ productNameSnapshot: null, pricePerSaleUnitCents: null }], payments: [{ method: '现金', amount: 100 }] });
  seedRoomIssueReview(state, applicant); prepare(state);
  const memory = createMemoryLedgerStore(state, { ledgerId: 'room-review-unit' });
  const tokenDigest = Buffer.alloc(32, 15), events = [];
  const auth = { id: REVIEWER_PRINCIPAL, permissions, enabled: true, revoked: false, version: 1, sessionVersion: 1,
    idle: '2099-01-01T00:00:00.000000Z', absolute: '2099-01-02T00:00:00.000000Z' };
  const port = {
    locateSessionByDigest: async () => ({ principalId: auth.id, sessionId: 'synthetic-room-review-session' }),
    lockAccount: async () => { events.push('account'); return { principalId: auth.id, enabled: auth.enabled, credentialVersion: auth.version }; },
    lockSessionById: async () => { events.push('session'); return { sessionId: 'synthetic-room-review-session', principalId: auth.id,
      tokenDigest, revoked: auth.revoked, credentialVersion: auth.sessionVersion, idleExpiresAt: auth.idle, absoluteExpiresAt: auth.absolute }; },
    listGrants: async () => { events.push('grants'); return auth.permissions; },
    readDbNow: async () => { events.push('db-now'); return dbNow; }
  };
  let context, executions = 0;
  const store = { ledgerId: memory.ledgerId, runAtomic: work => memory.runAtomic(tx => {
    events.push('head'); const find = tx.findOperationResult;
    tx.findOperationResult = key => { events.push('operation'); return find(key); };
    if (bind) tx.sessionRevalidation = { revalidateSessionInTransaction: credential => revalidateSessionInTransaction({ port, ...credential }) };
    return work(tx);
  }) };
  const app = createTrustedLedgerApplication({ store, transactCommand: (...args) => {
    context = args[4].context; executions++; events.push('transact'); return execute(...args);
  } });
  return { state, memory, auth, app, credential: { tokenDigest }, events, context: () => context, executions: () => executions };
}
async function noEffects(f) {
  const head = await f.memory.read(); assert.deepEqual(head.state, f.state);
  assert.equal(head.revision, 0); assert.equal(head.operationResults.size, 0); assert.equal(head.audit.length, 0);
}

for (const action of ROOM_ISSUE_REVIEW_ACTIONS) {
  test(action + ': non-applicant commits only the original room transition and trusted decision metadata', async () => {
    const f = fixture(), cmd = roomIssueReviewCommand(action), result = await f.app.execute(cmd, f.credential);
    const head = await f.memory.read(), review = pendingRoomIssueReview(head.state);
    assert.equal(result.status, 'committed'); assert.equal(result.actorId, REVIEWER_PRINCIPAL); assert.equal(head.revision, 1);
    assert.equal(review.decidedByPrincipalId, REVIEWER_PRINCIPAL); assert.equal(review.decidedBy, null);
    assert.equal(review.decidedAt, dbNow); assert.equal(review.selfReviewAuthorized, false);
    assert.equal(review.submittedByPrincipalId, APPLICANT_PRINCIPAL); assert.equal(review.submittedBy, 'historical applicant display');
    assert.equal(review.status, action === 'approveRoomIssue' ? '已批准' : '已驳回');
    assert.equal(head.state.rooms[0].status, action === 'approveRoomIssue' ? '空闲' : '故障/维护中');
    if (action === 'rejectRoomIssue') assert.deepEqual(head.state.rooms, f.state.rooms);
    for (const field of ['orders', 'inventory', 'ledger', 'user', 'clock', 'permissions', 'capabilities', 'administrator'])
      assert.deepEqual(head.state[field], f.state[field]);
    assert.equal(head.state.inventory.bw.count, 0); assert.equal(head.state.inventory.qd.count, null);
    assert.equal(head.state.orders[0].room, null);
    assert.equal(head.operationResults.get(cmd.operationKey).actorId, REVIEWER_PRINCIPAL); assert.equal(head.audit[0].actorId, REVIEWER_PRINCIPAL);
    assert.deepEqual(f.events, ['head', 'account', 'session', 'grants', 'db-now', 'operation', 'transact']);
  });

  test(action + ': self-review requires both grants; denial leaves the same key reusable after granting review.self', async () => {
    const f = fixture({ applicant: REVIEWER_PRINCIPAL }), cmd = roomIssueReviewCommand(action);
    await assert.rejects(f.app.execute(cmd, f.credential), denied); await noEffects(f);
    const facts = createTrustedReviewFacts({ submittedByPrincipalId: pendingRoomIssueReview(f.state).submittedByPrincipalId });
    assert.equal(authorizeReviewCommand({ principal: f.context().principal, action, reviewFacts: facts }).reason, 'missing-review-self');
    f.auth.permissions.push('review.self'); const result = await f.app.execute(cmd, f.credential);
    assert.equal(result.status, 'committed'); const head = await f.memory.read();
    assert.equal(pendingRoomIssueReview(head.state).selfReviewAuthorized, true);
    assert.equal(pendingRoomIssueReview(head.state).decidedByPrincipalId, REVIEWER_PRINCIPAL);
    assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 1); assert.equal(head.revision, 1);
  });

  test(action + ': review.self/backend/demo fields do not grant approval permission', async () => {
    for (const permissions of [[], ['review.self'], ['backend.view'], ['room.issue'], ['review.self', 'backend.view']]) {
      const f = fixture({ permissions, applicant: REVIEWER_PRINCIPAL });
      const cmd = roomIssueReviewCommand(action, 'denied', 0, { permissions: ['room.issue.approve', 'review.self'], role: 'administrator', actorId: 'administrator' });
      await assert.rejects(f.app.execute(cmd, f.credential), denied); await noEffects(f); assert.equal(f.executions(), 0);
    }
  });

  test(action + ': payload applicant/selfReview/approver never override locked review facts in either direction', async () => {
    const self = fixture({ applicant: REVIEWER_PRINCIPAL });
    await assert.rejects(self.app.execute(roomIssueReviewCommand(action, 'fake', 0, {
      submittedBy: 'somebody else', submittedByPrincipalId: APPLICANT_PRINCIPAL, applicant: APPLICANT_PRINCIPAL,
      selfReview: false, approver: 'administrator', permissions: ['review.self'], role: 'administrator'
    }), self.credential), denied); await noEffects(self);
    const other = fixture(); const result = await other.app.execute(roomIssueReviewCommand(action, 'fake', 0, {
      submittedBy: 'forged name', submittedByPrincipalId: REVIEWER_PRINCIPAL, applicant: REVIEWER_PRINCIPAL,
      selfReview: true, approver: 'forged approver', actorId: 'fake', principalId: 'fake', decidedByPrincipalId: 'fake',
      clock: '1900-01-01', person: 'fake', permissions: ['*'], role: 'administrator'
    }), other.credential);
    assert.equal(result.status, 'committed'); const review = pendingRoomIssueReview((await other.memory.read()).state);
    assert.equal(review.selfReviewAuthorized, false); assert.equal(review.decidedByPrincipalId, REVIEWER_PRINCIPAL);
    assert.equal(review.decidedBy, null); assert.equal(review.decidedAt, dbNow);
  });

  test(action + ': legacy missing/invalid principal fails closed even with self permission and forged or matching old identities', async () => {
    for (const applicant of [undefined, null, '', ' padded ', 123, { principalId: APPLICANT_PRINCIPAL }]) {
      const f = fixture({ permissions: ['room.issue.approve', 'review.self'], prepare: state => {
        const review = pendingRoomIssueReview(state); delete review.submittedByPrincipalId;
        if (applicant !== undefined) review.submittedByPrincipalId = applicant;
        review.submittedById = state.user; review.submittedBy = REVIEWER_PRINCIPAL; review.employeeId = REVIEWER_PRINCIPAL;
      } });
      await assert.rejects(f.app.execute(roomIssueReviewCommand(action, 'legacy', 0, {
        submittedByPrincipalId: APPLICANT_PRINCIPAL, applicant: APPLICANT_PRINCIPAL, selfReview: false
      }), f.credential), error => denied(error) && error.reason === 'untrusted-room-issue-applicant');
      await noEffects(f);
    }
  });

  test(action + ': revoke after success preserves terminal replay; new key denied and actor/request conflicts stay intact', async () => {
    const f = fixture({ applicant: REVIEWER_PRINCIPAL, permissions: ['room.issue.approve', 'review.self'] });
    const cmd = roomIssueReviewCommand(action), first = await f.app.execute(cmd, f.credential);
    const before = await f.memory.read(); f.auth.permissions = [];
    assert.deepEqual(await f.app.execute(cmd, f.credential), first); assert.equal(f.executions(), 1);
    await assert.rejects(f.app.execute({ ...cmd, operationKey: 'new', expectedRevision: 1 }, f.credential), denied);
    for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, payload: { ...cmd.payload, decisionNote: 'changed' } },
      { ...cmd, action: action === 'approveRoomIssue' ? 'rejectRoomIssue' : 'approveRoomIssue' }]) {
      const result = await f.app.execute(changed, f.credential); assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'request-mismatch');
    }
    f.auth.id = APPLICANT_PRINCIPAL;
    const result = await f.app.execute(cmd, f.credential); assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'actor-mismatch');
    assert.equal(f.executions(), 1); assert.deepEqual(await f.memory.read(), before);
  });

  test(action + ': account/session invalidation prevents old terminal lookup', async () => {
    for (const invalidate of [a => a.enabled = false, a => a.revoked = true, a => a.idle = dbNow, a => a.absolute = dbNow,
      a => a.sessionVersion = 0]) {
      const f = fixture(), cmd = roomIssueReviewCommand(action); await f.app.execute(cmd, f.credential);
      const before = await f.memory.read(); invalidate(f.auth); f.events.length = 0;
      await assert.rejects(f.app.execute(cmd, f.credential), error => error.code === 'AUTHENTICATION_REQUIRED');
      assert.ok(!f.events.includes('operation')); assert.equal(f.executions(), 1); assert.deepEqual(await f.memory.read(), before);
    }
  });

  test(action + ': original domain rejections remain terminal without changing state or revision', async () => {
    const cases = [
      [() => {}, { request: 999 }, '已经处理'],
      [s => pendingRoomIssueReview(s).status = '已批准', {}, '已经处理'],
      [s => pendingRoomIssueReview(s).requestedStatus = '待清洁', {}, '只有恢复为空房'],
      ...(action === 'approveRoomIssue' ? [[s => s.rooms[0].status = '营业中', {}, '房间状态已经变化'],
        [s => s.rooms.shift(), {}, '房间状态已经变化']] : [[() => {}, { decisionNote: '  ' }, '驳回原因']])
    ];
    for (const [prepare, payload, reason] of cases) {
      const f = fixture({ prepare }), cmd = roomIssueReviewCommand(action, 'business', 0, payload);
      const result = await f.app.execute(cmd, f.credential); assert.equal(result.status, 'business-rejected'); assert.ok(result.reason.includes(reason));
      const head = await f.memory.read(); assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0);
      assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 0);
      f.auth.permissions = []; assert.deepEqual(await f.app.execute(cmd, f.credential), result);
    }
  });

  test(action + ': demo/trusted room transitions are equal after removing only execution identity/time metadata', async () => {
    const f = fixture({ prepare: s => pendingRoomIssueReview(s).submittedById = 'staff' });
    const demo = structuredClone(f.state); demo.user = 'administrator'; demo.clock = dbNow;
    const cmd = roomIssueReviewCommand(action, 'parity', 0, { decisionNote: 'x'.repeat(350) });
    const expected = transact(demo, action, cmd.payload, cmd.operationKey), result = await f.app.execute(cmd, f.credential);
    assert.equal(result.status, 'committed'); const actual = (await f.memory.read()).state;
    actual.user = demo.user; actual.clock = demo.clock;
    const review = pendingRoomIssueReview(actual); delete review.decidedByPrincipalId;
    review.decidedBy = pendingRoomIssueReview(expected).decidedBy;
    assert.deepEqual(actual, expected); assert.equal(review.decisionNote.length, 300);
  });
}

test('room issue review: domain direct entry never reads demo identity/time or invokes demo reviewer in trusted mode', async () => {
  for (const action of ROOM_ISSUE_REVIEW_ACTIONS) {
    const f = fixture(); await f.app.execute(roomIssueReviewCommand(action), f.credential);
    const state = structuredClone(f.state);
    for (const key of ['user', 'permissions', 'capabilities', 'clock']) Object.defineProperty(state, key, { get() { assert.fail('trusted domain read ' + key); } });
    decideRoomIssue(state, action, roomIssueReviewCommand(action).payload, 'fake', '1900-01-01',
      () => assert.fail('trusted domain invoked demo reviewer'), { mode: 'trusted', context: f.context() });
    assert.equal(pendingRoomIssueReview(state).decidedByPrincipalId, REVIEWER_PRINCIPAL);
    assert.equal(pendingRoomIssueReview(state).decidedAt, dbNow);
  }
});

test('room issue review: missing/copied context and direct domain self/legacy bypass fail closed', async () => {
  for (const action of ROOM_ISSUE_REVIEW_ACTIONS) {
    const f = fixture({ applicant: REVIEWER_PRINCIPAL });
    await assert.rejects(f.app.execute(roomIssueReviewCommand(action), f.credential), denied); await noEffects(f);
    const run = context => decideRoomIssue(structuredClone(f.state), action, roomIssueReviewCommand(action).payload,
      'fake', 'fake-clock', () => true, { mode: 'trusted', context });
    assert.throws(() => run(undefined), /可信认证上下文/); assert.throws(() => run({ ...f.context() }), /可信认证上下文/);
    assert.throws(() => run(f.context()), denied);
    assert.throws(() => transact(f.state, action, {}, 'no-context', { mode: 'trusted' }), /可信认证上下文/);
    const unbound = fixture({ bind: false }); await assert.rejects(unbound.app.execute(roomIssueReviewCommand(action), unbound.credential), /revalidation port/);
    await noEffects(unbound);
  }
});

test('room issue review: unknown exception after domain mutation rolls back all effects and the original key can retry', async () => {
  for (const action of ROOM_ISSUE_REVIEW_ACTIONS) {
    let broken = true; const f = fixture({ execute: (...args) => { const state = transact(...args); if (broken) throw Error('synthetic unknown fault'); return state; } });
    const cmd = roomIssueReviewCommand(action);
    await assert.rejects(f.app.execute(cmd, f.credential), /synthetic unknown fault/); await noEffects(f);
    broken = false; assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed');
    assert.equal((await f.memory.read()).revision, 1);
  }
});
