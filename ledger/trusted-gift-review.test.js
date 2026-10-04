import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { total } from '../sales.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { BusinessRejection } from '../shared/business-error.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { encodeLedgerSnapshot, decodeLedgerSnapshot } from './mysql-snapshot.js';
import { giftOrder } from '../test-support/trusted-gift-fixture.js';
import { GIFT_REVIEW_ACTIONS, GIFT_APPLICANT, GIFT_REVIEWER, seedGiftReview, giftReview, giftReviewCommand } from '../test-support/trusted-gift-review-fixture.js';

const dbNow = '2026-10-04T12:00:00.123456Z';
const denied = error => error instanceof AuthorizationDenied && !(error instanceof BusinessRejection);
function fixture({ permissions = ['gift.approve'], applicant = GIFT_APPLICANT,
  prepare = () => {}, execute = transact, bind = true } = {}) {
  const state = initialState(); state.user = 'unmapped-demo-user'; state.clock = 'invalid-demo-clock';
  state.permissions = { administrator: ['administrator'] }; state.administrator = true; state.capabilities = { administrator: ['*'] };
  state.orders = [{ id: 'historical-retail', kind: 'retail', room: null,
    sales: [{ productNameSnapshot: null, pricePerSaleUnitCents: null }], payments: [{ method: 'cash', amount: 10 }, { method: 'wechat', amount: 20 }] }];
  seedGiftReview(state, applicant); prepare(state);
  const memory = createMemoryLedgerStore(state, { ledgerId: 'gift-review-unit' }), events = [], digest = Buffer.alloc(32, 16);
  const auth = { id: GIFT_REVIEWER, permissions, enabled: true, revoked: false, version: 1, sessionVersion: 1,
    idle: '2099-01-01T00:00:00.000000Z', absolute: '2099-01-02T00:00:00.000000Z' };
  const port = { locateSessionByDigest: async () => ({ principalId: auth.id, sessionId: 'synthetic-gift-review-session' }),
    lockAccount: async () => { events.push('account'); return { principalId: auth.id, enabled: auth.enabled, credentialVersion: auth.version, policyAttributesConfigured: false }; },
    lockSessionById: async () => { events.push('session'); return { principalId: auth.id, sessionId: 'synthetic-gift-review-session', tokenDigest: digest,
      revoked: auth.revoked, credentialVersion: auth.sessionVersion, idleExpiresAt: auth.idle, absoluteExpiresAt: auth.absolute }; },
    listGrants: async () => { events.push('grants'); return auth.permissions; },
    listPolicyAttributes: async () => [],
    readDbNow: async () => { events.push('db-now'); return dbNow; } };
  let executions = 0, context;
  const store = { ledgerId: memory.ledgerId, runAtomic: work => memory.runAtomic(tx => {
    events.push('head'); const find = tx.findOperationResult; tx.findOperationResult = key => { events.push('operation'); return find(key); };
    if (bind) tx.sessionRevalidation = { revalidateSessionInTransaction: async credential => { context = await revalidateSessionInTransaction({ port, ...credential }); return context; } };
    return work(tx);
  }) };
  const app = createTrustedLedgerApplication({ store, transactCommand: (...args) => {
    executions++; context = args[4].context; events.push('transact'); return execute(...args);
  } });
  return { state, memory, app, auth, events, credential: { tokenDigest: digest }, executions: () => executions, context: () => context };
}
async function noEffects(f) {
  const head = await f.memory.read(); assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0);
  assert.equal(head.operationResults.size, 0); assert.equal(head.audit.length, 0);
}

test('approveGift: non-applicant with current approval grant preserves business facts and records the session decider', async () => {
  const f = fixture(), result = await f.app.execute(giftReviewCommand('approveGift'), f.credential), head = await f.memory.read();
  assert.equal(result.status, 'committed'); assert.equal(result.actorId, GIFT_REVIEWER); assert.equal(head.revision, 1);
  const request = giftReview(head.state), bonus = giftOrder(head.state).bonusGifts.at(-1), entry = head.state.ledger.at(-1);
  assert.equal(request.status, '\u5df2\u6279\u51c6'); assert.equal(request.submittedByPrincipalId, GIFT_APPLICANT);
  assert.equal(request.decidedByPrincipalId, GIFT_REVIEWER); assert.equal(request.decidedBy, null); assert.equal(request.decidedAt, dbNow);
  assert.equal(request.selfReviewAuthorized, false); assert.equal(bonus.actualActorPrincipalId, GIFT_REVIEWER);
  assert.equal(bonus.halves, 2); assert.equal(bonus.bottles, 12); assert.equal(bonus.referenceValueCents, 11800);
  assert.equal(bonus.requestedBy, 'Applicant Display Snapshot'); assert.equal(bonus.time, dbNow);
  assert.equal(head.state.inventory.bw.count, 38); assert.equal(entry.delta, -12); assert.equal(entry.actualActorPrincipalId, GIFT_REVIEWER); assert.equal(entry.time, dbNow);
  assert.equal(total(giftOrder(head.state)), 52900); assert.deepEqual(head.state.orders[0], f.state.orders[0]);
  assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 1);
  assert.equal(head.operationResults.get('decision').actorId, GIFT_REVIEWER); assert.equal(head.audit[0].actorId, GIFT_REVIEWER);
  assert.equal(f.context().policyAttributesConfigured, false);
});

