import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { canonical, digest } from './format.js';
import { protectPipelineTestDirectory } from '../test-support/encrypted-pipeline-fixture.js';
import { createSyntheticArchiveIssuer, createSyntheticArchiveDirectory, writeSyntheticArchiveTrust } from '../test-support/synthetic-archive-directory.js';
import { recordOffsiteFact, offsiteRpo } from '../operations/offsite-state.js';

const units = new Map();
mock.module('./offsite-unit.js', { exports: { retrieveSyntheticOffsiteUnit: async (_args, { locator }) => {
  const u = units.get(locator.unitId);
  if (!u || canonical(locator) !== canonical(u.locator)) throw Error('SYNTHETIC_MISSING');
  return { completion: structuredClone(u.completion) };
} } });
const { loadSyntheticArchiveBootstrap, syntheticArchiveScope } = await import('./archive-discovery.js');
const { initializeSyntheticCheckpointAnchor, openSyntheticCheckpointAnchor } = await import('../test-support/synthetic-checkpoint-anchor.js');
const { recoverSyntheticCheckpoint } = await import('./archive-checkpoint.js');
const { createSyntheticHandoffStore, openSyntheticHandoffStore, handoffSyntheticUnit } = await import('../test-support/synthetic-safe-handoff.js');
const url = 'mysql://synthetic@127.0.0.1:33313/jbhh_ktv_test';
const args = { environment: 'test', databaseUrl: url, storeId: 'synthetic-store', ledgerId: 'synthetic-ledger',
  env: { NODE_ENV: 'test', STAGE5E_RUN: 'synthetic-only', LEDGER_MYSQL_TEST_URL: url } };
