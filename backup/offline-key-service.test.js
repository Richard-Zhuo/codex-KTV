import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonical, digest, durableWrite } from './format.js';
import { withPipelineFixture, protectPipelineTestDirectory } from '../test-support/encrypted-pipeline-fixture.js';
import { createSyntheticRecoveryAuthority, createSyntheticKeyRegistry } from '../test-support/synthetic-key-service.js';
import { withRegisteredBackupKey, runSyntheticKeyBackup } from './key-session.js';

// Unit seam only: S4 itself is accepted evidence. No product injection point or alternate trust loader.
// The fixture's independent approval map refuses caller-selected self-consistent config/artifact pairs.
const approvals = new Map();
mock.module('../production/backup-identity.js', { exports: { readBackupIdentity: async ({ configFile, config }) => {
  const approved = approvals.get(configFile);
  if (!approved || approved.config !== canonical(config)) throw Error('SYNTHETIC_S4_REJECTED');
  return approved.commit;
} } });
const { loadSyntheticPublicKeyGenerator, createSyntheticOfflineRecovery } = await import('./offline-key-service.js');
const pair = wrappingKeyId => {
  const material = generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 65537,
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { ...material, wrappingKeyId, fingerprint: digest(createPublicKey(material.publicKey).export({ type: 'spki', format: 'der' })) };
};
const entry = key => ({ wrappingKeyId: key.wrappingKeyId, fingerprint: key.fingerprint, publicKey: key.publicKey });
async function policyOptions(f, entries, selected = entries[0]?.wrappingKeyId) {
  const source = 'export default ' + JSON.stringify({ version: 1, algorithm: 'RSA-OAEP-SHA256', keys: entries }) + ';\n';
  const artifact = canonical({ format: 1, applicationCommit: f.args.applicationCommit,
    files: [{ path: 'backup/offline-public-key-policy.js', bytes: Buffer.from(source).toString('base64'), sha256: digest(source) }] });
  const configFile = join(f.root, randomUUID() + '-backup.json'), releaseArtifactFile = join(f.root, randomUUID() + '-artifact.json');
  await durableWrite(releaseArtifactFile, artifact);
  const config = { releaseArtifactFile, releaseArtifactChecksum: digest(artifact) };
  await durableWrite(configFile, canonical(config));
  approvals.set(configFile, { config: canonical(config), commit: f.args.applicationCommit });
  return { configFile, config, identityEnv: {}, wrappingKeyId: selected };
}
async function registryFixture(f) {
  let now = 1000;
  const authority = createSyntheticRecoveryAuthority({ now: () => now }), directory = join(f.root, 'offline-registry');
  await mkdir(directory, { mode: 0o700 }); await protectPipelineTestDirectory(directory);
  const registry = await createSyntheticKeyRegistry(directory, { recoveryAuthority: authority });
  return { directory, registry, authority, advance: value => { now = value; }, reader(keyIds) {
    return registry.client('recovery', authority.issue({ keyIds, expiresAt: 2000 }));
  } };
}
function childRecover(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../test-support/offline-key-recovery-child.js', import.meta.url))],
      { windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '', TEMP: process.env.TEMP ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.on('error', reject); child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(JSON.stringify(input));
  });
}

