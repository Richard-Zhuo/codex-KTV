import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMemoryLedgerStore } from './memory-store.js';
import { paymentCommand, seedTrustedPayments, paymentOrder, paymentPrincipalId as principalId,
  otherPaymentPrincipalId as otherPrincipalId, paymentDbNow as dbNow, paymentPermission } from '../test-support/trusted-payments-fixture.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { collectPayment, payOrder, nextCollectCharge, outstanding, PAYMENT_METHODS } from '../sales.js';

const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
function fixture({ permissions = ['payment.collect', 'payment.settle'], prepare = () => {}, execute = transact, bind = true } = {}) {
  const state = initialState(); state.user = 'unmapped-demo-user'; state.clock = 'invalid-demo-clock';
  state.permissions = { administrator: ['管理员'] }; state.capabilities = { administrator: ['*'] }; state.administrator = true;
  state.orders = [{ id: 'historical-retail', kind: 'retail', room: null,
    sales: [{ productNameSnapshot: null, pricePerSaleUnitCents: null, baseQuantityPerSaleUnit: 12, totalBaseQuantity: 24 }],
    payments: [{ method: '现金', amount: 10 }, { method: '微信', amount: 20 }] }];
  seedTrustedPayments(state); prepare(state);
  const memory = createMemoryLedgerStore(state, { ledgerId: 'payments-unit' }), digest = Buffer.alloc(32, 23);
  const auth = { id: principalId, permissions, enabled: true, revoked: false, version: 1, sessionVersion: 1,
    idle: '2099-01-01T00:00:00.000000Z', absolute: '2099-01-02T00:00:00.000000Z' };
  const port = {
    locateSessionByDigest: async () => ({ principalId: auth.id, sessionId: 'synthetic-payments-session' }),
    lockAccount: async () => ({ principalId: auth.id, enabled: auth.enabled, credentialVersion: auth.version, policyAttributesConfigured: false }),
    lockSessionById: async () => ({ principalId: auth.id, sessionId: 'synthetic-payments-session', tokenDigest: digest,
      revoked: auth.revoked, credentialVersion: auth.sessionVersion, idleExpiresAt: auth.idle, absoluteExpiresAt: auth.absolute }),
    listGrants: async () => auth.permissions, listPolicyAttributes: async () => [], readDbNow: async () => dbNow
  };
  let context, executions = 0;
  const store = { ledgerId: memory.ledgerId, runAtomic: work => memory.runAtomic(tx => {
    if (bind) tx.sessionRevalidation = { revalidateSessionInTransaction: async credential => {
      context = await revalidateSessionInTransaction({ port, ...credential }); return context;
    } };
    return work(tx);
  }) };
  const app = createTrustedLedgerApplication({ store, transactCommand: (...args) => { executions++; return execute(...args); } });
  return { state, memory, app, auth, credential: { tokenDigest: digest }, context: () => context, executions: () => executions };
}
async function noEffects(f) {
  const head = await f.memory.read(); assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0);
  assert.equal(head.operationResults.size, 0); assert.equal(head.audit.length, 0);
}
function assertNewPayments(state, actor, time, action) {
  const order = paymentOrder(state), records = order.payments.slice(1);
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map(payment => payment.paymentId)).size, 2);
  for (const payment of records) {
    assert.match(payment.paymentId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(payment.occurredAt, time); assert.equal(payment.time, time);
    assert.equal(payment.recordedByPrincipalId, actor); assert.equal(payment.person, null);
    assert.equal(payment.chargeId, action === 'collect' ? 'other:810' : 'settlement');
  }
  assert.equal(state.inventory.qd.count, null); assert.equal(state.inventory.bw.count, 0);
  assert.equal(state.orders[0].room, null);
  return records;
}

test('collect: session-owned distinct payment UUIDs and frozen occurredAt, while room remains active', async () => {
  const f = fixture(), result = await f.app.execute(paymentCommand('collect'), f.credential), head = await f.memory.read();
  assert.equal(result.status, 'committed'); assert.equal(result.actorId, principalId); assert.equal(head.revision, 1);
  assertNewPayments(head.state, principalId, dbNow, 'collect');
  assert.equal(paymentOrder(head.state).status, '营业中'); assert.deepEqual(head.state.rooms, f.state.rooms);
  assert.equal(nextCollectCharge(paymentOrder(head.state)).id, 'sale:800');
  assert.equal(outstanding(paymentOrder(head.state)), 18200);
  assert.deepEqual(paymentOrder(head.state).payments[0], paymentOrder(f.state).payments[0]);
  assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 1);
});

