// B5-A synthetic composition only. No production entry point or historical-key access.
import { readFile, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runSyntheticKeyBackup, syntheticRecoveryMaterial } from './key-session.js';
import { assertSyntheticBackupEncryption } from './encryption-policy.js';
import { readBackupIdentity } from '../production/backup-identity.js';
import { readAcceptedArtifact } from '../shared/release-artifact.js';
import { canonical, digest } from './format.js';
import { recordOffsiteFact } from '../operations/offsite-state.js';

const units = new WeakMap(), MAX = 130 * 1024 * 1024;
const fail = () => Object.assign(new Error('BACKUP_OFFSITE_REJECTED'), { code: 'BACKUP_OFFSITE_REJECTED' });
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const roles = ['ciphertext', 'envelope', 'manifest', 'release'];
const copy = v => structuredClone(v);
function clockValue(clock) {
  try {
    const value = clock();
    if (Object.keys(value).sort().join(',') !== 'uncertaintyMs,utcMs' ||
        !Number.isSafeInteger(value.utcMs) || !Number.isSafeInteger(value.uncertaintyMs) ||
        value.uncertaintyMs < 0 || value.utcMs - value.uncertaintyMs < 0 ||
        value.utcMs + value.uncertaintyMs > 8640000000000000) return null;
    return value;
  } catch { return null; }
}
async function fileBytes(path, max = MAX) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > max || await realpath(path) !== resolve(path)) throw fail();
  const bytes = await readFile(path); if (bytes.length > max) throw fail(); return bytes;
}
async function deadline(work, ms) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => { timer = setTimeout(() => reject(fail()), ms); })]); }
  finally { clearTimeout(timer); }
}
function json(bytes, max) {
  if (!Buffer.isBuffer(bytes) || bytes.length > max) throw fail();
  const value = JSON.parse(bytes.toString('utf8'));
  if (canonical(value) !== bytes.toString('utf8')) throw fail();
  return value;
}
function descriptor(role, unitId, bytes) {
  return { role, objectId: unitId + '.' + role, version: digest(bytes), size: bytes.length, sha256: digest(bytes) };
}
function checkDescriptor(d, role, unitId) {
  if (!d || Object.keys(d).sort().join(',') !== 'objectId,role,sha256,size,version' || d.role !== role ||
      d.objectId !== unitId + '.' + role || !hash(d.version) || d.version !== d.sha256 ||
      !Number.isSafeInteger(d.size) || d.size < 1 || d.size > MAX) throw fail();
}
function checkCompletion(c) {
  if (!c || Object.keys(c).sort().join(',') !== 'applicationCommit,backupId,binding,objects,snapshotNotBefore,unitId,version,wrappingKeyId' ||
      c.version !== 1 || !id(c.unitId) || !id(c.wrappingKeyId) || c.binding?.keyId !== c.unitId ||
      Object.keys(c.binding).sort().join(',') !== 'checksum,keyId,ledgerId,storeId' || !hash(c.binding.checksum) ||
      [c.binding.storeId, c.binding.ledgerId].some(v => typeof v !== 'string' || !v || v.length > 64) ||
      !/^[a-f0-9-]{36}$/.test(c.backupId) || !/^[a-f0-9]{40}$/.test(c.applicationCommit) ||
      !(c.snapshotNotBefore === null || Number.isSafeInteger(c.snapshotNotBefore) && c.snapshotNotBefore >= 0) ||
      !Array.isArray(c.objects) || c.objects.length !== roles.length) throw fail();
  roles.forEach((role, n) => checkDescriptor(c.objects[n], role, c.unitId));
}
async function exact(reader, d, ms) {
  const response = await deadline(() => reader.getExact({ objectId: d.objectId, version: d.version }), ms);
  if (!response || response.objectId !== d.objectId || response.version !== d.version ||
      !Buffer.isBuffer(response.bytes) || response.bytes.length !== d.size || digest(response.bytes) !== d.sha256) throw fail();
  return Buffer.from(response.bytes);
}
function checkRelease(release, commit) {
  if (release?.format !== 1 || release.applicationCommit !== commit || !/^24\.19\.\d+$/.test(release.node ?? '') ||
      !Array.isArray(release.files) || !release.files.length || !Array.isArray(release.dependencies) || !release.dependencies.length ||
      !hash(release.lockChecksum)) throw fail();
  const files = new Map(release.files.map(f => [f.path, f]));
  if (files.size !== release.files.length || release.files.some(f => typeof f.bytes !== 'string' ||
      digest(Buffer.from(f.bytes, 'base64')) !== f.sha256)) throw fail();
  const required = ['package.json', 'pnpm-lock.yaml', 'backup/encryption.js', 'backup/format.js',
    'backup/key-session.js', 'backup/offline-key-service.js', 'production/schema-manifest.json'];
  if (required.some(path => !files.has(path)) || digest(Buffer.from(files.get('pnpm-lock.yaml').bytes, 'base64')) !== release.lockChecksum) throw fail();
  const schema = JSON.parse(Buffer.from(files.get('production/schema-manifest.json').bytes, 'base64'));
  for (const [name, checksum] of Object.entries(schema.migrations ?? {})) {
    const file = files.get('database/migrations/' + name);
    if (!file || digest(Buffer.from(file.bytes, 'base64').toString('utf8').replace(/\r\n/g, '\n')) !== checksum) throw fail();
  }
  if (!Object.keys(schema.migrations ?? {}).length || release.dependencies.some(d =>
      typeof d.name !== 'string' || typeof d.version !== 'string' || !files.has('node_modules/' + d.name + '/package.json'))) throw fail();
}