test('C2 key adapter: trusted pin, OAEP binding, private isolation and fail-closed', async t => withPipelineFixture(async f => {
  const v1 = pair('synthetic-v1'), v2 = pair('synthetic-v2');
  const approved = await policyOptions(f, [entry(v1), entry(v2)]), service = await loadSyntheticPublicKeyGenerator(f.args, approved);
  const r = await registryFixture(f), checksum = digest('SYNTHETIC-OFFLINE-CONTEXT');
  const binding = keyId => ({ keyId, checksum, storeId: f.args.storeId, ledgerId: f.args.ledgerId });
  let record, fingerprint;
  const a = randomUUID(), b = randomUUID();
  await t.test('new independent DEKs; only a public-key generate capability exists', async () => {
    assert.deepEqual(Object.keys(service), ['generate']);
    await withRegisteredBackupKey(f.args, { keyId: a, checksum, keyService: service, registry: r.registry.client('backup') }, async ({ keyProvider }) => {
      fingerprint = digest(keyProvider.resolve({ keyId: a, algorithm: 'aes-256-gcm', usage: 'encrypt' }).key);
    });
    const second = await service.generate(binding(b));
    try { assert.equal(second.key.length, 32); assert.notEqual(digest(second.key), fingerprint); }
    finally { second.key.fill(0); }
    record = await r.reader([a]).get(binding(a));
  });
  await t.test('approved key unwraps exact DEK through C1-authorized registry', async () => {
    const recovery = createSyntheticOfflineRecovery(f.args, { privateKeys: [{ wrappingKeyId: v1.wrappingKeyId, privateKey: v1.privateKey }], registry: r.reader([a]) });
    try { const value = await recovery.recover(record); try { assert.equal(digest(value.key), fingerprint); } finally { value.key.fill(0); } }
    finally { recovery.dispose(); }
  });
  for (const field of ['keyId', 'storeId', 'ledgerId', 'checksum']) {
    await t.test('OAEP independently authenticates changed binding ' + field, async () => {
      const altered = { ...record, binding: { ...record.binding, [field]: field === 'checksum' ? digest('WRONG') : 'wrong-synthetic-value' } };
      // Isolate OAEP's own binding check, even if a read oracle returns a modified registered record.
      const recovery = createSyntheticOfflineRecovery(f.args, { privateKeys: [{ wrappingKeyId: v1.wrappingKeyId, privateKey: v1.privateKey }], registry: { get: async () => altered } });
      try { await assert.rejects(recovery.recover(altered)); } finally { recovery.dispose(); }
    });
  }
  for (const kind of ['wrong-private-key', 'wrong-public-version', 'tampered-ciphertext', 'unknown-version', 'wrong-algorithm', 'noncanonical']) {
    await t.test(kind + ' rejects without DEK return', async () => {
      let altered = structuredClone(record), material = v1;
      const wrapped = JSON.parse(record.wrappedKey);
      if (kind === 'wrong-private-key') material = v2;
      if (kind === 'wrong-public-version') altered.wrappingKeyId = v2.wrappingKeyId;
      if (kind === 'tampered-ciphertext') { const bytes = Buffer.from(wrapped.ciphertext, 'base64'); bytes[0] ^= 1; wrapped.ciphertext = bytes.toString('base64'); }
      if (kind === 'unknown-version') wrapped.version = 2;
      if (kind === 'wrong-algorithm') wrapped.algorithm = 'RSA-OAEP-SHA1';
      altered.wrappedKey = canonical(wrapped) + (kind === 'noncanonical' ? ' ' : '');
      const recovery = createSyntheticOfflineRecovery(f.args, { privateKeys: [{ wrappingKeyId: altered.wrappingKeyId, privateKey: material.privateKey }], registry: { get: async () => altered } });
      try { await assert.rejects(recovery.recover(altered)); } finally { recovery.dispose(); }
    });
  }
  await t.test('static role, wrong keyId grant, expiry and disposed service fail closed', async () => {
    for (const registry of [r.registry.client('recovery'), r.reader([b]), r.registry.client('backup')]) {
      const recovery = createSyntheticOfflineRecovery(f.args, { privateKeys: [{ wrappingKeyId: v1.wrappingKeyId, privateKey: v1.privateKey }], registry });
      try { await assert.rejects(recovery.recover(record)); } finally { recovery.dispose(); }
    }
    const recovery = createSyntheticOfflineRecovery(f.args, { privateKeys: [{ wrappingKeyId: v1.wrappingKeyId, privateKey: v1.privateKey }], registry: r.reader([a]) });
    r.advance(2000); await assert.rejects(recovery.recover(record)); recovery.dispose(); await assert.rejects(recovery.recover(record)); r.advance(1000);
  });
  await t.test('backup constructor rejects private-key input without reading it', async () => {
    let read = false;
    const options = { ...approved };
    Object.defineProperty(options, 'privateKey', { enumerable: true, get() { read = true; throw Error('MUST_NOT_READ_PRIVATE_KEY'); } });
    await assert.rejects(loadSyntheticPublicKeyGenerator(f.args, options)); assert.equal(read, false);
  });
  await t.test('authorization lost before returning DEK rejects instead of releasing plaintext', async () => {
    let reads = 0;
    const recovery = createSyntheticOfflineRecovery(f.args, { privateKeys: [{ wrappingKeyId: v1.wrappingKeyId, privateKey: v1.privateKey }],
      registry: { get: async () => { if (++reads === 2) throw Error('SYNTHETIC_AUTH_EXPIRED'); return record; } } });
    try { await assert.rejects(recovery.recover(record), error => error.code === 'BACKUP_OFFLINE_KEY_REJECTED'); assert.equal(reads, 2); }
    finally { recovery.dispose(); }
  });
  await t.test('unsupported RSA parameters and production recovery admission reject', async () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const weakEntry = { wrappingKeyId: 'synthetic-unsupported', publicKey: weak.publicKey,
      fingerprint: digest(createPublicKey(weak.publicKey).export({ type: 'spki', format: 'der' })) };
    await assert.rejects(loadSyntheticPublicKeyGenerator(f.args, await policyOptions(f, [weakEntry])));
    assert.throws(() => createSyntheticOfflineRecovery({ ...f.args, environment: 'production' },
      { privateKeys: [{ wrappingKeyId: v1.wrappingKeyId, privateKey: v1.privateKey }], registry: r.reader([a]) }));
  });
  await t.test('pin mismatch, unknown key and self-selected trust material reject', async () => {
    const mismatch = await policyOptions(f, [{ ...entry(v1), fingerprint: '0'.repeat(64) }]);
    await assert.rejects(loadSyntheticPublicKeyGenerator(f.args, mismatch));
    await assert.rejects(loadSyntheticPublicKeyGenerator(f.args, { ...approved, wrappingKeyId: 'unapproved' }));
    await assert.rejects(loadSyntheticPublicKeyGenerator(f.args, { ...approved, publicKey: v2.publicKey, fingerprint: v2.fingerprint }));
    const selfSelected = await policyOptions(f, [entry(v2)]); approvals.delete(selfSelected.configFile);
    await assert.rejects(loadSyntheticPublicKeyGenerator(f.args, selfSelected));
    await assert.rejects(loadSyntheticPublicKeyGenerator({ ...f.args, environment: 'production' }, approved));
  });
  await t.test('tampered approved artifact and empty shipped policy cannot authorize keys', async () => {
    const changed = await policyOptions(f, [entry(v1)]);
    await writeFile(changed.config.releaseArtifactFile, '{}');
    await assert.rejects(loadSyntheticPublicKeyGenerator(f.args, changed));
    await assert.rejects(loadSyntheticPublicKeyGenerator(f.args, await policyOptions(f, [], 'synthetic-v1')));
  });
  await t.test('registry retains generic 8192-character cap and rejects oversized persisted metadata', async () => {
    for (const wrappedKey of ['', 'a'.repeat(8193), '\u0000'.repeat(8192)]) {
      await assert.rejects(r.registry.client('backup').register({ ...record, binding: binding(randomUUID()), wrappedKey }));
    }
  });
  await t.test('no DEK or private PEM in registered/public data', async () => {
    const generated = await service.generate(binding(randomUUID()));
    try {
      const text = canonical({ version: 1, binding: binding(generated.keyId), wrappingKeyId: generated.wrappingKeyId, wrappedKey: generated.wrappedKey });
      for (const secret of [generated.key.toString('hex'), generated.key.toString('base64'), v1.privateKey, v2.privateKey]) assert.equal(text.includes(secret), false);
    } finally { generated.key.fill(0); }
    assert.equal((await readFile(approved.config.releaseArtifactFile, 'utf8')).includes('PRIVATE KEY'), false);
  });
}));