for (const action of GIFT_REVIEW_ACTIONS) {
  test(action + ': non-applicant needs only gift.approve; rejection leaves all stock and granted gifts untouched', async () => {
    const f = fixture(), cmd = giftReviewCommand(action, 'normal', 0, { decisionNote: '  ' + 'x'.repeat(305) + '  ' });
    const result = await f.app.execute(cmd, f.credential), head = await f.memory.read(), request = giftReview(head.state);
    assert.equal(result.status, 'committed'); assert.equal(request.decidedByPrincipalId, GIFT_REVIEWER);
    assert.equal(request.status, action === 'approveGift' ? '\u5df2\u6279\u51c6' : '\u5df2\u9a73\u56de');
    assert.equal(request.selfReviewAuthorized, false); assert.equal(request.decisionNote.length, 300);
    if (action === 'rejectGift') { assert.deepEqual(head.state.inventory, f.state.inventory); assert.deepEqual(head.state.ledger, f.state.ledger);
      assert.deepEqual(giftOrder(head.state).bonusGifts, giftOrder(f.state).bonusGifts); }
    for (const field of ['sales','payments','drinks','resolvedComponents','person','recordedBy','creditedEmployeeId','creditedEmployeeNameSnapshot','otherCharges','extras','credit'])
      assert.deepEqual(giftOrder(head.state)[field], giftOrder(f.state)[field]);
    assert.deepEqual(head.state.orders[0], f.state.orders[0]); assert.deepEqual(head.state.rooms, f.state.rooms);
    assert.deepEqual(giftOrder(head.state).giftRequests[0], giftOrder(f.state).giftRequests[0]);
    const { json, checksum } = encodeLedgerSnapshot(head.state); assert.deepEqual(decodeLedgerSnapshot(json, checksum), head.state);
  });

  test(action + ': self-review requires approval AND review.self; denied key can succeed after the missing grant', async () => {
    const f = fixture({ applicant: GIFT_REVIEWER }), cmd = giftReviewCommand(action);
    await assert.rejects(f.app.execute(cmd, f.credential), denied); await noEffects(f);
    f.auth.permissions.push('review.self'); assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed');
    const head = await f.memory.read(); assert.equal(giftReview(head.state).selfReviewAuthorized, true);
    assert.equal(giftReview(head.state).decidedByPrincipalId, GIFT_REVIEWER); assert.equal(head.operationResults.size, 1);
  });

  test(action + ': review.self/backend/demo identity cannot replace gift.approve', async () => {
    for (const permissions of [[], ['review.self'], ['backend.view'], ['order.gift'], ['review.self','backend.view']]) {
      const f = fixture({ permissions, applicant: GIFT_REVIEWER }), cmd = giftReviewCommand(action, 'denied', 0,
        { actorId: 'administrator', principalId: GIFT_APPLICANT, permissions: ['gift.approve','review.self'], role: 'administrator' });
      await assert.rejects(f.app.execute(cmd, f.credential), denied); await noEffects(f); assert.equal(f.executions(), 0);
    }
  });

  test(action + ': payload applicant/selfReview/approver and quantities never override locked facts', async () => {
    const self = fixture({ applicant: GIFT_REVIEWER });
    await assert.rejects(self.app.execute(giftReviewCommand(action, 'fake', 0, { submittedByPrincipalId: GIFT_APPLICANT,
      applicant: GIFT_APPLICANT, selfReview: false, permissions: ['review.self'] }), self.credential), denied); await noEffects(self);
    const f = fixture(); await f.app.execute(giftReviewCommand(action, 'fake', 0, { requestedBy: 'fake', requestedById: 'administrator',
      submittedBy: 'fake', submittedByPrincipalId: GIFT_REVIEWER, applicant: GIFT_REVIEWER, selfReview: true, approver: 'fake',
      actorId: 'fake', principalId: 'fake', permissions: ['*'], role: 'administrator', clock: '1900-01-01', decidedByPrincipalId: 'fake',
      halves: 99, product: 'qd', productId: 'qd', totalBaseQuantity: 999, employee: 'fake' }), f.credential);
    const head = await f.memory.read(), request = giftReview(head.state);
    assert.equal(request.submittedByPrincipalId, GIFT_APPLICANT); assert.equal(request.selfReviewAuthorized, false);
    assert.equal(request.decidedByPrincipalId, GIFT_REVIEWER); assert.equal(request.decidedBy, null); assert.equal(request.decidedAt, dbNow);
    assert.equal(request.requestedBy, 'Applicant Display Snapshot'); assert.equal(request.product, 'bw'); assert.equal(request.halves, 2);
    assert.equal(head.state.inventory.bw.count, action === 'approveGift' ? 38 : 50); assert.equal(head.state.inventory.qd.count, null);
  });

  test(action + ': legacy missing/invalid principal is denied without guessing from names/demo IDs/employees/payload', async () => {
    for (const applicant of [undefined, null, '', ' padded ', 123, {}, 'x'.repeat(192)]) {
      const f = fixture({ permissions: ['gift.approve','review.self'], prepare: s => {
        const request = giftReview(s); delete request.submittedByPrincipalId; if (applicant !== undefined) request.submittedByPrincipalId = applicant;
        request.requestedBy = GIFT_REVIEWER; request.requestedById = s.user; request.employeeId = GIFT_APPLICANT;
      } });
      await assert.rejects(f.app.execute(giftReviewCommand(action, 'legacy', 0, { submittedByPrincipalId: GIFT_APPLICANT, selfReview: false }), f.credential),
        error => denied(error) && error.reason === 'untrusted-gift-applicant'); await noEffects(f);
    }
  });

  test(action + ': permission revoke preserves the original terminal and new key denial; all idempotency conflicts stay intact', async () => {
    const f = fixture({ applicant: GIFT_REVIEWER, permissions: ['gift.approve','review.self'] }), cmd = giftReviewCommand(action);
    const first = await f.app.execute(cmd, f.credential), before = await f.memory.read(); f.auth.permissions = [];
    assert.deepEqual(await f.app.execute(cmd, f.credential), first); assert.equal(f.executions(), 1);
    await assert.rejects(f.app.execute({ ...cmd, operationKey: 'new', expectedRevision: 1 }, f.credential), denied);
    for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, payload: { ...cmd.payload, decisionNote: 'changed' } },
      { ...cmd, action: action === 'approveGift' ? 'rejectGift' : 'approveGift' }]) {
      const result = await f.app.execute(changed, f.credential); assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'request-mismatch');
    }
    f.auth.id = GIFT_APPLICANT; const conflict = await f.app.execute(cmd, f.credential);
    assert.equal(conflict.status, 'idempotency-conflict'); assert.equal(conflict.reason, 'actor-mismatch'); assert.deepEqual(await f.memory.read(), before);
  });

  test(action + ': disabled/revoked/expired/version-invalid session cannot access saved results', async () => {
    for (const invalid of [a => a.enabled = false, a => a.revoked = true, a => a.idle = dbNow, a => a.absolute = dbNow, a => a.sessionVersion = 0]) {
      const f = fixture(), cmd = giftReviewCommand(action); await f.app.execute(cmd, f.credential); const before = await f.memory.read();
      invalid(f.auth); f.events.length = 0; await assert.rejects(f.app.execute(cmd, f.credential), e => e.code === 'AUTHENTICATION_REQUIRED');
      assert.equal(f.events.includes('operation'), false); assert.equal(f.executions(), 1); assert.deepEqual(await f.memory.read(), before);
    }
  });

  test(action + ': original order/request/stock/note rules reject atomically and remain business terminal', async () => {
    const cases = [[{ order: 'missing' }, () => {}], [{}, s => giftOrder(s).status = '\u5df2\u7ed3\u8d26'],
      [{ request: 999 }, () => {}], [{ request: '1001' }, () => {}], [{}, s => giftReview(s).status = '\u5df2\u6279\u51c6'],
      ...(action === 'approveGift' ? [[{}, s => s.inventory.bw.count = 11], [{}, s => delete s.inventory.bw],
        [{}, s => giftReview(s).product = 'unknown'], [{}, s => { const p = s.catalog.products.find(p => p.id === 'bw'); p.saleOptions = p.saleOptions.filter(o => o.id !== 'half'); }]]
        : [[{ decisionNote: '  ' }, () => {}]])];
    for (const [changes, prepare] of cases) {
      const f = fixture({ prepare }), cmd = giftReviewCommand(action, 'business', 0, changes), first = await f.app.execute(cmd, f.credential);
      assert.equal(first.status, 'business-rejected'); const head = await f.memory.read(); assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0);
      assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 0); f.auth.permissions = [];
      assert.deepEqual(await f.app.execute(cmd, f.credential), first); assert.deepEqual(await f.memory.read(), head);
    }
  });

  test(action + ': stale revision remains terminal after another command succeeds', async () => {
    const f = fixture(), cmd = giftReviewCommand(action, 'stale', 9), first = await f.app.execute(cmd, f.credential);
    assert.equal(first.status, 'revision-conflict'); assert.equal(f.executions(), 0);
    await f.app.execute(giftReviewCommand(action, 'other'), f.credential); const before = await f.memory.read(); f.auth.permissions = [];
    assert.deepEqual(await f.app.execute(cmd, f.credential), first); assert.deepEqual(await f.memory.read(), before);
  });

  test(action + ': demo/trusted share the same quantity, inventory, note and historical snapshot business rules', async () => {
    for (const count of [null, 50]) {
      const f = fixture({ prepare: s => { s.inventory.bw.count = count; giftReview(s).requestedById = 'staff'; } });
      const demo = structuredClone(f.state); demo.user = 'boss'; demo.clock = dbNow; const cmd = giftReviewCommand(action);
      const expected = transact(demo, action, cmd.payload, cmd.operationKey); await f.app.execute(cmd, f.credential); const actual = (await f.memory.read()).state;
      actual.user = expected.user; actual.clock = expected.clock; const request = giftReview(actual);
      delete request.decidedByPrincipalId; request.decidedBy = giftReview(expected).decidedBy;
      for (const [i, entry] of actual.ledger.entries()) if (i >= f.state.ledger.length) { delete entry.actualActorPrincipalId; entry.person = expected.ledger[i].person; }
      if (action === 'approveGift') { const bonus = giftOrder(actual).bonusGifts.at(-1), other = giftOrder(expected).bonusGifts.at(-1);
        delete bonus.actualActorPrincipalId; bonus.person = other.person; }
      assert.deepEqual(actual, expected);
    }
  });
}

