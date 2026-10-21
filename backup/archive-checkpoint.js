// Synthetic cumulative handoff only. No operational state, slot release or deletion.
import { canonical, digest } from './format.js';
import { assertSyntheticBackupEncryption } from './encryption-policy.js';
import { syntheticArchiveScope, verifySyntheticArchiveSignature, discoverSyntheticArchives } from './archive-discovery.js';

export const CHECKPOINT_LIMIT = 512;
const MAX_BYTES = 1024 * 1024;
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const fields = (v, names) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === names;
const fail = () => Object.assign(Error('ARCHIVE_CHECKPOINT_REJECTED'), { code: 'ARCHIVE_CHECKPOINT_REJECTED' });
const equal = (a, b) => canonical({ value: a }) === canonical({ value: b });
export async function checkpointDeadline(work, timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw fail();
  let timer;
  try { return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => { timer = setTimeout(() => reject(fail()), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
export function checkCheckpointPoint(point, scope) {
  if (!fields(point, 'locator,previous,sequence') || !Number.isSafeInteger(point.sequence) || point.sequence < 1 ||
      !(point.previous === null && point.sequence === 1 || point.sequence > 1 && hash(point.previous)) ||
      !fields(point.locator, 'objectId,size,version') || !hash(point.locator.version) ||
      point.locator.objectId !== 'checkpoint.' + scope.directoryId + '.' + point.locator.version ||
      !Number.isSafeInteger(point.locator.size) || point.locator.size < 1 || point.locator.size > MAX_BYTES) throw fail();
}
function checkEntries(entries, scope) {
  if (!Array.isArray(entries) || !entries.length || entries.length > CHECKPOINT_LIMIT) throw fail();
  let previous = '';
  for (const e of entries) {
    if (!fields(e, 'objectId,size,unitId,version') || typeof e.unitId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(e.unitId) || e.unitId <= previous ||
        e.objectId !== 'archive.' + scope.directoryId + '.' + digest(e.unitId) ||
        !hash(e.version) || !Number.isSafeInteger(e.size) || e.size < 1 || e.size > 32768) throw fail();
    previous = e.unitId;
  }
}
async function verifyReferences(args, { bootstrap, reader, entries, timeoutMs }) {
  const scope = syntheticArchiveScope(bootstrap);
  checkEntries(entries, scope);
  const enumerator = { listPage: async ({ cursor }) => {
    const start = cursor === null ? 0 : Number(cursor), end = Math.min(start + 16, entries.length);
    return { status: 'OK', entries: entries.slice(start, end).map(({ unitId: _unit, ...d }) => d),
      nextCursor: end < entries.length ? String(end) : null };
  } };
  const verified = await discoverSyntheticArchives(args, { bootstrap, reader, enumerator, timeoutMs });
  if (verified.entries.length !== entries.length || verified.entries.some((e, i) =>
    e.completion.unitId !== entries[i].unitId || e.objectId !== entries[i].objectId || e.version !== entries[i].version)) throw fail();
  return verified.entries;
}
// Full entry/material verification is mandatory here, including when called by the custodian.
export async function verifySyntheticCheckpoint(args, { bootstrap, reader, point, timeoutMs = 5000 } = {}) {
  try {
    assertSyntheticBackupEncryption(args);
    point = structuredClone(point);
    const scope = syntheticArchiveScope(bootstrap);
    checkCheckpointPoint(point, scope);
    const r = await checkpointDeadline(() => reader.getExact({ ...point.locator }), timeoutMs);
    if (r?.objectId !== point.locator.objectId || r.version !== point.locator.version || !Buffer.isBuffer(r.bytes) ||
        r.bytes.length !== point.locator.size || digest(r.bytes) !== point.locator.version) throw fail();
    const envelope = JSON.parse(r.bytes.toString('utf8'));
    if (canonical(envelope) !== r.bytes.toString('utf8') || !fields(envelope, 'payload,signature')) throw fail();
    const p = envelope.payload;
    if (!fields(p, 'algorithm,domain,entries,previous,scope,sequence,version') ||
        p.domain !== 'ktv-synthetic-archive-checkpoint' || p.version !== 1 || p.algorithm !== 'Ed25519' ||
        !equal(p.scope, scope) || p.sequence !== point.sequence || p.previous !== point.previous) throw fail();
    verifySyntheticArchiveSignature(bootstrap, p, envelope.signature);
    const entries = await verifyReferences(args, { bootstrap, reader, entries: p.entries, timeoutMs });
    return { point: structuredClone(point), payload: p, entries };
  } catch { throw fail(); }
}
export function assertCheckpointExtension(previous, next) {
  if (!previous) {
    if (next.payload.sequence !== 1 || next.payload.previous !== null) throw fail();
    return;
  }
  if (next.payload.sequence !== previous.payload.sequence + 1 || next.payload.previous !== previous.point.locator.version) throw fail();
  const members = new Map(next.payload.entries.map(e => [e.unitId, e]));
  if (previous.payload.entries.some(e => !members.has(e.unitId) || !equal(e, members.get(e.unitId)))) throw fail();
}
function result(point, entries) {
  return Object.freeze({ code: 'SYNTHETIC_CHECKPOINT_VERIFIED', point: structuredClone(point), entries,
    coverage: 'CHECKPOINT_MEMBERS_VERIFIED', directoryCompleteness: 'NOT_VERIFIED',
    rollbackProtection: 'EXTERNAL_SYNTHETIC_ANCHOR_ASSUMPTION', readyForSlotRelease: false,
    activitySlotsReleased: 0, physicalDeletion: false });
}
export async function recoverSyntheticCheckpoint(args, { bootstrap, reader, anchor, timeoutMs = 5000 } = {}) {
  try {
    assertSyntheticBackupEncryption(args);
    const scope = syntheticArchiveScope(bootstrap);
    const point = await checkpointDeadline(() => anchor.getLatest(scope), timeoutMs);
    if (!point) throw fail();
    const verified = await verifySyntheticCheckpoint(args, { bootstrap, reader, point, timeoutMs });
    if (!equal(point, await checkpointDeadline(() => anchor.getLatest(scope), timeoutMs))) throw fail();
    return result(point, verified.entries);
  } catch { throw fail(); }
}
export async function publishSyntheticCheckpoint(args, { bootstrap, reader, writer, anchor, issuer, entries, timeoutMs = 5000 } = {}) {
  try {
    assertSyntheticBackupEncryption(args);
    const scope = syntheticArchiveScope(bootstrap);
    const expected = await checkpointDeadline(() => anchor.getLatest(scope), timeoutMs);
    const previous = expected ? await verifySyntheticCheckpoint(args, { bootstrap, reader, point: expected, timeoutMs }) : null;
    // Validate caller additions before merging; neither duplicates nor conflicting versions are accepted.
    checkEntries(entries, scope);
    const members = new Map((previous?.payload.entries ?? []).map(e => [e.unitId, e]));
    for (const e of entries) {
      if (members.has(e.unitId) && !equal(members.get(e.unitId), e)) throw fail();
      members.set(e.unitId, structuredClone(e));
    }
    const cumulative = [...members.values()].sort((a, b) => a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0);
    await verifyReferences(args, { bootstrap, reader, entries: cumulative, timeoutMs });
    if (previous && equal(cumulative, previous.payload.entries)) return await recoverSyntheticCheckpoint(args, { bootstrap, reader, anchor, timeoutMs });
    const payload = { domain: 'ktv-synthetic-archive-checkpoint', version: 1, algorithm: 'Ed25519', scope,
      sequence: (expected?.sequence ?? 0) + 1, previous: expected?.locator.version ?? null, entries: cumulative };
    const bytes = await checkpointDeadline(() => issuer.issueCheckpoint(payload), timeoutMs);
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) throw fail();
    const point = { sequence: payload.sequence, previous: payload.previous, locator: {
      objectId: 'checkpoint.' + scope.directoryId + '.' + digest(bytes), version: digest(bytes), size: bytes.length } };
    const ack = await checkpointDeadline(() => writer.putIfAbsent({ objectId: point.locator.objectId, bytes }), timeoutMs);
    if (ack?.objectId !== point.locator.objectId || ack.version !== point.locator.version) throw fail();
    const next = await verifySyntheticCheckpoint(args, { bootstrap, reader, point, timeoutMs });
    if (!equal(next.payload, payload)) throw fail();
    assertCheckpointExtension(previous, next);
    // A timed-out CAS can commit late. Only an independent latest read can resolve uncertainty.
    try { await checkpointDeadline(() => anchor.compareAndSet(scope, expected, point), timeoutMs); } catch { /* reconcile below */ }
    if (!equal(await checkpointDeadline(() => anchor.getLatest(scope), timeoutMs), point)) throw fail();
    return await recoverSyntheticCheckpoint(args, { bootstrap, reader, anchor, timeoutMs });
  } catch { throw fail(); }
}
