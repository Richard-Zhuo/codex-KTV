import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { decideInventory } from '../inventory.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { BusinessRejection } from '../shared/business-error.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { encodeLedgerSnapshot, decodeLedgerSnapshot } from './mysql-snapshot.js';
import { authorizeReviewCommand, createTrustedReviewFacts } from './command-policy.js';
import { INVENTORY_REVIEW_ACTIONS, INVENTORY_REVIEWER, INVENTORY_APPLICANT, seedInventoryReview, inventoryReview, reviewBalance, inventoryReviewCommand } from '../test-support/trusted-inventory-review-fixture.js';

const dbNow = '2026-10-04T12:00:00.123456Z';
const denied = error => error instanceof AuthorizationDenied && !(error instanceof BusinessRejection);
function fixture({ permissions = ['inventory.approve'], applicant = INVENTORY_APPLICANT, kind = 'drink', before = null, after = 17,
  prepare = () => {}, execute = transact, bind = true } = {}) {
  const state = initialState(); state.user = 'not-a-demo-account'; state.clock = 'not-a-business-clock';
  state.permissions = { administrator: ['管理员'] }; state.capabilities = { administrator: ['*'] }; state.administrator = true;
  state.inventory.bw.count = 0;
  state.orders.push({ id: 'historical-retail', kind: 'retail', room: null,
    sales: [{ productNameSnapshot: null, pricePerSaleUnitCents: null }], payments: [{ method: '现金', amount: 100 }] });
  seedInventoryReview(state, { kind, before, after, submittedByPrincipalId: applicant }); prepare(state);
  const memory = createMemoryLedgerStore(state, { ledgerId: 'inventory-review-unit' });
  const tokenDigest = Buffer.alloc(32, 15), events = [];
  const auth = { id: INVENTORY_REVIEWER, permissions, enabled: true, revoked: false, version: 1, sessionVersion: 1,
    idle: '2099-01-01T00:00:00.000000Z', absolute: '2099-01-02T00:00:00.000000Z' };
  const port = {
    locateSessionByDigest: async () => ({ principalId: auth.id, sessionId: 'synthetic-inventory-review-session' }),
    lockAccount: async () => { events.push('account'); return { principalId: auth.id, enabled: auth.enabled, credentialVersion: auth.version }; },
    lockSessionById: async () => { events.push('session'); return { sessionId: 'synthetic-inventory-review-session', principalId: auth.id,
      tokenDigest, revoked: auth.revoked, credentialVersion: auth.sessionVersion, idleExpiresAt: auth.idle, absoluteExpiresAt: auth.absolute }; },
    listGrants: async () => { events.push('grants'); return auth.permissions; },
    readDbNow: async () => { events.push('db-now'); return dbNow; }
  };
  let context, executions = 0;
  const store = { ledgerId: memory.ledgerId, runAtomic: work => memory.runAtomic(tx => {
    events.push('head'); const find = tx.findOperationResult;
    tx.findOperationResult = key => { events.push('operation'); return find(key); };
    if (bind) tx.sessionRevalidation = { revalidateSessionInTransaction: async credential => { context = await revalidateSessionInTransaction({ port, ...credential }); return context; } };
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


for (const action of INVENTORY_REVIEW_ACTIONS) {
  test(action + ': non-applicant decisions preserve original null/zero/positive inventory and opened/base-unit rules', async () => {
    for (const kind of ['drink', 'consumable']) for (const before of [null, 0, 9]) for (const after of [0, 17]) {
      const f = fixture({ kind, before, after }), cmd = inventoryReviewCommand(action), result = await f.app.execute(cmd, f.credential);
      const head = await f.memory.read(), review = inventoryReview(head.state), approved = action === 'approveInventory';
      assert.equal(result.status, 'committed'); assert.equal(result.actorId, INVENTORY_REVIEWER); assert.equal(head.revision, 1);
      assert.equal(review.decidedByPrincipalId, INVENTORY_REVIEWER); assert.equal(review.decidedBy, null); assert.equal(review.decidedAt, dbNow);
      assert.equal(review.submittedByPrincipalId, INVENTORY_APPLICANT); assert.equal(review.submittedBy, 'historical stock submitter');
      assert.equal(review.selfReviewAuthorized, false); assert.equal(review.status, approved ? '已批准' : '已驳回');
      assert.equal(reviewBalance(head.state, kind).count, approved ? after : before);
      if (kind === 'consumable') assert.equal(reviewBalance(head.state, kind).opened, approved ? 2 : 3);
      assert.equal(head.state.ledger.length, f.state.ledger.length + (approved ? 1 : 0)); assert.equal(head.state.notices.length, approved ? 1 : 0);
      assert.deepEqual(head.state.ledger.slice(0, f.state.ledger.length), f.state.ledger);
      if (approved) {
        const entry = head.state.ledger.at(-1), notice = head.state.notices.at(-1);
        assert.equal(entry.before, before); assert.equal(entry.after, after); assert.equal(entry.delta, after - (before ?? 0)); assert.equal(entry.counted, true);
        assert.equal(entry.source, review.source); assert.equal(entry.time, dbNow); assert.equal(notice.time, dbNow);
        assert.equal(entry.person, review.submittedBy); assert.equal(entry.reviewedBy, null); assert.equal(notice.reviewedBy, null);
        for (const record of [entry, notice]) { assert.equal(record.submittedByPrincipalId, INVENTORY_APPLICANT); assert.equal(record.reviewedByPrincipalId, INVENTORY_REVIEWER); }
        assert.equal(notice.unit, reviewBalance(f.state, kind).unit);
        assert.equal(reviewBalance(head.state, kind).openedAt, before === null ? dbNow : reviewBalance(f.state, kind).openedAt);
        if (kind === 'consumable') { assert.equal(entry.openedBefore, 3); assert.equal(entry.openedAfter, 2); }
      } else {
        for (const field of ['inventory', 'consumables', 'ledger', 'notices']) assert.deepEqual(head.state[field], f.state[field]);
      }
      for (const field of ['orders', 'rooms', 'user', 'clock', 'permissions', 'capabilities', 'administrator']) assert.deepEqual(head.state[field], f.state[field]);
      assert.equal(head.state.inventory.qd.count, null); assert.equal(head.state.orders[0].room, null);
      assert.equal(head.operationResults.get(cmd.operationKey).actorId, INVENTORY_REVIEWER); assert.equal(head.audit[0].actorId, INVENTORY_REVIEWER);
      assert.deepEqual(f.events, ['head', 'account', 'session', 'grants', 'db-now', 'operation', 'transact']);
    }
  });

  test(action + ': self-review requires both approval and review.self; denial leaves key reusable after grant', async () => {
    for (const kind of ['drink', 'consumable']) {
      const f = fixture({ kind, applicant: INVENTORY_REVIEWER }), cmd = inventoryReviewCommand(action);
      await assert.rejects(f.app.execute(cmd, f.credential), denied); await noEffects(f);
      const facts = createTrustedReviewFacts({ submittedByPrincipalId: inventoryReview(f.state).submittedByPrincipalId });
      assert.equal(authorizeReviewCommand({ principal: f.context().principal, action, reviewFacts: facts }).reason, 'missing-review-self');
      f.auth.permissions.push('review.self'); assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed');
      const head = await f.memory.read(); assert.equal(inventoryReview(head.state).selfReviewAuthorized, true);
      assert.equal(inventoryReview(head.state).decidedByPrincipalId, INVENTORY_REVIEWER); assert.equal(head.revision, 1);
      assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 1);
    }
  });

  test(action + ': review.self/backend/opening/adjustment cannot replace inventory.approve', async () => {
    for (const permissions of [[], ['review.self'], ['backend.view'], ['inventory.opening', 'inventory.adjust'], ['review.self', 'backend.view']]) {
      const f = fixture({ permissions, applicant: INVENTORY_REVIEWER });
      await assert.rejects(f.app.execute(inventoryReviewCommand(action, 'forged', 0, { permissions: ['inventory.approve', 'review.self'], role: 'administrator', actorId: 'administrator' }), f.credential), denied);
      await noEffects(f); assert.equal(f.executions(), 0);
    }
  });

  test(action + ': payload applicant/selfReview/approver cannot override locked applicant in either direction or inventory facts', async () => {
    const self = fixture({ applicant: INVENTORY_REVIEWER });
    await assert.rejects(self.app.execute(inventoryReviewCommand(action, 'fake', 0, { submittedBy: 'other', submittedByPrincipalId: INVENTORY_APPLICANT,
      applicant: INVENTORY_APPLICANT, selfReview: false, approver: 'administrator', permissions: ['review.self'] }), self.credential), denied); await noEffects(self);
    const f = fixture(), cmd = inventoryReviewCommand(action, 'fake', 0, { submittedBy: 'fake', submittedByPrincipalId: INVENTORY_REVIEWER,
      applicant: INVENTORY_REVIEWER, selfReview: true, approver: 'fake', actorId: 'fake', principalId: 'fake', permissions: ['*'], role: 'administrator',
      decidedByPrincipalId: 'fake', reviewedBy: 'fake', reviewedByPrincipalId: 'fake', clock: '1900-01-01', count: 999, after: 999, before: 999, openedAfter: 999, product: 'qd' });
    assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed'); const head = await f.memory.read(), review = inventoryReview(head.state);
    assert.equal(review.selfReviewAuthorized, false); assert.equal(review.decidedByPrincipalId, INVENTORY_REVIEWER); assert.equal(review.decidedBy, null); assert.equal(review.decidedAt, dbNow);
    assert.equal(review.after, 17); assert.equal(review.product, 'bw'); assert.equal(head.state.inventory.qd.count, null);
    assert.equal(head.state.inventory.bw.count, action === 'approveInventory' ? 17 : null);
  });

  test(action + ': legacy missing/invalid applicant fails closed despite names/demo IDs/employees/payload', async () => {
    for (const kind of ['drink', 'consumable']) for (const applicant of [undefined, null, '', ' padded ', 123, {}, 'x'.repeat(192)]) {
      const f = fixture({ kind, permissions: ['inventory.approve', 'review.self'], prepare: s => {
        const review = inventoryReview(s); delete review.submittedByPrincipalId; if (applicant !== undefined) review.submittedByPrincipalId = applicant;
        review.submittedById = s.user; review.submittedBy = INVENTORY_REVIEWER; review.employeeId = INVENTORY_REVIEWER;
      } });
      await assert.rejects(f.app.execute(inventoryReviewCommand(action, 'legacy', 0, { submittedByPrincipalId: INVENTORY_APPLICANT, applicant: INVENTORY_APPLICANT, selfReview: false }), f.credential),
        error => denied(error) && error.reason === 'untrusted-inventory-applicant'); await noEffects(f);
    }
  });

  test(action + ': revoke keeps original terminal; new key denied and actor/action/payload/revision conflicts preserved', async () => {
    const f = fixture({ applicant: INVENTORY_REVIEWER, permissions: ['inventory.approve', 'review.self'] }), cmd = inventoryReviewCommand(action);
    const first = await f.app.execute(cmd, f.credential), before = await f.memory.read(); f.auth.permissions = [];
    assert.deepEqual(await f.app.execute(cmd, f.credential), first); assert.equal(f.executions(), 1);
    await assert.rejects(f.app.execute({ ...cmd, operationKey: 'new', expectedRevision: 1 }, f.credential), denied);
    for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, payload: { ...cmd.payload, decisionNote: 'changed' } },
      { ...cmd, action: action === 'approveInventory' ? 'rejectInventory' : 'approveInventory' }]) {
      const conflict = await f.app.execute(changed, f.credential); assert.equal(conflict.status, 'idempotency-conflict'); assert.equal(conflict.reason, 'request-mismatch');
    }
    f.auth.id = INVENTORY_APPLICANT; const conflict = await f.app.execute(cmd, f.credential);
    assert.equal(conflict.status, 'idempotency-conflict'); assert.equal(conflict.reason, 'actor-mismatch'); assert.deepEqual(await f.memory.read(), before);
  });

  test(action + ': invalid account/session blocks old terminal access before lookup', async () => {
    for (const invalidate of [a => a.enabled = false, a => a.revoked = true, a => a.idle = dbNow, a => a.absolute = dbNow, a => a.sessionVersion = 0]) {
      const f = fixture(), cmd = inventoryReviewCommand(action); await f.app.execute(cmd, f.credential); const before = await f.memory.read();
      invalidate(f.auth); f.events.length = 0; await assert.rejects(f.app.execute(cmd, f.credential), e => e.code === 'AUTHENTICATION_REQUIRED');
      assert.ok(!f.events.includes('operation')); assert.equal(f.executions(), 1); assert.deepEqual(await f.memory.read(), before);
    }
  });

  test(action + ': original missing/processed/drift/reject-note rules remain terminal with no partial state', async () => {
    for (const kind of ['drink', 'consumable']) {
      const cases = [[() => {}, { request: 999 }], [s => inventoryReview(s).status = '已批准', {}],
        ...(action === 'approveInventory' ? [[s => reviewBalance(s, kind).count = 0, {}], [s => { if (kind === 'consumable') delete s.consumables.cons_nuts; else delete s.inventory.bw; }, {}],
          ...(kind === 'consumable' ? [[s => reviewBalance(s, kind).opened = 4, {}]] : [])] : [[() => {}, { decisionNote: '  ' }]])];
      for (const [prepare, payload] of cases) {
        const f = fixture({ kind, prepare }), cmd = inventoryReviewCommand(action, 'business', 0, payload), result = await f.app.execute(cmd, f.credential);
        assert.equal(result.status, 'business-rejected'); const head = await f.memory.read(); assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0);
        assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 0); f.auth.permissions = [];
        assert.deepEqual(await f.app.execute(cmd, f.credential), result);
      }
      const f = fixture({ kind }), cmd = inventoryReviewCommand(action, 'stale', 7), result = await f.app.execute(cmd, f.credential);
      assert.equal(result.status, 'revision-conflict'); assert.equal(f.executions(), 0); const head = await f.memory.read();
      assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0); assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 0);
    }
  });

  test(action + ': demo/trusted business state stays identical after removing only new identity/display metadata', async () => {
    for (const kind of ['drink', 'consumable']) for (const before of [null, 0, 9]) {
      const f = fixture({ kind, before, prepare: s => inventoryReview(s).submittedById = 'staff' });
      const demo = structuredClone(f.state); demo.user = 'administrator'; demo.clock = dbNow;
      const cmd = inventoryReviewCommand(action, 'parity', 0, { decisionNote: 'x'.repeat(350) }), expected = transact(demo, action, cmd.payload, cmd.operationKey);
      await f.app.execute(cmd, f.credential); const actual = (await f.memory.read()).state; actual.user = demo.user; actual.clock = demo.clock;
      const review = inventoryReview(actual); delete review.decidedByPrincipalId; review.decidedBy = inventoryReview(expected).decidedBy;
      if (action === 'approveInventory') for (const [record, original] of [[actual.ledger.at(-1), expected.ledger.at(-1)], [actual.notices.at(-1), expected.notices.at(-1)]]) {
        delete record.submittedByPrincipalId; delete record.reviewedByPrincipalId; record.reviewedBy = original.reviewedBy;
        for (const field of ['openedBefore', 'openedAfter']) if (original[field] === undefined) delete original[field];
      }
      assert.deepEqual(actual, expected); assert.equal(review.decisionNote.length, 300);
    }
  });
}

