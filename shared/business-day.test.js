import test from 'node:test';
import assert from 'node:assert/strict';
import { orderBusinessDaySnapshot, businessDateFor, BUSINESS_DAY_POLICY } from './business-day.js';

const options = { timeZone: 'Asia/Shanghai' };

test('business day: 05:59:59 still belongs to the previous business date', () => {
  assert.equal(businessDateFor('2026-10-05T05:59:59+08:00', options), '2026-10-04');
});

for (const [time, expected] of [
  ['02:00:00', '2026-10-04'],
  ['06:00:00', '2026-10-05'],
  ['06:00:01', '2026-10-05'],
  ['20:00:00', '2026-10-05']
]) {
  test('business day: ' + time + ' uses the Owner-confirmed 06:00 boundary', () => {
    assert.equal(businessDateFor('2026-10-05T' + time + '+08:00', options), expected);
  });
}

test('business day: UTC database timestamp and offset representation describe the same instant', () => {
  assert.equal(businessDateFor('2026-10-04T21:59:59.999999Z', options), '2026-10-04');
  assert.equal(businessDateFor('2026-10-04T22:00:00.000000Z', options), '2026-10-05');
  assert.equal(businessDateFor('2026-10-04T22:00:00.000000Z', options),
    businessDateFor('2026-10-05T06:00:00+08:00', options));
});

test('business day: explicitly configured time zone controls the date instead of device defaults', () => {
  const timestamp = '2026-10-05T04:00:00Z';
  assert.equal(businessDateFor(timestamp, options), '2026-10-05');
  assert.equal(businessDateFor(timestamp, { timeZone: 'UTC' }), '2026-10-04');
});

for (const timeZone of [undefined, '', 'unknown-zone']) {
  test('business day: missing or invalid store time zone fails closed: ' + String(timeZone), () => {
    assert.throws(() => businessDateFor('2026-10-05T06:00:00Z', { timeZone }));
  });
}

for (const timestamp of ['2026-10-05T06:00:00', '2026-02-30T06:00:00Z', 'not-a-time', null]) {
  test('business day: ambiguous or damaged timestamp is not guessed: ' + String(timestamp), () => {
    assert.throws(() => businessDateFor(timestamp, options), TypeError);
  });
}

test('business day: early hours cross month and year by calendar date', () => {
  assert.equal(businessDateFor('2026-10-01T02:00:00+08:00', options), '2026-09-30');
  assert.equal(businessDateFor('2026-01-01T02:00:00+08:00', options), '2025-12-31');
});

test('business day: date projection does not rewrite occurredAt, payment or a historical date snapshot', () => {
  const historical = { businessDate: '2026-10-04', businessDayRuleVersion: 'noon-v1',
    payments: [{ paymentId: 'existing-id', amount: 100, occurredAt: '2026-10-05T08:00:00+08:00' }] };
  const before = structuredClone(historical);
  assert.equal(businessDateFor(historical.payments[0].occurredAt, options), '2026-10-05');
  assert.deepEqual(historical, before);
  assert.deepEqual(BUSINESS_DAY_POLICY, { version: 'cutoff-0600-v1', cutoff: '06:00' });
  assert.equal(Object.isFrozen(BUSINESS_DAY_POLICY), true);
});

test('order business day snapshot freezes version and explicit zone without changing actual time',()=>{
 const actual='2026-10-05T02:00:00+08:00',snapshot=orderBusinessDaySnapshot(actual,{timeZone:'Asia/Shanghai'});
 assert.deepEqual(snapshot,{businessDate:'2026-10-04',businessDayRuleVersion:'cutoff-0600-v1',businessTimeZone:'Asia/Shanghai'});
 assert.equal(Object.isFrozen(snapshot),true);assert.equal(actual,'2026-10-05T02:00:00+08:00');
 assert.throws(()=>orderBusinessDaySnapshot(actual),TypeError);
});

for(const [local,utc,date]of [
 ['2026-10-16T05:59:59+08:00','2026-10-15T21:59:59Z','2026-10-15'],
 ['2026-10-16T06:00:00+08:00','2026-10-15T22:00:00Z','2026-10-16']]){
 test('06:00 order snapshot boundary '+local+' agrees with UTC',()=>{
  const expected={businessDate:date,businessDayRuleVersion:'cutoff-0600-v1',businessTimeZone:'Asia/Shanghai'};
  assert.deepEqual(orderBusinessDaySnapshot(local,options),expected);
  assert.deepEqual(orderBusinessDaySnapshot(utc,options),expected);
 });
}
