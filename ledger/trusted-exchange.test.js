import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { total } from '../sales.js';
import { effectiveUser, AuthorizationDenied } from '../shared/identity.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { EMPLOYEE_ATTRIBUTED_ACTIONS } from './employee-attribution.js';
import { seedTrustedExchange, exchangeOrder, exchangeLines, exchangeLineSelector, exchangeCommand,
  seedExistingExchangeTarget } from '../test-support/trusted-exchange-fixture.js';

const dbNow = '2026-10-04T12:00:00.123456Z';
const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
function fixture({ permissions = ['order.exchange'], prepare = () => {}, execute = transact, bind = true } = {}) {
  const state = initialState(); state.user = 'unmapped-demo-user'; state.clock = 'invalid-demo-clock';
  state.permissions = { administrator: ['管理员'] }; state.administrator = true; state.capabilities = { administrator: ['*'] };
  state.orders = [{ id: 'historical-retail', kind: 'retail', room: null, sales: [{ productNameSnapshot: null, pricePerSaleUnitCents: null }],
    payments: [{ method: '现金', amount: 10 }, { method: '微信', amount: 20 }] }];
  seedTrustedExchange(state); prepare(state);
  const memory = createMemoryLedgerStore(state, { ledgerId: 'exchange-unit' }), events = [], digest = Buffer.alloc(32, 14);
  const auth = { id: 'synthetic-exchange-actor', permissions, enabled: true, revoked: false, credentialVersion: 1, sessionVersion: 1,
    idle: '2099-01-01T00:00:00.000000Z', absolute: '2099-01-02T00:00:00.000000Z' };
  const port = { locateSessionByDigest: async () => ({ principalId: auth.id, sessionId: 'synthetic-exchange-session' }),
    lockAccount: async () => { events.push('account'); return { principalId: auth.id, enabled: auth.enabled, credentialVersion: auth.credentialVersion, policyAttributesConfigured: false }; },
    lockSessionById: async () => { events.push('session'); return { principalId: auth.id, sessionId: 'synthetic-exchange-session', tokenDigest: digest,
      revoked: auth.revoked, credentialVersion: auth.sessionVersion, idleExpiresAt: auth.idle, absoluteExpiresAt: auth.absolute }; },
    listGrants: async () => { events.push('grants'); return auth.permissions; },
    listPolicyAttributes: async () => [],
    readDbNow: async () => { events.push('db-now'); return dbNow; } };
  let executions = 0, context;
  const store = { ledgerId: memory.ledgerId, runAtomic: work => memory.runAtomic(tx => {
    events.push('head'); const find = tx.findOperationResult; tx.findOperationResult = key => { events.push('operation'); return find(key); };
    if (bind) tx.sessionRevalidation = { revalidateSessionInTransaction: credential => revalidateSessionInTransaction({ port, ...credential }) };
    return work(tx); // No employee resolver: original exchange has no employee attribution.
  }) };
  const app = createTrustedLedgerApplication({ store, transactCommand: (...args) => {
    executions++; context = args[4].context; events.push('transact'); return execute(...args);
  } });
  return { state, memory, app, auth, events, credential: { tokenDigest: digest }, executions: () => executions, context: () => context };
}
async function assertNoEffects(f) {
  const head = await f.memory.read(); assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0);
  assert.equal(head.operationResults.size, 0); assert.equal(head.audit.length, 0);
}

