import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { submitStock, submitConsumableStock } from '../inventory.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { BusinessRejection } from '../shared/business-error.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { STOCK_ACTIONS, STOCK_PRINCIPAL, stockProduct, stockBalance, seedTrustedStock, stockCommand } from '../test-support/trusted-stock-fixture.js';

const dbNow = '2026-10-04T12:00:00.123456Z';
const denied = error => error instanceof AuthorizationDenied && !(error instanceof BusinessRejection);
function fixture({ permissions = ['inventory.opening'], action = 'stock', count = null,
  prepare = () => {}, execute = transact, bind = true } = {}) {
  const state = initialState(); state.user = 'not-a-demo-account'; state.clock = 'not-a-business-clock';
  state.permissions = { administrator: ['管理员'] }; state.capabilities = { administrator: ['*'] }; state.administrator = true;
  state.inventory.bw.count = 0;
  state.orders.push({ id: 'historical-retail', kind: 'retail', room: null,
    sales: [{ productNameSnapshot: null, pricePerSaleUnitCents: null }], payments: [{ method: '现金', amount: 100 }] });
  seedTrustedStock(state, action, count); prepare(state);
  const memory = createMemoryLedgerStore(state, { ledgerId: 'stock-unit' });
  const tokenDigest = Buffer.alloc(32, 15), events = [];
  const auth = { id: STOCK_PRINCIPAL, permissions, enabled: true, revoked: false, version: 1, sessionVersion: 1,
    idle: '2099-01-01T00:00:00.000000Z', absolute: '2099-01-02T00:00:00.000000Z' };
  const port = {
    locateSessionByDigest: async () => ({ principalId: auth.id, sessionId: 'synthetic-stock-session' }),
    lockAccount: async () => { events.push('account'); return { principalId: auth.id, enabled: auth.enabled, credentialVersion: auth.version }; },
    lockSessionById: async () => { events.push('session'); return { sessionId: 'synthetic-stock-session', principalId: auth.id,
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


for (const action of STOCK_ACTIONS) {
  test(action + ': null/zero/positive balances select the original permission and only create a pending request', async () => {
    for (const count of [null, 0, 9]) {
      const permission = count === null ? 'inventory.opening' : 'inventory.adjust';
      const f = fixture({ action, count, permissions: [permission] }), cmd = stockCommand(action);
      const result = await f.app.execute(cmd, f.credential), head = await f.memory.read(), review = head.state.inventoryReviews.at(-1);
      assert.equal(result.status, 'committed'); assert.equal(result.actorId, STOCK_PRINCIPAL); assert.equal(head.revision, 1);
      assert.equal(review.submittedByPrincipalId, STOCK_PRINCIPAL); assert.equal(review.submittedBy, null); assert.equal(review.submittedById, '');
      assert.equal(review.submittedAt, dbNow); assert.equal(review.status, '待审核'); assert.equal(review.before, count); assert.equal(review.after, 17);
      assert.equal(review.kind, action === 'stock' ? 'drink' : 'consumable'); assert.equal(review.product, stockProduct(action));
      assert.equal(review.source, (action === 'consumableStock' ? '消耗品' : '') + (count === null ? '期初建账' : '盘点调整'));
      if (action === 'consumableStock') { assert.equal(review.openedBefore, 3); assert.equal(review.openedAfter, 2); }
      for (const field of ['orders', 'inventory', 'consumables', 'ledger', 'notices', 'user', 'clock', 'permissions', 'capabilities', 'administrator'])
        assert.deepEqual(head.state[field], f.state[field]);
      assert.equal(stockBalance(head.state, action).count, count); assert.equal(head.state.inventory.qd.count, null);
      assert.equal(head.state.orders[0].room, null); assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 1);
      assert.equal(head.operationResults.get(cmd.operationKey).actorId, STOCK_PRINCIPAL); assert.equal(head.audit[0].actorId, STOCK_PRINCIPAL);
      assert.deepEqual(f.events, ['head', 'account', 'session', 'grants', 'db-now', 'operation', 'transact']);
    }
  });

  test(action + ': wrong opening/adjustment grant cannot be selected by payload; denied key remains reusable', async () => {
    for (const count of [null, 0, 9]) {
      const required = count === null ? 'inventory.opening' : 'inventory.adjust', wrong = count === null ? 'inventory.adjust' : 'inventory.opening';
      const f = fixture({ action, count, permissions: [wrong] });
      const cmd = stockCommand(action, 'grant-selection', 0, { before: count === null ? 0 : null, source: 'forged', inventory: { count: count === null ? 0 : null },
        actorId: 'administrator', submittedByPrincipalId: 'fake', permissions: [required], role: 'administrator' });
      await assert.rejects(f.app.execute(cmd, f.credential), denied); await noEffects(f);
      assert.equal(f.executions(), 1); // Domain selects the exact grant from the locked balance.
      f.auth.permissions = [required]; assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed');
      const head = await f.memory.read(); assert.equal(head.revision, 1); assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 1);
      assert.equal(head.state.inventoryReviews[0].before, count);
    }
  });

  test(action + ': backend/approval/self-review and forged identity cannot grant submission permission or overwrite applicant/time', async () => {
    const payload = { submittedBy: 'fake', submittedById: 'administrator', submittedByPrincipalId: 'fake', applicant: 'fake',
      actualActorPrincipalId: 'fake', actorId: 'administrator', principalId: 'fake', person: 'fake', user: 'administrator',
      permissions: ['inventory.opening', 'inventory.adjust'], role: 'administrator', clock: '1900-01-01', dbNow: 'fake', submittedAt: 'fake' };
    for (const permissions of [[], ['backend.view'], ['inventory.approve', 'review.self']]) {
      const f = fixture({ action, permissions }); await assert.rejects(f.app.execute(stockCommand(action, 'fake', 0, payload), f.credential), denied);
      await noEffects(f); assert.equal(f.executions(), 0);
    }
    const f = fixture({ action }); await f.app.execute(stockCommand(action, 'fake', 0, payload), f.credential);
    const review = (await f.memory.read()).state.inventoryReviews[0];
    assert.equal(review.submittedByPrincipalId, STOCK_PRINCIPAL); assert.equal(review.submittedById, '');
    assert.equal(review.submittedBy, null); assert.equal(review.submittedAt, dbNow);
  });

  test(action + ': revoke preserves terminal replay; new key denied and actor/payload/revision/action conflicts remain', async () => {
    const f = fixture({ action }), cmd = stockCommand(action), first = await f.app.execute(cmd, f.credential), before = await f.memory.read();
    f.auth.permissions = []; assert.deepEqual(await f.app.execute(cmd, f.credential), first); assert.equal(f.executions(), 1);
    await assert.rejects(f.app.execute({ ...cmd, operationKey: 'new', expectedRevision: 1 }, f.credential), denied);
    for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, payload: { ...cmd.payload, count: 18 } },
      { ...cmd, action: action === 'stock' ? 'consumableStock' : 'stock' }]) {
      const conflict = await f.app.execute(changed, f.credential); assert.equal(conflict.status, 'idempotency-conflict'); assert.equal(conflict.reason, 'request-mismatch');
    }
    f.auth.id = 'synthetic-other-actor'; const conflict = await f.app.execute(cmd, f.credential);
    assert.equal(conflict.status, 'idempotency-conflict'); assert.equal(conflict.reason, 'actor-mismatch');
    assert.deepEqual(await f.memory.read(), before); assert.equal(f.executions(), 1);
  });

  test(action + ': invalid account/session refuses old result before operation lookup', async () => {
    for (const invalidate of [a => a.enabled = false, a => a.revoked = true, a => a.idle = dbNow, a => a.absolute = dbNow, a => a.sessionVersion = 0]) {
      const f = fixture({ action }), cmd = stockCommand(action); await f.app.execute(cmd, f.credential); const before = await f.memory.read();
      invalidate(f.auth); f.events.length = 0;
      await assert.rejects(f.app.execute(cmd, f.credential), error => error.code === 'AUTHENTICATION_REQUIRED');
      assert.ok(!f.events.includes('operation')); assert.equal(f.executions(), 1); assert.deepEqual(await f.memory.read(), before);
    }
  });

  test(action + ': original validation failures and stale revision remain terminal without changing inventory', async () => {
    const cases = [ [{ count: -1 }, 0, 'business-rejected'], [{ count: 1.5 }, 0, 'business-rejected'], [{ count: Number.MAX_SAFE_INTEGER + 1 }, 0, 'business-rejected'],
      [{ reason: '  ' }, 0, 'business-rejected'], [{ product: 'unknown' }, 0, 'business-rejected'], [{}, 7, 'revision-conflict'],
      ...(action === 'consumableStock' ? [[{ opened: -1 }, 0, 'business-rejected'], [{ opened: 0.5 }, 0, 'business-rejected']] : []) ];
    for (const [payload, revision, status] of cases) {
      const f = fixture({ action }), cmd = stockCommand(action, 'terminal', revision, payload), result = await f.app.execute(cmd, f.credential);
      assert.equal(result.status, status); const head = await f.memory.read(); assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0);
      assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 0); f.auth.permissions = [];
      assert.deepEqual(await f.app.execute(cmd, f.credential), result);
    }
  });

  test(action + ': pending same-product review blocks another request; other products remain independent', async () => {
    const f = fixture({ action }), cmd = stockCommand(action); await f.app.execute(cmd, f.credential); const before = await f.memory.read();
    const second = stockCommand(action, 'pending', 1); const rejection = await f.app.execute(second, f.credential);
    assert.equal(rejection.status, 'business-rejected'); assert.match(rejection.reason, /已有库存盘点待审核/);
    const head = await f.memory.read(); assert.deepEqual(head.state, before.state); assert.equal(head.revision, 1);
    assert.equal(head.operationResults.size, 2); assert.equal(head.audit.length, 1);
    const product = action === 'stock' ? 'qd' : 'cons_ice';
    assert.equal((await f.app.execute(stockCommand(action, 'other-product', 1, { product }), f.credential)).status, 'committed');
    assert.equal((await f.memory.read()).state.inventoryReviews.length, 2);
  });

  test(action + ': demo/trusted retain original request/quantity/base-unit semantics after removing only identity/time metadata', async () => {
    for (const count of [null, 0, 9]) {
      const f = fixture({ action, count, permissions: [count === null ? 'inventory.opening' : 'inventory.adjust'] });
      const demo = structuredClone(f.state); demo.user = 'administrator'; demo.clock = dbNow;
      const cmd = stockCommand(action, 'parity', 0, { count: 0, reason: 'x'.repeat(350), ...(action === 'consumableStock' ? { opened: 0 } : {}) });
      const expected = transact(demo, action, cmd.payload, cmd.operationKey); await f.app.execute(cmd, f.credential);
      const actual = (await f.memory.read()).state; actual.user = demo.user; actual.clock = demo.clock;
      const review = actual.inventoryReviews[0]; delete review.submittedByPrincipalId;
      review.submittedBy = expected.inventoryReviews[0].submittedBy; review.submittedById = expected.inventoryReviews[0].submittedById;
      assert.deepEqual(actual, expected); assert.equal(review.reason.length, 300); assert.equal(review.after, 0);
    }
  });

  test(action + ': unknown fault after adding request fully rolls back; repaired original key can retry', async () => {
    let broken = true; const f = fixture({ action, execute: (...args) => { const state = transact(...args); if (broken) throw Error('synthetic stock fault'); return state; } });
    const cmd = stockCommand(action); await assert.rejects(f.app.execute(cmd, f.credential), /synthetic stock fault/); await noEffects(f);
    broken = false; assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed');
    const head = await f.memory.read(); assert.equal(head.revision, 1); assert.equal(head.state.inventoryReviews.length, 1);
  });
}

