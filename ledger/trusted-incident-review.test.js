import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { decideIncidentResolution } from '../incidents.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { BusinessRejection } from '../shared/business-error.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { INCIDENT_REVIEW_ACTIONS, APPLICANT_PRINCIPAL, REVIEWER_PRINCIPAL, reviewDbNow as dbNow,
  seedIncidentReview, incidentReviewCommand, incidentReviewRequest } from '../test-support/trusted-incident-review-fixture.js';

const denied = error => error instanceof AuthorizationDenied && !(error instanceof BusinessRejection);
function fixture({ permissions = ['incident.resolve.approve'], applicant = APPLICANT_PRINCIPAL,
  prepare = () => {}, execute = transact, bind = true } = {}) {
  const state = initialState(); state.user = 'not-a-demo-account'; state.clock = 'not-a-business-clock';
  state.permissions = { administrator: ['管理员'] }; state.capabilities = { administrator: ['*'] }; state.administrator = true;
  state.inventory.bw.count = 0;
  state.orders.push({ id: 'historical-retail', kind: 'retail', room: null,
    sales: [{ productNameSnapshot: null, pricePerSaleUnitCents: null }], payments: [{ method: '现金', amount: 100 }] });
  seedIncidentReview(state, applicant); prepare(state);
  const memory = createMemoryLedgerStore(state, { ledgerId: 'incident-review-unit' });
  const tokenDigest = Buffer.alloc(32, 19), events = [];
  const auth = { id: REVIEWER_PRINCIPAL, permissions, enabled: true, revoked: false, version: 1, sessionVersion: 1,
    idle: '2099-01-01T00:00:00.000000Z', absolute: '2099-01-02T00:00:00.000000Z' };
  const port = {
    locateSessionByDigest: async () => ({ principalId: auth.id, sessionId: 'synthetic-incident-review-session' }),
    lockAccount: async () => { events.push('account'); return { principalId: auth.id, enabled: auth.enabled, credentialVersion: auth.version, policyAttributesConfigured: false }; },
    lockSessionById: async () => { events.push('session'); return { sessionId: 'synthetic-incident-review-session', principalId: auth.id,
      tokenDigest, revoked: auth.revoked, credentialVersion: auth.sessionVersion, idleExpiresAt: auth.idle, absoluteExpiresAt: auth.absolute }; },
    listGrants: async () => { events.push('grants'); return auth.permissions; },
    listPolicyAttributes: async () => [],
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

for (const action of INCIDENT_REVIEW_ACTIONS) {
  test(action + ': non-applicant keeps original decision semantics and unrelated historical facts', async () => {
    const f = fixture(), cmd = incidentReviewCommand(action), result = await f.app.execute(cmd, f.credential);
    const head = await f.memory.read(), incident = head.state.incidents[0], request = incidentReviewRequest(head.state);
    assert.equal(result.status, 'committed'); assert.equal(result.actorId, REVIEWER_PRINCIPAL);
    assert.equal(head.revision, 1); assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 1);
    assert.equal(request.decidedByPrincipalId, REVIEWER_PRINCIPAL); assert.equal(request.decidedBy, null);
    assert.equal(request.decidedAt, dbNow); assert.equal(request.selfReviewAuthorized, false);
    assert.equal(request.submittedByPrincipalId, APPLICANT_PRINCIPAL); assert.equal(request.submittedBy, 'Historical applicant display');
    assert.equal(request.status, action === 'approveIncidentResolution' ? '已批准' : '已驳回');
    if (action === 'approveIncidentResolution') {
      assert.equal(incident.status, '已完成'); assert.equal(incident.result, request.result); assert.equal(incident.note, request.note);
      assert.equal(incident.resolvedBy, request.submittedBy); assert.equal(incident.reviewedBy, null); assert.equal(incident.resolvedAt, dbNow);
      assert.equal(incident.lastReminderDate, '');
    } else {
      const expected = structuredClone(f.state.incidents[0]); expected.status = '待处理'; expected.resolutionReviews = [request];
      assert.deepEqual(incident, expected);
    }
    assert.equal(head.state.serial, f.state.serial);
    for (const field of ['rooms', 'orders', 'inventory', 'ledger', 'user', 'clock', 'permissions', 'capabilities', 'administrator'])
      assert.deepEqual(head.state[field], f.state[field]);
    assert.equal(head.state.inventory.bw.count, 0); assert.equal(head.state.inventory.qd.count, null); assert.equal(head.state.orders[0].room, null);
    assert.equal(head.operationResults.get(cmd.operationKey).actorId, REVIEWER_PRINCIPAL); assert.equal(head.audit[0].actorId, REVIEWER_PRINCIPAL);
    assert.deepEqual(f.events, ['head', 'account', 'session', 'grants', 'db-now', 'operation', 'transact']);
    assert.equal(Object.hasOwn(f.context(), 'actorEmployeeId'), false);
  });

  test(action + ': self requires concrete approval plus review.self; denied key remains reusable after grant', async () => {
    const f = fixture({ applicant: REVIEWER_PRINCIPAL }), cmd = incidentReviewCommand(action);
    await assert.rejects(f.app.execute(cmd, f.credential), denied); await noEffects(f);
    f.auth.permissions.push('review.self'); assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed');
    const head = await f.memory.read(); assert.equal(incidentReviewRequest(head.state).selfReviewAuthorized, true);
    assert.equal(incidentReviewRequest(head.state).decidedByPrincipalId, REVIEWER_PRINCIPAL);
    assert.equal(head.revision, 1); assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 1);
  });

  test(action + ': review.self/viewAll/backend/submit grants and demo administrator cannot replace approval permission', async () => {
    for (const permissions of [[], ['review.self'], ['backend.view'], ['incident.viewAll'], ['incident.resolve'], ['review.self', 'backend.view']]) {
      const f = fixture({ permissions, applicant: REVIEWER_PRINCIPAL });
      await assert.rejects(f.app.execute(incidentReviewCommand(action, 'denied', 0, {
        permissions: ['incident.resolve.approve', 'review.self'], role: 'administrator', actorId: 'administrator'
      }), f.credential), denied); await noEffects(f); assert.equal(f.executions(), 0);
      f.auth.permissions = ['incident.resolve.approve', 'review.self'];
      assert.equal((await f.app.execute(incidentReviewCommand(action, 'denied', 0, {
        permissions: ['incident.resolve.approve', 'review.self'], role: 'administrator', actorId: 'administrator'
      }), f.credential)).status, 'committed');
    }
  });

  test(action + ': only the selected resolution applicant decides self-review, never creator, assignee, another request or old ID', async () => {
    const f = fixture({ prepare: state => {
      const incident = state.incidents[0]; incident.submittedByPrincipalId = REVIEWER_PRINCIPAL;
      incident.actualActorPrincipalId = REVIEWER_PRINCIPAL; incident.assigneePrincipalId = REVIEWER_PRINCIPAL;
      incident.assigneeId = REVIEWER_PRINCIPAL; incident.person = REVIEWER_PRINCIPAL;
      incidentReviewRequest(state).submittedById = REVIEWER_PRINCIPAL;
      incident.resolutionReviews.unshift({ ...incidentReviewRequest(state), id: 43, submittedByPrincipalId: REVIEWER_PRINCIPAL });
    } });
    assert.equal((await f.app.execute(incidentReviewCommand(action), f.credential)).status, 'committed');
    const incident = (await f.memory.read()).state.incidents[0];
    assert.equal(incidentReviewRequest((await f.memory.read()).state).selfReviewAuthorized, false);
    assert.equal(incident.resolutionReviews[0].status, '待审核'); assert.equal(Object.hasOwn(incident.resolutionReviews[0], 'decidedByPrincipalId'), false);
    const self = fixture({ prepare: state => {
      state.incidents[0].resolutionReviews.push({ ...incidentReviewRequest(state), id: 43, submittedByPrincipalId: REVIEWER_PRINCIPAL });
    } });
    await assert.rejects(self.app.execute(incidentReviewCommand(action, 'selected-self', 0, { request: 43 }), self.credential), denied); await noEffects(self);
  });

  test(action + ': forged applicant/selfReview/assignee/approver/principal/role/time fields cannot change locked facts or trusted metadata', async () => {
    const self = fixture({ applicant: REVIEWER_PRINCIPAL });
    await assert.rejects(self.app.execute(incidentReviewCommand(action, 'fake', 0, {
      submittedBy: 'somebody else', submittedByPrincipalId: APPLICANT_PRINCIPAL, applicant: APPLICANT_PRINCIPAL,
      selfReview: false, approver: 'administrator', permissions: ['review.self'], role: 'administrator'
    }), self.credential), denied); await noEffects(self);
    const other = fixture(), result = await other.app.execute(incidentReviewCommand(action, 'fake', 0, {
      submittedBy: 'fake', submittedByPrincipalId: REVIEWER_PRINCIPAL, applicant: REVIEWER_PRINCIPAL,
      assignee: REVIEWER_PRINCIPAL, assigneeEmployeeId: REVIEWER_PRINCIPAL, selfReview: true, approver: 'fake',
      actorId: 'fake', principalId: 'fake', principal: { id: 'fake' }, decidedByPrincipalId: 'fake',
      clock: '1900-01-01', person: 'fake', permissions: ['*'], role: 'administrator', attributes: ['*']
    }), other.credential);
    assert.equal(result.status, 'committed'); const request = incidentReviewRequest((await other.memory.read()).state);
    assert.equal(request.selfReviewAuthorized, false); assert.equal(request.decidedByPrincipalId, REVIEWER_PRINCIPAL);
    assert.equal(request.submittedByPrincipalId, APPLICANT_PRINCIPAL); assert.equal(request.decidedBy, null); assert.equal(request.decidedAt, dbNow);
  });

  test(action + ': legacy missing/invalid applicant fails closed regardless of names, old IDs, employee linkage or payload', async () => {
    for (const applicant of [undefined, null, '', ' padded ', 123, { principalId: APPLICANT_PRINCIPAL }, 'x'.repeat(192)]) {
      const f = fixture({ permissions: ['incident.resolve.approve', 'review.self'], prepare: state => {
        const request = incidentReviewRequest(state); delete request.submittedByPrincipalId;
        if (applicant !== undefined) request.submittedByPrincipalId = applicant;
        request.submittedById = state.user; request.submittedBy = REVIEWER_PRINCIPAL; request.submittedByEmployeeId = REVIEWER_PRINCIPAL;
        state.incidents[0].submittedByPrincipalId = APPLICANT_PRINCIPAL; state.incidents[0].assigneePrincipalId = APPLICANT_PRINCIPAL;
      } });
      await assert.rejects(f.app.execute(incidentReviewCommand(action, 'legacy', 0, {
        submittedByPrincipalId: APPLICANT_PRINCIPAL, applicant: APPLICANT_PRINCIPAL, selfReview: false
      }), f.credential), error => denied(error) && error.reason === 'untrusted-incident-resolution-applicant'); await noEffects(f);
    }
  });

  test(action + ': revoke after success preserves terminal replay; new key denied and actor/request conflicts stay intact', async () => {
    const f = fixture({ applicant: REVIEWER_PRINCIPAL, permissions: ['incident.resolve.approve', 'review.self'] });
    const cmd = incidentReviewCommand(action), first = await f.app.execute(cmd, f.credential), before = await f.memory.read();
    f.auth.permissions = []; assert.deepEqual(await f.app.execute(cmd, f.credential), first); assert.equal(f.executions(), 1);
    await assert.rejects(f.app.execute({ ...cmd, operationKey: 'new', expectedRevision: 1 }, f.credential), denied);
    for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, payload: { ...cmd.payload, decisionNote: 'changed' } },
      { ...cmd, payload: { ...cmd.payload, request: 999 } },
      { ...cmd, action: action === 'approveIncidentResolution' ? 'rejectIncidentResolution' : 'approveIncidentResolution' }]) {
      const result = await f.app.execute(changed, f.credential); assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'request-mismatch');
    }
    f.auth.id = APPLICANT_PRINCIPAL; const result = await f.app.execute(cmd, f.credential);
    assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'actor-mismatch');
    assert.equal(f.executions(), 1); assert.deepEqual(await f.memory.read(), before);
  });

  test(action + ': disabled/revoked/expired/version-invalid authentication blocks saved terminal lookup', async () => {
    for (const invalidate of [a => a.enabled = false, a => a.revoked = true, a => a.idle = dbNow, a => a.absolute = dbNow, a => a.sessionVersion = 0]) {
      const f = fixture(), cmd = incidentReviewCommand(action); await f.app.execute(cmd, f.credential);
      const before = await f.memory.read(); invalidate(f.auth); f.events.length = 0;
      await assert.rejects(f.app.execute(cmd, f.credential), error => error.code === 'AUTHENTICATION_REQUIRED');
      assert.ok(!f.events.includes('operation')); assert.equal(f.executions(), 1); assert.deepEqual(await f.memory.read(), before);
    }
  });

  test(action + ': original pending-request and reject-note business rejections remain terminal and atomic', async () => {
    const cases = [[() => {}, { id: 999 }], [() => {}, { request: 999 }],
      [s => incidentReviewRequest(s).status = '已批准', {}], [s => incidentReviewRequest(s).status = '已驳回', {}],
      ...(action === 'rejectIncidentResolution' ? [[() => {}, { decisionNote: '  ' }]] : [])];
    for (const [prepare, payload] of cases) {
      const f = fixture({ prepare }), cmd = incidentReviewCommand(action, 'business', 0, payload);
      const result = await f.app.execute(cmd, f.credential); assert.equal(result.status, 'business-rejected');
      const head = await f.memory.read(); assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0);
      assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 0);
      f.auth.permissions = []; assert.deepEqual(await f.app.execute(cmd, f.credential), result);
    }
  });

  test(action + ': stale revision remains the same terminal after ledger advances and permission is revoked', async () => {
    const f = fixture({ permissions: ['incident.resolve.approve', 'room.clean'], prepare: s => s.rooms[0].status = '待清洁' });
    const cmd = incidentReviewCommand(action, 'stale', 1), first = await f.app.execute(cmd, f.credential);
    assert.equal(first.status, 'revision-conflict'); assert.equal(f.executions(), 0);
    await f.app.execute({ operationKey: 'clean-advance', expectedRevision: 0, action: 'clean', payload: { room: 'V01' } }, f.credential);
    const before = await f.memory.read(); f.auth.permissions = [];
    assert.deepEqual(await f.app.execute(cmd, f.credential), first); assert.deepEqual(await f.memory.read(), before);
  });

  test(action + ': demo and trusted decision business state are equal except execution identity metadata', async () => {
    const f = fixture({ prepare: s => incidentReviewRequest(s).submittedById = 'staff' });
    const demo = structuredClone(f.state); demo.user = 'administrator'; demo.clock = dbNow;
    const cmd = incidentReviewCommand(action, 'parity', 0, { decisionNote: 'x'.repeat(350) });
    const expected = transact(demo, action, cmd.payload, cmd.operationKey);
    assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed'); const actual = (await f.memory.read()).state;
    actual.user = demo.user; actual.clock = demo.clock; const request = incidentReviewRequest(actual); delete request.decidedByPrincipalId;
    request.decidedBy = incidentReviewRequest(expected).decidedBy;
    if (action === 'approveIncidentResolution') actual.incidents[0].reviewedBy = expected.incidents[0].reviewedBy;
    assert.deepEqual(actual, expected); assert.equal(request.decisionNote.length, 300);
  });
}

