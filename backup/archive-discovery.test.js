import { fileURLToPath } from 'node:url';
import test, { before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { digest, canonical } from './format.js';
import { protectPipelineTestDirectory } from '../test-support/encrypted-pipeline-fixture.js';
import { createSyntheticArchiveIssuer, writeSyntheticArchiveTrust } from '../test-support/synthetic-archive-directory.js';

const databaseUrl = 'mysql://synthetic@127.0.0.1:33313/jbhh_ktv_test';
const args = () => ({ environment: 'test', databaseUrl, storeId: 'synthetic-store', ledgerId: 'synthetic-ledger',
  env: { NODE_ENV: 'test', STAGE5E_RUN: 'synthetic-only', LEDGER_MYSQL_TEST_URL: databaseUrl } });
const approvedUnits = new Map();
let materialReads = 0;
mock.module('./offsite-unit.js', { exports: { retrieveSyntheticOffsiteUnit: async (_args, { locator }) => {
  materialReads++;
  const unit = approvedUnits.get(locator.unitId);
  if (!unit || canonical(locator) !== canonical(unit.locator)) throw Error('SYNTHETIC_MATERIAL_REJECTED');
  return { completion: structuredClone(unit.completion) };
} } });
const { loadSyntheticArchiveBootstrap, discoverSyntheticArchives } = await import('./archive-discovery.js');
let root, issuer, offlineTrust;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ktv-b3a0-unit-')); await protectPipelineTestDirectory(root);
  issuer = createSyntheticArchiveIssuer(args(), { directoryId: 'synthetic-directory', storeId: 'synthetic-store', ledgerId: 'synthetic-ledger' });
  offlineTrust = await writeSyntheticArchiveTrust(args(), root, issuer);
});
after(async () => {
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('ktv-b3a0-unit-'));
  await rm(root, { recursive: true, force: true });
});
function makeUnit(id = 'synthetic-a') {
  const locator = { unitId: id, objectId: id + '.complete', version: digest(id), sha256: digest(id), size: 123 };
  const completion = { version: 1, unitId: id, backupId: 'synthetic-backup-' + id,
    binding: { keyId: id, storeId: 'synthetic-store', ledgerId: 'synthetic-ledger', checksum: digest('manifest-' + id) },
    wrappingKeyId: 'synthetic-key-version', snapshotNotBefore: 1000, applicationCommit: 'a'.repeat(40),
    objects: ['ciphertext', 'envelope', 'manifest', 'release'].map(role => ({
      role, objectId: id + '.' + role, size: 123, version: digest(role), sha256: digest(role) })) };
  const unit = { locator, completion }; approvedUnits.set(id, structuredClone(unit)); return unit;
}
function model(records) {
  const objects = new Map(records.map(r => [r.objectId, Buffer.from(r.bytes)]));
  const descriptors = records.map(r => ({ objectId: r.objectId, version: digest(r.bytes), size: r.bytes.length }));
  const reader = { getExact: async ({ objectId, version }) => {
    if (!objects.has(objectId)) throw Object.assign(Error('SYNTHETIC_PRIVATE_HEADERS'), { params: { authorization: 'SYNTHETIC_SECRET' } });
    return { objectId, version, bytes: Buffer.from(objects.get(objectId)) };
  } };
  const enumerator = { listPage: async () => ({ status: 'OK', entries: descriptors, nextCursor: null }) };
  return { objects, descriptors, reader, enumerator };
}
const safe = e => {
  assert.equal(e.code, 'ARCHIVE_DISCOVERY_REJECTED'); assert.equal(e.message, 'ARCHIVE_DISCOVERY_REJECTED');
  assert.equal(e.cause, undefined); assert.deepEqual(Object.keys(e), ['code']); return true;
};
async function setup(records) {
  const bootstrap = await loadSyntheticArchiveBootstrap(args(), offlineTrust);
  const remote = model(records ?? [issuer.issue(makeUnit())]);
  return { bootstrap, ...remote };
}
function limited(result) {
  assert.equal(result.code, 'ARCHIVE_ENTRIES_VERIFIED');
  assert.equal(result.directoryCompleteness, 'NOT_VERIFIED');
  assert.equal(result.rollbackProtection, 'NOT_VERIFIED');
  assert.equal(result.readyForSlotRelease, false);
}

