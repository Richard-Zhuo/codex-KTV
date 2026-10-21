import { createOssOffsiteAdapter } from './oss-adapter.js';
import { mockOss } from '../test-support/mock-oss-client.js';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink, link, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonical, digest, durableWrite } from './format.js';
import { withPipelineFixture, protectPipelineTestDirectory, createSyntheticFormat1 } from '../test-support/encrypted-pipeline-fixture.js';
import { createSyntheticKeyRegistry, createSyntheticRecoveryAuthority } from '../test-support/synthetic-key-service.js';
import { createSyntheticOffsiteRemote } from '../test-support/synthetic-offsite-remote.js';
import { createOperationalStore } from '../operations/store.js';
import { acquireOperationalWriter } from '../operations/writer-lock.js';
import { offsiteRpo, recordOffsiteFact } from '../operations/offsite-state.js';

const approvals = new Map();
mock.module('../production/backup-identity.js', { exports: { readBackupIdentity: async ({ configFile, config }) => {
  const approved = approvals.get(configFile);
  if (!approved || approved.config !== canonical(config)) throw Error('SYNTHETIC_IDENTITY_REJECTED');
  return approved.commit;
} } });
const { loadSyntheticPublicKeyGenerator } = await import('./offline-key-service.js');
const { produceSyntheticOffsiteUnit, publishSyntheticOffsiteUnit, retrieveSyntheticOffsiteUnit } = await import('./offsite-unit.js');
const at = Date.parse('2026-10-21T00:00:00.000Z');
const key = generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 65537,
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const wrappingKeyId = 'b5-synthetic-v1';
const schema = JSON.parse(await readFile(new URL('../production/schema-manifest.json', import.meta.url)));
const retainedPaths = ['package.json', 'pnpm-lock.yaml', 'backup/encryption.js', 'backup/format.js', 'backup/key-session.js',
  'backup/offline-key-service.js', 'production/schema-manifest.json', ...Object.keys(schema.migrations).map(n => 'database/migrations/' + n)];
const retainedFiles = await Promise.all(retainedPaths.map(async path => {
  const bytes = await readFile(new URL('../' + path, import.meta.url));
  return { path, bytes: bytes.toString('base64'), sha256: digest(bytes) };
}));
const mockDependency = Buffer.from('{"name":"mysql2","version":"3.24.4","synthetic":true}');
retainedFiles.push({ path: 'node_modules/mysql2/package.json', bytes: mockDependency.toString('base64'), sha256: digest(mockDependency) });

async function fixture(work, { create, time = at, clockUnknown = false, registryFault, beforeProduce, releaseChange } = {}) {
  const remoteRoot = await mkdtemp(join(tmpdir(), 'ktv-b5-remote-'));
  let releaseWriter;
  try {
    await protectPipelineTestDirectory(remoteRoot);
    await withPipelineFixture(async f => {
      for (const d of ['registry', 'operations']) { await mkdir(join(f.root, d), { mode: 0o700 }); await protectPipelineTestDirectory(join(f.root, d)); }
      const source = 'export default ' + JSON.stringify({ version: 1, algorithm: 'RSA-OAEP-SHA256', keys: [{
        wrappingKeyId, publicKey: key.publicKey, fingerprint: digest(createPublicKey(key.publicKey).export({ type: 'spki', format: 'der' }))
      }] }) + ';\n';
      const release = { format: 1, applicationCommit: f.args.applicationCommit,
        node: process.versions.node, dependencies: [{ name: 'mysql2', version: '3.24.4' }],
        lockChecksum: digest(Buffer.from(retainedFiles.find(f => f.path === 'pnpm-lock.yaml').bytes, 'base64')),
        files: [...retainedFiles, { path: 'backup/offline-public-key-policy.js', bytes: Buffer.from(source).toString('base64'), sha256: digest(source) }] };
      if (releaseChange) releaseChange(release);
      const config = { releaseArtifactFile: join(f.root, 'release.json'), releaseArtifactChecksum: digest(JSON.stringify(release)) };
      await durableWrite(config.releaseArtifactFile, JSON.stringify(release)); // Preserve legitimate noncanonical artifact bytes.
      const configFile = join(f.root, 'backup.json'); await durableWrite(configFile, canonical(config));
      approvals.set(configFile, { config: canonical(config), commit: f.args.applicationCommit });
      const releaseIdentity = { config, configFile, identityEnv: {} };
      const service = await loadSyntheticPublicKeyGenerator(f.args, { ...releaseIdentity, wrappingKeyId });
      const authority = createSyntheticRecoveryAuthority();
      const registry = (await createSyntheticKeyRegistry(join(f.root, 'registry'), { recoveryAuthority: authority })).client('backup');
      const keyBackup = { stagingDirectory: f.staging, keyService: service, registry: registryFault?.(registry) ?? registry, timeoutMs: 5000 };
      const store = await createOperationalStore(join(f.root, 'operations'), 'synthetic-offsite');
      releaseWriter = await acquireOperationalWriter(join(f.root, 'operations'), 'synthetic-offsite');
      try {
      let now = time;
      const clock = () => clockUnknown ? null : { utcMs: now, uncertaintyMs: 50 };
      let creates = 0;
      await beforeProduce?.({ releaseIdentity, args: f.args });
      const produced = await produceSyntheticOffsiteUnit(f.args, { keyBackup, releaseIdentity, clock }, {
        create: async input => { creates++; return (create ?? createSyntheticFormat1)(input); }
      });
      const remote = await createSyntheticOffsiteRemote(f.args, remoteRoot);
      const independentReader = (await createSyntheticOffsiteRemote(f.args, remoteRoot)).reader;
      await work({ ...f, remoteRoot, remote, independentReader, store, produced, creates,
        clock, stopWriter: async () => { await releaseWriter?.(); releaseWriter = null; }, advance: ms => { now = ms; }, publish: overrides => publishSyntheticOffsiteUnit(f.args, {
          unit: produced.unit, writer: remote.writer, reader: independentReader, store, clock, ...overrides
        }) });
      } finally { await releaseWriter?.(); releaseWriter = null; approvals.delete(configFile); }
    });
  } finally {
    await releaseWriter?.();
    assert.equal(dirname(resolve(remoteRoot)), resolve(tmpdir())); assert.ok(basename(remoteRoot).startsWith('ktv-b5-remote-'));
    await rm(remoteRoot, { recursive: true, force: true });
  }
}
function child(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../test-support/offsite-retrieval-child.js', import.meta.url))],
      { windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '', TEMP: process.env.TEMP ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.on('error', reject); child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(JSON.stringify(input));
  });
}

