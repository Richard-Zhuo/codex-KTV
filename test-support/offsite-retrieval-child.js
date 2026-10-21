// Isolated synthetic evidence only. Private recovery material travels via stdin, never argv/files/logs.
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { createSyntheticOffsiteRemote } from './synthetic-offsite-remote.js';
import { retrieveSyntheticOffsiteUnit } from '../backup/offsite-unit.js';
import { createSyntheticRecoveryAuthority, createSyntheticKeyRegistry } from './synthetic-key-service.js';
import { createSyntheticOfflineRecovery } from '../backup/offline-key-service.js';
import { withHistoricalBackupKey } from '../backup/key-session.js';
import { withDecryptedArtifact } from '../backup/encryption.js';
import { verifyArtifact } from '../backup/format.js';
import { protectPipelineTestDirectory } from './encrypted-pipeline-fixture.js';
let root, recovery;
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const remote = await createSyntheticOffsiteRemote(input.args, input.remoteRoot);
  const locator = JSON.parse(await readFile(input.locatorFile, 'utf8'));
  const unit = await retrieveSyntheticOffsiteUnit(input.args, { reader: remote.reader, locator });
  root = await mkdtemp(join(tmpdir(), 'ktv-b5-recovery-')); await protectPipelineTestDirectory(root);
  const registryPath = join(root, 'registry'); await mkdir(registryPath, { mode: 0o700 }); await protectPipelineTestDirectory(registryPath);
  const record = JSON.parse(unit.envelope), authority = createSyntheticRecoveryAuthority();
  const registryService = await createSyntheticKeyRegistry(registryPath, { recoveryAuthority: authority });
  await registryService.client('backup').register(record); // Reconstitute exact encrypted registry evidence, not a private key.
  const registry = registryService.client('recovery', authority.issue({ keyIds: [record.binding.keyId], expiresAt: Date.now() + 60000 }));
  recovery = createSyntheticOfflineRecovery(input.args, { privateKeys: input.privateKeys, registry }); delete input.privateKeys;
  await withHistoricalBackupKey(input.args, { ...record.binding, keyService: recovery, registry }, async ({ keyProvider }) => {
    await withDecryptedArtifact({ envelope: unit.ciphertext, expectedKeyId: record.binding.keyId, keyProvider,
      temporaryParent: root, expectedChecksum: record.binding.checksum, storeId: record.binding.storeId, ledgerId: record.binding.ledgerId },
    async ({ directory }) => { await verifyArtifact(directory, { expectedChecksum: record.binding.checksum,
      storeId: record.binding.storeId, ledgerId: record.binding.ledgerId }); });
  });
  process.stdout.write(JSON.stringify({ code: 'SYNTHETIC_OFFSITE_RETRIEVED', checksum: record.binding.checksum }));
} catch { process.stderr.write('SYNTHETIC_OFFSITE_RETRIEVAL_REJECTED'); process.exitCode = 1; }
finally {
  recovery?.dispose();
  if (root) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ktv-b5-recovery-')) throw Error('TEST_CLEANUP_SCOPE');
    await rm(root, { recursive: true, force: true });
  }
}
