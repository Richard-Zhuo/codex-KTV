// TEST SUPPORT ONLY. Local filesystem simulation; not real offsite storage, IAM or delete protection.
import { lstat, realpath, readFile, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, durableWrite, externalDirectory } from '../backup/format.js';
import { assertSyntheticBackupEncryption } from '../backup/encryption-policy.js';
import { windowsDirectoryAcl } from '../production/wecom-smoke-config.js';
import { validateRuntimeFileAclStructure } from '../production/runtime-config.js';

const fail = () => Object.assign(Error('SYNTHETIC_REMOTE_REJECTED'), { code: 'SYNTHETIC_REMOTE_REJECTED' });
const valid = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(id);
const MAX = 130 * 1024 * 1024;
export async function createSyntheticOffsiteRemote(args, directory, { fault = async () => {} } = {}) {
  assertSyntheticBackupEncryption(args);
  const root = resolve(directory);
  async function check() {
    assertSyntheticBackupEncryption(args);
    if (await externalDirectory(root) !== root || (await lstat(root)).isSymbolicLink()) throw fail();
    if (process.platform === 'win32') {
      const acl = await windowsDirectoryAcl(root); validateRuntimeFileAclStructure(acl, acl.current);
    } else {
      const s = await lstat(root); if (s.uid !== process.getuid() || s.mode & 0o077) throw fail();
    }
  }
  async function read(objectId) {
    await check(); if (!valid(objectId)) throw fail();
    const path = join(root, objectId + '.object'), s = await lstat(path);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > MAX || await realpath(path) !== path) throw fail();
    const bytes = await readFile(path); if (bytes.length > MAX) throw fail(); return bytes;
  }
  await check();
  return Object.freeze({
    writer: Object.freeze({ async putIfAbsent({ objectId, bytes }) {
      try {
        await check();
        if (!valid(objectId) || !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX) throw fail();
        bytes = Buffer.from(bytes);
        await fault('beforePut', objectId);
        const target = join(root, objectId + '.object'), pending = join(root, 'pending-' + randomUUID());
        await durableWrite(pending, bytes); await check();
        try { await link(pending, target); }
        catch (e) {
          if (e.code !== 'EEXIST') throw e;
          const current = await read(objectId);
          if (!current.equals(bytes)) throw fail();
        }
        // Remove only this producer's pending link. A failed sync/close never publishes a target.
        const info = await lstat(pending);
        if (!info.isFile() || info.isSymbolicLink() || await realpath(pending) !== pending) throw fail();
        await unlink(pending);
        await fault('afterPut', objectId);
        return { objectId, version: digest(bytes) };
      } catch { throw fail(); }
    } }),
    reader: Object.freeze({ async getExact({ objectId, version }) {
      try {
        if (!/^[a-f0-9]{64}$/.test(version ?? '')) throw fail();
        await fault('beforeGet', objectId);
        const bytes = await read(objectId);
        if (digest(bytes) !== version) throw fail();
        await fault('afterGet', objectId);
        return { objectId, version, bytes };
      } catch { throw fail(); }
    } })
  });
}