test('pay: complete remaining balance closes once, releases to cleaning and never applies a waiver', async () => {
  const f = fixture(), cmd = paymentCommand('pay', 'pay-first', 0, { differenceType: '免零', differenceNote: 'ignored', rounding: 1000 });
  const result = await f.app.execute(cmd, f.credential), head = await f.memory.read(), order = paymentOrder(head.state);
  assert.equal(result.status, 'committed'); assertNewPayments(head.state, principalId, dbNow, 'pay');
  assert.equal(outstanding(order), 0); assert.equal(order.status, '已结账'); assert.equal(order.closedAt, dbNow);
  assert.equal(order.rounding, 0); assert.equal(order.roundingReview, null);
  assert.equal(head.state.rooms[0].status, '待清洁'); assert.equal(head.state.rooms[0].order, null);
  const beforeReplay = structuredClone(head); assert.deepEqual(await f.app.execute(cmd, f.credential), result);
  assert.deepEqual(await f.memory.read(), beforeReplay); assert.equal(f.executions(), 1);
});

for (const action of ['collect', 'pay']) {
  test(action + ': root and nested client identity/time/IDs cannot replace session facts or demo state', async () => {
    const f = fixture(), cmd = paymentCommand(action, 'forged', 0, { actorId: 'administrator', principalId: 'forged',
      person: 'Fake Collector', permissions: ['*'], role: 'administrator', clock: '1900-01-01',
      paymentId: 'fake-root-id', occurredAt: '1900-01-01', recordedByPrincipalId: 'fake-root-actor' });
    cmd.payload.payments = cmd.payload.payments.map(payment => ({ ...payment, paymentId: 'fake-id', occurredAt: '1900-01-01',
      recordedByPrincipalId: 'fake-actor', actorId: 'fake-actor', principalId: 'fake', person: 'Fake Collector',
      time: '1900-01-01', permissions: ['*'], role: 'administrator', clock: '1900-01-01' }));
    assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed'); const head = await f.memory.read();
    const records = assertNewPayments(head.state, principalId, dbNow, action);
    for (const record of records) assert.deepEqual(Object.keys(record).sort(),
      ['method','amount','chargeId','paymentId','occurredAt','recordedByPrincipalId','person','time'].sort());
    assert.equal(head.state.user, f.state.user); assert.equal(head.state.clock, f.state.clock);
    assert.deepEqual(head.state.permissions, f.state.permissions); assert.deepEqual(head.state.capabilities, f.state.capabilities);
    assert.deepEqual(paymentOrder(head.state).sales, paymentOrder(f.state).sales);
    assert.deepEqual(head.state.orders[0], f.state.orders[0]);
  });

  test(action + ': exact existing permission required, backend/delegation/client grants cannot authorize; denied key remains free', async () => {
    for (const permissions of [[], ['backend.view'], ['staff.record'], [paymentPermission(action === 'collect' ? 'pay' : 'collect')]]) {
      const f = fixture({ permissions }), cmd = paymentCommand(action, 'denied', 0, { permissions: [paymentPermission(action)], role: 'administrator' });
      await assert.rejects(f.app.execute(cmd, f.credential), denied); await noEffects(f); assert.equal(f.executions(), 0);
      f.auth.permissions = [paymentPermission(action)];
      assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed');
      assertNewPayments((await f.memory.read()).state, principalId, dbNow, action);
    }
  });

  test(action + ': revoke keeps original terminal and UUIDs, new key denied; actor/payload/revision/action conflicts unchanged', async () => {
    const f = fixture(), cmd = paymentCommand(action), first = await f.app.execute(cmd, f.credential), before = await f.memory.read();
    f.auth.permissions = []; assert.deepEqual(await f.app.execute(cmd, f.credential), first);
    await assert.rejects(f.app.execute(paymentCommand(action, 'new', 1), f.credential), denied);
    assert.deepEqual(await f.memory.read(), before); assert.equal(f.executions(), 1);
    f.auth.id = otherPrincipalId; const actor = await f.app.execute(cmd, f.credential);
    assert.equal(actor.status, 'idempotency-conflict'); assert.equal(actor.reason, 'actor-mismatch'); f.auth.id = principalId;
    for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, payload: { ...cmd.payload, person: 'changed' } },
      { ...cmd, payload: { ...cmd.payload, payments: [{ method: '现金', amount: 1 }] } }, { ...cmd, action: 'settle' }]) {
      const conflict = await f.app.execute(changed, f.credential);
      assert.equal(conflict.status, 'idempotency-conflict'); assert.equal(conflict.reason, 'request-mismatch');
    }
    assert.deepEqual(await f.memory.read(), before);
  });

  test(action + ': disabled, revoked, idle, absolute and credential-version mismatch prevent old terminal access', async () => {
    for (const mutate of [auth => auth.enabled = false, auth => auth.revoked = true, auth => auth.idle = dbNow,
      auth => { auth.absolute = dbNow; auth.idle = dbNow; }, auth => auth.version++]) {
      const f = fixture(), cmd = paymentCommand(action); await f.app.execute(cmd, f.credential);
      const before = await f.memory.read(); mutate(f.auth);
      await assert.rejects(f.app.execute(cmd, f.credential), error => error.code === 'AUTHENTICATION_REQUIRED');
      assert.deepEqual(await f.memory.read(), before); assert.equal(f.executions(), 1);
    }
  });

  test(action + ': original amount/method/state business failures are terminal, with no half-payment or room change', async () => {
    const cases = [
      { changes: { payments: [{ method: '现金', amount: 1 }] } },
      { changes: { payments: [{ method: '现金', amount: action === 'collect' ? 3001 : 21201 }] } },
      { changes: { payments: [] } }, { changes: { payments: [{ method: '银行卡', amount: action === 'collect' ? 3000 : 21200 }] } },
      { changes: { payments: [{ method: '现金', amount: 0 }] } }, { changes: { payments: [{ method: '现金', amount: 1.5 }] } },
      { prepare: state => paymentOrder(state).status = '已结账' }, { changes: { order: 'unknown-order' } },
      ...(action === 'collect' ? [{ changes: { charge: 'open' } },
        { prepare: state => paymentOrder(state).payments.push({ method: '现金', amount: 21200, chargeId: 'settlement' }), changes: { charge: 'other:810', payments: [] } }]
        : [{ prepare: state => paymentOrder(state).giftRequests.push({ status: '待确认' }) },
          { changes: { payments: [{ method: '现金', amount: 20200 }], differenceType: '免零', rounding: 1000 } }])
    ];
    // collect's no-charge fixture must pay each charge under its original charge IDs.
    if (action === 'collect') cases.at(-1).prepare = state => paymentOrder(state).payments.push(
      { method: '现金', amount: 15800, chargeId: 'open' }, { method: '现金', amount: 2400, chargeId: 'sale:800' },
      { method: '现金', amount: 3000, chargeId: 'other:810' });
    for (const [index, c] of cases.entries()) {
      const f = fixture({ prepare: c.prepare }), cmd = paymentCommand(action, 'business-' + index, 0, c.changes);
      const result = await f.app.execute(cmd, f.credential), head = await f.memory.read();
      assert.equal(result.status, 'business-rejected'); assert.deepEqual(head.state, f.state); assert.equal(head.revision, 0);
      assert.equal(head.operationResults.size, 1); assert.equal(head.audit.length, 0);
      f.auth.permissions = []; assert.deepEqual(await f.app.execute(cmd, f.credential), result);
    }
  });

  test(action + ': legal channels, charge balance and final room state agree with the original demo transaction', async () => {
    for (const method of PAYMENT_METHODS) {
      const f = fixture(), cmd = paymentCommand(action, 'channel', 0, { payments: [{ method, amount: action === 'collect' ? 3000 : 21200 }] });
      const result = await f.app.execute(cmd, f.credential); assert.equal(result.status, 'committed');
      const actual = (await f.memory.read()).state, expected = transact({ ...f.state, user: 'administrator', clock: dbNow }, action, cmd.payload, cmd.operationKey);
      const payment = paymentOrder(actual).payments.at(-1); const { paymentId, occurredAt, recordedByPrincipalId, ...legacy } = payment;
      assert.ok(paymentId); assert.equal(occurredAt, dbNow); assert.equal(recordedByPrincipalId, principalId);
      paymentOrder(actual).payments[1] = { ...legacy, person: paymentOrder(expected).payments[1].person };
      actual.user = expected.user; actual.clock = expected.clock; assert.deepEqual(actual, expected);
    }
  });

  test(action + ': stale revision stays terminal and never creates a payment when a later command reaches its revision', async () => {
    const f = fixture(), cmd = paymentCommand(action, 'stale', 1), terminal = await f.app.execute(cmd, f.credential);
    assert.equal(terminal.status, 'revision-conflict'); assert.equal(f.executions(), 0);
    assert.equal((await f.app.execute(paymentCommand(action, 'advance'), f.credential)).status, 'committed');
    const before = await f.memory.read(); assert.deepEqual(await f.app.execute(cmd, f.credential), terminal); assert.deepEqual(await f.memory.read(), before);
  });

  test(action + ': unknown failure after payment/room mutations rolls back and permits the original key after repair', async () => {
    let broken = true;
    const f = fixture({ execute: (...args) => { const next = transact(...args); if (broken) throw Error('synthetic payment fault'); return next; } });
    const cmd = paymentCommand(action, 'repair'); await assert.rejects(f.app.execute(cmd, f.credential), /synthetic payment fault/); await noEffects(f);
    broken = false; assert.equal((await f.app.execute(cmd, f.credential)).status, 'committed'); assertNewPayments((await f.memory.read()).state, principalId, dbNow, action);
  });

  test(action + ': explicit trusted context is mandatory in both ledger and public domain boundary', async () => {
    const f = fixture({ bind: false }), cmd = paymentCommand(action);
    await assert.rejects(f.app.execute(cmd, f.credential), /revalidation port/); await noEffects(f);
    assert.throws(() => transact(f.state, action, cmd.payload, 'missing', { mode: 'trusted' }), TypeError);
    const fn = action === 'collect' ? collectPayment : payOrder;
    assert.throws(() => fn(f.state, paymentOrder(f.state), cmd.payload, 'forged', '1900-01-01', { mode: 'trusted' }), TypeError);
  });
}

