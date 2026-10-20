import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withBackupFixture } from '../test-support/backup-fixture.js';
import { protectPipelineTestDirectory } from '../test-support/encrypted-pipeline-fixture.js';
import { createConfiguredBackup, inspectEncryptedBackupResidues } from './encrypted-pipeline.js';
import { withDecryptedArtifact } from './encryption.js';
import { verifyArtifact, canonical, digest } from './format.js';
import { restoreDatabase, connect, readTables } from './mysql-backup.js';

test('B4-B: owned synthetic MySQL creation publishes verified ciphertext and keeps legacy single-backup/TEST restore contracts',
  { skip: !process.env.LEDGER_MYSQL_TEST_URL }, async t => withBackupFixture(async f => {
    const staging = join(f.dir, 'b4b-staging'), published = join(f.dir, 'b4b-published');
    for (const path of [staging, published]) { await mkdir(path, { mode: 0o700 }); await protectPipelineTestDirectory(path); }
    const key = randomBytes(32), keyId = 'synthetic-b4b-integration', keyProvider = { resolve: () => ({ keyId, key }) };
    try {
      const before = canonical((await f.store.read()).state);
      const args = { ...f.backupArgs, outputDirectory: join(published, 'encrypted') };
      const result = await createConfiguredBackup(args, { encryption: { enabled: true, keyId, stagingDirectory: staging }, keyProvider });
      await t.test('encrypted result separates valid ciphertext, absent plaintext and durable completion', async () => {
        assert.equal(result.complete, true); assert.equal(result.code, 'BACKUP_ENCRYPTED_VERIFIED');
        assert.equal(result.ciphertext, 'PUBLISHED'); assert.equal(result.plaintext, 'ABSENT'); assert.equal(result.resultRecorded, true);
        assert.deepEqual(await readdir(result.directory), ['backup.b4']);
        assert.equal(digest(await readFile(join(result.directory, 'backup.b4'))), result.artifactChecksum);
        assert.equal((await inspectEncryptedBackupResidues(staging))[0].incomplete, false);
      });
      await t.test('published envelope decrypts through original format1 and unchanged TEST restore', async () => {
        const target = f.targetArgs({ directory: result.directory, checksum: result.checksum }, 'b4b');
        let original;
        const restored = await withDecryptedArtifact({ envelope: await readFile(join(result.directory, 'backup.b4')), expectedKeyId: keyId, keyProvider,
          temporaryParent: staging, expectedChecksum: result.checksum, storeId: f.storeId, ledgerId: f.ledgerId }, async ({ directory }) => {
          original = await verifyArtifact(directory, { expectedChecksum: result.checksum, storeId: f.storeId, ledgerId: f.ledgerId });
          return restoreDatabase({ ...target, directory });
        });
        assert.equal(restored.code, 'RESTORE_REQUIRES_VERIFICATION'); assert.equal(restored.mode, 'VERIFYING');
        const connection = await connect(target.databaseUrl);
        try {
          const tables = await readTables(connection, original.spec.tables.filter(name => !['recovery_control', 'recovery_events'].includes(name)));
          for (const [name, table] of Object.entries(tables)) assert.equal(canonical(table), canonical(original.data.tables[name]));
        } finally { await connection.end(); }
        assert.equal(canonical((await f.store.read()).state), before);
      });
      await t.test('omitted encryption still uses the existing format1 single-backup implementation', async () => {
        const legacy = await createConfiguredBackup({ ...args, outputDirectory: join(published, 'legacy') });
        assert.equal(legacy.code, 'BACKUP_VERIFIED');
        const verified = await verifyArtifact(legacy.directory, { expectedChecksum: legacy.checksum, storeId: f.storeId, ledgerId: f.ledgerId });
        assert.equal(verified.manifest.backupFormatVersion, 1);
        assert.deepEqual((await readdir(legacy.directory)).sort(), ['data.json', 'manifest.json', 'manifest.sha256']);
      });
    } finally { key.fill(0); }
  }));
