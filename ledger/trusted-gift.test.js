import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { total } from '../sales.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { EMPLOYEE_ATTRIBUTED_ACTIONS } from './employee-attribution.js';
import { encodeLedgerSnapshot, decodeLedgerSnapshot } from './mysql-snapshot.js';
import { seedTrustedGift, giftOrder, giftCommand } from '../test-support/trusted-gift-fixture.js';

const dbNow = '2026-10-04T12:00:00.123456Z';
const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
function fixture({ permissions = ['order.gift'], prepare = () => {}, execute = transact, bind = true } = {}) {
  const state = initialState(); state.user = 'unmapped-demo-user'; state.clock = 'invalid-demo-clock';
  state.permissions = { administrator: ['管理员'] }; state.administrator = true; state.capabilities = { administrator: ['*'] };
  state.orders = [{ id: 'historical-retail', kind: 'retail', room: null, sales: [{ productNameSnapshot: null, pricePerSaleUnitCents: null }],
    payments: [{ method: '现金', amount: 10 }, { method: '微信', amount: 20 }] }];
  seedTrustedGift(state); prepare(state);
  const memory = createMemoryLedgerStore(state, { ledgerId: 'gift-unit' }), events = [], digest = Buffer.alloc(32, 14);
  const auth = { id: 'synthetic-gift-actor', permissions, enabled: true, revoked: false, credentialVersion: 1, sessionVersion: 1,
    idle: '2099-01-01T00:00:00.000000Z', absolute: '2099-01-02T00:00:00.000000Z' };
  const port = { locateSessionByDigest: async () => ({ principalId: auth.id, sessionId: 'synthetic-gift-session' }),
    lockAccount: async () => { events.push('account'); return { principalId: auth.id, enabled: auth.enabled, credentialVersion: auth.credentialVersion, policyAttributesConfigured: false }; },
    lockSessionById: async () => { events.push('session'); return { principalId: auth.id, sessionId: 'synthetic-gift-session', tokenDigest: digest,
      revoked: auth.revoked, credentialVersion: auth.sessionVersion, idleExpiresAt: auth.idle, absoluteExpiresAt: auth.absolute }; },
    listGrants: async () => { events.push('grants'); return auth.permissions; },
    listPolicyAttributes: async () => [],
    readDbNow: async () => { events.push('db-now'); return dbNow; } };
  let executions = 0, context;
  const store = { ledgerId: memory.ledgerId, runAtomic: work => memory.runAtomic(tx => {
    events.push('head'); const find = tx.findOperationResult; tx.findOperationResult = key => { events.push('operation'); return find(key); };
    if (bind) tx.sessionRevalidation = { revalidateSessionInTransaction: async credential => { context = await revalidateSessionInTransaction({ port, ...credential }); return context; } };
    return work(tx); // No employee resolver: original gift has no employee attribution.
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

test('gift: session actor submits only excess and grants only earned halves, preserving prices and historical facts', async () => {
  const f = fixture(), cmd = giftCommand('first', 0, { actorId: 'administrator', principalId: 'forged', permissions: ['*'],
    role: 'administrator', clock: '1900-01-01', requestedBy: 'forged', submittedByPrincipalId: 'forged',
    employee: 'untrusted-employee' });
  const result = await f.app.execute(cmd, f.credential), head = await f.memory.read(), order = giftOrder(head.state);
  assert.equal(result.status, 'committed'); assert.equal(result.actorId, f.auth.id); assert.equal(head.revision, 1);
  assert.equal(head.state.inventory.bw.count, 44); assert.equal(head.state.inventory.qd.count, null); assert.equal(head.state.inventory.lm.count, 0);
  const direct = order.bonusGifts.at(-1), pending = order.giftRequests.at(-1), entry = head.state.ledger.at(-1);
  assert.equal(direct.halves, 1); assert.equal(direct.bottles, 6); assert.equal(direct.referenceValueCents, 5900);
  assert.equal(direct.actualActorPrincipalId, f.auth.id); assert.equal(direct.person, f.auth.id); assert.equal(direct.requestedBy, null); assert.equal(direct.time, dbNow);
  assert.equal(entry.actualActorPrincipalId, f.auth.id); assert.equal(entry.person, f.auth.id); assert.equal(entry.delta, -6); assert.equal(entry.time, dbNow);
  assert.equal(pending.status, '待确认'); assert.equal(pending.halves, 1); assert.equal(pending.totalBaseQuantity, 6); assert.equal(pending.referenceValueCents, 5900);
  assert.equal(pending.submittedByPrincipalId, f.auth.id); assert.equal(pending.requestedById, ''); assert.equal(pending.requestedBy, null);
  assert.equal(pending.submittedAt, dbNow); assert.equal(pending.time, dbNow); assert.equal(pending.allowanceAtRequest, 1);
  assert.equal(total(order), 52900); assert.deepEqual(order.sales, giftOrder(f.state).sales);
  for (const field of ['person','recordedBy','creditedEmployeeId','creditedEmployeeNameSnapshot','payments','drinks','resolvedComponents','extras','otherCharges','credit'])
    assert.deepEqual(order[field], giftOrder(f.state)[field]);
  assert.deepEqual(order.bonusGifts.slice(0, -1), giftOrder(f.state).bonusGifts); assert.deepEqual(order.giftRequests.slice(0, -1), giftOrder(f.state).giftRequests);
  assert.deepEqual(head.state.orders[0], f.state.orders[0]); assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 1);
  assert.equal(head.operationResults.get('first').actorId, f.auth.id); assert.equal(head.audit[0].actorId, f.auth.id);
  assert.equal(EMPLOYEE_ATTRIBUTED_ACTIONS.includes('gift'), false); assert.equal(Object.hasOwn(pending, 'creditedEmployeeId'), false);
  const { json, checksum } = encodeLedgerSnapshot(head.state); assert.deepEqual(decodeLedgerSnapshot(json, checksum), head.state);
});

test('gift: direct-only, pending-only, mixed, exhausted and already-pending allowance retain original semantics', async () => {
  const cases = [
    { purchased: 24, halves: 1, direct: 1, pending: 0 },
    { purchased: 12, halves: 1, direct: 0, pending: 1 },
    { purchased: 48, halves: 3, direct: 2, pending: 1 },
    { purchased: 24, halves: 2, direct: 1, pending: 1 },
    { purchased: 24, halves: 1, granted: 1, direct: 0, pending: 1 },
    { purchased: 24, halves: 1, waiting: 1, direct: 0, pending: 1 }
  ];
  for (const c of cases) {
    const f = fixture({ prepare: state => {
      const o = giftOrder(state); o.sales[0].totalBaseQuantity = c.purchased;
      if (c.granted) o.bonusGifts.push({ id: 730, product: 'bw', halves: 1, source: 'Historical Grant' });
      if (c.waiting) o.giftRequests.push({ id: 731, product: 'bw', halves: 1, status: '待确认', requestedBy: 'Historical Applicant' });
    } });
    await f.app.execute(giftCommand('allowance', 0, { halves: c.halves }), f.credential);
    const { state } = await f.memory.read(), o = giftOrder(state);
    assert.equal(state.inventory.bw.count, c.direct === 2 ? 38 : c.direct === 1 ? 44 : 50);
    assert.equal(state.ledger.length - f.state.ledger.length, c.direct ? 1 : 0);
    assert.equal(o.bonusGifts.length - giftOrder(f.state).bonusGifts.length, c.direct ? 1 : 0);
    assert.equal(o.giftRequests.length - giftOrder(f.state).giftRequests.length, c.pending ? 1 : 0);
    if (c.direct) { assert.equal(o.bonusGifts.at(-1).halves, c.direct); assert.equal(o.bonusGifts.at(-1).source, '每增购2打赠半打'); }
    if (c.pending) { assert.equal(o.giftRequests.at(-1).halves, c.pending); assert.equal(o.giftRequests.at(-1).status, '待确认'); }
    assert.equal(total(o), 52900); assert.deepEqual(o.payments, giftOrder(f.state).payments);
  }
});

test('gift: uncounted and zero remain distinct; pending-only never deducts; managed shortage is atomic', async () => {
  for (const count of [null, 0, 5, 6]) {
    const f = fixture({ prepare: s => s.inventory.bw.count = count }), result = await f.app.execute(giftCommand(), f.credential), head = await f.memory.read();
    if (count === 0 || count === 5) { assert.equal(result.status, 'business-rejected'); assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0); assert.equal(head.audit.length, 0); }
    else { assert.equal(result.status, 'committed'); assert.equal(head.state.inventory.bw.count, count === null ? null : 0); assert.equal(head.state.ledger.at(-1).counted, count !== null); }
  }
  const pending = fixture({ prepare: s => { s.inventory.bw.count = 0; giftOrder(s).sales[0].totalBaseQuantity = 12; } });
  assert.equal((await pending.app.execute(giftCommand(), pending.credential)).status, 'committed');
  const head = await pending.memory.read(); assert.equal(head.state.inventory.bw.count, 0); assert.deepEqual(head.state.ledger, pending.state.ledger);
  const unmanaged = fixture({ prepare: s => { s.inventory.bw.count = 0; s.catalog.products.find(p => p.id === 'bw').inventoryManaged = false; } });
  await unmanaged.app.execute(giftCommand(), unmanaged.credential); const after = await unmanaged.memory.read();
  assert.equal(after.state.inventory.bw.count, 0); assert.deepEqual(after.state.ledger, unmanaged.state.ledger);
});

test('gift: only current order.gift grants authority; denied key is reusable after grant', async () => {
  for (const permissions of [[], ['backend.view'], ['gift.approve','review.self'], ['staff.record','order.sale']]) {
    const f = fixture({ permissions }), cmd = giftCommand('denied', 0, { permissions: ['order.gift'], role: 'administrator', actorId: 'administrator' });
    await assert.rejects(f.app.execute(cmd, f.credential), denied); await assertNoEffects(f);
    f.auth.permissions.push('order.gift'); assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed');
    assert.equal((await f.memory.read()).operationResults.size, 1);
  }
});

test('gift: explicit employee attribution cannot replace actor or broaden the original non-delegated policy', async () => {
  for (const permissions of [[], ['order.gift'], ['staff.record']]) {
    const f = fixture({ permissions }); await assert.rejects(f.app.execute(giftCommand('employee', 0,
      { creditedEmployeeId: '10000000-0000-4000-8000-000000000001' }), f.credential), e => denied(e) && e.reason === 'invalid-attribution'); await assertNoEffects(f);
  }
});

test('gift: valid original actor replays after revoke without duplicate gifts, stock or requests; new key denied', async () => {
  const f = fixture(), cmd = giftCommand(), first = await f.app.execute(cmd, f.credential), before = await f.memory.read(); f.auth.permissions = [];
  assert.deepEqual(await f.app.execute(cmd, f.credential), first); assert.equal(f.executions(), 1);
  await assert.rejects(f.app.execute(giftCommand('new', 1), f.credential), denied); assert.deepEqual(await f.memory.read(), before);
});

test('gift: disabled/revoked/idle/absolute/version invalidation blocks old terminal access', async () => {
  for (const invalid of [a => a.enabled = false, a => a.revoked = true, a => a.idle = dbNow, a => a.absolute = dbNow, a => a.credentialVersion = 2]) {
    const f = fixture(), cmd = giftCommand(); await f.app.execute(cmd, f.credential); const before = await f.memory.read(); invalid(f.auth); f.events.length = 0;
    await assert.rejects(f.app.execute(cmd, f.credential), e => e.code === 'AUTHENTICATION_REQUIRED');
    assert.equal(f.events.includes('operation'), false); assert.deepEqual(await f.memory.read(), before);
  }
});

test('gift: actor/action/payload/revision changes retain Stage 1 idempotency conflicts before current authorization', async () => {
  const f = fixture(), cmd = giftCommand(); await f.app.execute(cmd, f.credential); const before = await f.memory.read(); f.auth.permissions = [];
  f.auth.id = 'synthetic-other-actor'; assert.equal((await f.app.execute(cmd, f.credential)).reason, 'actor-mismatch'); f.auth.id = 'synthetic-gift-actor';
  for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, action: 'approveGift' }, { ...cmd, payload: { ...cmd.payload, halves: 1 } }]) {
    const result = await f.app.execute(changed, f.credential); assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'request-mismatch');
  }
  assert.deepEqual(await f.memory.read(), before); assert.equal(f.executions(), 1);
});

