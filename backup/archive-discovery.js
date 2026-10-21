// B3-A0 synthetic discovery only. No operational store, signing key, deletion or slot release.
import { createPublicKey, verify } from 'node:crypto';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { canonical, digest, externalDirectory } from './format.js';
import { assertSyntheticBackupEncryption } from './encryption-policy.js';
import { retrieveSyntheticOffsiteUnit } from './offsite-unit.js';
import { windowsFileAcl, validateRuntimeFileAclStructure } from '../production/runtime-config.js';

const anchors = new WeakMap(), MAX_ENTRY = 32768, PAGE_SIZE = 16, MAX_PAGES = 64, MAX_ENTRIES = 512;
const fail = () => Object.assign(Error('ARCHIVE_DISCOVERY_REJECTED'), { code: 'ARCHIVE_DISCOVERY_REJECTED' });
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const fields = (v, names) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === names;
const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(v);
async function deadline(work, ms) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => { timer = setTimeout(() => reject(fail()), ms); })]); }
  finally { clearTimeout(timer); }
}
function json(bytes) {
  const value = JSON.parse(bytes.toString('utf8'));
  if (canonical(value) !== bytes.toString('utf8')) throw fail();
  return value;
}
async function trustBytes(path) {
  if (typeof path !== 'string' || path !== resolve(path) || await realpath(path) !== path) throw fail();
  await externalDirectory(dirname(path));
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 4096) throw fail();
  if (process.platform === 'win32') {
    const acl = await windowsFileAcl(path); validateRuntimeFileAclStructure(acl, acl.current);
  } else if (s.uid !== process.getuid() || s.mode & 0o077) throw fail();
  const bytes = await readFile(path);
  if (bytes.length > 4096) throw fail();
  return bytes;
}
// The OFFLINE custodian supplies expectedSha256 through its separate trusted recovery handoff.
// It must never be obtained from the remote directory, list response or the trust file itself.
export async function loadSyntheticArchiveBootstrap(args, { trustFile, expectedSha256 } = {}) {
  try {
    assertSyntheticBackupEncryption(args);
    if (!hash(expectedSha256)) throw fail();
    const bytes = await trustBytes(trustFile);
    if (digest(bytes) !== expectedSha256) throw fail();
    const data = json(bytes);
    if (!fields(data, 'algorithm,directoryId,ledgerId,publicKey,storeId,version') || data.version !== 1 ||
        data.algorithm !== 'Ed25519' || !id(data.directoryId) ||
        [data.storeId, data.ledgerId].some(v => typeof v !== 'string' || !v || v.length > 64) ||
        typeof data.publicKey !== 'string' || data.publicKey.length > 256) throw fail();
    const der = Buffer.from(data.publicKey, 'base64');
    if (der.toString('base64') !== data.publicKey) throw fail();
    const publicKey = createPublicKey({ key: der, type: 'spki', format: 'der' });
    if (publicKey.asymmetricKeyType !== 'ed25519' || !publicKey.export({ type: 'spki', format: 'der' }).equals(der)) throw fail();
    const bootstrap = Object.freeze({ directoryId: data.directoryId });
    anchors.set(bootstrap, { ...data, publicKey, prefix: 'archive.' + data.directoryId + '.' });
    return bootstrap;
  } catch { throw fail(); }
}

export async function discoverSyntheticArchives(args, { bootstrap, enumerator, reader, timeoutMs = 5000 } = {}) {
  try {
    assertSyntheticBackupEncryption(args);
    const trust = anchors.get(bootstrap);
    if (!trust || typeof enumerator?.listPage !== 'function' || typeof reader?.getExact !== 'function' ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw fail();
    const cursors = new Set(), seen = new Map(), entries = [];
    let cursor = null;
    for (let pageNumber = 0; ; pageNumber++) {
      assertSyntheticBackupEncryption(args);
      if (pageNumber >= MAX_PAGES) throw fail();
      const page = await deadline(() => enumerator.listPage({ prefix: trust.prefix, cursor, limit: PAGE_SIZE }), timeoutMs);
      if (!fields(page, 'entries,nextCursor,status') || page.status !== 'OK' || !Array.isArray(page.entries) ||
          page.entries.length > PAGE_SIZE || !(page.nextCursor === null ||
          typeof page.nextCursor === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(page.nextCursor))) throw fail();
      for (const descriptor of page.entries) {
        if (!fields(descriptor, 'objectId,size,version') || typeof descriptor.objectId !== 'string' ||
            !descriptor.objectId.startsWith(trust.prefix) || !hash(descriptor.objectId.slice(trust.prefix.length)) ||
            !hash(descriptor.version) || !Number.isSafeInteger(descriptor.size) || descriptor.size < 1 || descriptor.size > MAX_ENTRY) throw fail();
        const previous = seen.get(descriptor.objectId);
        if (previous) {
          if (canonical(previous) !== canonical(descriptor)) throw fail();
          continue;
        }
        if (seen.size >= MAX_ENTRIES) throw fail();
        seen.set(descriptor.objectId, structuredClone(descriptor));
        const response = await deadline(() => reader.getExact({ objectId: descriptor.objectId, version: descriptor.version }), timeoutMs);
        if (response?.objectId !== descriptor.objectId || response.version !== descriptor.version ||
            !Buffer.isBuffer(response.bytes) || response.bytes.length !== descriptor.size ||
            digest(response.bytes) !== descriptor.version) throw fail();
        const entry = json(response.bytes);
        if (!fields(entry, 'payload,signature') || typeof entry.signature !== 'string') throw fail();
        const signature = Buffer.from(entry.signature, 'base64'), p = entry.payload;
        if (signature.length !== 64 || signature.toString('base64') !== entry.signature ||
            !fields(p, 'algorithm,completion,directoryId,domain,locator,version') ||
            p.domain !== 'ktv-synthetic-archive-entry' || p.version !== 1 || p.algorithm !== 'Ed25519' ||
            p.directoryId !== trust.directoryId || !verify(null, Buffer.from(canonical(p)), trust.publicKey, signature)) throw fail();
        // Only the pinned signer may authenticate a candidate. Remote hashes are just transport checks.
        const locator = p.locator, c = p.completion;
        if (!locator || !c || c.unitId !== locator.unitId || c.binding?.keyId !== locator.unitId ||
            c.binding.storeId !== trust.storeId || c.binding.ledgerId !== trust.ledgerId ||
            descriptor.objectId !== trust.prefix + digest(locator.unitId)) throw fail();
        const unit = await deadline(() => retrieveSyntheticOffsiteUnit(args, { reader, locator, timeoutMs }), timeoutMs);
        if (canonical(unit.completion) !== canonical(c)) throw fail();
        entries.push(Object.freeze({ objectId: descriptor.objectId, version: descriptor.version,
          locator: structuredClone(locator), completion: structuredClone(c) }));
      }
      if (page.nextCursor === null) break;
      if (cursors.has(page.nextCursor)) throw fail();
      cursors.add(page.nextCursor); cursor = page.nextCursor;
    }
    // A valid old signature, an empty page or end-of-list cannot prove completeness/freshness.
    return Object.freeze({ code: 'ARCHIVE_ENTRIES_VERIFIED', entries: Object.freeze(entries),
      directoryCompleteness: 'NOT_VERIFIED', rollbackProtection: 'NOT_VERIFIED', readyForSlotRelease: false });
  } catch { throw fail(); }
}
