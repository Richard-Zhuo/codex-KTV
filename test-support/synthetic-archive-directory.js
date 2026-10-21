import { protectActivationPath } from '../production/activation-receipt.js';
// Synthetic support only. This separate directory boundary does not change B5 put/get.
import { readdir, lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonical, digest, externalDirectory, durableWrite } from '../backup/format.js';
import { assertSyntheticBackupEncryption } from '../backup/encryption-policy.js';
import { createSyntheticOffsiteRemote } from './synthetic-offsite-remote.js';
import { windowsDirectoryAcl } from '../production/wecom-smoke-config.js';
import { validateRuntimeFileAclStructure } from '../production/runtime-config.js';
const fail = () => Object.assign(Error('SYNTHETIC_ARCHIVE_REJECTED'), { code: 'SYNTHETIC_ARCHIVE_REJECTED' });

// Isolated OFFLINE test custodian. Never a production signer or recovery private key.
export function createSyntheticArchiveIssuer(args, { directoryId, storeId, ledgerId }) {
  assertSyntheticBackupEncryption(args);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const policy = { version: 1, algorithm: 'Ed25519', directoryId, storeId, ledgerId,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
  const bytes = Buffer.from(canonical(policy));
  return Object.freeze({
    trustBytes: () => Buffer.from(bytes),
    expectedSha256: digest(bytes),
    issueCheckpoint(payload) {
      assertSyntheticBackupEncryption(args);
      if (payload?.domain !== 'ktv-synthetic-archive-checkpoint' ||
          canonical(payload.scope) !== canonical({ directoryId, storeId, ledgerId })) throw fail();
      return Buffer.from(canonical({ payload: structuredClone(payload),
        signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64') }));
    },
    // The test controller approves B5 producer references; discovery never obtains this private key.
    issue({ locator, completion }) {
      const payload = { domain: 'ktv-synthetic-archive-entry', version: 1, algorithm: 'Ed25519',
        directoryId, locator: structuredClone(locator), completion: structuredClone(completion) };
      const signed = Buffer.from(canonical({ payload, signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64') }));
      return { objectId: 'archive.' + directoryId + '.' + digest(locator.unitId), bytes: signed };
    }
  });
}

export async function createSyntheticArchiveDirectory(args, directory, { fault = async (_phase, value) => value } = {}) {
  assertSyntheticBackupEncryption(args);
  const root = resolve(directory), remote = await createSyntheticOffsiteRemote(args, root);
  return Object.freeze({ ...remote, enumerator: Object.freeze({
    async listPage({ prefix, cursor, limit }) {
      try {
        assertSyntheticBackupEncryption(args);
        if (!/^archive\.[A-Za-z0-9][A-Za-z0-9_-]{0,31}\.$/.test(prefix ?? '') || limit !== 16 ||
            !(cursor === null || typeof cursor === 'string' && /^[0-9]{1,8}$/.test(cursor)) ||
            await externalDirectory(root) !== root || await realpath(root) !== root || (await lstat(root)).isSymbolicLink()) throw fail();
        if (process.platform === 'win32') {
          const acl = await windowsDirectoryAcl(root); validateRuntimeFileAclStructure(acl, acl.current);
        } else { const s = await lstat(root); if (s.uid !== process.getuid() || s.mode & 0o077) throw fail(); }
        await fault('beforeList', null);
        const names = (await readdir(root)).filter(n => n.startsWith(prefix)).sort();
        // Bounded simulation, never a promise that the underlying directory cannot omit entries.
        if (names.length > 1024) throw fail();
        const offset = cursor === null ? 0 : Number(cursor);
        if (!Number.isSafeInteger(offset) || offset > names.length) throw fail();
        const entries = [];
        for (const name of names.slice(offset, offset + limit)) {
          if (!name.endsWith('.object') || !/^[a-f0-9]{64}$/.test(name.slice(prefix.length, -7))) throw fail();
          const path = join(root, name), s = await lstat(path);
          if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size < 1 || s.size > 32768 || await realpath(path) !== path) throw fail();
          const bytes = await readFile(path);
          if (bytes.length !== s.size) throw fail();
          entries.push({ objectId: name.slice(0, -7), version: digest(bytes), size: bytes.length });
        }
        const next = offset + entries.length;
        return await fault('afterList', { status: 'OK', entries, nextCursor: next < names.length ? String(next) : null });
      } catch { throw fail(); }
    }
  }) });
}



export async function writeSyntheticArchiveTrust(args, directory, issuer) {
  assertSyntheticBackupEncryption(args);
  const root = await externalDirectory(directory), trustFile = join(root, 'archive-trust.json');
  await durableWrite(trustFile, issuer.trustBytes());
  if (process.platform === 'win32') {
    await protectActivationPath(trustFile, (await windowsDirectoryAcl(root)).current);
  }
  return { trustFile, expectedSha256: issuer.expectedSha256 };
}
