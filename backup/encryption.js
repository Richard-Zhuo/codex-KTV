// B4-A only: no scheduler, CLI, KMS or production restore wiring.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { open, lstat, realpath, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { canonical, digest, externalDirectory, durableWrite, verifyArtifact } from './format.js';
import { protectActivationPath, validateActivationAcl } from '../production/activation-receipt.js';
import { validateRuntimeFileAclStructure } from '../production/runtime-config.js';
import { windowsDirectoryAcl } from '../production/wecom-smoke-config.js';

const MAGIC = Buffer.from('KTVB4AE1');
const ALGORITHM = 'aes-256-gcm', VERSION = 1, TAG_BYTES = 16, NONCE_BYTES = 12;
const LIMITS = [1024 * 1024, 128 * 1024 * 1024, 1024];
const FILES = ['manifest.json', 'data.json', 'manifest.sha256'];
const MAX_HEADER = 1024, MAX_PAYLOAD = LIMITS.reduce((a, b) => a + b + 4, 0);
const internalErrors = new WeakSet();
function failure(code) {
  const error = Object.assign(new Error(code), { code });
  internalErrors.add(error); return error;
}
const sanitized = (error, fallback) => internalErrors.has(error) ? error : failure(fallback);
const validKeyId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);
function checkIdentity({ expectedChecksum, storeId, ledgerId }) {
  if (!/^[a-f0-9]{64}$/.test(expectedChecksum ?? '') ||
      [storeId, ledgerId].some(id => typeof id !== 'string' || !id || id.length > 64)) {
    throw failure('B4_INPUT_INVALID');
  }
}
async function resolveKey(provider, keyId, usage) {
  if (!validKeyId(keyId)) throw failure('B4_KEY_ID_INVALID');
  if (typeof provider?.resolve !== 'function') throw failure('B4_KEY_UNAVAILABLE');
  let supplied;
  try { supplied = await provider.resolve(Object.freeze({ keyId, algorithm: ALGORITHM, usage })); }
  catch { throw failure('B4_KEY_UNAVAILABLE'); }
  if (supplied == null) throw failure('B4_KEY_UNAVAILABLE');
  if (supplied.keyId !== keyId) throw failure('B4_KEY_ID_MISMATCH');
  if (!Buffer.isBuffer(supplied.key) || supplied.key.length !== 32) throw failure('B4_KEY_INVALID');
  return Buffer.from(supplied.key); // Never mutate provider-owned key material.
}
async function readBounded(path, limit) {
  if ((await lstat(path)).isSymbolicLink()) throw failure('B4_SOURCE_INVALID');
  const file = await open(path, 'r'); let bytes;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > limit) throw failure('B4_SOURCE_INVALID');
    bytes = Buffer.alloc(info.size + 1); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw failure('B4_SOURCE_CHANGED');
    return bytes.subarray(0, offset);
  } catch (error) { bytes?.fill(0); throw error; }
  finally { await file.close(); }
}
function frame(parts) {
  return Buffer.concat(parts.flatMap(bytes => {
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); return [length, bytes];
  }));
}
function unframe(bytes) {
  let offset = 0;
  const parts = LIMITS.map(limit => {
    if (offset + 4 > bytes.length) throw failure('B4_PAYLOAD_INVALID');
    const size = bytes.readUInt32BE(offset); offset += 4;
    if (!size || size > limit || offset + size > bytes.length) throw failure('B4_PAYLOAD_INVALID');
    const part = bytes.subarray(offset, offset + size); offset += size; return part;
  });
  if (offset !== bytes.length) throw failure('B4_PAYLOAD_INVALID');
  return parts;
}
function parseEnvelope(bytes, expectedKeyId) {
  if (bytes.length < 12 + TAG_BYTES || bytes.length > 12 + MAX_HEADER + MAX_PAYLOAD + TAG_BYTES ||
      !bytes.subarray(0, 8).equals(MAGIC)) throw failure('B4_ENVELOPE_INVALID');
  const headerSize = bytes.readUInt32BE(8), end = 12 + headerSize;
  if (!headerSize || headerSize > MAX_HEADER || end + TAG_BYTES >= bytes.length) throw failure('B4_ENVELOPE_INVALID');
  let header;
  try { header = JSON.parse(bytes.subarray(12, end).toString('utf8')); }
  catch { throw failure('B4_ENVELOPE_INVALID'); }
  if (!header || typeof header !== 'object' || Array.isArray(header) ||
      Object.keys(header).sort().join(',') !== 'algorithm,envelopeVersion,keyId,nonce' ||
      canonical(header) !== bytes.subarray(12, end).toString('utf8')) throw failure('B4_ENVELOPE_INVALID');
  if (header.envelopeVersion !== VERSION || header.algorithm !== ALGORITHM) throw failure('B4_FORMAT_UNSUPPORTED');
  if (!validKeyId(header.keyId)) throw failure('B4_KEY_ID_INVALID');
  if (header.keyId !== expectedKeyId) throw failure('B4_KEY_ID_MISMATCH');
  if (typeof header.nonce !== 'string' || !/^[A-Za-z0-9+/]{16}$/.test(header.nonce)) throw failure('B4_ENVELOPE_INVALID');
  const nonce = Buffer.from(header.nonce, 'base64');
  if (nonce.length !== NONCE_BYTES || nonce.toString('base64') !== header.nonce) throw failure('B4_ENVELOPE_INVALID');
  return { nonce, aad: bytes.subarray(0, end),
    ciphertext: bytes.subarray(end, -TAG_BYTES), tag: bytes.subarray(-TAG_BYTES) };
}

