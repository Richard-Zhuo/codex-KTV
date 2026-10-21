import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as mock from '../test-support/synthetic-key-service.js';
import { withPipelineFixture, protectPipelineTestDirectory } from '../test-support/encrypted-pipeline-fixture.js';
import { withRegisteredBackupKey, withHistoricalBackupKey } from './key-session.js';
import { digest } from './format.js';

test('C1 P2 recovery authorization scope and expiry', async t => {
  await withPipelineFixture(async f => {
    let now = 1000;
    const authority = mock.createSyntheticRecoveryAuthority({ now: () => now });
    const master = randomBytes(32), service = mock.createSyntheticKeyService({ masterKey: master, recoveryAuthority: authority });
    const directory = join(f.root, 'scoped-registry');
    await mkdir(directory, { mode: 0o700 }); await protectPipelineTestDirectory(directory);
    const registry = await mock.createSyntheticKeyRegistry(directory, { recoveryAuthority: authority });
    const ids = [randomUUID(), randomUUID()], checksum = digest('SYNTHETIC-SCOPED-RECOVERY');
    const binding = keyId => ({ keyId, storeId: f.args.storeId, ledgerId: f.args.ledgerId, checksum });
    const clients = grant => ({ keyService: service.client('recovery', grant), registry: registry.client('recovery', grant) });
    const grant = authority.issue({ keyIds: [ids[0]], expiresAt: 2000 }), scoped = clients(grant);
    let recordA, recordB;
    try {
      for (const keyId of ids) await withRegisteredBackupKey(f.args, { keyId, checksum,
        keyService: service.client('backup'), registry: registry.client('backup') }, async () => {});
      const administrative = clients(authority.issue({ keyIds: ids, expiresAt: 2000 }));
      recordA = await administrative.registry.get(binding(ids[0])); recordB = await administrative.registry.get(binding(ids[1]));
      await t.test('original regression: A grant recovers A but same grant cannot read or unwrap B', async () => {
        await withHistoricalBackupKey(f.args, { ...scoped, keyId: ids[0], checksum }, async ({ keyProvider }) => {
          const value = keyProvider.resolve({ keyId: ids[0], algorithm: 'aes-256-gcm', usage: 'decrypt' });
          assert.equal(value.key.length, 32);
        });
        await assert.rejects(scoped.registry.get(binding(ids[1])));
        await assert.rejects(scoped.keyService.recover(recordB));
        await assert.rejects(withHistoricalBackupKey(f.args, { ...scoped, keyId: ids[1], checksum }, () => assert.fail('B DEK exposed')));
      });
      await t.test('exact expiry rejects new registry reads and DEK unwraps', async () => {
        now = 1999;
        const value = await scoped.keyService.recover(recordA); value.key.fill(0);
        now = 2000;
        await assert.rejects(scoped.registry.get(binding(ids[0])));
        await assert.rejects(scoped.keyService.recover(recordA));
        await assert.rejects(withHistoricalBackupKey(f.args, { ...scoped, keyId: ids[0], checksum }, () => assert.fail('expired DEK exposed')));
        now = 1000;
      });
      await t.test('expiry between registry read and unwrap rejects', async () => {
        const beforeExpiry = await scoped.registry.get(binding(ids[0])); now = 2001;
        await assert.rejects(scoped.keyService.recover(beforeExpiry)); now = 1000;
      });
      await t.test('DEK unwrap rechecks expiry before transferring plaintext key', async () => {
        let reads = 0;
        const issuer = mock.createSyntheticRecoveryAuthority({ now: () => ++reads === 1 ? 1000 : reads === 2 ? 1999 : 2000 });
        const token = issuer.issue({ keyIds: [ids[0]], expiresAt: 2000 });
        const expiringService = mock.createSyntheticKeyService({ masterKey: master, recoveryAuthority: issuer });
        try {
          await assert.rejects(expiringService.client('recovery', token).recover(recordA));
          assert.equal(reads, 3);
        } finally { expiringService.dispose(); }
      });
      await t.test('registry rechecks expiry after asynchronous file reads', async () => {
        const reading = scoped.registry.get(binding(ids[0])); now = 2000;
        await assert.rejects(reading); now = 1000;
      });
      for (const [name, token] of [
        ['missing', undefined], ['forged', { keyIds: ids, expiresAt: 999999 }],
        ['copied and expanded', { ...grant, keyIds: ids, expiresAt: 999999 }],
        ['foreign authority', mock.createSyntheticRecoveryAuthority({ now: () => now }).issue({ keyIds: ids, expiresAt: 2000 })]
      ]) {
        await t.test(name + ' grant is rejected at both endpoints', async () => {
          const untrusted = clients(token);
          await assert.rejects(untrusted.registry.get(binding(ids[0])));
          await assert.rejects(untrusted.keyService.recover(recordA));
        });
      }
      await t.test('issuer snapshots scope and expiry; mutable input and token cannot expand grant', async () => {
        const keyIds = [ids[0]], input = { keyIds, expiresAt: 2000 }, token = authority.issue(input);
        keyIds.push(ids[1]); input.expiresAt = 999999;
        assert.equal(Reflect.set(token, 'keyIds', ids), false);
        const restricted = clients(token);
        await assert.rejects(restricted.registry.get(binding(ids[1])));
        await assert.rejects(restricted.keyService.recover(recordB));
        now = 2000;
        await assert.rejects(restricted.keyService.recover(recordA)); now = 1000;
      });
      await t.test('backup and denied identities cannot use even a valid recovery grant', async () => {
        for (const role of ['backup', 'denied']) {
          await assert.rejects(registry.client(role, grant).get(binding(ids[0])));
          await assert.rejects(service.client(role, grant).recover(recordA));
        }
      });
      await t.test('missing or fake server authority cannot accept caller-controlled grants', async () => {
        const fake = Object.freeze({ issue: () => grant, assertAuthorized: () => true });
        const otherService = mock.createSyntheticKeyService({ masterKey: master, recoveryAuthority: fake });
        const noAuthority = mock.createSyntheticKeyService({ masterKey: master });
        try {
          await assert.rejects(otherService.client('recovery', grant).recover(recordA));
          await assert.rejects(noAuthority.client('recovery', grant).recover(recordA));
          const unboundRegistry = await mock.createSyntheticKeyRegistry(directory, { recoveryAuthority: fake });
          await assert.rejects(unboundRegistry.client('recovery', grant).get(binding(ids[0])));
        } finally { otherService.dispose(); noAuthority.dispose(); }
      });
      await t.test('invalid clock and malformed/expired issuance fail closed', async () => {
        for (const spec of [{ keyIds: [], expiresAt: 2000 }, { keyIds: ['../escape'], expiresAt: 2000 },
          { keyIds: ids, expiresAt: 1000 }, { keyIds: ids, expiresAt: Infinity }]) assert.throws(() => authority.issue(spec));
        now = NaN;
        await assert.rejects(scoped.registry.get(binding(ids[0])));
        await assert.rejects(scoped.keyService.recover(recordA));
        assert.throws(() => authority.issue({ keyIds: ids, expiresAt: 2000 })); now = 1000;
      });
    } finally { service.dispose(); master.fill(0); }
  });
});