test('B5 normal immutable unit, last marker, independent reads and separate local status', async () => fixture(async f => {
  const events = [];
  const result = await f.publish({ writer: { putIfAbsent: async input => { events.push('put:' + input.objectId.split('.').at(-1)); return f.remote.writer.putIfAbsent(input); } },
    reader: { getExact: async input => { events.push('get:' + input.objectId.split('.').at(-1)); return f.independentReader.getExact(input); } } });
  assert.equal(result.code, 'OFFSITE_VERIFIED'); assert.equal(f.creates, 1);
  assert.equal(f.produced.localResult.complete, true); assert.equal(f.produced.localResult.code, 'BACKUP_ENCRYPTED_VERIFIED');
  assert.deepEqual(events.slice(0, 9), ['put:ciphertext', 'put:envelope', 'put:manifest', 'put:release',
    'get:ciphertext', 'get:envelope', 'get:manifest', 'get:release', 'put:complete']);
  assert.equal(events[9], 'get:complete');
  const recovered = await retrieveSyntheticOffsiteUnit(f.args, { reader: f.independentReader, locator: result.locator });
  assert.equal(digest(recovered.ciphertext), f.produced.localResult.artifactChecksum);
  assert.equal(digest(recovered.manifest), f.produced.localResult.checksum);
  assert.equal(JSON.parse(recovered.envelope).binding.keyId, result.unitId);
  const state = f.store.read();
  assert.equal(state.observations.backup, undefined);
  assert.equal(state.observations.offsite.attempts[result.unitId].status, 'OFFSITE_VERIFIED');
  assert.equal(offsiteRpo(state.observations, { utcMs: at + 60000, uncertaintyMs: 10 }).ageMs, 60060);
}));