test('inventory review: trusted direct domain never reads demo identity/time or invokes demo reviewer', async () => {
  for (const action of INVENTORY_REVIEW_ACTIONS) {
    const f = fixture(); await f.app.execute(inventoryReviewCommand(action), f.credential); const state = structuredClone(f.state);
    for (const field of ['user', 'permissions', 'capabilities', 'administrator', 'clock']) Object.defineProperty(state, field, { get() { assert.fail('trusted domain read ' + field); } });
    decideInventory(state, action, inventoryReviewCommand(action).payload, 'fake', 'fake-clock', () => assert.fail('demo reviewer invoked'), { mode: 'trusted', context: f.context() });
    assert.equal(inventoryReview(state).decidedByPrincipalId, INVENTORY_REVIEWER); assert.equal(inventoryReview(state).decidedAt, dbNow);
  }
});

test('inventory review: missing/copied context, direct self/legacy bypass and missing revalidation all fail closed', async () => {
  for (const action of INVENTORY_REVIEW_ACTIONS) {
    const f = fixture({ applicant: INVENTORY_REVIEWER }); await assert.rejects(f.app.execute(inventoryReviewCommand(action), f.credential), denied); await noEffects(f);
    const run = context => decideInventory(structuredClone(f.state), action, inventoryReviewCommand(action).payload, 'fake', 'fake-clock', () => true, { mode: 'trusted', context });
    assert.throws(() => run(undefined), /可信认证上下文/); assert.throws(() => run({ ...f.context() }), /可信认证上下文/); assert.throws(() => run(f.context()), denied);
    assert.throws(() => transact(f.state, action, {}, 'missing', { mode: 'trusted' }), /可信认证上下文/);
    const legacy = structuredClone(f.state); delete inventoryReview(legacy).submittedByPrincipalId;
    assert.throws(() => decideInventory(legacy, action, inventoryReviewCommand(action).payload, 'fake', 'fake', () => false, { mode: 'trusted', context: f.context() }), denied);
    const unbound = fixture({ bind: false }); await assert.rejects(unbound.app.execute(inventoryReviewCommand(action), unbound.credential), /revalidation port/); await noEffects(unbound);
  }
});