test('exchange: trusted actor/time and inventory use session context; all forged demo/payload facts stay inert', async () => {
  const f = fixture(), cmd = exchangeCommand('first', 0, { actorId: 'administrator', principalId: 'forged', role: 'administrator',
    permissions: ['*'], clock: '1900-01-01', user: 'administrator', person: 'forged', actualActorPrincipalId: 'forged', employee: 'untrusted-name' });
  const result = await f.app.execute(cmd, f.credential), head = await f.memory.read(), order = exchangeOrder(head.state);
  assert.equal(result.status, 'committed'); assert.equal(result.actorId, f.auth.id); assert.equal(head.revision, 1); assert.equal(f.executions(), 1);
  assert.equal(order.drinks[0].count, 17); assert.equal(order.drinks[1].count, 3); assert.equal(total(order), total(exchangeOrder(f.state)));
  assert.deepEqual(head.state.ledger.slice(-2).map(line => [line.product, line.delta, line.baseQuantityDelta, line.counted]),
    [['lm', 3, 3, true], ['soda0', -3, -3, true]]);
  assert.ok(head.state.ledger.slice(-2).every(line => line.person === f.auth.id && line.actualActorPrincipalId === f.auth.id && line.time === dbNow));
  assert.deepEqual(order.exchanges[0], { from: 'lm', to: 'soda0', fromProductId: 'lm', toProductId: 'soda0', count: 3,
    scope: '套餐', person: f.auth.id, actualActorPrincipalId: f.auth.id, time: dbNow });
  assert.equal(head.state.inventory.lm.count, 53); assert.equal(head.state.inventory.soda0.count, 17);
  assert.equal(head.state.inventory.qd.count, null); assert.equal(head.state.inventory.water.count, 0); assert.equal(head.state.orders[0].room, null);
  assert.equal(head.operationResults.get('first').actorId, f.auth.id); assert.equal(head.audit[0].actorId, f.auth.id);
  for (const field of ['sales', 'bonusGifts', 'giftRequests', 'payments', 'extras', 'resolvedComponents', 'otherCharges', 'credit',
    'packageBaseCents', 'packageGiftValueCents', 'packageNameSnapshot', 'person', 'recordedBy', 'creditedEmployeeId']) assert.deepEqual(order[field], exchangeOrder(f.state)[field]);
  assert.deepEqual(head.state.rooms, f.state.rooms); assert.deepEqual(head.state.orders[0], f.state.orders[0]);
  assert.equal(order.drinks[0].productNameSnapshot, 'Historical Opening Beer'); assert.equal(order.drinks[0].referenceValueCents, null);
  assert.deepEqual(f.events, ['head', 'account', 'session', 'grants', 'db-now', 'operation', 'transact']);
  assert.equal(f.context().dbNow, dbNow); assert.equal(Object.hasOwn(f.context(), 'creditedEmployeeId'), false);
});

test('exchange: only order.exchange grants authority; denial consumes no key and a later grant can use it', async () => {
  for (const permissions of [[], ['backend.view'], ['staff.record'], ['order.sale'], ['order.gift'], ['inventory.adjust']]) {
    const f = fixture({ permissions }), cmd = exchangeCommand('denied', 0, { actorId: 'administrator', role: 'administrator', permissions: ['order.exchange'] });
    await assert.rejects(f.app.execute(cmd, f.credential), denied); await assertNoEffects(f); assert.equal(f.executions(), 0);
    f.auth.permissions = ['order.exchange']; assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed');
  }
});

test('exchange: no new employee attribution or resolver; credited employee cannot authorize or replace the actor', async () => {
  assert.deepEqual(EMPLOYEE_ATTRIBUTED_ACTIONS, ['reserve', 'sale', 'retailSale', 'open']); const f = fixture();
  await assert.rejects(f.app.execute(exchangeCommand('attribution', 0, { creditedEmployeeId: '10000000-0000-4000-8000-000000000001' }), f.credential),
    error => denied(error) && error.reason === 'invalid-attribution');
  await assertNoEffects(f); assert.equal((await f.app.execute(exchangeCommand('attribution'), f.credential)).status, 'committed');
});