// Returns only ciphertext. Callers own durable ciphertext storage and its lifecycle.
export async function encryptArtifact({ directory, expectedChecksum, storeId, ledgerId, keyId, keyProvider } = {}) {
  let key, payload; const parts = [];
  try {
    const identity = { expectedChecksum, storeId, ledgerId }; checkIdentity(identity);
    const root = await externalDirectory(directory);
    let verified;
    try { verified = await verifyArtifact(root, identity); }
    catch { throw failure('B4_FORMAT1_REJECTED'); }
    for (let i = 0; i < FILES.length; i++) parts.push(await readBounded(join(root, FILES[i]), LIMITS[i]));
    // Bind the exact captured bytes to the original verifier's snapshot, despite source races.
    if (digest(parts[0]) !== expectedChecksum || digest(parts[1]) !== verified.manifest.dataChecksum ||
        parts[1].length !== verified.manifest.dataBytes || parts[2].toString('utf8').trim() !== expectedChecksum) {
      throw failure('B4_SOURCE_CHANGED');
    }
    key = await resolveKey(keyProvider, keyId, 'encrypt');
    payload = frame(parts);
    const nonce = randomBytes(NONCE_BYTES);
    const header = Buffer.from(canonical({ envelopeVersion: VERSION, algorithm: ALGORITHM, keyId, nonce: nonce.toString('base64') }));
    const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
    const aad = Buffer.concat([MAGIC, length, header]);
    const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    return Buffer.concat([aad, cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  } catch (error) { throw sanitized(error, 'B4_ENCRYPT_FAILED'); }
  finally { key?.fill(0); payload?.fill(0); for (const bytes of parts) bytes.fill(0); }
}

async function checkStagingParent(parent) {
  if (process.platform === 'win32') {
    const acl = await windowsDirectoryAcl(parent);
    validateRuntimeFileAclStructure(acl, acl.current);
    if (![acl.current, 'S-1-5-18', 'S-1-5-32-544'].includes(acl.owner)) throw failure('B4_STAGE_FAILED');
  } else {
    const info = await lstat(parent);
    if ((info.mode & 0o022) !== 0 || info.uid !== process.getuid()) throw failure('B4_STAGE_FAILED');
  }
}
async function protectStaging(directory) {
  if (process.platform === 'win32') {
    const { current } = await windowsDirectoryAcl(directory);
    await protectActivationPath(directory, current, true);
    validateActivationAcl(await windowsDirectoryAcl(directory), current, { directory: true, producer: true });
  } else if (((await lstat(directory)).mode & 0o077) !== 0) {
    throw failure('B4_STAGE_FAILED');
  }
}
async function removeOwnedStage(directory, parent) {
  // Do not recursively remove an unexpected/replaced path on Windows or other hosts.
  if (dirname(directory) !== parent || !/^b4-auth-[A-Za-z0-9]+$/.test(basename(directory)) ||
      await realpath(directory) !== resolve(directory) || (await lstat(directory)).isSymbolicLink()) {
    throw failure('B4_CLEANUP_FAILED');
  }
  await rm(directory, { recursive: true, force: false });
}

// The authenticated, format1-verified directory is borrowed only during consume().
// Nothing is written to disk before GCM final() succeeds. No plaintext stream is exposed.
export async function withDecryptedArtifact({ envelope, expectedKeyId, keyProvider, temporaryParent,
  expectedChecksum, storeId, ledgerId } = {}, consume) {
  let key, plaintext, pending, directory, parent;
  try {
    const identity = { expectedChecksum, storeId, ledgerId }; checkIdentity(identity);
    if (!validKeyId(expectedKeyId)) throw failure('B4_KEY_ID_INVALID');
    if (!Buffer.isBuffer(envelope) || typeof consume !== 'function' ||
        envelope.length > 12 + MAX_HEADER + MAX_PAYLOAD + TAG_BYTES) throw failure('B4_INPUT_INVALID');
    const captured = Buffer.from(envelope); // Snapshot before awaiting the provider.
    const parsed = parseEnvelope(captured, expectedKeyId);
    key = await resolveKey(keyProvider, expectedKeyId, 'decrypt');
    try {
      const decipher = createDecipheriv(ALGORITHM, key, parsed.nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(parsed.aad); decipher.setAuthTag(parsed.tag);
      pending = decipher.update(parsed.ciphertext);
      plaintext = Buffer.concat([pending, decipher.final()]);
    } catch { throw failure('B4_AUTHENTICATION_FAILED'); }
    const parts = unframe(plaintext);
    try {
      parent = await externalDirectory(temporaryParent);
      await checkStagingParent(parent);
      directory = await mkdtemp(join(parent, 'b4-auth-'));
      await protectStaging(directory); // Harden the empty directory before plaintext writes.
      for (let i = 0; i < FILES.length; i++) await durableWrite(join(directory, FILES[i]), parts[i]);
    } catch (error) { throw sanitized(error, 'B4_STAGE_FAILED'); }
    try { await verifyArtifact(directory, identity); }
    catch { throw failure('B4_FORMAT1_REJECTED'); }
    try { return await consume(Object.freeze({ directory, checksum: expectedChecksum })); }
    catch { throw failure('B4_CONSUMER_FAILED'); }
  } catch (error) { throw sanitized(error, 'B4_DECRYPT_FAILED'); }
  finally {
    key?.fill(0); pending?.fill(0); plaintext?.fill(0);
    if (directory) {
      try { await removeOwnedStage(directory, parent); }
      catch { throw failure('B4_CLEANUP_FAILED'); }
    }
  }
}