test('gift: stale revision remains terminal after another gift commits', async () => {
  const f = fixture(), cmd = giftCommand('stale', 4), first = await f.app.execute(cmd, f.credential); assert.equal(first.status, 'revision-conflict');
  let head = await f.memory.read(); assert.equal(head.revision, 0); assert.deepEqual(head.state, f.state); assert.equal(head.audit.length, 0);
  await f.app.execute(giftCommand('other'), f.credential); head = await f.memory.read(); f.auth.permissions = [];
  assert.deepEqual(await f.app.execute(cmd, f.credential), first); assert.deepEqual(await f.memory.read(), head);
});

test('gift: original order/product/quantity/half-option/purchase/stock failures remain business terminals without partial effects', async () => {
  const cases = [[{ order: 'missing' }, () => {}, /账单已变化/], [{}, s => giftOrder(s).status = '已结账', /账单已变化/],
    ...[0,-1,1.5,'1',Number.MAX_SAFE_INTEGER + 1].map(halves => [{ halves }, () => {}, /数量/]),
    [{ product: 'unknown' }, () => {}, /商品/], [{ product: 'drink' }, () => {}, /赠酒水规则/], [{ product: 'water' }, () => {}, /赠酒水规则/],
    [{}, s => giftOrder(s).sales = [], /先增购/], [{}, s => s.inventory.bw.count = 5, /库存不足/],
    [{}, s => delete s.inventory.bw, /库存账/], [{}, s => { s.catalog.products.find(p => p.id === 'bw').saleOptions = s.catalog.products.find(p => p.id === 'bw').saleOptions.filter(o => o.id !== 'half'); }, /规格/]];
  for (const [changes, prepare, message] of cases) {
    const f = fixture({ prepare }), cmd = giftCommand('business', 0, changes), first = await f.app.execute(cmd, f.credential);
    assert.equal(first.status, 'business-rejected'); assert.match(first.reason, message); const head = await f.memory.read(); assert.deepEqual(head.state, f.state);
    assert.equal(head.revision, 0); assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 0); f.auth.permissions = [];
    assert.deepEqual(await f.app.execute(cmd, f.credential), first); assert.deepEqual(await f.memory.read(), head);
  }
});