test('exchange: package/sale/existing bonus, partial/full quantities and target merging retain original amounts and snapshots', async () => {
  for (const scope of ['套餐', '增购', '赠送']) for (const existing of [false, true]) for (const full of [false, true]) {
    const f = fixture({ prepare: state => { if (existing) seedExistingExchangeTarget(state, scope); } });
    const count = full ? exchangeLines(f.state, scope)[0].count : 3;
    const originalLine = structuredClone(exchangeLines(f.state, scope)[0]), originalTarget = exchangeLines(f.state, scope)[1];
    const result = await f.app.execute(exchangeCommand('scope', 0, { line: exchangeLineSelector(scope), count }), f.credential);
    assert.equal(result.status, 'committed'); const { state } = await f.memory.read(), order = exchangeOrder(state), lines = exchangeLines(state, scope);
    assert.deepEqual(lines[0], { ...originalLine, count: originalLine.count - count });
    assert.equal(order.exchanges[0].scope, scope); assert.equal(total(order), total(exchangeOrder(f.state)));
    if (existing) assert.deepEqual(lines[1], { ...originalTarget, count: 2 + count });
    else assert.equal(lines[1].totalBaseQuantity, count);
    assert.equal(order.sales[0].amountCents, 11800); assert.equal(order.sales[0].pricePerSaleUnitCents, null);
    assert.equal(order.sales[0].baseQuantityPerSaleUnit, 12); assert.equal(order.sales[0].totalBaseQuantity, 12);
    assert.equal(order.bonusGifts[0].referenceValueCents, 5900); assert.deepEqual(order.giftRequests, exchangeOrder(f.state).giftRequests);
  }
  const f = fixture(); assert.equal((await f.app.execute(exchangeCommand('gift-alias', 0, { line: 'gift:501' }), f.credential)).status, 'committed');
  assert.equal(exchangeOrder((await f.memory.read()).state).exchanges[0].scope, '套餐');
});

test('exchange: original room/product/quantity/level checks remain atomic business terminal rejections', async () => {
  const cases = [['missing-order', { order: 'missing' }, () => {}, /账单已变化/],
    ['closed', {}, state => exchangeOrder(state).status = '已结账', /账单已变化/],
    ['zero', { count: 0 }, () => {}, /数量/], ['negative', { count: -1 }, () => {}, /数量/],
    ['fraction', { count: 1.5 }, () => {}, /数量/], ['overflow', { count: Number.MAX_SAFE_INTEGER + 1 }, () => {}, /数量/],
    ['unknown-line', { line: 999 }, () => {}, /超过可换/], ['too-many', { count: 21 }, () => {}, /超过可换/],
    ['unknown-sale', { line: 'sale:999' }, () => {}, /超过可换/], ['unknown-bonus', { line: 'bonus:999' }, () => {}, /超过可换/],
    ['same-product', { product: 'lm' }, () => {}, /同级或更低/], ['upward', { line: 'sale:601', product: 'lm' }, () => {}, /同级或更低/],
    ['selection-only', { product: 'drink' }, () => {}, /同级或更低/], ['unknown-product', { product: 'unknown' }, () => {}, /商品/],
    ['water-source', {}, state => { exchangeOrder(state).drinks[0].product = 'water'; exchangeOrder(state).drinks[0].productId = 'water'; }, /同级或更低/],
    ['target-short', {}, state => state.inventory.soda0.count = 2, /库存不足/],
    ['source-inventory-missing', {}, state => delete state.inventory.lm, /库存账/],
    ['target-inventory-missing', {}, state => delete state.inventory.soda0, /库存账/]];
  for (const [label, changes, prepare, message] of cases) {
    const f = fixture({ prepare }), cmd = exchangeCommand(label, 0, changes), result = await f.app.execute(cmd, f.credential);
    assert.equal(result.status, 'business-rejected'); assert.match(result.reason, message);
    const head = await f.memory.read(); assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0);
    assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 0); f.auth.permissions = [];
    assert.deepEqual(await f.app.execute(cmd, f.credential), result); assert.equal(f.executions(), 1);
  }
});

test('exchange: failure of the target stock leg after source return leaves no half exchange', async () => {
  const f = fixture({ prepare: state => state.inventory.soda0.count = 0 }), cmd = exchangeCommand('target-fails');
  const result = await f.app.execute(cmd, f.credential); assert.equal(result.status, 'business-rejected');
  const head = await f.memory.read(); assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0); assert.equal(head.audit.length, 0);
  assert.equal(head.state.inventory.lm.count, 50); assert.equal(head.state.inventory.soda0.count, 0); assert.equal(head.state.ledger.length, 1);
});

