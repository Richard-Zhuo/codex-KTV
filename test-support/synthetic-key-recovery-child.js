// Spawned by synthetic tests only. Recovery secrets arrive over stdin, never argv/env/logs.
import { readFile } from 'node:fs/promises';
import { createSyntheticKeyRegistry, createSyntheticKeyService } from './synthetic-key-service.js';
import { withHistoricalBackupKey } from '../backup/key-session.js';
import { withDecryptedArtifact } from '../backup/encryption.js';
import { verifyArtifact } from '../backup/format.js';
let master, service;
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const bytes = Buffer.concat(chunks), input = JSON.parse(bytes.toString('utf8')); bytes.fill(0);
  master = Buffer.from(input.recoveryMaterial, 'base64'); delete input.recoveryMaterial;
  service = createSyntheticKeyService({ masterKey: master }); master.fill(0);
  const registry = await createSyntheticKeyRegistry(input.registryDirectory);
  await withHistoricalBackupKey(input.args, { keyId: input.keyId, checksum: input.checksum,
    keyService: service.client('recovery'), registry: registry.client('recovery') }, async ({ keyProvider }) => {
    await withDecryptedArtifact({ envelope: await readFile(input.envelopePath), expectedKeyId: input.keyId,
      keyProvider, temporaryParent: input.temporaryParent, expectedChecksum: input.checksum,
      storeId: input.args.storeId, ledgerId: input.args.ledgerId }, async ({ directory }) => {
      await verifyArtifact(directory, { expectedChecksum: input.checksum, storeId: input.args.storeId, ledgerId: input.args.ledgerId });
    });
  });
  process.stdout.write(JSON.stringify({ code: 'SYNTHETIC_RECOVERY_VERIFIED' }));
} catch { process.stderr.write('SYNTHETIC_RECOVERY_REJECTED'); process.exitCode = 1; }
finally { master?.fill(0); service?.dispose(); }
