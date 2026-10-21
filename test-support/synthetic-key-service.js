// TEST SUPPORT ONLY: local simulation of separate key-service and create-only registry capabilities.
// Possessing the mock recovery material is simulation authority; this is not cloud IAM or production custody.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { lstat, realpath, readFile, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonical, digest, durableWrite } from '../backup/format.js';

const fail = () => Object.assign(new Error('SYNTHETIC_KEY_ACCESS_REJECTED'), { code: 'SYNTHETIC_KEY_ACCESS_REJECTED' });
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const roles = role => ['backup', 'recovery', 'denied'].includes(role);
function checkedBinding(binding) {
  if (!binding || Object.keys(binding).sort().join(',') !== 'checksum,keyId,ledgerId,storeId' ||
      !validId(binding.keyId) || !/^[a-f0-9]{64}$/.test(binding.checksum ?? '') ||
      [binding.storeId, binding.ledgerId].some(v => typeof v !== 'string' || !v || v.length > 64)) throw fail();
}
function checkedRecord(record) {
  if (!record || Object.keys(record).sort().join(',') !== 'binding,version,wrappedKey,wrappingKeyId' || record.version !== 1 ||
      !validId(record.wrappingKeyId) || typeof record.wrappedKey !== 'string' || !/^[A-Za-z0-9+/]{80}$/.test(record.wrappedKey)) throw fail();
  checkedBinding(record.binding);
}
export function createSyntheticKeyService({ masterKey, wrappingKeyId = 'synthetic-master-v1' }) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32 || !validId(wrappingKeyId)) throw fail();
  const master = Buffer.from(masterKey); let active = true;
  const authorize = (role, expected) => { if (!active || role !== expected) throw fail(); };
  return Object.freeze({ dispose() { active = false; master.fill(0); }, client(role) {
    if (!roles(role)) throw fail();
    return Object.freeze({ async generate(binding) {
      authorize(role, 'backup'); checkedBinding(binding);
      const key = randomBytes(32), nonce = randomBytes(12);
      try {
        const cipher = createCipheriv('aes-256-gcm', master, nonce, { authTagLength: 16 });
        cipher.setAAD(Buffer.from(canonical({ version: 1, binding, wrappingKeyId })));
        const wrappedKey = Buffer.concat([nonce, cipher.update(key), cipher.final(), cipher.getAuthTag()]).toString('base64');
        return { keyId: binding.keyId, key, wrappingKeyId, wrappedKey };
      } catch { key.fill(0); throw fail(); }
    }, async recover(record) {
      authorize(role, 'recovery'); checkedRecord(record);
      if (record.wrappingKeyId !== wrappingKeyId) throw fail();
      const bytes = Buffer.from(record.wrappedKey, 'base64'); let pending;
      try {
        const decipher = createDecipheriv('aes-256-gcm', master, bytes.subarray(0, 12), { authTagLength: 16 });
        decipher.setAAD(Buffer.from(canonical({ version: 1, binding: record.binding, wrappingKeyId })));
        decipher.setAuthTag(bytes.subarray(-16)); pending = decipher.update(bytes.subarray(12, -16));
        return { keyId: record.binding.keyId, key: Buffer.concat([pending, decipher.final()]) };
      } catch { throw fail(); }
      finally { pending?.fill(0); }
    } });
  } });
}

// The fixture owns/protects this external directory. No arbitrary names, replacement, recursive removal or retries.
export async function createSyntheticKeyRegistry(directory) {
  const root = resolve(directory);
  async function checkRoot() {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw fail();
  }
  await checkRoot();
  return Object.freeze({ client(role) {
    if (!roles(role)) throw fail();
    return Object.freeze({ async register(input) {
      if (role !== 'backup') throw fail();
      checkedRecord(input);
      // Capture before awaits: caller mutations cannot change the acknowledged binding.
      const bytes = canonical(input), record = JSON.parse(bytes);
      await checkRoot();
      const pending = join(root, record.binding.keyId + '.json.pending'), final = join(root, record.binding.keyId + '.json');
      await durableWrite(pending, bytes);
      await checkRoot();
      await link(pending, final); // Exclusive, never overwrite. Uncertain states retain pending evidence.
      await unlink(pending);
      return { status: 'CONFIRMED', keyId: record.binding.keyId, registrationDigest: digest(bytes) };
    }, async get(binding) {
      if (role !== 'recovery') throw fail();
      checkedBinding(binding); await checkRoot();
      const pending = join(root, binding.keyId + '.json.pending'), final = join(root, binding.keyId + '.json');
      try { await lstat(pending); throw fail(); } catch (error) { if (error.code !== 'ENOENT') throw fail(); }
      const info = await lstat(final);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > 12000 || await realpath(final) !== final) throw fail();
      const bytes = await readFile(final, 'utf8');
      if (Buffer.byteLength(bytes) > 12000) throw fail();
      const record = JSON.parse(bytes); checkedRecord(record);
      if (canonical(record.binding) !== canonical(binding)) throw fail();
      return record;
    } });
  } });
}