test('payments: IDs are distinct across later commands, old payment IDs/times/names remain untouched', async () => {
  const f = fixture(); await f.app.execute(paymentCommand('collect', 'charge-one'), f.credential);
  await f.app.execute(paymentCommand('collect', 'charge-two', 1, { charge: 'sale:800', payments: [{ method: '现金', amount: 2400 }] }), f.credential);
  await f.app.execute(paymentCommand('pay', 'finish', 2, { payments: [{ method: '微信', amount: 15800 }] }), f.credential);
  const head = await f.memory.read(), payments = paymentOrder(head.state).payments;
  assert.equal(payments.length, 5); assert.equal(new Set(payments.slice(1).map(payment => payment.paymentId)).size, 4);
  assert.deepEqual(payments[0], paymentOrder(f.state).payments[0]); assert.equal(Object.hasOwn(payments[0], 'paymentId'), false);
  assert.equal(Object.hasOwn(payments[0], 'occurredAt'), false); assert.equal(head.revision, 3); assert.equal(head.audit.length, 3);
});

test('payments: an ID collision against an existing payment fails as unknown error without reusing or consuming the key', async () => {
  const existing = '60000000-0000-4000-8000-000000000009';
  const f = fixture({ prepare: state => paymentOrder(state).payments[0].paymentId = existing });
  const original = globalThis.crypto.randomUUID; globalThis.crypto.randomUUID = () => existing;
  try { await assert.rejects(f.app.execute(paymentCommand('collect', 'collision'), f.credential), /付款 ID 冲突/); await noEffects(f); }
  finally { globalThis.crypto.randomUUID = original; }
  assert.equal((await f.app.execute(paymentCommand('collect', 'collision'), f.credential)).status, 'committed');
  assert.equal(paymentOrder((await f.memory.read()).state).payments[0].paymentId, existing);
});