test('gift: runtime names/spec/reference snapshots never rewrite historical unknown prices or prior gifts', async () => {
  const f = fixture({ permissions: ['order.gift','catalog.manage'] }); await f.app.execute(giftCommand(), f.credential);
  const before = (await f.memory.read()).state, p = before.catalog.products.find(p => p.id === 'bw');
  await f.app.execute({ operationKey: 'catalog', expectedRevision: 1, action: 'updateCatalogProduct', payload: { id: 'bw', name: 'Current Beer',
    saleOptions: p.saleOptions.map(o => o.id === 'half' ? { ...o, name: 'Current Half', priceCents: 6900 } : o) } }, f.credential);
  await f.app.execute(giftCommand('next', 2, { halves: 1 }), f.credential); const state = (await f.memory.read()).state, order = giftOrder(state);
  assert.deepEqual(order.bonusGifts, giftOrder(before).bonusGifts); assert.deepEqual(order.giftRequests.slice(0,-1), giftOrder(before).giftRequests);
  assert.deepEqual(order.sales, giftOrder(before).sales); assert.deepEqual(state.orders[0], before.orders[0]);
  assert.equal(order.giftRequests.at(-1).productNameSnapshot, 'Current Beer'); assert.equal(order.giftRequests.at(-1).saleOptionNameSnapshot, 'Current Half');
  assert.equal(order.giftRequests.at(-1).referenceValueCents, 6900); assert.equal(order.bonusGifts.at(-1).referenceValueCents, 5900);
});

