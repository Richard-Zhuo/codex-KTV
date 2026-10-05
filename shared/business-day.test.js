import test from 'node:test';
import assert from 'node:assert/strict';
import { businessDateFor, BUSINESS_DAY_POLICY } from './business-day.js';

const options = { timeZone: 'Asia/Shanghai' };

test('business day: 11:59:59 still belongs to the previous business date', () => {
  assert.equal(businessDateFor('2026-10-05T11:59:59+08:00', options), '2026-10-04');
});

for (const [time, expected] of [
  ['02:00:00', '2026-10-04'],
  ['12:00:00', '2026-10-05'],
  ['12:00:01', '2026-10-05'],
  ['20:00:00', '2026-10-05']
]) {
  test('business day: ' + time + ' uses the confirmed noon boundary', () => {
    assert.equal(businessDateFor('2026-10-05T' + time + '+08:00', options), expected);
  });
}

test('business day: UTC database timestamp and offset representation describe the same instant', () => {
  assert.equal(businessDateFor('2026-10-05T03:59:59.999999Z', options), '2026-10-04');
  assert.equal(businessDateFor('2026-10-05T04:00:00.000000Z', options), '2026-10-05');
  assert.equal(businessDateFor('2026-10-05T04:00:00.000000Z', options),
    businessDateFor('2026-10-05T12:00:00+08:00', options));
});

test('business day: explicitly configured time zone controls the date instead of device defaults', () => {
  const timestamp = '2026-10-05T04:00:00Z';
  assert.equal(businessDateFor(timestamp, options), '2026-10-05');
  assert.equal(businessDateFor(timestamp, { timeZone: 'UTC' }), '2026-10-04');
});

for (const timeZone of [undefined, '', 'unknown-zone']) {
  test('business day: missing or invalid store time zone fails closed: ' + String(timeZone), () => {
    assert.throws(() => businessDateFor('2026-10-05T12:00:00Z', { timeZone }));
  });
}

for (const timestamp of ['2026-10-05T12:00:00', '2026-02-30T12:00:00Z', 'not-a-time', null]) {
  test('business day: ambiguous or damaged timestamp is not guessed: ' + String(timestamp), () => {
    assert.throws(() => businessDateFor(timestamp, options), TypeError);
  });
}

test('business day: early hours cross month and year by calendar date', () => {
  assert.equal(businessDateFor('2026-10-01T02:00:00+08:00', options), '2026-09-30');
  assert.equal(businessDateFor('2026-01-01T02:00:00+08:00', options), '2025-12-31');
});

test('business day: date projection does not rewrite occurredAt, payment or a historical date snapshot', () => {
  const historical = { businessDate: '2026-10-05', businessDatePolicyVersion: 'historic-proof',
    payments: [{ paymentId: 'existing-id', amount: 100, occurredAt: '2026-10-05T11:00:00+08:00' }] };
  const before = structuredClone(historical);
  assert.equal(businessDateFor(historical.payments[0].occurredAt, options), '2026-10-04');
  assert.deepEqual(historical, before);
  assert.deepEqual(BUSINESS_DAY_POLICY, { version: 'noon-v1', cutoff: '12:00' });
  assert.equal(Object.isFrozen(BUSINESS_DAY_POLICY), true);
});