test('pay: real TypeError during room release rolls back payments, closing and operation key', async () => {
  const f = fixture({ prepare: state => state.rooms = {} });
  await assert.rejects(f.app.execute(paymentCommand('pay', 'release-fault'), f.credential), TypeError); await noEffects(f);
});

test('pay: already-paid balance allows no new payments and keeps the original zero-due behavior', async () => {
  const f = fixture({ prepare: state => paymentOrder(state).payments.push({ method: '现金', amount: 21200, chargeId: 'settlement' }) });
  assert.equal((await f.app.execute(paymentCommand('pay', 'zero', 0, { payments: [] }), f.credential)).status, 'committed');
  const head = await f.memory.read(); assert.deepEqual(paymentOrder(head.state).payments, paymentOrder(f.state).payments);
  assert.equal(paymentOrder(head.state).status, '已结账'); assert.equal(head.state.rooms[0].status, '待清洁');
});

test('payments: open stays formally disabled even with their permissions', async () => {
  const f = fixture({ permissions: ['payment.collect','payment.settle','rounding.approve','handover','room.open'] });
  for (const action of [ 'open'])
    await assert.rejects(f.app.execute(paymentCommand(action, action), f.credential), error => denied(error) && error.reason === 'trusted-action-not-enabled');
  await noEffects(f); assert.equal(f.executions(), 0);
});