test('gift: demo/trusted preserve original business effects after removing only trusted identity metadata', async () => {
  for (const purchased of [12,24,48]) for (const count of [null,50]) {
    const f = fixture({ prepare: s => { giftOrder(s).sales[0].totalBaseQuantity = purchased; s.inventory.bw.count = count; } });
    const demo = structuredClone(f.state); demo.user = 'administrator'; demo.clock = dbNow;
    const cmd = giftCommand(), expected = transact(demo, 'gift', cmd.payload, cmd.operationKey); await f.app.execute(cmd, f.credential);
    const actual = (await f.memory.read()).state; actual.user = expected.user; actual.clock = expected.clock;
    for (const [i, record] of actual.ledger.entries()) if (i >= f.state.ledger.length) { delete record.actualActorPrincipalId; record.person = expected.ledger[i].person; }
    const a = giftOrder(actual), b = giftOrder(expected);
    for (let i = giftOrder(f.state).bonusGifts.length; i < a.bonusGifts.length; i++) { delete a.bonusGifts[i].actualActorPrincipalId; a.bonusGifts[i].person = b.bonusGifts[i].person; a.bonusGifts[i].requestedBy = b.bonusGifts[i].requestedBy; }
    for (let i = giftOrder(f.state).giftRequests.length; i < a.giftRequests.length; i++) { delete a.giftRequests[i].submittedByPrincipalId; a.giftRequests[i].requestedBy = b.giftRequests[i].requestedBy; a.giftRequests[i].requestedById = b.giftRequests[i].requestedById; }
    assert.deepEqual(actual, expected);
  }
});

