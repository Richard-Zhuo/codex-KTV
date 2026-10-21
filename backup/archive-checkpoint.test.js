import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { canonical, digest } from './format.js';
import { protectPipelineTestDirectory } from '../test-support/encrypted-pipeline-fixture.js';
import { createSyntheticArchiveIssuer, createSyntheticArchiveDirectory, writeSyntheticArchiveTrust } from '../test-support/synthetic-archive-directory.js';

// Only fast unit tests mock B5 material reads. A separate genuine-unit/new-process integration uses real B5.
const units = new Map();
mock.module('./offsite-unit.js', { exports: { retrieveSyntheticOffsiteUnit: async (_args, { locator }) => {
  const u = units.get(locator.unitId);
  if (!u || canonical(u.locator) !== canonical(locator)) throw Error('PRIVATE_SYNTHETIC_REQUEST');
  return { completion: structuredClone(u.completion) };
} } });
const { loadSyntheticArchiveBootstrap, syntheticArchiveScope } = await import('./archive-discovery.js');
const { publishSyntheticCheckpoint, recoverSyntheticCheckpoint, verifySyntheticCheckpoint } = await import('./archive-checkpoint.js');
const { initializeSyntheticCheckpointAnchor, openSyntheticCheckpointAnchor } = await import('../test-support/synthetic-checkpoint-anchor.js');
const url = 'mysql://synthetic@127.0.0.1:33313/jbhh_ktv_test';
const args = { environment: 'test', databaseUrl: url, storeId: 'synthetic-store', ledgerId: 'synthetic-ledger',
  env: { NODE_ENV: 'test', STAGE5E_RUN: 'synthetic-only', LEDGER_MYSQL_TEST_URL: url } };
