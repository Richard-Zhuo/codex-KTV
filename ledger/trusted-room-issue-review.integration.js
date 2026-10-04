import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact } from '../rules.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { ROOM_ISSUE_REVIEW_ACTIONS, seedRoomIssueReview, roomIssueReviewCommand,
  pendingRoomIssueReview } from '../test-support/trusted-room-issue-review-fixture.js';

const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
const sqlAt = (run, name, verb) => run.calls.findIndex(call => call.kind === 'sql' && call.sql.includes(name) &&
  (verb.startsWith('FOR ') ? call.sql.endsWith(verb) : call.sql.startsWith(verb + ' ')));

// Shares the existing strictly guarded ten-table fixture. Creates no database or new table.
export async function testTrustedRoomIssueReviews({ t, pool, setup, auth, table, provision, seed, inspect, application,
  assertUnchanged, wrapConnection, poolOptions, database }) {
  const runFor = (id, options = {}) => application(id, { employeeBind: null, ...options });
  const createPending = (id, applicant, prepare = () => {}) => seed(id, state => { seedRoomIssueReview(state, applicant); prepare(state); });

  for (const action of ROOM_ISSUE_REVIEW_ACTIONS) {
    await t.test(action + ': trusted submission then non-applicant decision uses one locked connection and persists principal/state/result/audit', async () => {
      const applicant = await provision(['room.issue']), reviewer = await provision(['room.issue.approve']);
      const id = 'room-review-first-' + action; await seed(id);
      const submit = runFor(id);
      assert.equal((await submit.app.execute({ operationKey: 'mark', expectedRevision: 0, action: 'markRoomIssue',
        payload: { room: 'V01', issueType: '维护中', evidenceText: 'synthetic maintenance' } }, applicant.credential)).status, 'committed');
      assert.equal((await submit.app.execute({ operationKey: 'clear', expectedRevision: 1, action: 'clearRoomIssue',
        payload: { room: 'V01', evidenceText: 'synthetic repaired' } }, applicant.credential)).status, 'committed');
      const original = await inspect(id), request = original.head.state.roomIssueReviews.at(-1);
      assert.equal(request.submittedByPrincipalId, applicant.principalId); assert.equal(request.submittedById, '');
      const connection = await pool.getConnection(); let borrows = 0;
      const [[beforeActivity]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [reviewer.sessionId]);
      try {
        const run = runFor(id, { connectionPool: { getConnection: async () => { borrows++; return wrapConnection(connection, [], false); } } });
        const cmd = roomIssueReviewCommand(action, 'decide', 2, { request: request.id, submittedBy: 'fake',
          submittedByPrincipalId: reviewer.principalId, applicant: reviewer.principalId, selfReview: true, approver: 'administrator',
          actorId: 'fake', principalId: 'fake', role: 'administrator', permissions: ['*'], clock: '1900-01-01', decidedByPrincipalId: 'fake' });
        const result = await run.app.execute(cmd, reviewer.credential), actual = await inspect(id), review = actual.head.state.roomIssueReviews.at(-1);
        assert.equal(result.status, 'committed'); assert.equal(result.actorId, reviewer.principalId); assert.equal(actual.head.revision, 3);
        assert.equal(review.decidedByPrincipalId, reviewer.principalId); assert.equal(review.decidedBy, null);
        assert.equal(review.selfReviewAuthorized, false); assert.equal(review.decidedAt, run.context().dbNow);
        assert.equal(review.submittedByPrincipalId, applicant.principalId); assert.equal(review.submittedBy, request.submittedBy);
        assert.equal(review.status, action === 'approveRoomIssue' ? '已批准' : '已驳回');
        if (action === 'rejectRoomIssue') assert.deepEqual(actual.head.state.rooms, original.head.state.rooms);
        else {
          assert.equal(actual.head.state.rooms[0].status, '空闲');
          for (const key of ['issueType', 'issueNote', 'issueAt', 'issueBy', 'issueApprovedBy', 'issueEvidencePhoto', 'issueEvidencePhotoName'])
            assert.equal(actual.head.state.rooms[0][key], '');
        }
        assert.equal(actual.operations.length, 3); assert.equal(actual.audit.length, 3);
        const operation = actual.operations.find(row => row.operation_key === 'decide'), audit = actual.audit.find(row => row.operation_key === 'decide');
        assert.equal(operation.actor_principal_id, reviewer.principalId); assert.deepEqual(operation.terminal_result, result);
        assert.equal(audit.actor_principal_id, reviewer.principalId); assert.equal(audit.action, action);
        assert.equal(audit.before_revision, '2'); assert.equal(audit.after_revision, '3');
        for (const field of ['orders', 'inventory', 'ledger', 'user', 'clock', 'permissions', 'capabilities', 'administrator'])
          assert.deepEqual(actual.head.state[field], original.head.state[field]);
        assert.equal(actual.head.state.orders[0].room, null); assert.equal(actual.head.state.inventory.bw.count, 0); assert.equal(actual.head.state.inventory.qd.count, null);
        const order = [run.calls.findIndex(call => call.kind === 'begin'), sqlAt(run, 'ledger_heads', 'FOR UPDATE'),
          sqlAt(run, 'auth_accounts', 'FOR UPDATE'), sqlAt(run, 'auth_sessions', 'FOR UPDATE'), sqlAt(run, 'auth_grants', 'FOR UPDATE'),
          sqlAt(run, 'AS db_now', 'SELECT'), sqlAt(run, 'ledger_operations', 'SELECT'), run.calls.findIndex(call => call.kind === 'transact'),
          sqlAt(run, 'ledger_heads', 'UPDATE'), sqlAt(run, 'ledger_operations', 'INSERT'), sqlAt(run, 'ledger_success_audit', 'INSERT'),
          run.calls.findIndex(call => call.kind === 'commit')];
        assert.ok(order.every(index => index >= 0)); assert.deepEqual(order, [...order].sort((a, b) => a - b));
        assert.equal(borrows, 1); assert.equal(run.calls.filter(call => call.kind === 'begin').length, 1);
        assert.equal(run.calls.filter(call => call.kind === 'commit').length, 1); assert.equal(run.calls.filter(call => call.kind === 'db-now').length, 1);
        assert.equal(run.context().dbNow, run.calls.find(call => call.kind === 'db-now').value);
        assert.equal(run.context().policyAttributesConfigured, false); assert.equal(run.context().policyAttributeIds, null);
        assert.equal(sqlAt(run, 'employees', 'FOR SHARE'), -1);
        const [[afterActivity]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [reviewer.sessionId]);
        assert.deepEqual(afterActivity, beforeActivity);
      } finally { try { await connection.rollback(); } finally { connection.release(); } }
    });

    await t.test(action + ': self requires review.self; denial has no terminal and the same key succeeds after grant', async () => {
      const login = await provision(['room.issue.approve']), id = 'room-review-self-' + action;
      await createPending(id, login.principalId); const before = await inspect(id), run = runFor(id);
      const cmd = roomIssueReviewCommand(action, 'self', 0, { submittedBy: 'somebody else', submittedByPrincipalId: 'fake-other',
        applicant: 'fake-other', selfReview: false, approver: 'administrator', permissions: ['review.self'], role: 'administrator' });
      await assert.rejects(run.app.execute(cmd, login.credential), denied); await assertUnchanged(id, before);
      assert.equal(run.calls.filter(call => call.kind === 'rollback').length, 1);
      await auth.grantPermission({ principalId: login.principalId, permissionId: 'review.self' });
      const result = await run.app.execute(cmd, login.credential); assert.equal(result.status, 'committed');
      const actual = await inspect(id); assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
      const review = pendingRoomIssueReview(actual.head.state); assert.equal(review.selfReviewAuthorized, true);
      assert.equal(review.decidedByPrincipalId, login.principalId); assert.equal(review.decidedAt, run.context().dbNow);
    });

    await t.test(action + ': review.self/backend cannot replace approval permission; granting permission reuses unconsumed key', async () => {
      const login = await provision(['review.self', 'backend.view']), id = 'room-review-denied-' + action;
      await createPending(id, login.principalId); const before = await inspect(id), run = runFor(id);
      const cmd = roomIssueReviewCommand(action, 'permission', 0, { actorId: 'administrator', permissions: ['room.issue.approve'], role: 'administrator' });
      await assert.rejects(run.app.execute(cmd, login.credential), denied); await assertUnchanged(id, before); assert.equal(run.executions(), 0);
      await auth.grantPermission({ principalId: login.principalId, permissionId: 'room.issue.approve' });
      assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed');
    });

    await t.test(action + ': legacy lacks trusted applicant and cannot be rescued by names, demo IDs, employees or payload', async () => {
      const login = await provision(['room.issue.approve', 'review.self']); let index = 0;
      for (const applicant of [undefined, null, '', 7]) {
        const id = 'room-review-legacy-' + action + '-' + (++index);
        await createPending(id, login.principalId, state => {
          const review = pendingRoomIssueReview(state); delete review.submittedByPrincipalId;
          if (applicant !== undefined) review.submittedByPrincipalId = applicant;
          review.submittedById = login.principalId; review.submittedBy = login.principalId; review.employeeId = login.principalId;
        });
        const before = await inspect(id), run = runFor(id);
        await assert.rejects(run.app.execute(roomIssueReviewCommand(action, 'legacy', 0, {
          submittedByPrincipalId: login.principalId, submittedBy: login.principalId, applicant: 'fake-other', selfReview: false
        }), login.credential), error => denied(error) && error.reason === 'untrusted-room-issue-applicant');
        await assertUnchanged(id, before); assert.ok(run.calls.some(call => call.kind === 'rollback'));
      }
    });

    await t.test(action + ': reconnect after revoking both grants returns original terminal; new key denied and conflicts unchanged', async () => {
      const login = await provision(['room.issue.approve', 'review.self']), other = await provision([]), id = 'room-review-replay-' + action;
      await createPending(id, login.principalId); const run = runFor(id), cmd = roomIssueReviewCommand(action);
      const first = await run.app.execute(cmd, login.credential);
      await auth.revokePermission({ principalId: login.principalId, permissionId: 'room.issue.approve' });
      await auth.revokePermission({ principalId: login.principalId, permissionId: 'review.self' });
      const before = await inspect(id), reconnect = mysql.createPool(poolOptions);
      try {
        const again = runFor(id, { connectionPool: reconnect, bind: createMySqlAuthStore({ pool: reconnect, database }).bindSessionRevalidation,
          transactCommand: () => assert.fail('terminal lookup must not reexecute review or inspect current applicant') });
        assert.deepEqual(await again.app.execute(cmd, login.credential), first);
        const actor = await again.app.execute(cmd, other.credential); assert.equal(actor.status, 'idempotency-conflict'); assert.equal(actor.reason, 'actor-mismatch');
        for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, payload: { ...cmd.payload, decisionNote: 'changed' } },
          { ...cmd, action: action === 'approveRoomIssue' ? 'rejectRoomIssue' : 'approveRoomIssue' }]) {
          const conflict = await again.app.execute(changed, login.credential); assert.equal(conflict.status, 'idempotency-conflict'); assert.equal(conflict.reason, 'request-mismatch');
        }
        await assert.rejects(again.app.execute({ ...cmd, operationKey: 'new', expectedRevision: 1 }, login.credential), denied);
        assert.equal(again.executions(), 0); await assertUnchanged(id, before);
      } finally { await reconnect.end(); }
    });

    await t.test(action + ': disabled/revoked/idle/absolute/version invalidation refuses old terminal before lookup', async () => {
      for (const invalidation of ['disabled', 'revoked', 'idle', 'absolute', 'version']) {
        const login = await provision(['room.issue.approve']), applicant = await provision([]), id = 'room-review-auth-' + action + '-' + invalidation;
        await createPending(id, applicant.principalId); const run = runFor(id), cmd = roomIssueReviewCommand(action);
        await run.app.execute(cmd, login.credential); const before = await inspect(id);
        if (invalidation === 'disabled') await auth.disableAccount({ principalId: login.principalId });
        else if (invalidation === 'revoked') await auth.logout(login.token);
        else if (invalidation === 'version') await auth.rotateCredential({ principalId: login.principalId, password: 'synthetic-room-review-rotated' });
        else if (invalidation === 'idle') await pool.execute('UPDATE ' + table('auth_sessions') + ' SET idle_expires_at = created_at WHERE session_id=?', [login.sessionId]);
        else await pool.execute('UPDATE ' + table('auth_sessions') +
          ' SET idle_expires_at = created_at, absolute_expires_at = created_at + INTERVAL 1 MICROSECOND WHERE session_id=?', [login.sessionId]);
        run.calls.length = 0; await assert.rejects(run.app.execute(cmd, login.credential), error => error.code === 'AUTHENTICATION_REQUIRED');
        assert.equal(sqlAt(run, 'ledger_operations', 'SELECT'), -1); assert.equal(run.executions(), 1); await assertUnchanged(id, before);
      }
    });

    await t.test(action + ': stale revision and original room domain rejections persist terminal without partial effects', async () => {
      const reviewer = await provision(['room.issue.approve']), applicant = await provision([]); let index = 0;
      const cases = [
        [() => {}, { request: 999 }, 'business-rejected'],
        [state => pendingRoomIssueReview(state).status = '已驳回', {}, 'business-rejected'],
        [state => pendingRoomIssueReview(state).requestedStatus = '待清洁', {}, 'business-rejected'],
        [() => {}, {}, 'revision-conflict'],
        ...(action === 'approveRoomIssue' ? [[state => state.rooms[0].status = '营业中', {}, 'business-rejected'],
          [state => state.rooms.shift(), {}, 'business-rejected']] : [[() => {}, { decisionNote: '' }, 'business-rejected']])
      ];
      for (const [prepare, payload, terminal] of cases) {
        const id = 'room-review-terminal-' + action + '-' + (++index);
        await createPending(id, applicant.principalId, prepare); const before = await inspect(id), run = runFor(id);
        const cmd = roomIssueReviewCommand(action, 'terminal', terminal === 'revision-conflict' ? 9 : 0, payload);
        const result = await run.app.execute(cmd, reviewer.credential); assert.equal(result.status, terminal);
        const actual = await inspect(id); assert.deepEqual(actual.head, before.head); assert.equal(actual.audit.length, 0); assert.equal(actual.operations.length, 1);
        await auth.revokePermission({ principalId: reviewer.principalId, permissionId: 'room.issue.approve' });
        assert.deepEqual(await run.app.execute(cmd, reviewer.credential), result);
        await auth.grantPermission({ principalId: reviewer.principalId, permissionId: 'room.issue.approve' });
      }
    });

    await t.test(action + ': unknown exception after domain changes rolls back and the original operation key can retry', async () => {
      const reviewer = await provision(['room.issue.approve']), applicant = await provision([]), id = 'room-review-unknown-' + action;
      await createPending(id, applicant.principalId); const before = await inspect(id); let broken = true;
      const run = runFor(id, { transactCommand: (...args) => { const state = transact(...args); if (broken) throw Error('synthetic unknown review fault'); return state; } });
      const cmd = roomIssueReviewCommand(action); await assert.rejects(run.app.execute(cmd, reviewer.credential), /synthetic unknown review fault/);
      await assertUnchanged(id, before); assert.ok(run.calls.some(call => call.kind === 'rollback'));
      broken = false; assert.equal((await run.app.execute(cmd, reviewer.credential)).status, 'committed');
    });

    await t.test(action + ': audit SQL fault after head and operation writes rolls back decision/state/revision/terminal/audit', async () => {
      const reviewer = await provision(['room.issue.approve']), applicant = await provision([]), id = 'room-review-sql-' + action;
      await createPending(id, applicant.principalId); const before = await inspect(id), run = runFor(id);
      await setup.query('ALTER TABLE ' + table('ledger_success_audit') +
        " ADD CONSTRAINT chk_room_review_fault CHECK (ledger_id <> '" + id + "')");
      const cmd = roomIssueReviewCommand(action);
      try {
        await assert.rejects(run.app.execute(cmd, reviewer.credential), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
        assert.ok(sqlAt(run, 'ledger_heads', 'UPDATE') >= 0); assert.ok(sqlAt(run, 'ledger_operations', 'INSERT') >= 0);
        assert.ok(run.calls.some(call => call.kind === 'rollback')); await assertUnchanged(id, before);
      } finally { await setup.query('ALTER TABLE ' + table('ledger_success_audit') + ' DROP CHECK chk_room_review_fault'); }
      assert.equal((await run.app.execute(cmd, reviewer.credential)).status, 'committed');
      const actual = await inspect(id); assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
    });
  }

  await t.test('room issue review: two independent connections serialize approve/reject at the same old revision', async () => {
    const applicant = await provision([]), reviewer = await provision(['room.issue.approve']), id = 'room-review-race';
    await createPending(id, applicant.principalId); const a = await pool.getConnection(), b = await pool.getConnection();
    try {
      const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id'), [[bId]] = await b.query('SELECT CONNECTION_ID() AS id');
      assert.notEqual(aId.id, bId.id); await a.query('SET SESSION innodb_lock_wait_timeout = 5'); await b.query('SET SESSION innodb_lock_wait_timeout = 5');
      const first = runFor(id, { connectionPool: { getConnection: async () => wrapConnection(a, [], false) } });
      const second = runFor(id, { connectionPool: { getConnection: async () => wrapConnection(b, [], false) } });
      const results = await Promise.all([first.app.execute(roomIssueReviewCommand('approveRoomIssue', 'approve'), reviewer.credential),
        second.app.execute(roomIssueReviewCommand('rejectRoomIssue', 'reject'), reviewer.credential)]);
      assert.deepEqual(results.map(result => result.status).sort(), ['committed', 'revision-conflict']);
      const actual = await inspect(id); assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 2); assert.equal(actual.audit.length, 1);
      assert.equal(first.executions() + second.executions(), 1);
      const approved = results[0].status === 'committed', review = pendingRoomIssueReview(actual.head.state);
      assert.equal(review.status, approved ? '已批准' : '已驳回'); assert.equal(actual.head.state.rooms[0].status, approved ? '空闲' : '故障/维护中');
      assert.equal(review.decidedByPrincipalId, reviewer.principalId);
      t.diagnostic('room review revision race verified two independent CONNECTION_ID values');
    } finally { try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); } }
  });

  await t.test('room issue review: two independent connections retry the same key and perform exactly one decision', async () => {
    const reviewer = await provision(['room.issue.approve', 'review.self']), id = 'room-review-key-race';
    await createPending(id, reviewer.principalId); const a = await pool.getConnection(), b = await pool.getConnection();
    try {
      const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id'), [[bId]] = await b.query('SELECT CONNECTION_ID() AS id'); assert.notEqual(aId.id, bId.id);
      const first = runFor(id, { connectionPool: { getConnection: async () => wrapConnection(a, [], false) } });
      const second = runFor(id, { connectionPool: { getConnection: async () => wrapConnection(b, [], false) } });
      const cmd = roomIssueReviewCommand('approveRoomIssue', 'same');
      const results = await Promise.all([first.app.execute(cmd, reviewer.credential), second.app.execute(cmd, reviewer.credential)]);
      assert.deepEqual(results[0], results[1]); assert.equal(results[0].status, 'committed'); assert.equal(first.executions() + second.executions(), 1);
      const actual = await inspect(id); assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
      assert.equal(pendingRoomIssueReview(actual.head.state).selfReviewAuthorized, true);
      t.diagnostic('room review same-key race verified two independent CONNECTION_ID values');
    } finally { try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); } }
  });
}
