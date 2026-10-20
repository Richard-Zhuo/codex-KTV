import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { withBackupFixture } from '../test-support/backup-fixture.js';
import { backupDatabase, restoreDatabase, connect, readTables } from './mysql-backup.js';
import { verifyArtifact, canonical, durableWrite } from './format.js';
import { protectActivationPath } from '../production/activation-receipt.js';
import { windowsDirectoryAcl } from '../production/wecom-smoke-config.js';
import { encryptArtifact, withDecryptedArtifact } from './encryption.js';

test('B4-A: owned synthetic MySQL format1 encrypt/decrypt reuses unchanged TEST restore',
  { skip: !process.env.LEDGER_MYSQL_TEST_URL }, async () => withBackupFixture(async f => {
    const key = randomBytes(32), keyId = 'synthetic-mysql-key';
    const keyProvider = { resolve: () => ({ keyId, key }) };
    try {
      const before = canonical((await f.store.read()).state);
      const backup = await backupDatabase({ ...f.backupArgs, outputDirectory: join(f.dir, 'plaintext-source') });
      const identity = { expectedChecksum: backup.checksum, storeId: f.storeId, ledgerId: f.ledgerId };
      const original = await verifyArtifact(backup.directory, identity);
      const encrypted = await encryptArtifact({ ...identity, directory: backup.directory, keyId, keyProvider });
      const file = join(f.dir, 'ciphertext.b4'); await durableWrite(file, encrypted);
      const target = f.targetArgs(backup, 'b4a');
      const stagingParent = join(f.dir, 'b4-stage-parent'); await mkdir(stagingParent);
      if (process.platform === 'win32') await protectActivationPath(stagingParent, (await windowsDirectoryAcl(stagingParent)).current, true);
      const result = await withDecryptedArtifact({ ...identity, envelope: await readFile(file), expectedKeyId: keyId, keyProvider, temporaryParent: stagingParent },
        async ({ directory }) => restoreDatabase({ ...target, directory }));
      assert.equal(result.code, 'RESTORE_REQUIRES_VERIFICATION'); assert.equal(result.mode, 'VERIFYING');
      const connection = await connect(target.databaseUrl);
      try {
        const restored = await readTables(connection, original.spec.tables.filter(name => !['recovery_control', 'recovery_events'].includes(name)));
        for (const [name, table] of Object.entries(restored)) assert.equal(canonical(table), canonical(original.data.tables[name]));
      } finally { await connection.end(); }
      assert.equal(canonical((await f.store.read()).state), before);
      await verifyArtifact(backup.directory, identity);
      assert.deepEqual((await readdir(stagingParent)).filter(name => name.startsWith('b4-auth-')), []);
    } finally { key.fill(0); }
  }));