const safe = error => {
  assert.match(error.code, /^(ARCHIVE_CHECKPOINT|SYNTHETIC_ANCHOR)_REJECTED$/);
  assert.equal(error.message, error.code); assert.deepEqual(Object.keys(error), ['code']); return true;
};
async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), 'ktv-b3a1-unit-'));
  try {
    await protectPipelineTestDirectory(root);
    for (const d of ['remote', 'anchor', 'offline']) {
      await mkdir(join(root, d), { mode: 0o700 }); await protectPipelineTestDirectory(join(root, d));
    }
    const issuer = createSyntheticArchiveIssuer(args, { directoryId: 'directory', storeId: args.storeId, ledgerId: args.ledgerId });
    const offlineTrust = await writeSyntheticArchiveTrust(args, join(root, 'offline'), issuer);
    const bootstrap = await loadSyntheticArchiveBootstrap(args, offlineTrust);
    const scope = syntheticArchiveScope(bootstrap), directory = join(root, 'anchor');
    const access = await initializeSyntheticCheckpointAnchor(args, { directory, bootstrap });
    const remote = await createSyntheticArchiveDirectory(args, join(root, 'remote'));
    const reader = (await createSyntheticArchiveDirectory(args, join(root, 'remote'))).reader;
    const openAnchor = (role = 'custodian', overrides = {}) => openSyntheticCheckpointAnchor(args, { directory, bootstrap,
      anchorId: access.anchorId, credential: access[role + 'Credential'], reader, ...overrides });
    const anchor = await openAnchor();
    async function entry(id) {
      const locator = { unitId: id, objectId: id + '.complete', version: digest(id), sha256: digest(id), size: 123 };
      const completion = { unitId: id, binding: { keyId: id, storeId: args.storeId, ledgerId: args.ledgerId },
        snapshotNotBefore: 1000, objects: [] };
      units.set(id, { locator, completion });
      const signed = issuer.issue({ locator, completion });
      const ack = await remote.writer.putIfAbsent(signed);
      return { unitId: id, ...ack, size: signed.bytes.length };
    }
    async function point(entries, previous = null, changes = {}) {
      const payload = { domain: 'ktv-synthetic-archive-checkpoint', version: 1, algorithm: 'Ed25519', scope,
        sequence: (previous?.sequence ?? 0) + 1, previous: previous?.locator.version ?? null, entries, ...changes };
      const bytes = issuer.issueCheckpoint(payload), version = digest(bytes);
      const locator = { objectId: 'checkpoint.' + scope.directoryId + '.' + version, version, size: bytes.length };
      await remote.writer.putIfAbsent({ objectId: locator.objectId, bytes });
      return { sequence: payload.sequence, previous: payload.previous, locator };
    }
    const options = { bootstrap, reader, writer: remote.writer, anchor, issuer };
    await work({ root, bootstrap, scope, access, directory, issuer, offlineTrust, remote, reader, anchor, openAnchor, entry, point, options });
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('ktv-b3a1-unit-'));
    await rm(root, { recursive: true, force: true });
  }
}
function limited(result) {
  assert.equal(result.code, 'SYNTHETIC_CHECKPOINT_VERIFIED');
  assert.equal(result.directoryCompleteness, 'NOT_VERIFIED');
  assert.equal(result.rollbackProtection, 'EXTERNAL_SYNTHETIC_ANCHOR_ASSUMPTION');
  assert.equal(result.readyForSlotRelease, false); assert.equal(result.activitySlotsReleased, 0); assert.equal(result.physicalDeletion, false);
}
test('B3A1 normal cumulative publication, exact discovery and original snapshot preservation', async () => fixture(async f => {
  const a = await f.entry('a');
  const first = await publishSyntheticCheckpoint(args, { ...f.options, entries: [a] }); limited(first);
  const b = await f.entry('b');
  const second = await publishSyntheticCheckpoint(args, { ...f.options, entries: [b] }); limited(second);
  assert.equal(second.point.sequence, 2); assert.equal(second.point.previous, first.point.locator.version);
  assert.deepEqual(second.entries.map(e => e.completion.unitId), ['a', 'b']);
  assert.equal(second.entries[0].completion.snapshotNotBefore, 1000);
  assert.deepEqual(await f.anchor.getLatest(f.scope), second.point);
  const persisted = (await Promise.all((await readdir(join(f.root, 'remote'))).map(n => readFile(join(f.root, 'remote', n), 'utf8')))).join('');
  const policy = await readFile(join(f.directory, 'policy.json'), 'utf8');
  for (const secret of [f.access.custodianCredential, f.access.readerCredential]) {
    assert.equal(persisted.includes(secret), false); assert.equal(policy.includes(secret), false);
  }
}));
test('B3A1 reopening anchor and identical retry create no duplicate checkpoint', async () => fixture(async f => {
  const a = await f.entry('a'), first = await publishSyntheticCheckpoint(args, { ...f.options, entries: [a] });
  const reopened = await f.openAnchor('reader');
  limited(await recoverSyntheticCheckpoint(args, { ...f.options, anchor: reopened }));
  const second = await publishSyntheticCheckpoint(args, { ...f.options, entries: [a] });
  assert.deepEqual(second.point, first.point);
  assert.equal((await readdir(f.directory)).filter(n => n.startsWith('commit-')).length, 1);
}));
test('B3A1 producer/read credential cannot CAS, including idempotent update', async () => fixture(async f => {
  const a = await f.entry('a'), next = await f.point([a]), reader = await f.openAnchor('reader');
  await assert.rejects(reader.compareAndSet(f.scope, null, next), safe);
  assert.equal(await reader.getLatest(f.scope), null);
  await f.anchor.compareAndSet(f.scope, null, next);
  await assert.rejects(reader.compareAndSet(f.scope, null, next), safe);
}));
for (const mode of ['missing', 'forged', 'role-string', 'wrong-anchor', 'scope', 'trust-replacement']) {
  test('B3A1 authorization/pin rejection: ' + mode, async () => fixture(async f => {
    let overrides = {};
    if (mode === 'missing') overrides.credential = undefined;
    if (mode === 'forged') overrides.credential = 'x'.repeat(43);
    if (mode === 'role-string') overrides.credential = 'custodian';
    if (mode === 'wrong-anchor') overrides.anchorId = '0'.repeat(64);
    if (mode === 'trust-replacement') {
      const replacement = createSyntheticArchiveIssuer(args, { ...f.scope });
      const d = join(f.root, 'replacement'); await mkdir(d); await protectPipelineTestDirectory(d);
      overrides.bootstrap = await loadSyntheticArchiveBootstrap(args, await writeSyntheticArchiveTrust(args, d, replacement));
    }
    if (mode === 'scope') {
      for (const name of ['storeId', 'ledgerId', 'directoryId'])
        await assert.rejects(f.anchor.getLatest({ ...f.scope, [name]: 'other' }), safe);
    }
    else await assert.rejects(f.openAnchor('custodian', overrides), safe);
  }));
}
test('B3A1 concurrent independent custodians cannot commit a fork', async () => fixture(async f => {
  const a = await f.entry('a'), b = await f.entry('b');
  const left = await f.point([a]), right = await f.point([b]);
  const other = await f.openAnchor();
  const outcomes = await Promise.allSettled([f.anchor.compareAndSet(f.scope, null, left), other.compareAndSet(f.scope, null, right)]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  const latest = await f.anchor.getLatest(f.scope);
  assert.ok([left.locator.version, right.locator.version].includes(latest.locator.version));
  assert.equal((await readdir(f.directory)).filter(n => n.startsWith('commit-')).length, 1);
}));
for (const mode of ['wrong-expected', 'gap', 'rollback', 'wrong-previous', 'omit', 'rewrite']) {
  test('B3A1 CAS rejects ' + mode, async () => fixture(async f => {
    const a = await f.entry('a'), old = await f.point([a]); await f.anchor.compareAndSet(f.scope, null, old);
    const b = await f.entry('b'); let expected = old, entries = [a, b], changes = {};
    if (mode === 'wrong-expected') expected = null;
    if (mode === 'gap') changes.sequence = 3;
    if (mode === 'wrong-previous') changes.previous = '0'.repeat(64);
    if (mode === 'omit') entries = [b];
    if (mode === 'rewrite') entries = [{ ...a, version: digest('changed') }, b];
    const next = mode === 'rollback' ? old : await f.point(entries, old, changes);
    if (mode === 'rollback') {
      const newer = await f.point([a, b], old); await f.anchor.compareAndSet(f.scope, old, newer);
      await assert.rejects(f.anchor.compareAndSet(f.scope, newer, old), safe);
      assert.deepEqual(await f.anchor.getLatest(f.scope), newer);
    } else {
      await assert.rejects(f.anchor.compareAndSet(f.scope, expected, next), safe);
      assert.deepEqual(await f.anchor.getLatest(f.scope), old);
    }
  }));
}
for (const mode of ['beforeRecordSync', 'beforeCommit']) {
  test('B3A1 interrupted pending record is detectable and never a confirmed latest: ' + mode, async () => fixture(async f => {
    const a = await f.entry('a'), next = await f.point([a]);
    const faulted = await f.openAnchor('custodian', { fault: async phase => { if (phase === mode) throw Error('PRIVATE'); } });
    await assert.rejects(faulted.compareAndSet(f.scope, null, next), safe);
    assert.ok((await readdir(f.directory)).some(n => n.startsWith('pending-')));
    await assert.rejects((await f.openAnchor('reader')).getLatest(f.scope), safe);
    await assert.rejects(publishSyntheticCheckpoint(args, { ...f.options, entries: [a] }), safe);
  }));
}
test('B3A1 lost CAS acknowledgment is confirmed by independent durable read', async () => fixture(async f => {
  const a = await f.entry('a'), custodian = await f.openAnchor('custodian', { fault: async phase => { if (phase === 'afterCommit') throw Error('UNKNOWN'); } });
  const readonly = await f.openAnchor('reader'); let reads = 0;
  const anchor = { compareAndSet: (...input) => custodian.compareAndSet(...input), getLatest: (...input) => { reads++; return readonly.getLatest(...input); } };
  const result = await publishSyntheticCheckpoint(args, { ...f.options, anchor, entries: [a] }); limited(result);
  assert.ok(reads >= 4); assert.deepEqual(await readonly.getLatest(f.scope), result.point);
}));
for (const mode of ['never-committed', 'read-unavailable', 'late-commit']) {
  test('B3A1 unknown/timed-out CAS cannot guess success: ' + mode, async () => fixture(async f => {
    const a = await f.entry('a'); let attempted = false, commitLate;
    const anchor = {
      getLatest: scope => { if (attempted && mode === 'read-unavailable') throw Error('PRIVATE'); return f.anchor.getLatest(scope); },
      compareAndSet: (...input) => {
        attempted = true;
        if (mode === 'late-commit') commitLate = () => f.anchor.compareAndSet(...input);
        if (mode === 'never-committed') return new Promise(() => {});
        throw Error('UNKNOWN');
      }
    };
    await assert.rejects(publishSyntheticCheckpoint(args, { ...f.options, anchor, entries: [a], timeoutMs: 1000 }), safe);
    assert.equal(attempted, true);
    if (commitLate) { await commitLate(); limited(await publishSyntheticCheckpoint(args, { ...f.options, entries: [a] })); }
  }));
}
for (const mode of ['missing', 'tamper', 'list-and-checkpoint-rollback']) {
  test('B3A1 recovery refuses remote ' + mode, async () => fixture(async f => {
    const a = await f.entry('a'), first = await publishSyntheticCheckpoint(args, { ...f.options, entries: [a] });
    const b = await f.entry('b'), second = await publishSyntheticCheckpoint(args, { ...f.options, entries: [b] });
    const reader = { getExact: async input => {
      if (mode === 'missing' && input.objectId === b.objectId) throw Error('MISSING');
      if (mode === 'list-and-checkpoint-rollback' && input.objectId === second.point.locator.objectId)
        return f.reader.getExact(first.point.locator);
      const r = await f.reader.getExact(input);
      if (mode === 'tamper' && input.objectId === second.point.locator.objectId) r.bytes[0] ^= 1;
      return r;
    } };
    await assert.rejects(recoverSyntheticCheckpoint(args, { ...f.options, reader }), safe);
    assert.deepEqual(await f.anchor.getLatest(f.scope), second.point);
  }));
}
test('B3A1 signed invalid checkpoint version and oversized cumulative membership reject', async () => fixture(async f => {
  const a = await f.entry('a');
  const next = await f.point([a], null, { version: 2 });
  await assert.rejects(verifySyntheticCheckpoint(args, { ...f.options, point: next }), safe);
  const first = await publishSyntheticCheckpoint(args, { ...f.options, entries: [a] });
  const entries = Array.from({ length: 512 }, (_, i) => {
    const unitId = 'u' + String(i).padStart(4, '0');
    return { ...a, unitId, objectId: 'archive.' + f.scope.directoryId + '.' + digest(unitId) };
  });
  let puts = 0;
  await assert.rejects(publishSyntheticCheckpoint(args, { ...f.options, entries, writer: { putIfAbsent() { puts++; } } }), safe);
  assert.equal(puts, 0); assert.deepEqual(await f.anchor.getLatest(f.scope), first.point);
}));
test('B3A1 changed same-unit entry and conflict cannot replace existing remote bytes', async () => fixture(async f => {
  const a = await f.entry('a'), first = await publishSyntheticCheckpoint(args, { ...f.options, entries: [a] });
  const path = join(f.root, 'remote', first.point.locator.objectId + '.object'), before = await readFile(path);
  await assert.rejects(publishSyntheticCheckpoint(args, { ...f.options, entries: [{ ...a, version: '0'.repeat(64) }] }), safe);
  await assert.rejects(f.remote.writer.putIfAbsent({ objectId: first.point.locator.objectId, bytes: Buffer.from('conflict') }));
  assert.deepEqual(await readFile(path), before); assert.deepEqual(await f.anchor.getLatest(f.scope), first.point);
}));
test('B3A1 anchor missing and production selectors fail closed without remote writes', async () => fixture(async f => {
  const a = await f.entry('a');
  await rename(f.directory, f.directory + '-unavailable');
  await assert.rejects(publishSyntheticCheckpoint(args, { ...f.options, entries: [a] }), safe);
  await assert.rejects(publishSyntheticCheckpoint({ ...args, environment: 'production' }, { ...f.options, entries: [a] }), safe);
  await assert.rejects(recoverSyntheticCheckpoint(args, { ...f.options, bootstrap: { ...f.bootstrap } }), safe);
}));
test('B3A1 publication faults before CAS never confirm handoff or touch anchor history', async () => fixture(async f => {
  const a = await f.entry('a'); let casCalls = 0;
  const anchor = { getLatest: scope => f.anchor.getLatest(scope), compareAndSet: () => { casCalls++; throw Error('MUST_NOT_CAS'); } };
  for (const mode of ['write-failure', 'write-unknown', 'write-timeout', 'read-failure', 'tamper', 'signed-invalid']) {
    const writer = { putIfAbsent: async input => {
      if (mode === 'write-failure') throw Error('PRIVATE_AUTHORIZATION');
      if (mode === 'write-timeout') return new Promise(() => {});
      const ack = await f.remote.writer.putIfAbsent(input);
      if (mode === 'write-unknown') throw Error('UNKNOWN');
      return ack;
    } };
    const reader = { getExact: async input => {
      if (input.objectId.startsWith('checkpoint.') && mode === 'read-failure') throw Error('PRIVATE_HEADERS');
      const response = await f.reader.getExact(input);
      if (input.objectId.startsWith('checkpoint.') && mode === 'tamper') response.bytes[0] ^= 1;
      return response;
    } };
    const issuer = mode === 'signed-invalid' ? { issueCheckpoint: payload => f.issuer.issueCheckpoint({ ...payload, version: 2 }) } : f.issuer;
    await assert.rejects(publishSyntheticCheckpoint(args, { ...f.options, anchor, reader, writer, issuer, entries: [a], timeoutMs: 1000 }), safe);
    assert.equal(await f.anchor.getLatest(f.scope), null);
  }
  assert.equal(casCalls, 0);
  assert.equal((await readdir(f.directory)).filter(n => n.startsWith('commit-')).length, 0);
}));
test('B3A1 an injected reader cannot mutate the trusted expected checkpoint pointer', async () => fixture(async f => {
  const a = await f.entry('a'), b = await f.entry('b');
  const approved = await f.point([a]), substitute = await f.point([b]);
  const original = structuredClone(approved);
  const reader = { getExact: input => {
    if (input.objectId === approved.locator.objectId) Object.assign(input, substitute.locator);
    return f.reader.getExact(input);
  } };
  await assert.rejects(verifySyntheticCheckpoint(args, { ...f.options, reader, point: approved }), safe);
  assert.deepEqual(approved, original);
}));
