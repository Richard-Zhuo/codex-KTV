import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact } from '../rules.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { incidentCommand } from '../test-support/trusted-incident-fixture.js';
import { resolutionCommand } from '../test-support/trusted-incident-resolution-fixture.js';
import { INCIDENT_REVIEW_ACTIONS, seedIncidentReview, incidentReviewCommand, incidentReviewRequest } from '../test-support/trusted-incident-review-fixture.js';

const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
const sqlAt = (run, name, verb) => run.calls.findIndex(call => call.kind === 'sql' && call.sql.includes(name) &&
  (verb.startsWith('FOR ') ? call.sql.endsWith(verb) : call.sql.startsWith(verb + ' ')));

// Only the guarded parent fixture owns migration and cleanup of its eleven known tables.
export async function testTrustedIncidentReviews({ t, pool, setup, auth, table, provision, seed, inspect, application, roster,
  assertUnchanged, wrapConnection, poolOptions, database }) {
  const runFor = (id, options = {}) => application(id, { employeeBind: null, ...options });
  const pending = (id, applicant, prepare = () => {}) => seed(id, state => { seedIncidentReview(state, applicant); prepare(state); });

  for (const action of INCIDENT_REVIEW_ACTIONS) {
    await t.test(action + ': trusted registration and resolution followed by non-applicant review commit on one locked connection', async () => {
      const creator = await provision(['incident.create']), applicant = await provision(['incident.resolve']);
      const employee = await roster.createEmployee({ displayName: 'Synthetic Resolution Applicant' }, { actorPrincipalId: creator.principalId });
      await roster.linkPrincipal({ employeeId: employee.employeeId, principalId: applicant.principalId }, { actorPrincipalId: creator.principalId });
      const reviewer = await provision(['incident.resolve.approve']), id = 'incident-review-chain-' + action;
      await seed(id); const chain = application(id);
      assert.equal((await chain.app.execute(incidentCommand('create', employee.employeeId), creator.credential)).status, 'committed');
      const incidentId = (await inspect(id)).head.state.incidents.at(-1).id;
      assert.equal((await chain.app.execute(resolutionCommand('resolve', 1, { id: incidentId }), applicant.credential)).status, 'committed');
      const before = await inspect(id), original = before.head.state.incidents.at(-1), requestId = original.resolutionReviews[0].id;
      const connection = await pool.getConnection(); let borrows = 0;
      const [[activity]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [reviewer.sessionId]);
      try {
        const run = runFor(id, { connectionPool: { getConnection: async () => { borrows++; return wrapConnection(connection, [], false); } } });
        const cmd = incidentReviewCommand(action, 'decide', 2, { id: incidentId, request: requestId,
          applicant: reviewer.principalId, submittedByPrincipalId: reviewer.principalId, submittedBy: 'fake', selfReview: true,
          assignee: 'fake', assigneeEmployeeId: 'fake', approver: 'administrator', actorId: 'fake', principalId: 'fake',
          principal: { id: 'fake' }, role: 'administrator', permissions: ['*'], clock: '1900-01-01', decidedByPrincipalId: 'fake' });
        const result = await run.app.execute(cmd, reviewer.credential), actual = await inspect(id);
        const incident = actual.head.state.incidents.at(-1), request = incident.resolutionReviews[0];
        assert.equal(result.status, 'committed'); assert.equal(result.actorId, reviewer.principalId); assert.equal(actual.head.revision, 3);
        assert.equal(request.decidedByPrincipalId, reviewer.principalId); assert.equal(request.decidedBy, null);
        assert.equal(request.decidedAt, run.context().dbNow); assert.equal(request.selfReviewAuthorized, false);
        assert.equal(request.submittedByPrincipalId, applicant.principalId); assert.equal(request.submittedByEmployeeId, employee.employeeId);
        assert.equal(request.submittedBy, original.resolutionReviews[0].submittedBy);
        assert.equal(request.status, action === 'approveIncidentResolution' ? '已批准' : '已驳回');
        if (action === 'approveIncidentResolution') {
          assert.equal(incident.status, '已完成'); assert.equal(incident.result, request.result); assert.equal(incident.note, request.note);
          assert.equal(incident.resolvedBy, request.submittedBy); assert.equal(incident.resolvedAt, run.context().dbNow);
          assert.equal(incident.reviewedBy, null); assert.equal(incident.lastReminderDate, '');
        } else {
          assert.deepEqual(incident, { ...original, status: '待处理', resolutionReviews: [request] });
        }
        for (const field of ['rooms', 'orders', 'inventory', 'ledger', 'serial', 'user', 'clock', 'permissions', 'capabilities', 'administrator'])
          assert.deepEqual(actual.head.state[field], before.head.state[field]);
        assert.equal(actual.head.state.orders[0].room, null); assert.equal(actual.head.state.inventory.bw.count, 0);
        assert.equal(actual.head.state.inventory.qd.count, null);
        assert.equal(actual.operations.length, 3); assert.equal(actual.audit.length, 3);
        const operation = actual.operations.find(row => row.operation_key === 'decide'), audit = actual.audit.find(row => row.operation_key === 'decide');
        assert.equal(operation.actor_principal_id, reviewer.principalId); assert.deepEqual(operation.terminal_result, result);
        assert.equal(audit.actor_principal_id, reviewer.principalId); assert.equal(audit.action, action);
        assert.equal(audit.before_revision, '2'); assert.equal(audit.after_revision, '3');
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
        assert.equal(sqlAt(run, 'employees', 'FOR SHARE'), -1); assert.equal(Object.hasOwn(run.context(), 'actorEmployeeId'), false);
        const [[afterActivity]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [reviewer.sessionId]);
        assert.deepEqual(afterActivity, activity);
      } finally { try { await connection.rollback(); } finally { connection.release(); } }
    });

    await t.test(action + ': self denial reserves no key; grant review.self permits the identical request without employee linkage', async () => {
      const login = await provision(['incident.resolve.approve']), id = 'incident-review-self-' + action;
      await pending(id, login.principalId); const before = await inspect(id), run = runFor(id), cmd = incidentReviewCommand(action, 'self', 0, {
        submittedByPrincipalId: 'fake-other', applicant: 'fake-other', selfReview: false, approver: 'administrator', permissions: ['review.self'] });
      await assert.rejects(run.app.execute(cmd, login.credential), denied); await assertUnchanged(id, before);
      assert.ok(run.calls.some(call => call.kind === 'rollback'));
      await auth.grantPermission({ principalId: login.principalId, permissionId: 'review.self' });
      assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed'); const actual = await inspect(id);
      const request = incidentReviewRequest(actual.head.state); assert.equal(request.selfReviewAuthorized, true);
      assert.equal(request.decidedByPrincipalId, login.principalId); assert.equal(request.decidedAt, run.context().dbNow);
      assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
    });

    await t.test(action + ': review.self/submit/backend cannot replace incident.resolve.approve and denied key remains reusable', async () => {
      const login = await provision(['review.self', 'incident.resolve', 'backend.view']), id = 'incident-review-permission-' + action;
      await pending(id, login.principalId); const before = await inspect(id), run = runFor(id);
      const cmd = incidentReviewCommand(action, 'permission', 0, { actorId: 'administrator', permissions: ['incident.resolve.approve'], role: 'administrator' });
      await assert.rejects(run.app.execute(cmd, login.credential), denied); await assertUnchanged(id, before); assert.equal(run.executions(), 0);
      await auth.grantPermission({ principalId: login.principalId, permissionId: 'incident.resolve.approve' });
      assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed');
    });

    await t.test(action + ': selected request principal alone decides self-review, independent of incident creator, assignee and other reviews', async () => {
      const reviewer = await provision(['incident.resolve.approve']), applicant = await provision([]);
      const id = 'incident-review-selected-' + action, selfId = id + '-self';
      await pending(id, applicant.principalId, state => {
        const incident = state.incidents[0]; incident.submittedByPrincipalId = reviewer.principalId;
        incident.actualActorPrincipalId = reviewer.principalId; incident.assigneePrincipalId = reviewer.principalId;
        incident.person = reviewer.principalId; incident.assigneeId = reviewer.principalId;
        incidentReviewRequest(state).submittedById = reviewer.principalId;
        incident.resolutionReviews.unshift({ ...incidentReviewRequest(state), id: 43, submittedByPrincipalId: reviewer.principalId });
      });
      const run = runFor(id); assert.equal((await run.app.execute(incidentReviewCommand(action), reviewer.credential)).status, 'committed');
      const actual = await inspect(id); assert.equal(incidentReviewRequest(actual.head.state).selfReviewAuthorized, false);
      assert.equal(actual.head.state.incidents[0].resolutionReviews[0].status, '待审核');
      await pending(selfId, applicant.principalId, state => state.incidents[0].resolutionReviews.push({
        ...incidentReviewRequest(state), id: 43, submittedByPrincipalId: reviewer.principalId }));
      const before = await inspect(selfId);
      await assert.rejects(runFor(selfId).app.execute(incidentReviewCommand(action, 'selected', 0, { request: 43,
        applicant: applicant.principalId, submittedByPrincipalId: applicant.principalId, selfReview: false }), reviewer.credential), denied);
      await assertUnchanged(selfId, before);
    });

    await t.test(action + ': legacy missing/invalid applicant cannot be inferred from names, old IDs, employee association or payload', async () => {
      const login = await provision(['incident.resolve.approve', 'review.self']); let index = 0;
      for (const applicant of [undefined, null, '', 7, ' padded ']) {
        const id = 'incident-review-legacy-' + action + '-' + (++index);
        await pending(id, login.principalId, state => {
          const request = incidentReviewRequest(state); delete request.submittedByPrincipalId;
          if (applicant !== undefined) request.submittedByPrincipalId = applicant;
          request.submittedBy = login.principalId; request.submittedById = login.principalId;
          request.submittedByEmployeeId = login.principalId; state.incidents[0].submittedByPrincipalId = login.principalId;
        });
        const before = await inspect(id), run = runFor(id);
        await assert.rejects(run.app.execute(incidentReviewCommand(action, 'legacy', 0, {
          submittedByPrincipalId: login.principalId, applicant: 'fake-other', selfReview: false }), login.credential),
        error => denied(error) && error.reason === 'untrusted-incident-resolution-applicant');
        await assertUnchanged(id, before); assert.ok(run.calls.some(call => call.kind === 'rollback'));
      }
    });

    await t.test(action + ': reconnect after revoking approval/self grants replays original terminal; new key denied, actor/fingerprint conflicts unchanged', async () => {
      const login = await provision(['incident.resolve.approve', 'review.self']), other = await provision([]), id = 'incident-review-replay-' + action;
      await pending(id, login.principalId); const run = runFor(id), cmd = incidentReviewCommand(action), first = await run.app.execute(cmd, login.credential);
      await auth.revokePermission({ principalId: login.principalId, permissionId: 'incident.resolve.approve' });
      await auth.revokePermission({ principalId: login.principalId, permissionId: 'review.self' });
      const before = await inspect(id), reconnect = mysql.createPool(poolOptions);
      try {
        const again = runFor(id, { connectionPool: reconnect, bind: createMySqlAuthStore({ pool: reconnect, database }).bindSessionRevalidation,
          transactCommand: () => assert.fail('saved terminal must not reexecute decision or recheck applicant') });
        assert.deepEqual(await again.app.execute(cmd, login.credential), first);
        const mismatch = await again.app.execute(cmd, other.credential); assert.equal(mismatch.status, 'idempotency-conflict'); assert.equal(mismatch.reason, 'actor-mismatch');
        for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, payload: { ...cmd.payload, decisionNote: 'changed' } },
          { ...cmd, payload: { ...cmd.payload, request: 999 } },
          { ...cmd, action: action === 'approveIncidentResolution' ? 'rejectIncidentResolution' : 'approveIncidentResolution' }]) {
          const result = await again.app.execute(changed, login.credential); assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'request-mismatch');
        }
        await assert.rejects(again.app.execute({ ...cmd, operationKey: 'new', expectedRevision: 1 }, login.credential), denied);
        assert.equal(again.executions(), 0); await assertUnchanged(id, before);
      } finally { await reconnect.end(); }
    });

    await t.test(action + ': disabled/revoked/idle/absolute/credential invalidation blocks existing terminal access before operation lookup', async () => {
      for (const reason of ['disabled', 'revoked', 'idle', 'absolute', 'version']) {
        const login = await provision(['incident.resolve.approve']), applicant = await provision([]), id = 'incident-review-auth-' + action + '-' + reason;
        await pending(id, applicant.principalId); const run = runFor(id), cmd = incidentReviewCommand(action);
        await run.app.execute(cmd, login.credential); const before = await inspect(id);
        if (reason === 'disabled') await auth.disableAccount({ principalId: login.principalId });
        else if (reason === 'revoked') await auth.logout(login.token);
        else if (reason === 'version') await auth.rotateCredential({ principalId: login.principalId, password: 'synthetic-review-rotated' });
        else if (reason === 'idle') await pool.execute('UPDATE ' + table('auth_sessions') + ' SET idle_expires_at = created_at WHERE session_id=?', [login.sessionId]);
        else await pool.execute('UPDATE ' + table('auth_sessions') +
          ' SET idle_expires_at = created_at, absolute_expires_at = created_at + INTERVAL 1 MICROSECOND WHERE session_id=?', [login.sessionId]);
        run.calls.length = 0; await assert.rejects(run.app.execute(cmd, login.credential), error => error.code === 'AUTHENTICATION_REQUIRED');
        assert.equal(sqlAt(run, 'ledger_operations', 'SELECT'), -1); assert.equal(run.executions(), 1); await assertUnchanged(id, before);
      }
    });

    await t.test(action + ': stale revision and original domain rejections persist terminal without partial incident changes', async () => {
      const reviewer = await provision(['incident.resolve.approve']), applicant = await provision([]); let index = 0;
      const cases = [[() => {}, { id: 999 }, 'business-rejected'], [() => {}, { request: 999 }, 'business-rejected'],
        [state => incidentReviewRequest(state).status = '已批准', {}, 'business-rejected'],
        [state => incidentReviewRequest(state).status = '已驳回', {}, 'business-rejected'], [() => {}, {}, 'revision-conflict'],
        ...(action === 'rejectIncidentResolution' ? [[() => {}, { decisionNote: '  ' }, 'business-rejected']] : [])];
      for (const [prepare, payload, terminal] of cases) {
        const id = 'incident-review-terminal-' + action + '-' + (++index); await pending(id, applicant.principalId, prepare);
        const before = await inspect(id), run = runFor(id), cmd = incidentReviewCommand(action, 'terminal', terminal === 'revision-conflict' ? 9 : 0, payload);
        const result = await run.app.execute(cmd, reviewer.credential); assert.equal(result.status, terminal);
        const actual = await inspect(id); assert.deepEqual(actual.head, before.head); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 0);
        await auth.revokePermission({ principalId: reviewer.principalId, permissionId: 'incident.resolve.approve' });
        assert.deepEqual(await run.app.execute(cmd, reviewer.credential), result);
        await auth.grantPermission({ principalId: reviewer.principalId, permissionId: 'incident.resolve.approve' });
      }
    });

    await t.test(action + ': unknown exception after decision rolls back all state, revision, operation and audit; same key can retry', async () => {
      const reviewer = await provision(['incident.resolve.approve']), applicant = await provision([]), id = 'incident-review-unknown-' + action;
      await pending(id, applicant.principalId); const before = await inspect(id); let broken = true;
      const run = runFor(id, { transactCommand: (...args) => { const next = transact(...args); if (broken) throw Error('synthetic unknown review fault'); return next; } });
      const cmd = incidentReviewCommand(action); await assert.rejects(run.app.execute(cmd, reviewer.credential), /synthetic unknown review fault/);
      await assertUnchanged(id, before); assert.ok(run.calls.some(call => call.kind === 'rollback'));
      broken = false; assert.equal((await run.app.execute(cmd, reviewer.credential)).status, 'committed');
    });

    await t.test(action + ': audit SQL failure after head/operation writes rolls back the entire decision; same key can retry', async () => {
      const reviewer = await provision(['incident.resolve.approve']), applicant = await provision([]), id = 'incident-review-sql-' + action;
      await pending(id, applicant.principalId); const before = await inspect(id), run = runFor(id), cmd = incidentReviewCommand(action);
      await setup.query('ALTER TABLE ' + table('ledger_success_audit') +
        " ADD CONSTRAINT chk_incident_review_fault CHECK (ledger_id <> '" + id + "')");
      try {
        await assert.rejects(run.app.execute(cmd, reviewer.credential), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
        assert.ok(sqlAt(run, 'ledger_heads', 'UPDATE') >= 0); assert.ok(sqlAt(run, 'ledger_operations', 'INSERT') >= 0);
        assert.ok(run.calls.some(call => call.kind === 'rollback')); await assertUnchanged(id, before);
      } finally { await setup.query('ALTER TABLE ' + table('ledger_success_audit') + ' DROP CHECK chk_incident_review_fault'); }
      assert.equal((await run.app.execute(cmd, reviewer.credential)).status, 'committed');
      const actual = await inspect(id); assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
    });
  }

  const compete = async (id, actions, sameKey = false) => {
    const applicant = await provision([]), firstActor = await provision(['incident.resolve.approve']);
    const secondActor = sameKey ? firstActor : await provision(['incident.resolve.approve']);
    await pending(id, applicant.principalId);
    const a = await pool.getConnection(), b = await pool.getConnection();
    let unlock, signalLocked, firstWork, secondWork, timer;
    const held = new Promise(resolve => { unlock = resolve; }), locked = new Promise(resolve => { signalLocked = resolve; });
    try {
      const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id'), [[bId]] = await b.query('SELECT CONNECTION_ID() AS id');
      assert.notEqual(aId.id, bId.id); await a.query('SET SESSION innodb_lock_wait_timeout = 5'); await b.query('SET SESSION innodb_lock_wait_timeout = 5');
      const authStore = createMySqlAuthStore({ pool, database });
      const bind = connection => {
        const inner = authStore.bindSessionRevalidation(connection);
        return { async revalidateSessionInTransaction(credential) {
          const context = await inner.revalidateSessionInTransaction(credential); signalLocked(); await held; return context;
        } };
      };
      const first = runFor(id, { connectionPool: { getConnection: async () => wrapConnection(a, [], false) }, bind });
      const second = runFor(id, { connectionPool: { getConnection: async () => wrapConnection(b, [], false) } });
      firstWork = first.app.execute(incidentReviewCommand(actions[0], 'first'), firstActor.credential);
      await Promise.race([locked, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('review head/account lock timeout')), 5000); })]);
      clearTimeout(timer); let secondFinished = false;
      secondWork = second.app.execute(incidentReviewCommand(actions[1], sameKey ? 'first' : 'second'), secondActor.credential)
        .finally(() => { secondFinished = true; });
      await new Promise(resolve => setTimeout(resolve, 35));
      assert.equal(secondFinished, false); assert.ok(sqlAt(second, 'ledger_heads', 'FOR UPDATE') >= 0);
      assert.equal(sqlAt(second, 'auth_accounts', 'FOR UPDATE'), -1); unlock();
      const results = await Promise.all([firstWork, secondWork]);
      if (sameKey) assert.deepEqual(results[0], results[1]);
      else assert.deepEqual(results.map(result => result.status), ['committed', 'revision-conflict']);
      const actual = await inspect(id), request = incidentReviewRequest(actual.head.state);
      assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, sameKey ? 1 : 2); assert.equal(actual.audit.length, 1);
      assert.equal(first.executions() + second.executions(), 1); assert.equal(request.decidedByPrincipalId, firstActor.principalId);
      assert.equal(request.status, actions[0] === 'approveIncidentResolution' ? '已批准' : '已驳回');
      assert.equal(actual.head.state.incidents[0].status, actions[0] === 'approveIncidentResolution' ? '已完成' : '待处理');
      t.diagnostic('incident review race verified independent CONNECTION_ID ' + aId.id + ' / ' + bId.id + '; second waited on ledger head');
    } finally {
      clearTimeout(timer); unlock(); await Promise.allSettled([firstWork, secondWork].filter(Boolean));
      try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); }
    }
  };
  for (const actions of [['approveIncidentResolution', 'approveIncidentResolution'], ['approveIncidentResolution', 'rejectIncidentResolution'],
    ['rejectIncidentResolution', 'rejectIncidentResolution']]) {
    await t.test('incident review: two independent connections compete ' + actions.join('/') + ' at the same revision', { timeout: 10000 },
      () => compete('incident-review-race-' + actions.map(action => action.startsWith('approve') ? 'approve' : 'reject').join('-'), actions));
  }
  for (const action of INCIDENT_REVIEW_ACTIONS) {
    await t.test(action + ': two independent connections retry the identical key with exactly one decision', { timeout: 10000 },
      () => compete('incident-review-same-' + action, [action, action], true));
  }
  await t.test('incident review: the seven remaining eligible actions still fail closed even with their grants', async () => {
    const login = await provision(['incident.resolve.approve', 'rounding.approve', 'payment.collect', 'payment.settle', 'procurement.create', 'handover', 'room.open']);
    const id = 'incident-review-closed'; await pending(id, login.principalId); const before = await inspect(id);
    for (const action of ['approveRounding', 'rejectRounding', 'open', 'collect', 'settle', 'pay', 'handover'])
      await assert.rejects(runFor(id).app.execute({ ...incidentReviewCommand(action, action), action }, login.credential),
        error => denied(error) && error.reason === 'trusted-action-not-enabled');
    await assertUnchanged(id, before);
  });
}
