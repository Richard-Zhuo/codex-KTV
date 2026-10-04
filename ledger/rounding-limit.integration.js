import assert from 'node:assert/strict';
import { transact } from '../rules.js';

// Runs inside the existing guarded, disposable three-table ledger fixture.
// This tests the legacy settlement rules; it does not enable trusted payment actions.
export async function testRoundingLimit(t, { seed, app, inspect, pool, qualified }) {
  const prepare = state => Object.assign(state,
    transact(state, 'open', { room: 'V01', beer: 'bw' }, 'rounding-open'));
  for (const [difference, received, review] of [
    [0, 16800, false], [500, 16300, false], [999, 15801, false],
    [1000, 15800, false], [1001, 15799, true], [800, 16000, false]
  ]) {
    await t.test('rounding MySQL: ' + difference + ' cents preserves the direct/review boundary and replay', async () => {
      const id = 'rounding-' + difference; await seed(id, prepare);
      const before = await inspect(id), orderId = before.head.state.orders[0].id;
      const command = { operationKey: 'waiver', expectedRevision: 0, action: 'settle',
        payload: { order: orderId, payments: [{ method: '现金', amount: received }], differenceType: '免零' } };
      const result = await app(id).execute(command); assert.equal(result.status, 'committed');
      const after = await inspect(id), order = after.head.state.orders[0];
      assert.equal(order.rounding, difference);
      if (review) { assert.equal(order.roundingReview.status, '待审核'); assert.equal(order.roundingReview.amount, 1001); }
      else assert.equal(order.roundingReview, null);
      assert.equal(order.payments.length, 1); assert.equal(order.payments[0].amount, received);
      assert.equal(after.head.revision, 1); assert.equal(after.operations.length, 1); assert.equal(after.audit.length, 1);
      assert.deepEqual(after.head.state.inventory, before.head.state.inventory);
      assert.deepEqual(after.head.state.ledger, before.head.state.ledger);
      assert.deepEqual(await app(id, 'actor-a', pool, () => { throw Error('replay must not settle twice'); }).execute(command), result);
      assert.deepEqual(await inspect(id), after);
    });
  }
  await t.test('rounding MySQL: prior payment limits the remaining waiver and channels stay separate', async () => {
    const id = 'rounding-prior'; await seed(id, state => { prepare(state); state.orders[0].payments.push({ method: '微信', amount: 16000 }); });
    const before = await inspect(id);
    const result = await app(id).execute({ operationKey: 'remaining', expectedRevision: 0, action: 'settle',
      payload: { order: before.head.state.orders[0].id, payments: [{ method: '现金', amount: 1 }] } });
    assert.equal(result.status, 'committed'); const after = await inspect(id), order = after.head.state.orders[0];
    assert.equal(order.rounding, 799); assert.equal(order.roundingReview, null);
    assert.deepEqual(order.payments.map(p => [p.method, p.amount]), [['微信', 16000], ['现金', 1]]);
  });
  await t.test('rounding MySQL: invalid payment does not partially settle, waive or release the room', async () => {
    const id = 'rounding-invalid'; await seed(id, prepare); const before = await inspect(id);
    for (const amount of [-1, 0, 16801]) {
      const result = await app(id).execute({ operationKey: 'invalid-' + amount, expectedRevision: 0, action: 'settle',
        payload: { order: before.head.state.orders[0].id, payments: [{ method: '现金', amount }] } });
      assert.equal(result.status, 'business-rejected');
      const after = await inspect(id); assert.deepEqual(after.head, before.head); assert.equal(after.audit.length, 0);
    }
  });
  await t.test('rounding MySQL: SQL failure rolls payment, waiver, room, revision and operation back', async () => {
    const id = 'rounding-sql-fault'; await seed(id, prepare); const before = await inspect(id);
    const command = { operationKey: 'rounding-fault', expectedRevision: 0, action: 'settle',
      payload: { order: before.head.state.orders[0].id, payments: [{ method: '现金', amount: 15800 }] } };
    await pool.query('ALTER TABLE ' + qualified('ledger_success_audit') +
      " ADD CONSTRAINT chk_rounding_fault CHECK (operation_key <> 'rounding-fault')");
    try { await assert.rejects(app(id).execute(command), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
      assert.deepEqual(await inspect(id), before);
    } finally { await pool.query('ALTER TABLE ' + qualified('ledger_success_audit') + ' DROP CHECK chk_rounding_fault'); }
    assert.equal((await app(id).execute(command)).status, 'committed');
  });
}