test('B3A0 trusted independent signer authenticates entry and full reference', async () => {
  const options = await setup(), result = await discoverSyntheticArchives(args(), options);
  limited(result); assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0].completion, approvedUnits.get('synthetic-a').completion);
  assert.equal(Object.hasOwn(result, 'privateKey'), false);
});
test('B3A0 pagination, identical duplicates and multiple entries are verified', async () => {
  const options = await setup([issuer.issue(makeUnit('a')), issuer.issue(makeUnit('b'))]);
  const seen = [];
  options.enumerator.listPage = async query => {
    seen.push(query);
    return query.cursor === null ? { status: 'OK', entries: [options.descriptors[0]], nextCursor: 'page2' } :
      { status: 'OK', entries: [options.descriptors[0], options.descriptors[1]], nextCursor: null };
  };
  const result = await discoverSyntheticArchives(args(), options);
  limited(result); assert.equal(result.entries.length, 2);
  assert.equal(seen.length, 2); assert.equal(seen[0].limit, 16);
  assert.equal(seen[0].prefix, 'archive.synthetic-directory.');
});
test('B3A0 conflicting duplicate descriptors reject', async () => {
  const options = await setup();
  options.enumerator.listPage = async () => ({ status: 'OK',
    entries: [options.descriptors[0], { ...options.descriptors[0], version: '0'.repeat(64) }], nextCursor: null });
  await assert.rejects(discoverSyntheticArchives(args(), options), safe);
});
for (const mode of ['untrusted-key', 'changed-body', 'unknown-version', 'unknown-algorithm', 'bad-signature']) {
  test('B3A0 remote self-reported hash cannot authenticate: ' + mode, async () => {
    let record = issuer.issue(makeUnit());
    if (mode === 'untrusted-key') {
      record = createSyntheticArchiveIssuer(args(), { directoryId: 'synthetic-directory', storeId: 'synthetic-store', ledgerId: 'synthetic-ledger' }).issue(makeUnit());
    } else {
      const value = JSON.parse(record.bytes);
      if (mode === 'changed-body') value.payload.completion.backupId = 'REPLACED';
      if (mode === 'unknown-version') value.payload.version = 999;
      if (mode === 'unknown-algorithm') value.payload.algorithm = 'UNKNOWN';
      if (mode === 'bad-signature') value.signature = Buffer.alloc(64).toString('base64');
      record.bytes = Buffer.from(canonical(value));
    }
    const options = await setup([record]), before = materialReads;
    await assert.rejects(discoverSyntheticArchives(args(), options), safe);
    assert.equal(materialReads, before);
  });
}
for (const mode of ['wrong-store', 'wrong-ledger', 'wrong-unit', 'wrong-completion', 'missing-unit']) {
  test('B3A0 valid signature still requires correct B5 binding: ' + mode, async () => {
    const unit = makeUnit('binding-' + mode), payload = structuredClone(unit);
    if (mode === 'wrong-store') payload.completion.binding.storeId = 'other-store';
    if (mode === 'wrong-ledger') payload.completion.binding.ledgerId = 'other-ledger';
    if (mode === 'wrong-unit') payload.completion.unitId = 'other-unit';
    if (mode === 'wrong-completion') payload.completion.backupId = 'other-backup';
    if (mode === 'missing-unit') approvedUnits.delete(unit.locator.unitId);
    await assert.rejects(discoverSyntheticArchives(args(), await setup([issuer.issue(payload)])), safe);
  });
}
for (const mode of ['missing-entry', 'tampered-bytes', 'wrong-response-id', 'wrong-size', 'read-timeout']) {
  test('B3A0 exact entry read rejects: ' + mode, async () => {
    const options = await setup(), get = options.reader.getExact;
    options.reader.getExact = async q => {
      if (mode === 'missing-entry') throw Error('SYNTHETIC_SECRET');
      if (mode === 'read-timeout') return new Promise(() => {});
      const response = await get(q);
      if (mode === 'tampered-bytes') response.bytes[0] ^= 1;
      if (mode === 'wrong-response-id') response.objectId = 'replacement';
      if (mode === 'wrong-size') response.bytes = Buffer.concat([response.bytes, Buffer.from(' ')]);
      return response;
    };
    await assert.rejects(discoverSyntheticArchives(args(), { ...options, timeoutMs: 10 }), safe);
  });
}
for (const mode of ['unknown', 'throws', 'timeout', 'cycle', 'oversize', 'escape']) {
  test('B3A0 listing fail closed: ' + mode, async () => {
    const options = await setup();
    options.enumerator.listPage = async () => {
      if (mode === 'unknown') return { status: 'UNKNOWN', entries: [], nextCursor: null };
      if (mode === 'throws') throw Error('SYNTHETIC_PRIVATE_URL');
      if (mode === 'timeout') return new Promise(() => {});
      if (mode === 'cycle') return { status: 'OK', entries: [], nextCursor: 'again' };
      if (mode === 'oversize') return { status: 'OK', entries: Array(17).fill(options.descriptors[0]), nextCursor: null };
      return { status: 'OK', entries: [{ ...options.descriptors[0], objectId: '../outside' }], nextCursor: null };
    };
    await assert.rejects(discoverSyntheticArchives(args(), { ...options, timeoutMs: 10 }), safe);
  });
}
test('B3A0 empty/omitted directory and replayed valid old entries never prove complete or fresh', async () => {
  const options = await setup(), original = await discoverSyntheticArchives(args(), options); limited(original);
  const page = options.enumerator.listPage;
  options.enumerator.listPage = async () => ({ status: 'OK', entries: [], nextCursor: null });
  const omitted = await discoverSyntheticArchives(args(), options); limited(omitted); assert.equal(omitted.entries.length, 0);
  options.enumerator.listPage = page;
  limited(await discoverSyntheticArchives(args(), options));
});
test('B3A0 missing, copied or forged bootstrap rejects before listing', async () => {
  const options = await setup();
  options.enumerator.listPage = async () => { assert.fail('must not contact untrusted directory'); };
  for (const bootstrap of [undefined, {}, { ...options.bootstrap }]) {
    await assert.rejects(discoverSyntheticArchives(args(), { ...options, bootstrap }), safe);
  }
  for (const expectedSha256 of [undefined, '0'.repeat(64)]) {
    await assert.rejects(loadSyntheticArchiveBootstrap(args(), { ...offlineTrust, expectedSha256 }), safe);
  }
});
test('B3A0 replacement trust file cannot supply its own pin; repository file is not bootstrap', async () => {
  const fake = join(root, 'fake.json'); await writeFile(fake, Buffer.from('SYNTHETIC_REPLACEMENT'), { mode: 0o600 });
  await assert.rejects(loadSyntheticArchiveBootstrap(args(), { trustFile: fake, expectedSha256: offlineTrust.expectedSha256 }), safe);
  const repo = new URL('../package.json', import.meta.url);
  await assert.rejects(loadSyntheticArchiveBootstrap(args(), { trustFile: fileURLToPath(repo), expectedSha256: offlineTrust.expectedSha256 }), safe);
});
test('B3A0 synthetic admission remains enforced', async () => {
  const options = await setup(), production = { ...args(), environment: 'production' };
  await assert.rejects(loadSyntheticArchiveBootstrap(production, offlineTrust), safe);
  await assert.rejects(discoverSyntheticArchives(production, options), safe);
});