async function materials(reader, c, ms) {
  checkCompletion(c);
  const bytes = {};
  for (const d of c.objects) bytes[d.role] = await exact(reader, d, ms);
  const manifest = json(bytes.manifest, 1024 * 1024), record = json(bytes.envelope, 12000);
  if (digest(bytes.manifest) !== c.binding.checksum || manifest.backupFormatVersion !== 1 ||
      manifest.backupId !== c.backupId || manifest.storeId !== c.binding.storeId ||
      manifest.ledgerId !== c.binding.ledgerId || manifest.applicationCommit !== c.applicationCommit ||
      !Number.isFinite(Date.parse(manifest.createdAt)) || manifest.source?.environment !== 'test' ||
      c.snapshotNotBefore !== null && c.snapshotNotBefore > Date.parse(manifest.createdAt) ||
      Object.keys(record).sort().join(',') !== 'binding,version,wrappedKey,wrappingKeyId' || record.version !== 1 ||
      canonical(record.binding) !== canonical(c.binding) || record.wrappingKeyId !== c.wrappingKeyId ||
      typeof record.wrappedKey !== 'string' || !record.wrappedKey.length || record.wrappedKey.length > 8192) throw fail();
  // This validates retained release bytes without extracting/executing them. Trust is the producer's S4-pinned digest.
  const release = JSON.parse(bytes.release.toString('utf8'));
  checkRelease(release, c.applicationCommit);
  return { completion: copy(c), ...bytes };
}

// The trusted synthetic bootstrap supplies clock/identity capabilities, never a UI success flag.
// The existing C1/B4 pipeline creates exactly one backup; no history reads or second snapshot.
export async function produceSyntheticOffsiteUnit(args, { keyBackup, releaseIdentity, clock = () => null } = {}, ports = {}) {
  assertSyntheticBackupEncryption(args);
  try {
    if (!releaseIdentity || Object.keys(releaseIdentity).sort().join(',') !== 'config,configFile,identityEnv') throw fail();
    const identity = copy(releaseIdentity), commit = await readBackupIdentity({
      configFile: identity.configFile, config: identity.config, env: identity.identityEnv
    });
    if (commit !== args.applicationCommit) throw fail();
    const artifact = await readAcceptedArtifact({ artifact: identity.config.releaseArtifactFile,
      expectedChecksum: identity.config.releaseArtifactChecksum, commit });
    const release = await fileBytes(identity.config.releaseArtifactFile);
    if (digest(release) !== identity.config.releaseArtifactChecksum) throw fail();
    // A real accepted package includes recovery code, migrations and runtime dependencies. No extraction here.
    checkRelease(artifact, commit);
    const before = clockValue(clock);
    const localResult = await runSyntheticKeyBackup(args, keyBackup, ports);
    if (!localResult.complete) return Object.freeze({ localResult, unit: null });
    const handoff = syntheticRecoveryMaterial(localResult);
    const after = clockValue(clock);
    const snapshotNotBefore = before && after && before.utcMs <= after.utcMs &&
      before.utcMs - before.uncertaintyMs <= Date.parse(handoff.manifest.createdAt) ?
      before.utcMs - before.uncertaintyMs : null;
    const ciphertext = await fileBytes(join(localResult.directory, 'backup.b4'));
    if (digest(ciphertext) !== localResult.artifactChecksum || handoff.record.binding.checksum !== localResult.checksum) throw fail();
    const unitId = handoff.record.binding.keyId;
    const bytes = { ciphertext, envelope: Buffer.from(canonical(handoff.record)), manifest: Buffer.from(handoff.manifestBytes), release };
    const completion = { version: 1, unitId, backupId: handoff.manifest.backupId,
      binding: handoff.record.binding, wrappingKeyId: handoff.record.wrappingKeyId,
      applicationCommit: commit, snapshotNotBefore, objects: roles.map(role => descriptor(role, unitId, bytes[role])) };
    checkCompletion(completion);
    const unit = Object.freeze({ unitId, backupId: completion.backupId });
    units.set(unit, { completion: copy(completion), bytes });
    return Object.freeze({ localResult, unit });
  } catch { throw fail(); }
}