test('exchange: counted, null and zero stock keep original base-unit delta semantics', async () => {
  for (const [sourceCount, targetCount] of [[50, 20], [0, 20], [null, 20], [50, null], [null, null]]) {
    const f = fixture({ prepare: state => { state.inventory.lm.count = sourceCount; state.inventory.soda0.count = targetCount; } });
    assert.equal((await f.app.execute(exchangeCommand(), f.credential)).status, 'committed'); const { state } = await f.memory.read();
    assert.equal(state.inventory.lm.count, sourceCount === null ? null : sourceCount + 3);
    assert.equal(state.inventory.soda0.count, targetCount === null ? null : targetCount - 3);
    assert.deepEqual(state.ledger.slice(-2).map(line => [line.delta, line.counted]), [[3, sourceCount !== null], [-3, targetCount !== null]]);
    assert.equal(state.inventory.water.count, 0); assert.equal(state.inventory.qd.count, null);
  }
});

test('exchange: runtime non-inventory flags retain original no-stock/no-ledger behavior', async () => {
  for (const [sourceManaged, targetManaged] of [[false, true], [true, false], [false, false]]) {
    const f = fixture({ prepare: state => { state.catalog.products.find(p => p.id === 'lm').inventoryManaged = sourceManaged;
      state.catalog.products.find(p => p.id === 'soda0').inventoryManaged = targetManaged; } });
    assert.equal((await f.app.execute(exchangeCommand(), f.credential)).status, 'committed'); const { state } = await f.memory.read();
    assert.equal(state.inventory.lm.count, sourceManaged ? 53 : 50); assert.equal(state.inventory.soda0.count, targetManaged ? 17 : 20);
    assert.deepEqual(state.ledger.slice(1).map(line => [line.product, line.delta]),
      [...(sourceManaged ? [['lm', 3]] : []), ...(targetManaged ? [['soda0', -3]] : [])]);
    assert.equal(total(exchangeOrder(state)), total(exchangeOrder(f.state)));
  }
});

test('exchange: current catalog changes never reprice original charges or fabricate unknown historical snapshots', async () => {
  for (const existing of [false, true]) {
    const f = fixture({ prepare: state => { if (existing) seedExistingExchangeTarget(state, '套餐');
      for (const p of state.catalog.products.filter(p => ['lm', 'soda0'].includes(p.id))) {
        p.name = 'Current ' + p.id; p.active = false; for (const option of p.saleOptions) option.priceCents += 100;
      } } });
    assert.equal((await f.app.execute(exchangeCommand(), f.credential)).status, 'committed'); const { state } = await f.memory.read(), order = exchangeOrder(state);
    assert.equal(total(order), total(exchangeOrder(f.state))); assert.equal(order.drinks[0].productNameSnapshot, 'Historical Opening Beer');
    assert.equal(order.drinks[0].referenceValueCents, null); assert.equal(order.sales[0].pricePerSaleUnitCents, null);
    assert.equal(order.drinks[1].productNameSnapshot, existing ? 'Historical Target' : 'Current soda0');
    assert.deepEqual(order.resolvedComponents, exchangeOrder(f.state).resolvedComponents);
  }
});

test('exchange: revoked permission replays the original terminal without repeating inventory; new key is denied', async () => {
  const f = fixture(), cmd = exchangeCommand(), first = await f.app.execute(cmd, f.credential), before = await f.memory.read();
  f.auth.permissions = []; assert.deepEqual(await f.app.execute(cmd, f.credential), first);
  await assert.rejects(f.app.execute(exchangeCommand('new', 1), f.credential), denied);
  assert.equal(f.executions(), 1); assert.deepEqual(await f.memory.read(), before);
});

test('exchange: invalid auth cannot read a prior terminal even if old demo state grants all permissions', async () => {
  for (const invalidate of [f => f.auth.enabled = false, f => f.auth.revoked = true, f => f.auth.idle = dbNow,
    f => f.auth.absolute = dbNow, f => f.auth.credentialVersion++]) {
    const f = fixture(), cmd = exchangeCommand(); await f.app.execute(cmd, f.credential); const before = await f.memory.read();
    invalidate(f); f.events.length = 0; await assert.rejects(f.app.execute(cmd, f.credential), error => error.code === 'AUTHENTICATION_REQUIRED');
    assert.equal(f.events.includes('operation'), false); assert.deepEqual(await f.memory.read(), before);
  }
});