test('B3A0 filesystem directory adapter paginates candidates without granting trust', async () => {
  const { createSyntheticArchiveDirectory } = await import('../test-support/synthetic-archive-directory.js');
  const { durableWrite } = await import('./format.js');
  const prefix = 'archive.transport.';
  for (let n = 0; n < 17; n++) await durableWrite(join(root, prefix + digest('candidate-' + n) + '.object'), Buffer.from('SYNTHETIC-CANDIDATE-' + n));
  const remote = await createSyntheticArchiveDirectory(args(), root);
  const first = await remote.enumerator.listPage({ prefix, cursor: null, limit: 16 });
  const second = await remote.enumerator.listPage({ prefix, cursor: first.nextCursor, limit: 16 });
  assert.equal(first.entries.length, 16); assert.equal(second.entries.length, 1); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.entries, ...second.entries].map(v => v.objectId)).size, 17);
  for (const d of [...first.entries, ...second.entries]) {
    const response = await remote.reader.getExact(d);
    assert.equal(digest(response.bytes), d.version); assert.equal(response.bytes.length, d.size);
  }
  await assert.rejects(remote.enumerator.listPage({ prefix: '../outside', cursor: null, limit: 16 }));
  await assert.rejects(remote.enumerator.listPage({ prefix, cursor: '99999', limit: 16 }));
  assert.deepEqual(Object.keys(remote).sort(), ['enumerator', 'reader', 'writer']);
});