for (const role of ['ciphertext', 'envelope', 'manifest', 'release']) {
  test('B5 rejects missing ' + role + ' without completion', async () => fixture(async f => {
    const result = await f.publish({ reader: { getExact: input => {
      if (input.objectId.endsWith('.' + role)) throw Error('SYNTHETIC_MISSING'); return f.independentReader.getExact(input);
    } } });
    assert.equal(result.code, 'OFFSITE_UNCONFIRMED');
    assert.ok(!(await readdir(f.remoteRoot)).some(n => n.endsWith('.complete.object')));
    assert.equal(f.store.read().observations.offsite.latestRecoveryPoint, null);
    assert.equal(f.produced.localResult.complete, true);
  }));
  test('B5 rejects tampered ' + role, async () => fixture(async f => {
    const result = await f.publish({ reader: { getExact: async input => {
      const response = await f.independentReader.getExact(input);
      if (input.objectId.endsWith('.' + role)) response.bytes[0] ^= 1;
      return response;
    } } });
    assert.equal(result.code, 'OFFSITE_UNCONFIRMED');
    assert.ok(!(await readdir(f.remoteRoot)).some(n => n.endsWith('.complete.object')));
  }));
}
test('B5 rejects wrong envelope and binding substitution', async () => fixture(async f => {
  const result = await f.publish({ reader: { getExact: async input => {
    const response = await f.independentReader.getExact(input);
    if (input.objectId.endsWith('.envelope')) {
      const record = JSON.parse(response.bytes); record.binding.ledgerId = 'SYNTHETIC-WRONG-LEDGER';
      response.bytes = Buffer.from(canonical(record));
    }
    return response;
  } } });
  assert.equal(result.code, 'OFFSITE_UNCONFIRMED');
}));
for (const fault of ['before-first', 'partial', 'after-write-unknown', 'timeout', 'marker-unknown', 'marker-read', 'marker-tamper']) {
  test('B5 fail closed: ' + fault, async () => fixture(async f => {
    let calls = 0;
    const writer = { putIfAbsent: async input => {
      calls++;
      if (fault === 'before-first' || fault === 'partial' && calls === 2) throw Error('PRIVATE_ERROR_MUST_NOT_ESCAPE');
      if (fault === 'timeout') return new Promise(() => {});
      const ack = await f.remote.writer.putIfAbsent(input);
      if (fault === 'after-write-unknown' || fault === 'marker-unknown' && input.objectId.endsWith('.complete')) throw Error('UNKNOWN');
      return ack;
    } };
    const reader = { getExact: async input => {
      if (fault === 'marker-read' && input.objectId.endsWith('.complete')) throw Error('UNKNOWN');
      const r = await f.independentReader.getExact(input);
      if (fault === 'marker-tamper' && input.objectId.endsWith('.complete')) r.bytes[0] ^= 1;
      return r;
    } };
    const result = await f.publish({ writer, reader, timeoutMs: fault === 'timeout' ? 15 : 5000 });
    assert.deepEqual(result, { code: 'OFFSITE_UNCONFIRMED', unitId: f.produced.unit.unitId });
    assert.equal(f.store.read().observations.offsite.latestRecoveryPoint, null);
    assert.equal(f.store.read().observations.offsite.attempts[result.unitId].status, 'OFFSITE_UNCONFIRMED');
    assert.equal(f.produced.localResult.complete, true);
    if (fault === 'marker-unknown') {
      const reconciled = await f.publish(); assert.equal(reconciled.code, 'OFFSITE_VERIFIED');
    }
  }));
}
test('B5 duplicate submission reuses only identical exact objects', async () => fixture(async f => {
  const first = await f.publish(), names = await readdir(f.remoteRoot);
  const second = await f.publish();
  assert.equal(first.code, 'OFFSITE_VERIFIED'); assert.deepEqual(first.locator, second.locator);
  assert.deepEqual(await readdir(f.remoteRoot), names);
}));
test('B5 conflicting object is never overwritten', async () => fixture(async f => {
  const objectId = f.produced.unit.unitId + '.ciphertext', bytes = Buffer.from('SYNTHETIC-CONFLICT');
  await f.remote.writer.putIfAbsent({ objectId, bytes });
  const result = await f.publish();
  assert.equal(result.code, 'OFFSITE_UNCONFIRMED');
  assert.deepEqual((await f.independentReader.getExact({ objectId, version: digest(bytes) })).bytes, bytes);
}));
test('B5 remote getExact rejects wrong version, traversal and links', async () => fixture(async f => {
  assert.deepEqual(Object.keys(f.remote.writer), ['putIfAbsent']); assert.deepEqual(Object.keys(f.remote.reader), ['getExact']);
  await assert.rejects(f.remote.writer.putIfAbsent({ objectId: '../escape', bytes: Buffer.from('x') }));
  await f.remote.writer.putIfAbsent({ objectId: 'safe', bytes: Buffer.from('SYNTHETIC') });
  await assert.rejects(f.remote.reader.getExact({ objectId: 'safe', version: '0'.repeat(64) }));
  const outside = join(f.root, 'outside'); await durableWrite(outside, 'SYNTHETIC-OUTSIDE');
  await symlink(dirname(outside), join(f.remoteRoot, 'linked.object'), 'junction');
  await link(outside, join(f.remoteRoot, 'hardlinked.object'));
  await assert.rejects(f.remote.reader.getExact({ objectId: 'hardlinked', version: digest('SYNTHETIC-OUTSIDE') }));
  await assert.rejects(f.remote.reader.getExact({ objectId: 'linked', version: digest('SYNTHETIC-OUTSIDE') }));
  assert.equal(await readFile(outside, 'utf8'), 'SYNTHETIC-OUTSIDE');
}));
test('B5 unknown snapshot clock permits material verification but never claims RPO', async () => fixture(async f => {
  const result = await f.publish();
  assert.equal(result.code, 'OFFSITE_VERIFIED');
  assert.deepEqual(offsiteRpo(f.store.read().observations, { utcMs: at, uncertaintyMs: 0 }), { status: 'UNKNOWN', ageMs: null });
}, { clockUnknown: true }));
test('B5 original resources/cache absent: clean process retrieves and validates format1', async () => fixture(async f => {
  const result = await f.publish(); assert.equal(result.code, 'OFFSITE_VERIFIED');
  await rm(f.args.outputDirectory, { recursive: true }); await rm(f.staging, { recursive: true });
  await rm(join(f.root, 'registry'), { recursive: true }); await rm(join(f.root, 'release.json'));
  const locatorFile = join(f.remoteRoot, 'retained-owner-locator.json');
  await durableWrite(locatorFile, canonical(result.locator));
  const restored = await child({ args: f.args, remoteRoot: f.remoteRoot, locatorFile,
    privateKeys: [{ wrappingKeyId, privateKey: key.privateKey }] });
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).checksum, f.produced.localResult.checksum);
}));
test('B5 arbitrary success object cannot replace trusted producer receipt', async () => fixture(async f => {
  await assert.rejects(f.publish({ unit: { ...f.produced.unit } }));
  assert.equal((await readdir(f.remoteRoot)).length, 0);
}));
test('B5 operational record failure cannot report offsite success', async () => fixture(async f => {
  let n = 0;
  const store = { update: work => { if (++n >= 3) throw Error('SYNTHETIC_SYNC_FAILURE'); return f.store.update(work); } };
  const result = await f.publish({ store });
  assert.equal(result.code, 'OFFSITE_UNCONFIRMED');
  assert.equal(f.store.read().observations.offsite.latestRecoveryPoint, null);
}));
for (const mode of ['failure', 'unknown']) {
  test('B5 C1 registration ' + mode + ' prevents any remote publication', async () => fixture(async f => {
    assert.equal(f.produced.unit, null); assert.equal(f.produced.localResult.complete, false);
    assert.equal(f.produced.localResult.keyRegistration, 'UNCONFIRMED');
    assert.equal((await readdir(f.remoteRoot)).length, 0);
  }, { registryFault: registry => ({ register: async record => {
    if (mode === 'unknown') { await registry.register(record); return { status: 'UNKNOWN' }; }
    throw Error('SYNTHETIC_DENIED');
  } }) }));
}
test('B5 remote and retrieval remain synthetic-only', async () => fixture(async f => {
  const args = { ...f.args, environment: 'production' };
  await assert.rejects(createSyntheticOffsiteRemote(args, f.remoteRoot));
  await assert.rejects(retrieveSyntheticOffsiteUnit(args, {}));
}));