test('gift: missing/copied contexts and unbound session port fail closed; direct domain still requires current permission', async () => {
  const f = fixture(); await f.app.execute(giftCommand(), f.credential);
  for (const context of [undefined, { ...f.context() }]) assert.throws(() => transact(f.state, 'gift', giftCommand().payload, 'missing', { mode: 'trusted', context }), /可信认证上下文/);
  const deniedActor = fixture({ permissions: [] }); await assert.rejects(deniedActor.app.execute(giftCommand(), deniedActor.credential), denied);
  assert.throws(() => transact(deniedActor.state, 'gift', giftCommand().payload, 'direct', { mode: 'trusted', context: deniedActor.context() }), denied);
  const unbound = fixture({ bind: false }); await assert.rejects(unbound.app.execute(giftCommand(), unbound.credential), /revalidation port/); await assertNoEffects(unbound);
  for (const action of ['expense','credit','repay','approveRounding','settle','handover']) {
    await assert.rejects(f.app.execute({ ...giftCommand(action,1), action }, f.credential), e => denied(e) && e.reason === (['expense','credit','repay'].includes(action) ? 'missing-permission' : 'trusted-action-not-enabled'));
  }
});

test('gift: unknown failure after stock/grant/request mutations fully rolls back; repaired original key can retry', async () => {
  let broken = true; const f = fixture({ execute: (...args) => { const state = transact(...args); if (broken) throw Error('synthetic gift failure after domain'); return state; } });
  const cmd = giftCommand(); await assert.rejects(f.app.execute(cmd, f.credential), /synthetic gift failure/); await assertNoEffects(f);
  broken = false; assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed'); const head = await f.memory.read();
  assert.equal(head.revision, 1); assert.equal(head.state.inventory.bw.count, 44); assert.equal(giftOrder(head.state).giftRequests.length, 2);
});