test('stock submissions: direct trusted domain does not read demo identity/permissions/clock', async () => {
  for (const action of STOCK_ACTIONS) {
    const f = fixture({ action }); await f.app.execute(stockCommand(action), f.credential); const state = structuredClone(f.state);
    for (const key of ['user', 'permissions', 'capabilities', 'administrator', 'clock']) Object.defineProperty(state, key, { get() { assert.fail('trusted domain read ' + key); } });
    const submit = action === 'stock' ? submitStock : submitConsumableStock;
    submit(state, stockCommand(action).payload, 'fake actor', 'fake clock', { mode: 'trusted', context: f.context() });
    assert.equal(state.inventoryReviews[0].submittedByPrincipalId, STOCK_PRINCIPAL); assert.equal(state.inventoryReviews[0].submittedAt, dbNow);
  }
});

test('stock submissions: missing/copied context and missing revalidation never fall back to demo', async () => {
  for (const action of STOCK_ACTIONS) {
    const f = fixture({ action }); await f.app.execute(stockCommand(action), f.credential);
    const submit = action === 'stock' ? submitStock : submitConsumableStock;
    for (const context of [undefined, { ...f.context() }]) {
      assert.throws(() => transact(f.state, action, stockCommand(action).payload, 'missing', { mode: 'trusted', context }), /可信认证上下文/);
      assert.throws(() => submit(structuredClone(f.state), stockCommand(action).payload, 'fake', 'fake', { mode: 'trusted', context }), /可信认证上下文/);
    }
    const unbound = fixture({ action, bind: false }); await assert.rejects(unbound.app.execute(stockCommand(action), unbound.credential), /revalidation port/); await noEffects(unbound);
  }
});