test('B5 release trust rejects caller replacement before creating a backup', async () => {
  await assert.rejects(fixture(() => assert.fail('MUST_NOT_CREATE'), { beforeProduce: ({ releaseIdentity }) => {
    releaseIdentity.config.releaseArtifactChecksum = '0'.repeat(64);
  } }));
});
test('B5 missing retained recovery code is rejected before creating a backup', async () => {
  await assert.rejects(fixture(() => assert.fail('MUST_NOT_CREATE'), { releaseChange: release => {
    release.files = release.files.filter(f => f.path !== 'backup/encryption.js');
  } }));
});
test('B5 synthetic adapter after-write fault preserves unknown state and exact object references', async () => fixture(async f => {
  const remote = await createSyntheticOffsiteRemote(f.args, f.remoteRoot, { fault: async (phase, id) => {
    if (phase === 'afterPut' && id.endsWith('.ciphertext')) throw Error('SYNTHETIC_UNKNOWN');
  } });
  const result = await f.publish({ writer: remote.writer });
  assert.equal(result.code, 'OFFSITE_UNCONFIRMED');
  const attempt = f.store.read().observations.offsite.attempts[result.unitId];
  assert.equal(attempt.objects.length, 4);
  assert.equal(attempt.candidateLocator.objectId, result.unitId + '.complete');
  const d = attempt.objects[0];
  assert.equal(digest((await f.independentReader.getExact(d)).bytes), d.sha256);
  assert.equal(attempt.verifiedLocator, null);
}));
test('B5 independent read timeout cannot publish a completion manifest', async () => fixture(async f => {
  const result = await f.publish({ writer: { putIfAbsent: f.remote.writer.putIfAbsent },
    reader: { getExact: async () => new Promise(() => {}) }, timeoutMs: 2000 });
  assert.equal(result.code, 'OFFSITE_UNCONFIRMED');
  assert.ok(!(await readdir(f.remoteRoot)).some(n => n.endsWith('.complete.object')));
}));

