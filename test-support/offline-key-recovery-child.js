// Test-only clean recovery process: private PEMs arrive over stdin, never argv/environment/files.
import { readFile } from 'node:fs/promises';
import { createSyntheticOfflineRecovery } from '../backup/offline-key-service.js';
import { createSyntheticRecoveryAuthority, createSyntheticKeyRegistry } from './synthetic-key-service.js';
import { withHistoricalBackupKey } from '../backup/key-session.js';
import { withDecryptedArtifact } from '../backup/encryption.js';
import { verifyArtifact } from '../backup/format.js';
let recovery;
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const bytes = Buffer.concat(chunks), input = JSON.parse(bytes.toString('utf8')); bytes.fill(0);
  const authority = createSyntheticRecoveryAuthority();
  const grant = authority.issue({ keyIds: [input.keyId], expiresAt: Date.now() + 60000 });
  const registry = (await createSyntheticKeyRegistry(input.registryDirectory, { recoveryAuthority: authority })).client('recovery', grant);
  recovery = createSyntheticOfflineRecovery(input.args, { privateKeys: input.privateKeys, registry });
  delete input.privateKeys;
  await withHistoricalBackupKey(input.args, { keyId: input.keyId, checksum: input.checksum, keyService: recovery, registry }, async ({ keyProvider }) => {
    await withDecryptedArtifact({ envelope: await readFile(input.envelopePath), expectedKeyId: input.keyId, keyProvider,
      temporaryParent: input.temporaryParent, expectedChecksum: input.checksum, storeId: input.args.storeId, ledgerId: input.args.ledgerId },
    async ({ directory }) => { await verifyArtifact(directory, { expectedChecksum: input.checksum, storeId: input.args.storeId, ledgerId: input.args.ledgerId }); });
  });
  process.stdout.write('{"code":"SYNTHETIC_OFFLINE_RECOVERY_VERIFIED"}');
} catch { process.stderr.write('SYNTHETIC_OFFLINE_RECOVERY_REJECTED'); process.exitCode = 1; }
finally { recovery?.dispose(); }