// Returned locator must be retained independently. It pins the complete manifest, not just a mutable object name.
export async function retrieveSyntheticOffsiteUnit(args, { reader, locator, timeoutMs = 5000 } = {}) {
  assertSyntheticBackupEncryption(args);
  try {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || typeof reader?.getExact !== 'function' ||
        !locator || Object.keys(locator).sort().join(',') !== 'objectId,sha256,size,unitId,version' || !id(locator.unitId)) throw fail();
    const d = { role: 'complete', ...locator }; delete d.unitId;
    checkDescriptor(d, 'complete', locator.unitId);
    const completeBytes = await exact(reader, d, timeoutMs), c = json(completeBytes, 16384);
    if (c.unitId !== locator.unitId) throw fail();
    return await materials(reader, c, timeoutMs);
  } catch { throw fail(); }
}

export async function publishSyntheticOffsiteUnit(args, { unit, writer, reader, store, clock = () => null, timeoutMs = 5000 } = {}) {
  assertSyntheticBackupEncryption(args);
  const source = units.get(unit);
  if (!source || typeof writer?.putIfAbsent !== 'function' || typeof reader?.getExact !== 'function' ||
      typeof store?.update !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw fail();
  const c = source.completion;
  const completeBytes = Buffer.from(canonical(c)), completeDescriptor = descriptor('complete', c.unitId, completeBytes);
  const candidateLocator = { unitId: c.unitId, objectId: completeDescriptor.objectId, version: completeDescriptor.version,
    sha256: completeDescriptor.sha256, size: completeDescriptor.size };
  let phase = 'LOCAL_VERIFIED', locator = null, referenceLimit = false;
  const save = async (status, point = null) => {
    try {
      await recordOffsiteFact(store, { unitId: c.unitId, backupId: c.backupId,
        status, at: clockValue(clock)?.utcMs ?? null, snapshotNotBefore: c.snapshotNotBefore, locator: point,
        objects: copy(c.objects), candidateLocator: copy(candidateLocator) });
    } catch (error) {
      // Only the local state boundary can supply this nonsecret, stable reason.
      if (error?.code === 'OFFSITE_REFERENCE_LIMIT') referenceLimit = true;
      throw error;
    }
  };
  try {
    await save(phase);
    phase = 'UPLOAD_UNCONFIRMED'; await save(phase);
    for (const d of c.objects) {
      const ack = await deadline(() => writer.putIfAbsent({ objectId: d.objectId, bytes: Buffer.from(source.bytes[d.role]) }), timeoutMs);
      if (ack?.objectId !== d.objectId || ack.version !== d.version) throw fail();
    }
    await materials(reader, c, timeoutMs);
    const bytes = completeBytes, d = completeDescriptor;
    const ack = await deadline(() => writer.putIfAbsent({ objectId: d.objectId, bytes }), timeoutMs);
    if (ack?.objectId !== d.objectId || ack.version !== d.version) throw fail();
    locator = { unitId: c.unitId, objectId: d.objectId, version: d.version, sha256: d.sha256, size: d.size };
    await retrieveSyntheticOffsiteUnit(args, { reader, locator, timeoutMs });
    await save('OFFSITE_VERIFIED', locator);
    return Object.freeze({ code: 'OFFSITE_VERIFIED', unitId: c.unitId, locator: Object.freeze(locator) });
  } catch {
    try { await save('OFFSITE_UNCONFIRMED'); } catch {}
    // A late remote commit is possible. Keep the stable unitId and all immutable objects for reconciliation.
    return Object.freeze({ code: 'OFFSITE_UNCONFIRMED', unitId: c.unitId,
      ...(referenceLimit ? { reason: 'OFFSITE_REFERENCE_LIMIT' } : {}) });
  }
}