test('B5 rejects hash-consistent but wrongly bound completion and unknown version', async () => fixture(async f => {
  const result = await f.publish();
  const retained = await retrieveSyntheticOffsiteUnit(f.args, { reader: f.independentReader, locator: result.locator });
  for (const kind of ['ledger', 'wrappingKeyId', 'version']) {
    const root = join(f.root, 'bad-' + kind); await mkdir(root, { mode: 0o700 }); await protectPipelineTestDirectory(root);
    const remote = await createSyntheticOffsiteRemote(f.args, root), c = structuredClone(retained.completion);
    if (kind === 'ledger') c.binding.ledgerId = 'SYNTHETIC-WRONG-LEDGER';
    if (kind === 'wrappingKeyId') c.wrappingKeyId = 'SYNTHETIC-WRONG-WRAPPER';
    if (kind === 'version') c.version = 999;
    for (const d of c.objects) await remote.writer.putIfAbsent({ objectId: d.objectId, bytes: retained[d.role] });
    const bytes = Buffer.from(canonical(c)), objectId = c.unitId + '.complete';
    const ack = await remote.writer.putIfAbsent({ objectId, bytes });
    await assert.rejects(retrieveSyntheticOffsiteUnit(f.args, { reader: remote.reader,
      locator: { unitId: c.unitId, objectId, version: ack.version, sha256: digest(bytes), size: bytes.length } }));
  }
}));

test('B5 P2 capacity: full references return a stable reason with zero uploads and unchanged recovery point', async () => fixture(async f => {
  for (let n = 0; n < 128; n++) await recordOffsiteFact(f.store, {
    unitId: 'synthetic-retained-' + n, backupId: randomUUID(), at,
    snapshotNotBefore: n === 0 ? at - 1000 : null,
    status: n === 0 ? 'OFFSITE_VERIFIED' : 'UPLOAD_UNCONFIRMED',
    locator: n === 0 ? { unitId: 'synthetic-retained-0' } : null
  });
  const before = f.store.read(), beforeRpo = offsiteRpo(before.observations, { utcMs: at, uncertaintyMs: 0 });
  let uploads = 0;
  const result = await f.publish({ writer: { putIfAbsent: input => {
    uploads++; return f.remote.writer.putIfAbsent(input);
  } } });
  assert.equal(uploads, 0);
  assert.equal(result.code, 'OFFSITE_UNCONFIRMED');
  assert.equal(result.reason, 'OFFSITE_REFERENCE_LIMIT');
  assert.equal(Object.keys(f.store.read().observations.offsite.attempts).length, 128);
  assert.deepEqual(f.store.read(), before);
  assert.deepEqual(offsiteRpo(f.store.read().observations, { utcMs: at, uncertaintyMs: 0 }), beforeRpo);
  assert.deepEqual(await readdir(f.remoteRoot), []);
  assert.equal(f.produced.localResult.complete, true);
}));

test('B5 P2 capacity: remote errors cannot impersonate the local reference limit', async () => fixture(async f => {
  const result = await f.publish({ writer: { putIfAbsent: async () => {
    throw Object.assign(Error('SYNTHETIC_REMOTE_PRIVATE_DETAIL'), { code: 'OFFSITE_REFERENCE_LIMIT' });
  } } });
  assert.deepEqual(result, { code: 'OFFSITE_UNCONFIRMED', unitId: f.produced.unit.unitId });
  assert.equal(f.store.read().observations.offsite.latestRecoveryPoint, null);
}));


test('B5 OSS adapter integration: verified last marker and fresh exact retrieval', async () => fixture(async f => {
  const remote = mockOss();
  const adapter = createOssOffsiteAdapter(f.args, remote);
  const result = await f.publish(adapter);
  assert.equal(result.code, 'OFFSITE_VERIFIED');
  assert.equal(f.produced.localResult.complete, true);
  const puts = remote.events.filter(e => e.method === 'PUT');
  assert.equal(puts.length, 5);
  assert.ok(puts.at(-1).name.endsWith('.complete'));
  assert.equal(remote.events.filter(e => e.method === 'GET').length, 14); // 5 writer reconciliations + original 9 independent reads.
  const fresh = createOssOffsiteAdapter(f.args, { ...remote, writeClient: undefined });
  const restored = await retrieveSyntheticOffsiteUnit(f.args, { reader: fresh.reader, locator: result.locator });
  assert.equal(restored.completion.backupId, f.produced.unit.backupId);
  assert.equal(remote.objects.size, 5);
  assert.equal((await f.publish(adapter)).code, 'OFFSITE_VERIFIED');
  assert.equal(remote.objects.size, 5);
}));