test('C2 B4-B/C1 full publication, rotation, and clean-process historical format1 recovery', async () => {
  let retained;
  await withPipelineFixture(async f => {
    const v1 = pair('synthetic-v1'), v2 = pair('synthetic-v2'), r = await registryFixture(f), backups = [];
    for (const material of [v1, v2]) {
      const service = await loadSyntheticPublicKeyGenerator(f.args, await policyOptions(f, [entry(material)]));
      const generatedBindings = [];
      const observed = { generate: binding => { generatedBindings.push({ ...binding }); return service.generate(binding); } };
      const result = await runSyntheticKeyBackup({ ...f.args, outputDirectory: join(f.published, material.wrappingKeyId) }, {
        stagingDirectory: f.staging, keyService: observed, registry: r.registry.client('backup') }, f.ports);
      assert.equal(generatedBindings.length, 1);
      assert.deepEqual(generatedBindings[0], { keyId: result.keyId, checksum: result.checksum, storeId: f.args.storeId, ledgerId: f.args.ledgerId });
      assert.equal(result.complete, true); assert.equal(result.keyRegistration, 'CONFIRMED'); assert.equal(result.plaintext, 'ABSENT'); backups.push(result);
    }
    assert.notEqual(backups[0].keyId, backups[1].keyId);
    retained = { args: f.args, privateKeys: [v1, v2].map(({ wrappingKeyId, privateKey }) => ({ wrappingKeyId, privateKey })), backups: [] };
    for (const result of backups) retained.backups.push({ keyId: result.keyId, checksum: result.checksum,
      record: await readFile(join(r.directory, result.keyId + '.json')), ciphertext: await readFile(join(result.directory, 'backup.b4')) });
  }); // Original backup directories and key-generation instances are gone before the recovery child starts.
  await withPipelineFixture(async f => {
    const directory = join(f.root, 'retained-offline-registry'); await mkdir(directory, { mode: 0o700 }); await protectPipelineTestDirectory(directory);
    for (const backup of retained.backups) {
      await durableWrite(join(directory, backup.keyId + '.json'), backup.record);
      const envelopePath = join(f.root, backup.keyId + '.b4'); await durableWrite(envelopePath, backup.ciphertext);
      const input = { args: retained.args, registryDirectory: directory, temporaryParent: f.root, envelopePath,
        keyId: backup.keyId, checksum: backup.checksum, privateKeys: retained.privateKeys };
      const result = await childRecover(input);
      assert.deepEqual(result, { code: 0, stdout: '{"code":"SYNTHETIC_OFFLINE_RECOVERY_VERIFIED"}', stderr: '' });
    }
  });
});

test('C2 unknown/failed registration never publishes and retains original B4-B residue gate', async () => withPipelineFixture(async f => {
  const material = pair('synthetic-v1'), service = await loadSyntheticPublicKeyGenerator(f.args, await policyOptions(f, [entry(material)]));
  const result = await runSyntheticKeyBackup(f.args, { stagingDirectory: f.staging, keyService: service,
    registry: { register: async () => ({ status: 'UNKNOWN' }) } }, f.ports);
  assert.equal(result.complete, false); assert.equal(result.keyRegistration, 'UNCONFIRMED'); assert.equal(result.ciphertext, 'NOT_PUBLISHED');
  assert.equal(result.plaintext, 'REMAINS'); assert.deepEqual(await readdir(f.published), []);
  await assert.rejects(runSyntheticKeyBackup(f.args, { stagingDirectory: f.staging, keyService: service,
    registry: { register: async () => { throw Error('SYNTHETIC_ERROR'); } } }, f.ports), { code: 'BACKUP_ENCRYPTION_RESIDUE_REQUIRES_REVIEW' });
}));
