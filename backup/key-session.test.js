import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withRegisteredBackupKey, withHistoricalBackupKey, runSyntheticKeyBackup } from './key-session.js';
import { inspectEncryptedBackupResidues } from './encrypted-pipeline.js';
import { digest, durableWrite } from './format.js';
import { withPipelineFixture, protectPipelineTestDirectory } from '../test-support/encrypted-pipeline-fixture.js';
import { createSyntheticKeyService, createSyntheticKeyRegistry, createSyntheticRecoveryAuthority } from '../test-support/synthetic-key-service.js';

const checksum = digest('SYNTHETIC-KEY-SESSION');
const request = keyId => ({ keyId, algorithm: 'aes-256-gcm', usage: 'encrypt' });
const options = (service, registry) => ({ keyId: 'b4c1-' + randomUUID(), checksum,
  keyService: service.client('backup'), registry: registry.client('backup') });
async function setup(f) {
  const registryDirectory = join(f.root, 'independent-registry');
  await mkdir(registryDirectory, { mode: 0o700 }); await protectPipelineTestDirectory(registryDirectory);
  const authority = createSyntheticRecoveryAuthority();
  const master = randomBytes(32), service = createSyntheticKeyService({ masterKey: master, recoveryAuthority: authority });
  const registry = await createSyntheticKeyRegistry(registryDirectory, { recoveryAuthority: authority });
  return { registryDirectory, master, service, registry, recovery(keyId) {
    const grant = authority.issue({ keyIds: [keyId], expiresAt: Date.now() + 60000 });
    return { keyService: service.client('recovery', grant), registry: registry.client('recovery', grant) };
  } };
}
async function recoverInChild(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../test-support/synthetic-key-recovery-child.js', import.meta.url))],
      { windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '', TEMP: process.env.TEMP ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.on('error', reject); child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('C1 key session: generation, immutable binding, authorization and uncertain outcomes', async t => {
  await withPipelineFixture(async f => {
    const s = await setup(f); const { service, registry } = s;
    try {
      let first, firstFingerprint, savedProvider, rawKey;
      await t.test('registered sessions use distinct random DEKs and keyIds; close revokes and zeros', async () => {
        first = options(service, registry); const second = options(service, registry);
        assert.notEqual(first.keyId, second.keyId);
        await withRegisteredBackupKey(f.args, first, async ({ keyProvider }) => {
          savedProvider = keyProvider; rawKey = keyProvider.resolve(request(first.keyId)).key;
          firstFingerprint = digest(rawKey); assert.equal(rawKey.length, 32);
        });
        assert.ok(rawKey.equals(Buffer.alloc(32))); assert.throws(() => savedProvider.resolve(request(first.keyId)));
        await withRegisteredBackupKey(f.args, second, async ({ keyProvider }) => {
          assert.notEqual(digest(keyProvider.resolve(request(second.keyId)).key), firstFingerprint);
        });
      });
      await t.test('authorized historical recovery obtains original DEK without generation cache', async () => {
        await withHistoricalBackupKey(f.args, { ...first, ...s.recovery(first.keyId) },
          async ({ keyProvider }) => {
            assert.equal(digest(keyProvider.resolve({ ...request(first.keyId), usage: 'decrypt' }).key), firstFingerprint);
            assert.throws(() => keyProvider.resolve(request(first.keyId)));
          });
      });
      await t.test('daily identity cannot read history at registry or key service', async () => {
        const binding = { keyId: first.keyId, storeId: f.args.storeId, ledgerId: f.args.ledgerId, checksum };
        const record = await s.recovery(first.keyId).registry.get(binding);
        await assert.rejects(registry.client('backup').get(binding));
        await assert.rejects(service.client('backup').recover(record));
        await assert.rejects(withHistoricalBackupKey(f.args, first, () => assert.fail('not authorized')));
      });
      await t.test('ungranted identity cannot generate, register or recover', async () => {
        const denied = { ...options(service, registry), keyService: service.client('denied'), registry: registry.client('denied') };
        await assert.rejects(withRegisteredBackupKey(f.args, denied, () => assert.fail('not authorized')));
        await assert.rejects(withHistoricalBackupKey(f.args, { ...denied, keyId: first.keyId }, () => assert.fail('not authorized')));
      });
      for (const field of ['storeId', 'ledgerId', 'checksum']) {
        await t.test('historical binding rejects changed ' + field, async () => {
          const args = { ...f.args, ...(field !== 'checksum' ? { [field]: 'another-synthetic-ledger' } : {}) };
          await assert.rejects(withHistoricalBackupKey(args, { ...first, ...(field === 'checksum' ? { checksum: digest('different') } : {}),
            ...s.recovery(first.keyId) }, () => assert.fail('binding bypass')));
        });
      }
      await t.test('wrapped DEK and binding tampering fail authentication', async () => {
        const binding = { keyId: first.keyId, storeId: f.args.storeId, ledgerId: f.args.ledgerId, checksum };
        const record = await s.recovery(first.keyId).registry.get(binding);
        const bytes = Buffer.from(record.wrappedKey, 'base64'); bytes[13] ^= 1;
        await assert.rejects(s.recovery(first.keyId).keyService.recover({ ...record, wrappedKey: bytes.toString('base64') }));
        await assert.rejects(s.recovery(first.keyId).keyService.recover({ ...record, binding: { ...binding, checksum: digest('different') } }));
      });
      await t.test('duplicate registration never overwrites valid history and leaves uncertainty visible', async () => {
        const path = join(s.registryDirectory, first.keyId + '.json'), before = await readFile(path);
        await assert.rejects(withRegisteredBackupKey(f.args, first, () => assert.fail('duplicate confirmed')));
        assert.deepEqual(await readFile(path), before);
        assert.ok((await readdir(s.registryDirectory)).includes(first.keyId + '.json.pending'));
        await assert.rejects(withHistoricalBackupKey(f.args, { ...first, ...s.recovery(first.keyId) }, () => assert.fail('pending accepted')));
      });
      await t.test('missing history rejects and exposes no upstream secret', async () => {
        const missing = options(service, registry);
        await assert.rejects(withHistoricalBackupKey(f.args, { ...missing, ...s.recovery(missing.keyId) },
          () => assert.fail('missing accepted')), error => error.message === 'BACKUP_KEY_OPERATION_UNCONFIRMED');
      });
      for (const [name, replacement] of [
        ['exception', { register: async () => { throw Error('DO-NOT-LEAK-CREDENTIAL'); } }],
        ['unknown outcome', { register: async () => ({ status: 'UNKNOWN' }) }],
        ['incorrect acknowledgement', { register: async () => ({ status: 'CONFIRMED', keyId: 'wrong', registrationDigest: checksum }) }],
        ['timeout', { register: () => new Promise(() => {}) }]
      ]) {
        await t.test('registration ' + name + ' is fail closed and disposes plaintext DEK', async () => {
          let key, entered = false;
          const original = service.client('backup');
          const selected = { ...options(service, registry), timeoutMs: 20, registry: replacement,
            keyService: { generate: async binding => { const result = await original.generate(binding); key = result.key; return result; } } };
          await assert.rejects(withRegisteredBackupKey(f.args, selected, () => { entered = true; }), error => !error.message.includes('DO-NOT-LEAK'));
          assert.equal(entered, false); assert.ok(key.equals(Buffer.alloc(32)));
        });
      }
      await t.test('committed registration with lost response is never assumed successful or overwritten', async () => {
        const selected = options(service, registry); let entered = false;
        selected.registry = { register: async record => { await registry.client('backup').register(record); throw Error('response lost'); } };
        await assert.rejects(withRegisteredBackupKey(f.args, selected, () => { entered = true; })); assert.equal(entered, false);
        const bytes = await readFile(join(s.registryDirectory, selected.keyId + '.json'));
        await assert.rejects(withRegisteredBackupKey(f.args, selected, () => assert.fail('retry accepted')));
        assert.deepEqual(await readFile(join(s.registryDirectory, selected.keyId + '.json')), bytes);
      });
      await t.test('late generation after timeout is discarded and zeros transferred key', async () => {
        let finish, key; const original = service.client('backup');
        const selected = { ...options(service, registry), timeoutMs: 10,
          keyService: { generate: binding => new Promise(resolve => { finish = async () => { const result = await original.generate(binding); key = result.key; resolve(result); }; }) } };
        await assert.rejects(withRegisteredBackupKey(f.args, selected, () => assert.fail('late callback')));
        await finish(); await new Promise(resolve => setImmediate(resolve)); assert.ok(key.equals(Buffer.alloc(32)));
      });
      await t.test('generation failure and malformed key are rejected without leaking upstream details', async () => {
        for (const generate of [async () => { throw Error('DO-NOT-LEAK'); }, async binding => ({ keyId: binding.keyId, key: Buffer.alloc(31) })]) {
          await assert.rejects(withRegisteredBackupKey(f.args, { ...options(service, registry), keyService: { generate } }, () => assert.fail('bad key')),
            error => !error.message.includes('DO-NOT-LEAK'));
        }
      });
      await t.test('historical missing/invalid key and recovery timeout reject and zero late key', async () => {
        const selected = options(service, registry);
        await withRegisteredBackupKey(f.args, selected, async () => {});
        const recovery = { ...selected, registry: s.recovery(selected.keyId).registry };
        for (const recover of [async () => null, async () => ({ keyId: 'wrong', key: Buffer.alloc(32) }),
          async () => { throw Error('PRIVATE-CREDENTIAL'); }]) {
          await assert.rejects(withHistoricalBackupKey(f.args, { ...recovery, keyService: { recover } }, () => assert.fail('bad recovery')),
            error => !error.message.includes('PRIVATE-CREDENTIAL'));
        }
        let finish, transferred;
        const recovering = withHistoricalBackupKey(f.args, { ...recovery, timeoutMs: 20,
          keyService: { recover: record => new Promise(resolve => { finish = async () => {
            const value = await s.recovery(selected.keyId).keyService.recover(record); transferred = value.key; resolve(value);
          }; }) } }, () => assert.fail('late recovery'));
        await assert.rejects(recovering); await finish(); await new Promise(resolve => setImmediate(resolve));
        assert.ok(transferred.equals(Buffer.alloc(32)));
      });
      await t.test('all interfaces reject production admission and unsafe identifiers', async () => {
        const selected = options(service, registry);
        for (const method of [withRegisteredBackupKey, withHistoricalBackupKey]) {
          await assert.rejects(method({ ...f.args, environment: 'production' }, selected, () => assert.fail('production')));
          await assert.rejects(method(f.args, { ...selected, keyId: '../escape' }, () => assert.fail('path escape')));
        }
        await assert.rejects(runSyntheticKeyBackup({ ...f.args, environment: 'production' }, {}));
      });
      await t.test('key never appears in registry or public registration acknowledgement', async () => {
        const selected = options(service, registry);
        await withRegisteredBackupKey(f.args, selected, async ({ keyProvider, ...ack }) => {
          const key = keyProvider.resolve(request(selected.keyId)).key;
          const text = await readFile(join(s.registryDirectory, selected.keyId + '.json'), 'utf8');
          for (const encoded of [key.toString('hex'), key.toString('base64')]) {
            assert.equal(text.includes(encoded), false); assert.equal(JSON.stringify(ack).includes(encoded), false);
          }
        });
      });
    } finally { service.dispose(); s.master.fill(0); }
  });
});

test('C1 real B4-B pipeline publishes distinct sessions; recovery works after original resources are gone', async () => {
  let independent;
  try {
    await withPipelineFixture(async f => {
      const s = await setup(f), results = [];
      try {
        for (const name of ['one-backup', 'two-backup']) {
          const result = await runSyntheticKeyBackup({ ...f.args, outputDirectory: join(f.published, name) }, {
            stagingDirectory: f.staging, keyService: s.service.client('backup'), registry: s.registry.client('backup') }, f.ports);
          assert.equal(result.complete, true); assert.equal(result.keyRegistration, 'CONFIRMED');
          assert.equal(result.plaintext, 'ABSENT'); assert.equal(result.ciphertext, 'PUBLISHED'); results.push(result);
        }
        assert.notEqual(results[0].keyId, results[1].keyId);
        assert.ok((await inspectEncryptedBackupResidues(f.staging)).every(record => !record.incomplete && record.phase === 'COMPLETE'));
        const first = results[0];
        // Model separately retained encrypted registry/ciphertext and authorized recovery material.
        independent = { args: { ...f.args }, keyId: first.keyId, checksum: first.checksum, recoveryMaterial: Buffer.from(s.master),
          record: await readFile(join(s.registryDirectory, first.keyId + '.json')), envelope: await readFile(join(first.directory, 'backup.b4')) };
      } finally { s.service.dispose(); s.master.fill(0); }
    }); // Original directories removed by the owned fixture; original provider and master copy destroyed.
    await withPipelineFixture(async recovery => {
      const registryDirectory = join(recovery.root, 'recovered-registry');
      await mkdir(registryDirectory, { mode: 0o700 }); await protectPipelineTestDirectory(registryDirectory);
      await durableWrite(join(registryDirectory, independent.keyId + '.json'), independent.record);
      const envelopePath = join(recovery.root, 'retained-backup.b4'); await durableWrite(envelopePath, independent.envelope);
      const input = { args: independent.args, registryDirectory, recoveryMaterial: independent.recoveryMaterial.toString('base64'),
        temporaryParent: recovery.root, keyId: independent.keyId, checksum: independent.checksum, envelopePath };
      const recovered = await recoverInChild(input);
      assert.deepEqual(recovered, { code: 0, stdout: '{"code":"SYNTHETIC_RECOVERY_VERIFIED"}', stderr: '' });
      const wrong = randomBytes(32);
      try {
        const rejected = await recoverInChild({ ...input, recoveryMaterial: wrong.toString('base64') });
        assert.equal(rejected.code, 1); assert.equal(rejected.stderr, 'SYNTHETIC_RECOVERY_REJECTED');
      } finally { wrong.fill(0); }
      assert.equal((await readdir(recovery.root)).some(name => name.startsWith('b4-auth-')), false);
    });
  } finally { independent?.recoveryMaterial.fill(0); }
});

test('C1 registration failure retains B4-B residue, never publishes/falls back, blocks next attempt', async () => {
  await withPipelineFixture(async f => {
    const s = await setup(f);
    try {
      const result = await runSyntheticKeyBackup(f.args, { stagingDirectory: f.staging, keyService: s.service.client('backup'),
        registry: { register: async () => { throw Error('SYNTHETIC-SECRET-NOT-LOGGED'); } } }, f.ports);
      assert.equal(result.complete, false); assert.equal(result.keyRegistration, 'UNCONFIRMED');
      assert.equal(result.resultRecorded, true); assert.equal(result.ciphertext, 'NOT_PUBLISHED'); assert.equal(result.plaintext, 'REMAINS');
      assert.equal(JSON.stringify(result).includes('SYNTHETIC-SECRET'), false);
      assert.deepEqual(await readdir(f.published), []);
      assert.ok((await inspectEncryptedBackupResidues(f.staging)).some(record => record.incomplete));
      await assert.rejects(runSyntheticKeyBackup(f.args, { stagingDirectory: f.staging, keyService: s.service.client('backup'),
        registry: s.registry.client('backup') }, f.ports), error => error.code === 'BACKUP_ENCRYPTION_RESIDUE_REQUIRES_REVIEW');
    } finally { s.service.dispose(); s.master.fill(0); }
  });
});