test('incident resolution review: direct trusted domain never reads demo identity/time or calls demo reviewer', async () => {
  for (const action of INCIDENT_REVIEW_ACTIONS) {
    const f = fixture(); await f.app.execute(incidentReviewCommand(action), f.credential); const state = structuredClone(f.state);
    for (const key of ['user', 'permissions', 'capabilities', 'administrator', 'clock']) Object.defineProperty(state, key, { get() { assert.fail('trusted domain read ' + key); } });
    decideIncidentResolution(state, action, incidentReviewCommand(action).payload, 'fake', '1900-01-01',
      () => assert.fail('trusted domain invoked demo reviewer'), { mode: 'trusted', context: f.context() });
    assert.equal(incidentReviewRequest(state).decidedByPrincipalId, REVIEWER_PRINCIPAL); assert.equal(incidentReviewRequest(state).decidedAt, dbNow);
  }
});

test('incident resolution review: missing/copied context, missing revalidation and direct self bypass fail closed', async () => {
  for (const action of INCIDENT_REVIEW_ACTIONS) {
    const f = fixture({ applicant: REVIEWER_PRINCIPAL }); await assert.rejects(f.app.execute(incidentReviewCommand(action), f.credential), denied);
    await noEffects(f); const run = context => decideIncidentResolution(structuredClone(f.state), action,
      incidentReviewCommand(action).payload, 'fake', 'fake-clock', () => true, { mode: 'trusted', context });
    assert.throws(() => run(undefined), TypeError); assert.throws(() => run({ ...f.context() }), TypeError); assert.throws(() => run(f.context()), denied);
    assert.throws(() => transact(f.state, action, {}, 'no-context', { mode: 'trusted' }), TypeError);
    const unbound = fixture({ bind: false }); await assert.rejects(unbound.app.execute(incidentReviewCommand(action), unbound.credential), /revalidation port/); await noEffects(unbound);
  }
});

test('incident resolution review: unknown exception after either decision rolls back and leaves the same key reusable', async () => {
  for (const action of INCIDENT_REVIEW_ACTIONS) {
    let broken = true; const f = fixture({ execute: (...args) => { const next = transact(...args); if (broken) throw Error('synthetic unknown review fault'); return next; } });
    const cmd = incidentReviewCommand(action); await assert.rejects(f.app.execute(cmd, f.credential), /synthetic unknown review fault/); await noEffects(f);
    broken = false; assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed'); assert.equal((await f.memory.read()).revision, 1);
  }
});