const safe = e => { assert.equal(e.code, 'SYNTHETIC_HANDOFF_REJECTED'); assert.equal(e.message, e.code); return true; };
async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), 'ktv-b3a2-control-')); let session;
  try {
    await protectPipelineTestDirectory(root);
    for (const d of ['remote', 'anchor', 'offline']) {
      await mkdir(join(root, d), { mode: 0o700 }); await protectPipelineTestDirectory(join(root, d));
    }
    const issuer = createSyntheticArchiveIssuer(args, { directoryId: 'handoff', storeId: args.storeId, ledgerId: args.ledgerId });
    const offlineTrust = await writeSyntheticArchiveTrust(args, join(root, 'offline'), issuer);
    const bootstrap = await loadSyntheticArchiveBootstrap(args, offlineTrust);
    const remote = await createSyntheticArchiveDirectory(args, join(root, 'remote'));
    const reader = (await createSyntheticArchiveDirectory(args, join(root, 'remote'))).reader;
    const access = await initializeSyntheticCheckpointAnchor(args, { directory: join(root, 'anchor'), bootstrap });
    const anchor = await openSyntheticCheckpointAnchor(args, { directory: join(root, 'anchor'), bootstrap,
      anchorId: access.anchorId, credential: access.custodianCredential, reader, timeoutMs: 30000 });
    const context = { bootstrap, writer: remote.writer, reader, issuer, anchor };
    const faults = { phase: null, writes: 0, writeAt: 0 };
    const options = { fault: async phase => {
      if (phase === 'afterStateReplace' && faults.writeAt && ++faults.writes === faults.writeAt) throw Error('PRIVATE_WRITE_UNKNOWN');
      if (phase === faults.phase) throw Error('PRIVATE_PHASE_INTERRUPTED');
    } };
    session = await createSyntheticHandoffStore(args, context, options);
    const descriptor = session.descriptor;
    function unit(unitId = 'unit-a') {
      const completion = { version: 1, unitId, backupId: randomUUID(), binding: {
        keyId: unitId, storeId: args.storeId, ledgerId: args.ledgerId, checksum: digest(unitId + '-manifest') },
        wrappingKeyId: 'synthetic-v1', applicationCommit: 'a'.repeat(40), snapshotNotBefore: 1000,
        objects: ['ciphertext', 'envelope', 'manifest', 'release'].map(role => ({
          role, objectId: unitId + '.' + role, version: digest(unitId + role), sha256: digest(unitId + role), size: 123 })) };
      const bytes = Buffer.from(canonical(completion)), version = digest(bytes);
      const locator = { unitId, objectId: unitId + '.complete', version, sha256: version, size: bytes.length };
      units.set(unitId, { locator, completion });
      return { unitId, backupId: completion.backupId, snapshotNotBefore: 1000, at: 2000, status: 'OFFSITE_VERIFIED',
        locator, candidateLocator: locator, objects: completion.objects };
    }
    await work({ root, context, faults, unit, descriptor, remote, bootstrap, access,
      get session() { return session; },
      reopen: async () => { await session.close(); session = await openSyntheticHandoffStore(args, descriptor, context, options); return session; } });
  } finally {
    await session?.close();
    for (const path of [session?.descriptor.root, root].filter(Boolean)) {
      assert.equal(dirname(resolve(path)), resolve(tmpdir())); assert.ok(basename(path).startsWith('ktv-b3a2-'));
      await rm(path, { recursive: true, force: true });
    }
  }
}
async function seed(f, count = 1) {
  const facts = Array.from({ length: count }, (_, i) => f.unit(i === 0 ? 'unit-a' : 'unit-' + i));
  await f.session.store.update(s => {
    s.observations.offsite = { attempts: Object.fromEntries(facts.map(f => [f.unitId, { ...f, failures: 0, verifiedLocator: f.locator }])),
      latestRecoveryPoint: { unitId: facts[0].unitId, backupId: facts[0].backupId, snapshotNotBefore: 1000, verifiedAt: 2000, locator: facts[0].locator }, lastAttempt: facts[0].unitId };
  });
  return facts;
}
test('B3A2 normal trusted handoff releases exactly one slot; RPO and materials unchanged', async () => fixture(async f => {
  await seed(f); const before = f.session.store.read(), rpo = offsiteRpo(before.observations, { utcMs: 5000, uncertaintyMs: 10 });
  const result = await handoffSyntheticUnit(f.session.capability, 'unit-a');
  assert.equal(result.code, 'SYNTHETIC_HANDOFF_RELEASED'); assert.equal(result.physicalDeletion, false);
  const state = f.session.store.read().observations.offsite;
  assert.equal(Object.keys(state.attempts).length, 0); assert.equal(state.handoffs['unit-a'].phase, 'RELEASED');
  assert.deepEqual(state.latestRecoveryPoint, before.observations.offsite.latestRecoveryPoint);
  assert.deepEqual(offsiteRpo(f.session.store.read().observations, { utcMs: 5000, uncertaintyMs: 10 }), rpo);
  const files = (await readdir(join(f.root, 'remote'))).sort();
  const again = await handoffSyntheticUnit(f.session.capability, 'unit-a');
  assert.equal(again.alreadyReleased, true); assert.deepEqual((await readdir(join(f.root, 'remote'))).sort(), files);
}));
test('B3A2 128 full: verified handoff admits one new unit and preserves the cap', async () => fixture(async f => {
  await seed(f, 128);
  const extra = f.unit('new-unit');
  await assert.rejects(recordOffsiteFact(f.session.store, extra), { code: 'OFFSITE_REFERENCE_LIMIT' });
  assert.equal(Object.keys(f.session.store.read().observations.offsite.attempts).length, 128);
  assert.equal((await handoffSyntheticUnit(f.session.capability, 'unit-a')).code, 'SYNTHETIC_HANDOFF_RELEASED');
  await recordOffsiteFact(f.session.store, { ...extra, status: 'LOCAL_VERIFIED', locator: null });
  const state = f.session.store.read().observations.offsite;
  assert.equal(Object.keys(state.attempts).length, 128); assert.ok(state.attempts['unit-127']);
  assert.equal(state.handoffs['unit-a'].phase, 'RELEASED');
}));
for (const phase of ['afterIntent', 'afterArchive', 'afterCheckpoint', 'beforeRelease']) {
  test('B3A2 interrupted ' + phase + ' retains active reference; reopen/retry is idempotent', async () => fixture(async f => {
    const [fact] = await seed(f); f.faults.phase = phase;
    assert.equal((await handoffSyntheticUnit(f.session.capability, 'unit-a')).code, 'SYNTHETIC_HANDOFF_UNCONFIRMED');
    assert.ok(f.session.store.read().observations.offsite.attempts['unit-a']);
    await assert.rejects(recordOffsiteFact(f.session.store, fact), { code: 'OFFSITE_HANDOFF_FENCED' });
    f.faults.phase = null; await f.reopen();
    assert.equal((await handoffSyntheticUnit(f.session.capability, 'unit-a')).code, 'SYNTHETIC_HANDOFF_RELEASED');
    assert.equal((await handoffSyntheticUnit(f.session.capability, 'unit-a')).alreadyReleased, true);
  }));
}
test('B3A2 unknown local release write blocks new capacity until durable reconciliation', async () => fixture(async f => {
  await seed(f); f.faults.writeAt = 4;
  const result = await handoffSyntheticUnit(f.session.capability, 'unit-a');
  assert.equal(result.code, 'SYNTHETIC_HANDOFF_UNCONFIRMED');
  await assert.rejects(recordOffsiteFact(f.session.store, f.unit('new-unit')), safe);
  f.faults.writeAt = 0; await f.reopen();
  const retry = await handoffSyntheticUnit(f.session.capability, 'unit-a');
  assert.equal(retry.code, 'SYNTHETIC_HANDOFF_RELEASED'); assert.equal(retry.alreadyReleased, true);
  assert.equal(Object.keys(f.session.store.read().observations.offsite.attempts).length, 0);
}));
test('B3A2 concurrent retries and late results cannot resurrect released references', async () => fixture(async f => {
  const [fact] = await seed(f);
  const results = await Promise.all([handoffSyntheticUnit(f.session.capability, 'unit-a'), handoffSyntheticUnit(f.session.capability, 'unit-a')]);
  assert.ok(results.every(r => r.code === 'SYNTHETIC_HANDOFF_RELEASED'));
  assert.equal(results.filter(r => !r.alreadyReleased).length, 1);
  for (const status of ['LOCAL_VERIFIED', 'UPLOAD_UNCONFIRMED', 'OFFSITE_UNCONFIRMED', 'OFFSITE_VERIFIED'])
    await assert.rejects(recordOffsiteFact(f.session.store, { ...fact, status }), { code: 'OFFSITE_HANDOFF_FENCED' });
  assert.equal(Object.keys(f.session.store.read().observations.offsite.attempts).length, 0);
}));
for (const status of ['LOCAL_VERIFIED', 'UPLOAD_UNCONFIRMED', 'OFFSITE_UNCONFIRMED']) {
  test('B3A2 historical verifiedLocator alone cannot archive unstable ' + status, async () => fixture(async f => {
    const [fact] = await seed(f);
    await recordOffsiteFact(f.session.store, { ...fact, status });
    assert.equal((await handoffSyntheticUnit(f.session.capability, 'unit-a')).code, 'SYNTHETIC_HANDOFF_UNCONFIRMED');
    assert.ok(f.session.store.read().observations.offsite.attempts['unit-a'].verifiedLocator);
    assert.equal(f.session.store.read().observations.offsite.handoffs, undefined);
    assert.equal((await readdir(join(f.root, 'remote'))).length, 0);
  }));
}
for (const mode of ['archive-write', 'cas-unknown', 'anchor-unavailable', 'binding']) {
  test('B3A2 fail closed before release: ' + mode, async () => fixture(async f => {
    await seed(f); const context = f.context, original = { ...context };
    if (mode === 'archive-write') context.writer = { putIfAbsent: async () => { throw Error('PRIVATE_NETWORK'); } };
    if (mode === 'cas-unknown') context.anchor = { getLatest: s => original.anchor.getLatest(s), compareAndSet: async () => { throw Error('UNKNOWN'); } };
    if (mode === 'anchor-unavailable') context.anchor = { getLatest: async () => { throw Error('UNAVAILABLE'); } };
    if (mode === 'binding') units.get('unit-a').completion.backupId = randomUUID();
    assert.equal((await handoffSyntheticUnit(f.session.capability, 'unit-a')).code, 'SYNTHETIC_HANDOFF_UNCONFIRMED');
    assert.ok(f.session.store.read().observations.offsite.attempts['unit-a']);
    Object.assign(context, original);
  }));
}
test('B3A2 checkpoint rollback and wrong CAS authorization cannot free a slot', async () => fixture(async f => {
  await seed(f); f.faults.phase = 'afterCheckpoint';
  assert.equal((await handoffSyntheticUnit(f.session.capability, 'unit-a')).code, 'SYNTHETIC_HANDOFF_UNCONFIRMED');
  f.faults.phase = null;
  const original = f.context.anchor;
  const point = await original.getLatest(syntheticArchiveScope(f.bootstrap));
  f.context.anchor = { getLatest: async () => null, compareAndSet: async () => { throw Error('DENIED'); } };
  assert.equal((await handoffSyntheticUnit(f.session.capability, 'unit-a')).code, 'SYNTHETIC_HANDOFF_UNCONFIRMED');
  assert.ok(f.session.store.read().observations.offsite.attempts['unit-a']);
  f.context.anchor = original;
  assert.deepEqual(await original.getLatest(syntheticArchiveScope(f.bootstrap)), point);
}));
test('B3A2 production selectors, copied capabilities, injected stores and arbitrary roots reject', async () => fixture(async f => {
  await seed(f); const before = f.session.store.read();
  await assert.rejects(handoffSyntheticUnit({ ...f.session.capability }, 'unit-a'), safe);
  await assert.rejects(handoffSyntheticUnit({ store: f.session.store }, 'unit-a'), safe);
  await assert.rejects(createSyntheticHandoffStore(args, { ...f.context, store: f.session.store }), safe);
  await assert.rejects(openSyntheticHandoffStore(args, { root: f.root, token: f.descriptor.token }, f.context), safe);
  await assert.rejects(openSyntheticHandoffStore(args, { ...f.descriptor, token: 'x'.repeat(43) }, f.context), safe);
  await assert.rejects(createSyntheticHandoffStore({ ...args, environment: 'production' }, f.context), safe);
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.equal((await handoffSyntheticUnit(f.session.capability, 'unit-a')).code, 'SYNTHETIC_HANDOFF_UNCONFIRMED');
    await assert.rejects(createSyntheticHandoffStore(args, f.context), safe);
  } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
  assert.deepEqual(f.session.store.read(), before);
}));
test('B3A2 public store cannot delete active references or forge durable receipts', async () => fixture(async f => {
  await seed(f); const before = f.session.store.read();
  await assert.rejects(f.session.store.update(s => { delete s.observations.offsite.attempts['unit-a']; }), safe);
  await assert.rejects(f.session.store.update(s => { s.observations.offsite.handoffs = { 'unit-a': { phase: 'RELEASED' } }; }), safe);
  assert.deepEqual(f.session.store.read(), before);
}));
test('B3A2 retained update objects cannot mutate persisted or cached active indexes', async () => fixture(async f => {
  await seed(f); let retained;
  await f.session.store.update(s => { retained = s; s.observations.offsite.attempts['unit-a'].failures++; });
  const before = f.session.store.read();
  delete retained.observations.offsite.attempts['unit-a'];
  retained.observations.offsite.handoffs = { 'unit-a': { phase: 'RELEASED' } };
  assert.deepEqual(f.session.store.read(), before);
  await f.reopen(); assert.deepEqual(f.session.store.read(), before);
}));
test('B3A2 reconciliation is serialized with handoff and preserves durable released evidence', async () => fixture(async f => {
  await seed(f);
  const release = handoffSyntheticUnit(f.session.capability, 'unit-a');
  const reconcile = f.session.reconcile();
  assert.equal((await release).code, 'SYNTHETIC_HANDOFF_RELEASED'); await reconcile;
  assert.equal(f.session.store.read().observations.offsite.handoffs['unit-a'].phase, 'RELEASED');
  await Promise.all([f.session.close(), f.session.close()]);
}));
test('B3A2 concurrent different units preserve cumulative receipts and latest recovery locator', async () => fixture(async f => {
  await seed(f, 2); const before = f.session.store.read().observations.offsite.latestRecoveryPoint;
  const results = await Promise.all(['unit-a', 'unit-1'].map(id => handoffSyntheticUnit(f.session.capability, id)));
  assert.ok(results.every(r => r.code === 'SYNTHETIC_HANDOFF_RELEASED'));
  const state = f.session.store.read().observations.offsite;
  assert.equal(Object.keys(state.attempts).length, 0); assert.equal(Object.keys(state.handoffs).length, 2);
  assert.deepEqual(state.latestRecoveryPoint, before);
  const recovered = await recoverSyntheticCheckpoint(args, f.context);
  assert.deepEqual(recovered.entries.map(e => e.completion.unitId).sort(), ['unit-1', 'unit-a']);
  await f.reopen(); assert.equal((await handoffSyntheticUnit(f.session.capability, 'unit-a')).alreadyReleased, true);
}));