test('inventory review: unknown fault after quantity/ledger/decision mutations rolls back and repaired same key retries', async () => {
  for (const action of INVENTORY_REVIEW_ACTIONS) for (const kind of ['drink', 'consumable']) {
    let broken = true; const f = fixture({ kind, execute: (...args) => { const state = transact(...args); if (broken) throw Error('synthetic inventory decision fault'); return state; } });
    const cmd = inventoryReviewCommand(action); await assert.rejects(f.app.execute(cmd, f.credential), /synthetic inventory decision fault/); await noEffects(f);
    broken = false; assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed'); assert.equal((await f.memory.read()).revision, 1);
  }
});

test('inventory review: rejection after balance drift preserves the changed balances and a prior business rejection stays terminal', async () => {
  for (const kind of ['drink', 'consumable']) {
    const f = fixture({ kind, prepare: s => { reviewBalance(s, kind).count = 0; if (kind === 'consumable') reviewBalance(s, kind).opened = 5; } });
    const cmd = inventoryReviewCommand('approveInventory', 'failed'), rejected = await f.app.execute(cmd, f.credential); assert.equal(rejected.status, 'business-rejected');
    assert.equal((await f.app.execute(inventoryReviewCommand('rejectInventory', 'decline'), f.credential)).status, 'committed');
    const before = await f.memory.read(); assert.deepEqual(before.state.inventory, f.state.inventory); assert.deepEqual(before.state.consumables, f.state.consumables);
    assert.deepEqual(before.state.ledger, f.state.ledger); assert.deepEqual(await f.app.execute(cmd, f.credential), rejected);
    assert.deepEqual(await f.memory.read(), before); assert.equal(inventoryReview(before.state).status, '已驳回');
  }
});

test('inventory review: approved snapshot is JSON-safe without fabricating absent drink opened quantities', async () => {
  for (const kind of ['drink', 'consumable']) {
    const f = fixture({ kind }); await f.app.execute(inventoryReviewCommand('approveInventory'), f.credential);
    const state = (await f.memory.read()).state, notice = state.notices.at(-1);
    if (kind === 'drink') for (const field of ['openedBefore', 'openedAfter']) assert.equal(Object.hasOwn(notice, field), false);
    else { assert.equal(notice.openedBefore, 3); assert.equal(notice.openedAfter, 2); }
    const { json, checksum } = encodeLedgerSnapshot(state); assert.deepEqual(decodeLedgerSnapshot(json, checksum), state);
  }
});
