import test from 'node:test';
import assert from 'node:assert/strict';
import { recordOffsiteFact, offsiteRpo } from './offsite-state.js';
const make = () => {
  let s = { observations: { backup: { lastResult: 'SUCCESS', lastSuccessAt: 123 } } };
  return { read: () => structuredClone(s), update: async work => { const next = structuredClone(s); await work(next); s = next; } };
};
const fact = (unitId, snapshotNotBefore, at, status = 'OFFSITE_VERIFIED') =>
  ({ unitId, backupId: unitId, snapshotNotBefore, at, status, locator: { unitId } });
test('B5 RPO: older completion and reverify never refresh data time', async () => {
  const store = make();
  await recordOffsiteFact(store, fact('newer', 2000, 3000));
  await recordOffsiteFact(store, fact('older', 1000, 4000));
  await recordOffsiteFact(store, fact('newer', 2000, 5000));
  assert.equal(store.read().observations.offsite.latestRecoveryPoint.snapshotNotBefore, 2000);
  assert.equal(store.read().observations.offsite.latestRecoveryPoint.verifiedAt, 3000);
  assert.deepEqual(store.read().observations.backup, { lastResult: 'SUCCESS', lastSuccessAt: 123 });
  assert.deepEqual(offsiteRpo(store.read().observations, { utcMs: 3602001, uncertaintyMs: 0 }),
    { status: 'OVERDUE', ageMs: 3600001, unitId: 'newer' });
});
test('B5 RPO: failed, partial and unknown time do not advance verified point', async () => {
  const store = make();
  await recordOffsiteFact(store, fact('a', 1000, 2000));
  for (const status of ['LOCAL_VERIFIED', 'UPLOAD_UNCONFIRMED', 'OFFSITE_UNCONFIRMED']) await recordOffsiteFact(store, fact('b', 3000, 4000, status));
  await recordOffsiteFact(store, fact('unknown', null, 5000));
  assert.equal(store.read().observations.offsite.latestRecoveryPoint.unitId, 'a');
  assert.equal(store.read().observations.offsite.attempts.b.failures, 1);
  assert.equal(offsiteRpo(store.read().observations, { utcMs: 1000, uncertaintyMs: 0 }).status, 'UNKNOWN');
  assert.equal(offsiteRpo(store.read().observations, { utcMs: 6000, uncertaintyMs: -1 }).status, 'UNKNOWN');
});
test('B5 state preserves references, rejects changed snapshot and bounds retained attempts', async () => {
  const store = make();
  await recordOffsiteFact(store, fact('a', 1000, 2000));
  await assert.rejects(recordOffsiteFact(store, fact('a', 999, 4000)));
  for (let n = 1; n < 128; n++) await recordOffsiteFact(store, fact('u' + n, null, 4000, 'UPLOAD_UNCONFIRMED'));
  const before = store.read();
  await assert.rejects(recordOffsiteFact(store, fact('overflow', null, 4000)), { code: 'OFFSITE_REFERENCE_LIMIT' });
  assert.deepEqual(store.read(), before);
  assert.equal(store.read().observations.offsite.latestRecoveryPoint.unitId, 'a');
});
