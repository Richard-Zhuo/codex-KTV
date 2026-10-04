import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact } from '../rules.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { INVENTORY_REVIEW_ACTIONS, seedInventoryReview, inventoryReview, reviewBalance, inventoryReviewCommand } from '../test-support/trusted-inventory-review-fixture.js';

const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
const sqlAt = (run, name, verb) => run.calls.findIndex(call => call.kind === 'sql' && call.sql.includes(name) &&
  (verb.startsWith('FOR ') ? call.sql.endsWith(verb) : call.sql.startsWith(verb + ' ')));
const forged = { submittedBy: 'fake', submittedById: 'administrator', submittedByPrincipalId: 'fake', applicant: 'fake', selfReview: false,
  approver: 'fake', actorId: 'administrator', principalId: 'fake', actualActorPrincipalId: 'fake', permissions: ['inventory.approve', 'review.self'],
  role: 'administrator', clock: '1900-01-01', decidedByPrincipalId: 'fake', reviewedByPrincipalId: 'fake', before: 999, after: 999, count: 999, openedAfter: 999 };

// Extends only the existing guarded ten-table fixture; no new schema or cleanup ownership.
export async function testTrustedInventoryReviews({ t, pool, setup, auth, table, provision, seed, inspect, application,
  assertUnchanged, wrapConnection, poolOptions, database }) {
  const runFor = (id, options = {}) => application(id, { employeeBind: null, ...options });
  const createPending = (id, applicant, kind = 'drink', prepare = () => {}) => seed(id, state => {
    seedInventoryReview(state, { kind, submittedByPrincipalId: applicant }); prepare(state);
  });

  for (const action of INVENTORY_REVIEW_ACTIONS) {
    await t.test(action + ': real trusted submission then decision atomically commits original quantities/ledger and session principal on one connection', async () => {
      const applicant = await provision(['inventory.opening', 'inventory.adjust']), reviewer = await provision(['inventory.approve']);
      for (const kind of ['drink', 'consumable']) for (const before of [null, 0, 9]) for (const after of [0, 17]) {
        const id = 'inventory-review-first-' + action + '-' + kind + '-' + before + '-' + after;
        await seed(id, state => { const balance = reviewBalance(state, kind); balance.count = before;
          if (kind === 'consumable') balance.opened = 3; if (before !== null) balance.openedAt = '2026-01-01T00:00:00Z'; });
        const submit = runFor(id), product = kind === 'consumable' ? 'cons_nuts' : 'bw';
        assert.equal((await submit.app.execute({ operationKey: 'submit', expectedRevision: 0, action: kind === 'consumable' ? 'consumableStock' : 'stock',
          payload: { product, count: after, reason: 'synthetic stock count', ...(kind === 'consumable' ? { opened: 2 } : {}) } }, applicant.credential)).status, 'committed');
        const original = await inspect(id), request = original.head.state.inventoryReviews.at(-1);
        assert.equal(request.submittedByPrincipalId, applicant.principalId); assert.equal(request.submittedById, '');
        const connection = await pool.getConnection(); let borrows = 0;
        const [[activity]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [reviewer.sessionId]);
        try {
          const run = runFor(id, { connectionPool: { getConnection: async () => { borrows++; return wrapConnection(connection, [], false); } } });
          const cmd = inventoryReviewCommand(action, 'decide', 1, { ...forged, request: request.id, submittedByPrincipalId: reviewer.principalId, applicant: reviewer.principalId, selfReview: true });
          const result = await run.app.execute(cmd, reviewer.credential), actual = await inspect(id), review = actual.head.state.inventoryReviews.at(-1), approved = action === 'approveInventory';
          assert.equal(result.status, 'committed'); assert.equal(result.actorId, reviewer.principalId); assert.equal(actual.head.revision, 2);
          assert.equal(review.decidedByPrincipalId, reviewer.principalId); assert.equal(review.decidedBy, null); assert.equal(review.decidedAt, run.context().dbNow);
          assert.equal(review.submittedByPrincipalId, applicant.principalId); assert.equal(review.submittedBy, request.submittedBy); assert.equal(review.selfReviewAuthorized, false);
          assert.equal(review.status, approved ? '已批准' : '已驳回'); assert.equal(review.before, before); assert.equal(review.after, after); assert.equal(review.product, product);
          assert.equal(reviewBalance(actual.head.state, kind).count, approved ? after : before);
          if (kind === 'consumable') assert.equal(reviewBalance(actual.head.state, kind).opened, approved ? 2 : 3);
          if (approved) {
            const entry = actual.head.state.ledger.at(-1), notice = actual.head.state.notices.at(-1);
            assert.equal(entry.before, before); assert.equal(entry.after, after); assert.equal(entry.delta, after - (before ?? 0)); assert.equal(entry.counted, true);
            assert.equal(entry.source, request.source); assert.equal(entry.person, request.submittedBy); assert.equal(entry.reviewedBy, null);
            assert.equal(notice.unit, reviewBalance(original.head.state, kind).unit); assert.equal(notice.reviewedBy, null);
            for (const record of [entry, notice]) { assert.equal(record.submittedByPrincipalId, applicant.principalId); assert.equal(record.reviewedByPrincipalId, reviewer.principalId); assert.equal(record.time, run.context().dbNow); }
            assert.equal(reviewBalance(actual.head.state, kind).openedAt, before === null ? run.context().dbNow : reviewBalance(original.head.state, kind).openedAt);
            if (kind === 'consumable') { assert.equal(entry.openedBefore, 3); assert.equal(entry.openedAfter, 2); assert.equal(notice.openedBefore, 3); assert.equal(notice.openedAfter, 2); }
            else for (const field of ['openedBefore', 'openedAfter']) assert.equal(Object.hasOwn(notice, field), false);
          } else for (const field of ['inventory', 'consumables', 'ledger', 'notices']) assert.deepEqual(actual.head.state[field], original.head.state[field]);
          for (const field of ['orders', 'rooms', 'user', 'clock', 'permissions', 'capabilities', 'administrator']) assert.deepEqual(actual.head.state[field], original.head.state[field]);
          assert.equal(actual.head.state.inventory.qd.count, null); assert.equal(actual.head.state.orders[0].room, null); assert.equal(actual.head.state.orders[0].sales[0].pricePerSaleUnitCents, null);
          assert.equal(actual.operations.length, 2); assert.equal(actual.audit.length, 2);
          const operation = actual.operations.find(row => row.operation_key === 'decide'), audit = actual.audit.find(row => row.operation_key === 'decide');
          assert.equal(operation.actor_principal_id, reviewer.principalId); assert.deepEqual(operation.terminal_result, result);
          assert.equal(audit.actor_principal_id, reviewer.principalId); assert.equal(audit.action, action); assert.equal(audit.before_revision, '1'); assert.equal(audit.after_revision, '2');
          const order = [run.calls.findIndex(call => call.kind === 'begin'), sqlAt(run, 'ledger_heads', 'FOR UPDATE'), sqlAt(run, 'auth_accounts', 'FOR UPDATE'),
            sqlAt(run, 'auth_sessions', 'FOR UPDATE'), sqlAt(run, 'auth_grants', 'FOR UPDATE'), sqlAt(run, 'AS db_now', 'SELECT'), sqlAt(run, 'ledger_operations', 'SELECT'),
            run.calls.findIndex(call => call.kind === 'transact'), sqlAt(run, 'ledger_heads', 'UPDATE'), sqlAt(run, 'ledger_operations', 'INSERT'), sqlAt(run, 'ledger_success_audit', 'INSERT'), run.calls.findIndex(call => call.kind === 'commit')];
          assert.ok(order.every(index => index >= 0)); assert.deepEqual(order, [...order].sort((a, b) => a - b)); assert.equal(borrows, 1);
          assert.equal(run.calls.filter(call => call.kind === 'begin').length, 1); assert.equal(run.calls.filter(call => call.kind === 'commit').length, 1);
          assert.equal(run.calls.filter(call => call.kind === 'db-now').length, 1); assert.equal(run.context().dbNow, run.calls.find(call => call.kind === 'db-now').value);
          assert.equal(run.context().policyAttributesConfigured, false); assert.equal(sqlAt(run, 'employees', 'FOR SHARE'), -1);
          const [[afterActivity]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [reviewer.sessionId]); assert.deepEqual(afterActivity, activity);
        } finally { try { await connection.rollback(); } finally { connection.release(); } }
      }
    });

    await t.test(action + ': self needs review.self as well as inventory.approve; denied key remains free until grant', async () => {
      const login = await provision(['inventory.approve']);
      for (const kind of ['drink', 'consumable']) {
        const id = 'inventory-review-self-' + action + '-' + kind; await createPending(id, login.principalId, kind); const before = await inspect(id), run = runFor(id);
        const cmd = inventoryReviewCommand(action, 'self', 0, { ...forged, applicant: 'fake-other', submittedByPrincipalId: 'fake-other', selfReview: false });
        await assert.rejects(run.app.execute(cmd, login.credential), denied); await assertUnchanged(id, before); assert.ok(run.calls.some(call => call.kind === 'rollback'));
        await auth.grantPermission({ principalId: login.principalId, permissionId: 'review.self' });
        assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed'); const actual = await inspect(id);
        assert.equal(inventoryReview(actual.head.state).selfReviewAuthorized, true); assert.equal(inventoryReview(actual.head.state).decidedByPrincipalId, login.principalId);
        assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
        await auth.revokePermission({ principalId: login.principalId, permissionId: 'review.self' });
      }
    });

    await t.test(action + ': backend/opening/adjustment/review.self never grant inventory.approve', async () => {
      const login = await provision(['backend.view', 'inventory.opening', 'inventory.adjust', 'review.self']), id = 'inventory-review-no-grant-' + action;
      await createPending(id, login.principalId); const before = await inspect(id), run = runFor(id), cmd = inventoryReviewCommand(action, 'denied', 0, forged);
      await assert.rejects(run.app.execute(cmd, login.credential), denied); await assertUnchanged(id, before); assert.equal(run.executions(), 0);
      await auth.grantPermission({ principalId: login.principalId, permissionId: 'inventory.approve' }); assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed');
    });

    await t.test(action + ': payload cannot replace locked self-review facts in either direction', async () => {
      const reviewer = await provision(['inventory.approve']), applicant = await provision([]); const selfId = 'inventory-review-forged-self-' + action;
      await createPending(selfId, reviewer.principalId); const selfBefore = await inspect(selfId);
      await assert.rejects(runFor(selfId).app.execute(inventoryReviewCommand(action, 'fake', 0, { ...forged, applicant: applicant.principalId, submittedByPrincipalId: applicant.principalId, selfReview: false }), reviewer.credential), denied);
      await assertUnchanged(selfId, selfBefore); const otherId = 'inventory-review-forged-other-' + action; await createPending(otherId, applicant.principalId);
      const run = runFor(otherId); assert.equal((await run.app.execute(inventoryReviewCommand(action, 'fake', 0, { ...forged, applicant: reviewer.principalId,
        submittedByPrincipalId: reviewer.principalId, selfReview: true }), reviewer.credential)).status, 'committed');
      const review = inventoryReview((await inspect(otherId)).head.state); assert.equal(review.selfReviewAuthorized, false); assert.equal(review.decidedByPrincipalId, reviewer.principalId);
    });

    await t.test(action + ': legacy missing trusted applicant fails closed for both inventory kinds without name/demo/employee inference', async () => {
      const reviewer = await provision(['inventory.approve', 'review.self']); let index = 0;
      for (const kind of ['drink', 'consumable']) for (const applicant of [undefined, null, '', 7]) {
        const id = 'inventory-review-legacy-' + action + '-' + (++index); await createPending(id, reviewer.principalId, kind, state => {
          const review = inventoryReview(state); delete review.submittedByPrincipalId; if (applicant !== undefined) review.submittedByPrincipalId = applicant;
          review.submittedBy = reviewer.principalId; review.submittedById = state.user; review.employeeId = reviewer.principalId;
        });
        const before = await inspect(id); await assert.rejects(runFor(id).app.execute(inventoryReviewCommand(action, 'legacy', 0, {
          ...forged, submittedByPrincipalId: reviewer.principalId, applicant: 'fake-other', selfReview: false }), reviewer.credential),
          error => denied(error) && error.reason === 'untrusted-inventory-applicant'); await assertUnchanged(id, before);
      }
    });

    await t.test(action + ': revoke then new pool reconnect returns original terminal, never repeats inventory/ledger; new key denied', async () => {
      const login = await provision(['inventory.approve', 'review.self']), other = await provision([]);
      for (const kind of ['drink', 'consumable']) {
        const id = 'inventory-review-replay-' + action + '-' + kind; await createPending(id, login.principalId, kind);
        const cmd = inventoryReviewCommand(action), first = await runFor(id).app.execute(cmd, login.credential);
        await auth.revokePermission({ principalId: login.principalId, permissionId: 'inventory.approve' }); await auth.revokePermission({ principalId: login.principalId, permissionId: 'review.self' });
        const before = await inspect(id), reconnect = mysql.createPool(poolOptions);
        try {
          const again = runFor(id, { connectionPool: reconnect, bind: createMySqlAuthStore({ pool: reconnect, database }).bindSessionRevalidation,
            transactCommand: () => assert.fail('replay must not decide again or inspect current grants/applicant/quantity') });
          assert.deepEqual(await again.app.execute(cmd, login.credential), first); assert.equal(again.executions(), 0);
          await assert.rejects(again.app.execute({ ...cmd, operationKey: 'new', expectedRevision: 1 }, login.credential), denied);
          const actor = await again.app.execute(cmd, other.credential); assert.equal(actor.status, 'idempotency-conflict'); assert.equal(actor.reason, 'actor-mismatch');
          for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, payload: { ...cmd.payload, decisionNote: 'changed' } }, { ...cmd, action: action === 'approveInventory' ? 'rejectInventory' : 'approveInventory' }]) {
            const conflict = await again.app.execute(changed, login.credential); assert.equal(conflict.status, 'idempotency-conflict'); assert.equal(conflict.reason, 'request-mismatch');
          }
          await assertUnchanged(id, before);
        } finally { await reconnect.end(); }
        await auth.grantPermission({ principalId: login.principalId, permissionId: 'inventory.approve' }); await auth.grantPermission({ principalId: login.principalId, permissionId: 'review.self' });
      }
    });

    await t.test(action + ': disabled/revoked/idle/absolute/credential invalidation blocks old terminal before operation lookup', async () => {
      for (const invalid of ['disabled', 'revoked', 'idle', 'absolute', 'version']) {
        const reviewer = await provision(['inventory.approve']), applicant = await provision([]), id = 'inventory-review-auth-' + action + '-' + invalid;
        await createPending(id, applicant.principalId); const run = runFor(id), cmd = inventoryReviewCommand(action); await run.app.execute(cmd, reviewer.credential); const before = await inspect(id);
        if (invalid === 'disabled') await auth.disableAccount({ principalId: reviewer.principalId });
        else if (invalid === 'revoked') await auth.logout(reviewer.token);
        else if (invalid === 'version') await auth.rotateCredential({ principalId: reviewer.principalId, password: 'synthetic-inventory-review-rotated' });
        else if (invalid === 'idle') await pool.execute('UPDATE ' + table('auth_sessions') + ' SET idle_expires_at=created_at WHERE session_id=?', [reviewer.sessionId]);
        else await pool.execute('UPDATE ' + table('auth_sessions') + ' SET idle_expires_at=created_at, absolute_expires_at=created_at+INTERVAL 1 MICROSECOND WHERE session_id=?', [reviewer.sessionId]);
        run.calls.length = 0; await assert.rejects(run.app.execute(cmd, reviewer.credential), error => error.code === 'AUTHENTICATION_REQUIRED');
        assert.equal(sqlAt(run, 'ledger_operations', 'SELECT'), -1); assert.equal(run.executions(), 1); await assertUnchanged(id, before);
      }
    });

    await t.test(action + ': stale revision and original missing/processed/changed balance/reject-note rules remain terminal and atomic', async () => {
      const reviewer = await provision(['inventory.approve']), applicant = await provision([]); let index = 0;
      for (const kind of ['drink', 'consumable']) {
        const cases = [[() => {}, { request: 999 }, 'business-rejected'], [s => inventoryReview(s).status = '已驳回', {}, 'business-rejected'], [() => {}, {}, 'revision-conflict'],
          ...(action === 'approveInventory' ? [[s => reviewBalance(s, kind).count = 0, {}, 'business-rejected'],
            [s => { if (kind === 'consumable') delete s.consumables.cons_nuts; else delete s.inventory.bw; }, {}, 'business-rejected'],
            ...(kind === 'consumable' ? [[s => reviewBalance(s, kind).opened = 4, {}, 'business-rejected']] : [])] : [[() => {}, { decisionNote: '' }, 'business-rejected']])];
        for (const [prepare, payload, status] of cases) {
          const id = 'inventory-review-terminal-' + action + '-' + (++index); await createPending(id, applicant.principalId, kind, prepare); const before = await inspect(id), run = runFor(id);
          const cmd = inventoryReviewCommand(action, 'terminal', status === 'revision-conflict' ? 5 : 0, payload), result = await run.app.execute(cmd, reviewer.credential);
          assert.equal(result.status, status); const actual = await inspect(id); assert.deepEqual(actual.head, before.head); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 0);
          await auth.revokePermission({ principalId: reviewer.principalId, permissionId: 'inventory.approve' }); assert.deepEqual(await run.app.execute(cmd, reviewer.credential), result); await assertUnchanged(id, actual);
          await auth.grantPermission({ principalId: reviewer.principalId, permissionId: 'inventory.approve' });
        }
      }
    });

    await t.test(action + ': unknown fault after all decision/inventory mutations fully rolls back and repaired same key retries', async () => {
      const reviewer = await provision(['inventory.approve']), applicant = await provision([]);
      for (const kind of ['drink', 'consumable']) {
        const id = 'inventory-review-unknown-' + action + '-' + kind; await createPending(id, applicant.principalId, kind); const before = await inspect(id); let broken = true;
        const run = runFor(id, { transactCommand: (...args) => { const state = transact(...args); if (broken) throw Error('synthetic unknown inventory review fault'); return state; } });
        const cmd = inventoryReviewCommand(action); await assert.rejects(run.app.execute(cmd, reviewer.credential), /synthetic unknown inventory review fault/); await assertUnchanged(id, before);
        assert.ok(run.calls.some(call => call.kind === 'rollback')); broken = false; assert.equal((await run.app.execute(cmd, reviewer.credential)).status, 'committed');
      }
    });

    await t.test(action + ': SQL fault after state/operation writes rolls back balances, ledger, request, revision, result and audit', async () => {
      const reviewer = await provision(['inventory.approve']), applicant = await provision([]);
      for (const kind of ['drink', 'consumable']) {
        const id = 'inventory-review-sql-' + action + '-' + kind; await createPending(id, applicant.principalId, kind); const before = await inspect(id), run = runFor(id), cmd = inventoryReviewCommand(action);
        await setup.query('ALTER TABLE ' + table('ledger_success_audit') + " ADD CONSTRAINT chk_inventory_review_fault CHECK (ledger_id <> '" + id + "')");
        try {
          await assert.rejects(run.app.execute(cmd, reviewer.credential), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
          assert.ok(sqlAt(run, 'ledger_heads', 'UPDATE') >= 0); assert.ok(sqlAt(run, 'ledger_operations', 'INSERT') >= 0); assert.ok(run.calls.some(call => call.kind === 'rollback')); await assertUnchanged(id, before);
        } finally { await setup.query('ALTER TABLE ' + table('ledger_success_audit') + ' DROP CHECK chk_inventory_review_fault'); }
        assert.equal((await run.app.execute(cmd, reviewer.credential)).status, 'committed'); const actual = await inspect(id);
        assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
      }
    });

    await t.test(action + ': same key on two independent connections decides once with no repeated inventory delta', async () => {
      const reviewer = await provision(['inventory.approve', 'review.self']);
      for (const kind of ['drink', 'consumable']) {
        const id = 'inventory-review-key-race-' + action + '-' + kind; await createPending(id, reviewer.principalId, kind);
        const a = await pool.getConnection(), b = await pool.getConnection();
        try {
          const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id'), [[bId]] = await b.query('SELECT CONNECTION_ID() AS id'); assert.notEqual(aId.id, bId.id);
          const first = runFor(id, { connectionPool: { getConnection: async () => wrapConnection(a, [], false) } }), second = runFor(id, { connectionPool: { getConnection: async () => wrapConnection(b, [], false) } });
          const cmd = inventoryReviewCommand(action, 'same'), results = await Promise.all([first.app.execute(cmd, reviewer.credential), second.app.execute(cmd, reviewer.credential)]);
          assert.deepEqual(results[0], results[1]); assert.equal(results[0].status, 'committed'); assert.equal(first.executions() + second.executions(), 1);
          const actual = await inspect(id); assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
          assert.equal(inventoryReview(actual.head.state).selfReviewAuthorized, true); assert.equal(actual.head.state.ledger.length, action === 'approveInventory' ? 2 : 1);
          assert.equal(reviewBalance(actual.head.state, kind).count, action === 'approveInventory' ? 17 : null);
          t.diagnostic(action + '/' + kind + ' same-key race verified two independent CONNECTION_ID values');
        } finally { try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); } }
      }
    });
  }

  for (const kind of ['drink', 'consumable']) await t.test('inventory review: two independent connections compete approve/reject at one old revision for ' + kind, async () => {
    const reviewer = await provision(['inventory.approve']), applicant = await provision([]), id = 'inventory-review-revision-race-' + kind; await createPending(id, applicant.principalId, kind);
    const a = await pool.getConnection(), b = await pool.getConnection();
    try {
      const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id'), [[bId]] = await b.query('SELECT CONNECTION_ID() AS id'); assert.notEqual(aId.id, bId.id);
      await a.query('SET SESSION innodb_lock_wait_timeout=5'); await b.query('SET SESSION innodb_lock_wait_timeout=5');
      const first = runFor(id, { connectionPool: { getConnection: async () => wrapConnection(a, [], false) } }), second = runFor(id, { connectionPool: { getConnection: async () => wrapConnection(b, [], false) } });
      const results = await Promise.all([first.app.execute(inventoryReviewCommand('approveInventory', 'approve'), reviewer.credential), second.app.execute(inventoryReviewCommand('rejectInventory', 'reject'), reviewer.credential)]);
      assert.deepEqual(results.map(result => result.status).sort(), ['committed', 'revision-conflict']); assert.equal(first.executions() + second.executions(), 1);
      const actual = await inspect(id), approved = results[0].status === 'committed'; assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 2); assert.equal(actual.audit.length, 1);
      assert.equal(inventoryReview(actual.head.state).status, approved ? '已批准' : '已驳回'); assert.equal(reviewBalance(actual.head.state, kind).count, approved ? 17 : null);
      assert.equal(actual.head.state.ledger.length, approved ? 2 : 1); assert.equal(actual.head.state.notices.length, approved ? 1 : 0);
      t.diagnostic(kind + ' approve/reject revision race verified two independent CONNECTION_ID values');
    } finally { try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); } }
  });
}