test('gift approval: null and zero remain distinct and uncounted/unmanaged inventory behavior stays unchanged', async () => {
  for (const count of [null, 0, 11, 12]) {
    const f = fixture({ prepare: s => s.inventory.bw.count = count }), result = await f.app.execute(giftReviewCommand('approveGift'), f.credential);
    const head = await f.memory.read(); assert.equal(result.status, count === 0 || count === 11 ? 'business-rejected' : 'committed');
    if (result.status === 'committed') { assert.equal(head.state.inventory.bw.count, count === null ? null : 0); assert.equal(head.state.ledger.at(-1).counted, count !== null); }
    else assert.deepEqual(head.state, f.state);
  }
  const f = fixture({ prepare: s => { s.inventory.bw.count = 0; s.catalog.products.find(p => p.id === 'bw').inventoryManaged = false; } });
  await f.app.execute(giftReviewCommand('approveGift'), f.credential); const head = await f.memory.read(); assert.equal(head.state.inventory.bw.count, 0); assert.deepEqual(head.state.ledger, f.state.ledger);
});

test('gift approvals: missing/copied context or session port never falls back to demo; direct trusted transact enforces self/legacy/base checks', async () => {
  const f = fixture(); await f.app.execute(giftReviewCommand('rejectGift'), f.credential);
  for (const action of GIFT_REVIEW_ACTIONS) {
    for (const context of [undefined, { ...f.context() }]) assert.throws(() => transact(f.state, action, giftReviewCommand(action).payload, 'direct', { mode: 'trusted', context }), /\u53ef\u4fe1\u8ba4\u8bc1\u4e0a\u4e0b\u6587/);
    for (const options of [{ applicant: GIFT_REVIEWER }, { permissions: [] }, { prepare: s => delete giftReview(s).submittedByPrincipalId }]) {
      const deniedActor = fixture(options); await assert.rejects(deniedActor.app.execute(giftReviewCommand(action), deniedActor.credential), denied);
      assert.throws(() => transact(deniedActor.state, action, giftReviewCommand(action).payload, 'direct', { mode: 'trusted', context: deniedActor.context() }), denied);
    }
    const unbound = fixture({ bind: false }); await assert.rejects(unbound.app.execute(giftReviewCommand(action), unbound.credential), /revalidation port/); await noEffects(unbound);
  }
  for (const action of ['expense','incident','credit','repay','approveRounding','settle','handover','open']) {
    await assert.rejects(f.app.execute({ ...giftReviewCommand(action,action,1), action }, f.credential), e => denied(e) && e.reason === 'trusted-action-not-enabled');
  }
});

test('gift decisions: unknown failure after domain mutation rolls back state/revision/operation/audit and permits original-key retry', async () => {
  for (const action of GIFT_REVIEW_ACTIONS) {
    let broken = true; const f = fixture({ execute: (...args) => { const state = transact(...args); if (broken) throw Error('synthetic gift decision failure'); return state; } });
    const cmd = giftReviewCommand(action); await assert.rejects(f.app.execute(cmd, f.credential), /synthetic gift decision failure/); await noEffects(f);
    broken = false; assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed'); assert.equal((await f.memory.read()).revision, 1);
  }
});