for (const fault of ['denied', 'unknown-unconfirmed', 'conflicting-marker', 'tampered-read']) {
  test('B5 OSS adapter integration fails closed: ' + fault, async () => fixture(async f => {
    const remote = mockOss({
      beforePut: async () => {
        if (fault === 'denied') throw Object.assign(Error('SYNTHETIC_PRIVATE_DETAIL'), { status: 403, code: 'AccessDenied' });
        if (fault === 'unknown-unconfirmed') return new Promise(() => {});
      },
      changeGet: r => { if (fault === 'tampered-read') r.content[0] ^= 1; return r; }
    });
    if (fault === 'conflicting-marker') remote.objects.set(remote.prefix + f.produced.unit.unitId + '.complete', Buffer.from('SYNTHETIC-CONFLICT'));
    const adapter = createOssOffsiteAdapter(f.args, { ...remote, timeoutMs: 15 });
    const result = await f.publish(adapter);
    assert.equal(result.code, 'OFFSITE_UNCONFIRMED');
    assert.equal(f.produced.localResult.complete, true);
    assert.equal(f.store.read().observations.offsite.latestRecoveryPoint, null);
    if (fault === 'conflicting-marker') assert.equal(remote.objects.get(remote.prefix + f.produced.unit.unitId + '.complete').toString(), 'SYNTHETIC-CONFLICT');
    else assert.equal(remote.objects.has(remote.prefix + f.produced.unit.unitId + '.complete'), false);
  }));
}