test('exchange: actor/action/payload/revision conflicts remain Stage 1 conflicts after permission revoke', async () => {
  const f = fixture(), cmd = exchangeCommand(); await f.app.execute(cmd, f.credential); const before = await f.memory.read(); f.auth.permissions = [];
  f.auth.id = 'synthetic-other-actor'; assert.equal((await f.app.execute(cmd, f.credential)).reason, 'actor-mismatch'); f.auth.id = 'synthetic-exchange-actor';
  for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, action: 'gift' }, { ...cmd, payload: { ...cmd.payload, count: 1 } }])
    assert.equal((await f.app.execute(changed, f.credential)).reason, 'request-mismatch');
  assert.equal(f.executions(), 1); assert.deepEqual(await f.memory.read(), before);
});

test('exchange: stale revision is terminal and cannot start applying inventory after later grant changes', async () => {
  const f = fixture(), cmd = exchangeCommand('stale', 99), result = await f.app.execute(cmd, f.credential);
  assert.equal(result.status, 'revision-conflict'); const before = await f.memory.read(); assert.deepEqual(before.state, f.state); assert.equal(before.revision, 0);
  assert.equal(before.operationResults.size, 1); assert.equal(before.audit.length, 0); assert.equal(f.executions(), 0);
  f.auth.permissions = []; assert.deepEqual(await f.app.execute(cmd, f.credential), result); assert.deepEqual(await f.memory.read(), before);
});

test('exchange: unexpected failure after both stock legs rolls back and repaired same key can retry', async () => {
  let fail = true; const f = fixture({ execute: (...args) => { const next = transact(...args); if (fail) throw Error('synthetic exchange fault'); return next; } });
  const cmd = exchangeCommand('retry'); await assert.rejects(f.app.execute(cmd, f.credential), /synthetic exchange fault/); await assertNoEffects(f);
  fail = false; assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed');
  const head = await f.memory.read(); assert.equal(head.revision, 1); assert.equal(head.state.ledger.length, 3); assert.equal(exchangeOrder(head.state).exchanges.length, 1);
});

test('exchange: no revalidation, missing/copied context or wrong grant never falls back to demo', async () => {
  const unbound = fixture({ bind: false }); await assert.rejects(unbound.app.execute(exchangeCommand(), unbound.credential), TypeError); await assertNoEffects(unbound);
  const f = fixture(); await f.app.execute(exchangeCommand(), f.credential);
  for (const context of [undefined, structuredClone(f.context()), { ...f.context() }])
    assert.throws(() => transact(f.state, 'exchange', exchangeCommand().payload, 'direct', { mode: 'trusted', context }), TypeError);
  const clean = fixture({ permissions: ['room.clean'], prepare: state => state.rooms[1].status = '待清洁' });
  await clean.app.execute({ operationKey: 'clean', expectedRevision: 0, action: 'clean', payload: { room: 'V02' } }, clean.credential);
  assert.throws(() => transact(f.state, 'exchange', exchangeCommand().payload, 'direct', { mode: 'trusted', context: clean.context() }), denied);
  assert.deepEqual(f.state, fixture().state);
});

test('exchange: demo and trusted modes share identical business mutations after actor/time metadata normalization', async () => {
  const f = fixture(), demo = structuredClone(f.state); demo.user = 'staff'; demo.clock = dbNow;
  const cmd = exchangeCommand('equivalence'), demoResult = transact(demo, cmd.action, cmd.payload, cmd.operationKey);
  await f.app.execute(cmd, f.credential); const trusted = (await f.memory.read()).state;
  trusted.user = demo.user; trusted.clock = demo.clock;
  for (const line of [...trusted.ledger.slice(1), ...exchangeOrder(trusted).exchanges]) {
    delete line.actualActorPrincipalId; line.person = effectiveUser(demo).name; line.time = demo.clock;
  }
  assert.deepEqual(trusted, demoResult);
});
