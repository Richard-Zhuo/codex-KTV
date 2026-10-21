// B5-A uses the existing operational store under its existing single-writer ownership.
// No local backup fields, scheduler state, alert transport or production wiring is changed.
const fail = () => Error('OFFSITE_STATE_REJECTED');
export async function recordOffsiteFact(store, fact) {
  if (!['LOCAL_VERIFIED', 'UPLOAD_UNCONFIRMED', 'OFFSITE_UNCONFIRMED', 'OFFSITE_VERIFIED'].includes(fact.status)) throw fail();
  await store.update(s => {
    const state = s.observations.offsite ??= { attempts: {}, latestRecoveryPoint: null };
    const previous = state.attempts[fact.unitId];
    if (!previous && Object.keys(state.attempts).length >= 128) {
      throw Object.assign(Error('OFFSITE_REFERENCE_LIMIT'), { code: 'OFFSITE_REFERENCE_LIMIT' });
    }
    // A repeat attempt cannot erase independently verified history or refresh its data time.
    if (previous && (previous.backupId !== fact.backupId || previous.snapshotNotBefore !== fact.snapshotNotBefore)) throw fail();
    const failures = (previous?.failures ?? 0) + (fact.status === 'OFFSITE_UNCONFIRMED' ? 1 : 0);
    state.attempts[fact.unitId] = { ...previous, ...structuredClone(fact), failures,
      verifiedLocator: fact.locator ?? previous?.verifiedLocator ?? null };
    state.lastAttempt = fact.unitId;
    if (fact.status === 'OFFSITE_VERIFIED' && fact.at !== null && fact.snapshotNotBefore !== null &&
        fact.snapshotNotBefore <= fact.at && (!state.latestRecoveryPoint ||
        fact.snapshotNotBefore > state.latestRecoveryPoint.snapshotNotBefore)) {
      state.latestRecoveryPoint = { unitId: fact.unitId, backupId: fact.backupId,
        snapshotNotBefore: fact.snapshotNotBefore, verifiedAt: fact.at, locator: structuredClone(fact.locator) };
    }
  });
}
export function offsiteRpo(observations, time) {
  const point = observations.offsite?.latestRecoveryPoint;
  if (!point || !Number.isSafeInteger(time?.utcMs) || !Number.isSafeInteger(time?.uncertaintyMs) ||
      time.uncertaintyMs < 0 || time.utcMs < point.verifiedAt || time.utcMs < point.snapshotNotBefore ||
      !Number.isSafeInteger(time.utcMs + time.uncertaintyMs)) return { status: 'UNKNOWN', ageMs: null };
  const ageMs = time.utcMs + time.uncertaintyMs - point.snapshotNotBefore;
  return { status: ageMs <= 3600000 ? 'WITHIN_TARGET' : 'OVERDUE', ageMs, unitId: point.unitId };
}