test('B3A0 clean process discovers signed archive after original server directory is unavailable', async () => fixture(async f => {
  const { createSyntheticArchiveIssuer, createSyntheticArchiveDirectory, writeSyntheticArchiveTrust } =
    await import('../test-support/synthetic-archive-directory.js');
  const result = await f.publish(); assert.equal(result.code, 'OFFSITE_VERIFIED');
  const original = await retrieveSyntheticOffsiteUnit(f.args, { reader: f.independentReader, locator: result.locator });
  const issuer = createSyntheticArchiveIssuer(f.args, {
    directoryId: 'offline-recovery', storeId: f.args.storeId, ledgerId: f.args.ledgerId });
  const directory = await createSyntheticArchiveDirectory(f.args, f.remoteRoot);
  const entry = issuer.issue({ locator: result.locator, completion: original.completion });
  const ack = await directory.writer.putIfAbsent(entry);
  assert.equal(ack.version, digest(entry.bytes));
  const beforeState = f.store.read();
  const beforeObjects = (await readdir(f.remoteRoot)).sort();
  const offlineRoot = await mkdtemp(join(tmpdir(), 'ktv-b3-offline-'));
  let moved = false;
  const unavailable = f.root + '-offline';
  try {
    await protectPipelineTestDirectory(offlineRoot);
    const offlineTrust = await writeSyntheticArchiveTrust(f.args, offlineRoot, issuer);
    // Move only this owned temporary fixture; keep all recovery materials physically intact.
    assert.equal(dirname(resolve(f.root)), resolve(tmpdir()));
    assert.equal(dirname(resolve(unavailable)), resolve(tmpdir()));
    assert.ok(basename(f.root).startsWith('ktv-b4b-unit-'));
    await f.stopWriter();
    await rename(f.root, unavailable); moved = true;
    const recoveryArgs = { environment: f.args.environment, databaseUrl: f.args.databaseUrl,
      storeId: f.args.storeId, ledgerId: f.args.ledgerId, env: f.args.env };
    const restored = await new Promise((resolve, reject) => {
      const processChild = spawn(process.execPath, [fileURLToPath(new URL('../test-support/archive-discovery-child.js', import.meta.url))],
        { windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '', TEMP: process.env.TEMP ?? '' },
          stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      processChild.on('error', reject); processChild.stdout.on('data', b => { stdout += b; });
      processChild.stderr.on('data', b => { stderr += b; });
      processChild.on('close', code => resolve({ code, stdout, stderr }));
      processChild.stdin.end(JSON.stringify({ args: recoveryArgs, remoteRoot: f.remoteRoot, offlineTrust }));
    });
    assert.equal(restored.code, 0, restored.stderr);
    const found = JSON.parse(restored.stdout);
    assert.equal(found.code, 'ARCHIVE_ENTRIES_VERIFIED'); assert.equal(found.entries.length, 1);
    assert.equal(found.entries[0].unitId, result.unitId);
    assert.equal(found.entries[0].checksum, original.completion.binding.checksum);
    assert.equal(found.directoryCompleteness, 'NOT_VERIFIED');
    assert.equal(found.rollbackProtection, 'NOT_VERIFIED'); assert.equal(found.readyForSlotRelease, false);
    assert.deepEqual((await readdir(f.remoteRoot)).sort(), beforeObjects);
    assert.deepEqual(f.store.read(), beforeState);
  } finally {
    if (moved) await rename(unavailable, f.root);
    assert.equal(dirname(resolve(offlineRoot)), resolve(tmpdir())); assert.ok(basename(offlineRoot).startsWith('ktv-b3-offline-'));
    await rm(offlineRoot, { recursive: true, force: true });
  }
}));

test('B3A1 genuine unit checkpoint survives original server loss and independent child recovery', async () => fixture(async f => {
  const { createSyntheticArchiveIssuer, createSyntheticArchiveDirectory, writeSyntheticArchiveTrust } =
    await import('../test-support/synthetic-archive-directory.js');
  const { loadSyntheticArchiveBootstrap } = await import('./archive-discovery.js');
  const { publishSyntheticCheckpoint, recoverSyntheticCheckpoint } = await import('./archive-checkpoint.js');
  const { initializeSyntheticCheckpointAnchor, openSyntheticCheckpointAnchor } = await import('../test-support/synthetic-checkpoint-anchor.js');
  const offlineRoot = await mkdtemp(join(tmpdir(), 'ktv-b3a1-offline-'));
  const unavailable = f.root + '-unavailable'; let moved = false;
  try {
    await protectPipelineTestDirectory(offlineRoot);
    const anchorDirectory = join(offlineRoot, 'anchor'); await mkdir(anchorDirectory); await protectPipelineTestDirectory(anchorDirectory);
    const result = await f.publish();
    const original = await retrieveSyntheticOffsiteUnit(f.args, { reader: f.independentReader, locator: result.locator });
    const directory = await createSyntheticArchiveDirectory(f.args, f.remoteRoot);
    const issuer = createSyntheticArchiveIssuer(f.args, { directoryId: 'checkpoint-integration', storeId: f.args.storeId, ledgerId: f.args.ledgerId });
    const signed = issuer.issue({ locator: result.locator, completion: original.completion });
    const ack = await directory.writer.putIfAbsent(signed);
    const offlineTrust = await writeSyntheticArchiveTrust(f.args, offlineRoot, issuer);
    const bootstrap = await loadSyntheticArchiveBootstrap(f.args, offlineTrust);
    const access = await initializeSyntheticCheckpointAnchor(f.args, { directory: anchorDirectory, bootstrap });
    const anchor = await openSyntheticCheckpointAnchor(f.args, { directory: anchorDirectory, bootstrap, reader: f.independentReader,
      anchorId: access.anchorId, credential: access.custodianCredential });
    const before = f.store.read();
    const options = { bootstrap, reader: f.independentReader, writer: directory.writer, issuer, anchor,
      entries: [{ unitId: result.unitId, ...ack, size: signed.bytes.length }] };
    const checkpoint = await publishSyntheticCheckpoint(f.args, options);
    assert.equal(checkpoint.code, 'SYNTHETIC_CHECKPOINT_VERIFIED');
    assert.equal(checkpoint.entries[0].completion.snapshotNotBefore, original.completion.snapshotNotBefore);
    assert.deepEqual(f.store.read(), before); // no activity release/RPO/local-success writes
    for (const mode of ['missing', 'tamper']) {
      const reader = { getExact: async input => {
        if (input.objectId.endsWith('.manifest') && mode === 'missing') throw Error('MISSING');
        const response = await f.independentReader.getExact(input);
        if (input.objectId.endsWith('.manifest')) response.bytes[0] ^= 1;
        return response;
      } };
      await assert.rejects(recoverSyntheticCheckpoint(f.args, { ...options, reader }), { code: 'ARCHIVE_CHECKPOINT_REJECTED' });
    }
    const objects = (await readdir(f.remoteRoot)).sort();
    await f.stopWriter();
    assert.equal(dirname(resolve(unavailable)), resolve(tmpdir()));
    assert.ok(basename(f.root).startsWith('ktv-b4b-unit-'));
    await rename(f.root, unavailable); moved = true;
    const recoveryArgs = { environment: f.args.environment, databaseUrl: f.args.databaseUrl, env: f.args.env };
    const restored = await new Promise((resolve, reject) => {
      const processChild = spawn(process.execPath, [fileURLToPath(new URL('../test-support/checkpoint-recovery-child.js', import.meta.url))],
        { windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '', TEMP: process.env.TEMP ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      processChild.on('error', reject); processChild.stdout.on('data', b => { stdout += b; });
      processChild.stderr.on('data', b => { stderr += b; });
      processChild.on('close', code => resolve({ code, stdout, stderr }));
      processChild.stdin.end(JSON.stringify({ args: recoveryArgs, remoteRoot: f.remoteRoot, offlineTrust,
        anchor: { directory: anchorDirectory, anchorId: access.anchorId, credential: access.readerCredential } }));
    });
    assert.equal(restored.code, 0, restored.stderr);
    const found = JSON.parse(restored.stdout);
    assert.equal(found.code, 'SYNTHETIC_CHECKPOINT_VERIFIED'); assert.deepEqual(found.units, [result.unitId]);
    assert.equal(found.sequence, 1); assert.equal(found.readyForSlotRelease, false);
    assert.equal(found.activitySlotsReleased, 0); assert.equal(found.physicalDeletion, false);
    assert.equal(found.directoryCompleteness, 'NOT_VERIFIED');
    assert.equal(found.rollbackProtection, 'EXTERNAL_SYNTHETIC_ANCHOR_ASSUMPTION');
    assert.deepEqual((await readdir(f.remoteRoot)).sort(), objects);
    // A real isolated child dies after synced pending bytes and before exclusive publication.
    const oldCheckpoint = JSON.parse((await f.independentReader.getExact(checkpoint.point.locator)).bytes);
    const payload = { ...oldCheckpoint.payload, sequence: 2, previous: checkpoint.point.locator.version };
    const bytes = issuer.issueCheckpoint(payload), version = digest(bytes);
    const next = { sequence: 2, previous: checkpoint.point.locator.version,
      locator: { objectId: 'checkpoint.checkpoint-integration.' + version, version, size: bytes.length } };
    await directory.writer.putIfAbsent({ objectId: next.locator.objectId, bytes });
    const crashed = await new Promise((resolve, reject) => {
      const processChild = spawn(process.execPath, [fileURLToPath(new URL('../test-support/checkpoint-recovery-child.js', import.meta.url))],
        { windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '', TEMP: process.env.TEMP ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
      processChild.on('error', reject); processChild.stdout.resume(); processChild.stderr.resume();
      processChild.on('close', code => resolve(code));
      processChild.stdin.end(JSON.stringify({ action: 'crash-beforeCommit', args: recoveryArgs,
        remoteRoot: f.remoteRoot, offlineTrust, expected: checkpoint.point, next,
        anchor: { directory: anchorDirectory, anchorId: access.anchorId, credential: access.custodianCredential } }));
    });
    assert.equal(crashed, 77);
    assert.ok((await readdir(anchorDirectory)).some(name => name.startsWith('pending-')));
    const reopened = await openSyntheticCheckpointAnchor(recoveryArgs, { directory: anchorDirectory, bootstrap,
      reader: f.independentReader, anchorId: access.anchorId, credential: access.readerCredential });
    const { syntheticArchiveScope } = await import('./archive-discovery.js');
    await assert.rejects(reopened.getLatest(syntheticArchiveScope(bootstrap)), { code: 'SYNTHETIC_ANCHOR_REJECTED' });
    assert.deepEqual(f.store.read(), before);
  } finally {
    if (moved) await rename(unavailable, f.root);
    assert.equal(dirname(resolve(offlineRoot)), resolve(tmpdir())); assert.ok(basename(offlineRoot).startsWith('ktv-b3a1-offline-'));
    await rm(offlineRoot, { recursive: true, force: true });
  }
}));

test('B3A0 signed archive still rejects missing or tampered actual recovery materials', async () => fixture(async f => {
  const { createSyntheticArchiveIssuer, createSyntheticArchiveDirectory, writeSyntheticArchiveTrust } =
    await import('../test-support/synthetic-archive-directory.js');
  const { loadSyntheticArchiveBootstrap, discoverSyntheticArchives } = await import('./archive-discovery.js');
  const result = await f.publish(), original = await retrieveSyntheticOffsiteUnit(f.args, { reader: f.independentReader, locator: result.locator });
  const issuer = createSyntheticArchiveIssuer(f.args, {
    directoryId: 'isolated-failures', storeId: f.args.storeId, ledgerId: f.args.ledgerId });
  const directory = await createSyntheticArchiveDirectory(f.args, f.remoteRoot);
  await directory.writer.putIfAbsent(issuer.issue({ locator: result.locator, completion: original.completion }));
  const offlineRoot = await mkdtemp(join(tmpdir(), 'ktv-b3-offline-'));
  try {
    await protectPipelineTestDirectory(offlineRoot);
    const bootstrap = await loadSyntheticArchiveBootstrap(f.args, await writeSyntheticArchiveTrust(f.args, offlineRoot, issuer));
    const before = f.store.read(), objects = (await readdir(f.remoteRoot)).sort();
    for (const mode of ['missing', 'tampered', 'exception']) {
      const reader = { getExact: async input => {
        if (input.objectId.endsWith('.manifest')) {
          if (mode !== 'tampered') throw Error('SYNTHETIC_PRIVATE_REMOTE_ERROR');
          const response = await directory.reader.getExact(input); response.bytes[0] ^= 1; return response;
        }
        return directory.reader.getExact(input);
      } };
      await assert.rejects(discoverSyntheticArchives(f.args, { bootstrap, reader, enumerator: directory.enumerator }),
        { code: 'ARCHIVE_DISCOVERY_REJECTED' });
    }
    assert.deepEqual(f.store.read(), before);
    assert.deepEqual((await readdir(f.remoteRoot)).sort(), objects);
  } finally {
    assert.equal(dirname(resolve(offlineRoot)), resolve(tmpdir())); assert.ok(basename(offlineRoot).startsWith('ktv-b3-offline-'));
    await rm(offlineRoot, { recursive: true, force: true });
  }
}));
