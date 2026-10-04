import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from './rules.js';

function opened() {
  const state = initialState();
  state.user = 'shaoBoss'; state.clock = '2026-10-05T20:00:00+08:00';
  return transact(state, 'open', { room: 'V01', beer: 'bw' }, 'rounding-open');
}

test('small rounding: 10.01 yuan enters the existing review path', () => {
  const state = opened(), order = state.orders[0];
  const after = transact(state, 'settle', { order: order.id,
    payments: [{ method: '现金', amount: 15799 }], differenceType: '免零' }, 'rounding-excess');
  assert.equal(after.orders[0].rounding, 1001);
  assert.equal(after.orders[0].roundingReview?.status, '待审核');
  assert.equal(after.orders[0].roundingReview?.amount, 1001);
});

for (const [difference, received] of [[0, 16800], [500, 16300], [999, 15801], [1000, 15800]]) {
  test('small rounding: ' + difference + ' cents is direct without a review', () => {
    const before = opened();
    const after = transact(before, 'settle', { order: before.orders[0].id,
      payments: [{ method: '现金', amount: received }] }, 'direct-' + difference);
    const order = after.orders[0];
    assert.equal(order.rounding, difference); assert.equal(order.roundingReview, null);
    assert.equal(order.roundingType, difference ? '免零' : '');
    assert.equal(order.payments.at(-1).amount, received); assert.equal(order.status, '已结账');
    assert.deepEqual(before.orders[0].payments, []);
  });
}

test('small rounding: 168 yuan can round down to 160 without changing the total or inventory', () => {
  const before = opened();
  const after = transact(before, 'settle', { order: before.orders[0].id,
    payments: [{ method: '现金', amount: 16000 }] }, 'round-to-ten');
  assert.equal(after.orders[0].rounding, 800); assert.equal(after.orders[0].roundingReview, null);
  assert.equal(after.orders[0].base + after.orders[0].gift, 16800);
  assert.deepEqual(after.inventory, before.inventory); assert.deepEqual(after.ledger, before.ledger);
});

test('small rounding: only the actual unpaid amount can be waived after prior payments', () => {
  const before = opened(); before.orders[0].payments.push({ method: '微信', amount: 16000 });
  const after = transact(before, 'settle', { order: before.orders[0].id,
    payments: [{ method: '现金', amount: 1 }] }, 'remaining-only');
  assert.equal(after.orders[0].rounding, 799); assert.equal(after.orders[0].roundingReview, null);
  assert.deepEqual(after.orders[0].payments.map(p => p.amount), [16000, 1]);
});

test('small rounding: negative, zero and over-received payments fail without changing state', () => {
  const before = opened(), snapshot = structuredClone(before);
  for (const amount of [-1, 0, 16801]) {
    assert.throws(() => transact(before, 'settle', { order: before.orders[0].id,
      payments: [{ method: '现金', amount }] }, 'invalid-' + amount));
    assert.deepEqual(before, snapshot);
  }
});

test('small rounding: explicit special-case reason and reviewer permissions stay unchanged', () => {
  const before = opened(), id = before.orders[0].id;
  assert.throws(() => transact(before, 'settle', { order: id,
    payments: [{ method: '现金', amount: 16300 }], differenceType: '特殊情况' }, 'no-note'), /说明/);
  const after = transact(before, 'settle', { order: id, payments: [{ method: '现金', amount: 16300 }],
    differenceType: '特殊情况', differenceNote: '原有特殊情况' }, 'special');
  assert.equal(after.orders[0].roundingReview.status, '待审核');
  assert.equal(after.orders[0].roundingReview.approver, '店长');
  assert.throws(() => transact(after, 'approveRounding', { order: id }, 'self'), /审核本人申请需要/);
});

test('small rounding: a direct waiver does not grant settlement permission', () => {
  const before = opened(); before.user = 'zhuYi';
  const snapshot = structuredClone(before);
  assert.throws(() => transact(before, 'settle', { order: before.orders[0].id,
    payments: [{ method: '现金', amount: 15800 }] }, 'no-settle'));
  assert.deepEqual(before, snapshot);
});
