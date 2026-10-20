// B4-B synthetic-only composition. S4/CLI admission and B2 scheduling are unchanged.
import { randomUUID } from 'node:crypto';
import { lstat, realpath, readdir, readFile, mkdir, link, unlink, rmdir } from 'node:fs/promises';
import { join, dirname, basename, resolve, relative, isAbsolute } from 'node:path';
import { backupDatabase } from './mysql-backup.js';
import { encryptArtifact, withDecryptedArtifact } from './encryption.js';
import { canonical, digest, durableWrite, externalDirectory, verifyArtifact } from './format.js';
import { backupEncryptionPolicy, assertSyntheticBackupEncryption } from './encryption-policy.js';
export { backupEncryptionPolicy } from './encryption-policy.js';
import { protectActivationPath, validateActivationAcl } from '../production/activation-receipt.js';
import { windowsDirectoryAcl } from '../production/wecom-smoke-config.js';
import { validateRuntimeFileAclStructure } from '../production/runtime-config.js';

const fail = code => Object.assign(new Error(code), { code });
const RUN = /^b4-run-([a-f0-9-]{36})$/;
const SOURCE_FILES = ['data.json', 'manifest.json', 'manifest.sha256'];
const PHASES = ['PREPARING', 'CREATING', 'ENCRYPTING', 'VALIDATING', 'PUBLISHING', 'CLEANING', 'COMPLETE', 'FAILED'];
const MAX_ENVELOPE = 130 * 1024 * 1024;
const inside = (parent, child) => { const r = relative(parent, child); return r !== '' && !r.startsWith('..') && !isAbsolute(r); };

async function checkedDirectory(path) {
  const root = await externalDirectory(path);
  if (root !== resolve(path) || (await lstat(path)).isSymbolicLink()) throw fail('BACKUP_ENCRYPTION_PATH_DENIED');
  if (process.platform === 'win32') {
    const acl = await windowsDirectoryAcl(root); validateRuntimeFileAclStructure(acl, acl.current);
  } else { const info = await lstat(root); if (info.uid !== process.getuid() || (info.mode & 0o022)) throw fail('BACKUP_ENCRYPTION_PATH_DENIED'); }
  return root;
}
async function protectNewDirectory(path) {
  if (process.platform === 'win32') {
    const acl = await windowsDirectoryAcl(path);
    await protectActivationPath(path, acl.current, true);
    validateActivationAcl(await windowsDirectoryAcl(path), acl.current, { directory: true, producer: true });
  }
}
async function checkedFile(path, max) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max || await realpath(path) !== resolve(path)) throw fail('BACKUP_ENCRYPTION_PATH_DENIED');
  return info;
}
async function readEnvelope(path) {
  await checkedFile(path, MAX_ENVELOPE);
  const file = await readFile(path);
  if (file.length > MAX_ENVELOPE) throw fail('BACKUP_ENCRYPTION_ARTIFACT_INVALID');
  return file;
}
function validRecord(record) {
  return record && Object.keys(record).sort().join(',') === 'artifactChecksum,checksum,ciphertext,code,complete,createdAt,phase,plaintext,requestId,version' &&
    record.version === 1 && /^[a-f0-9-]{36}$/.test(record.requestId) && PHASES.includes(record.phase) &&
    ['NOT_PUBLISHED', 'VERIFIED', 'PUBLISHED', 'UNKNOWN'].includes(record.ciphertext) &&
    ['POSSIBLE', 'ABSENT', 'REMAINS', 'UNKNOWN'].includes(record.plaintext) && typeof record.complete === 'boolean' &&
    /^BACKUP_[A-Z_]+$/.test(record.code) && [record.checksum, record.artifactChecksum].every(v => v === null || /^[a-f0-9]{64}$/.test(v)) &&
    (record.createdAt === null || typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt))) &&
    (!record.complete || record.phase === 'COMPLETE' && record.ciphertext === 'PUBLISHED' && record.plaintext === 'ABSENT');
}
async function appendRecord(run, sequence, state) {
  await checkedDirectory(run);
  if (!validRecord(state)) throw fail('BACKUP_ENCRYPTION_RECORD_INVALID');
  await durableWrite(join(run, 'state-' + String(sequence).padStart(4, '0') + '.json'), canonical(state));
}
async function observePlaintext(run) {
  await checkedDirectory(run);
  const names = await readdir(run);
  let remains = false;
  for (const name of names) {
    if (name === 'source' || /^b4-auth-/.test(name)) {
      const path = join(run, name), info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) return 'UNKNOWN';
      remains = true;
    } else if (!/^state-\d{4}\.json$/.test(name) && name !== 'ciphertext.tmp') return 'UNKNOWN';
  }
  return remains ? 'REMAINS' : 'ABSENT';
}

// Read-only inspection: never follows directory links, marks malformed/missing records UNKNOWN.
// An incomplete record can be live or interrupted; inspection never guesses process liveness.
export async function inspectEncryptedBackupResidues(stagingDirectory) {
  const root = await checkedDirectory(stagingDirectory), reports = [];
  for (const name of await readdir(root)) {
    if (!RUN.test(name)) { reports.push({ requestId: null, phase: 'UNKNOWN', plaintext: 'UNKNOWN', incomplete: true }); continue; }
    const run = join(root, name);
    try {
      await checkedDirectory(run);
      const records = (await readdir(run)).filter(n => /^state-\d{4}\.json$/.test(n)).sort();
      if (!records.length || records.length > 32) throw Error();
      let last;
      for (let i = 0; i < records.length; i++) {
        if (records[i] !== 'state-' + String(i).padStart(4, '0') + '.json') throw Error();
        const file = join(run, records[i]); await checkedFile(file, 4096);
        last = JSON.parse(await readFile(file, 'utf8'));
        if (!validRecord(last) || last.requestId !== name.slice(7)) throw Error();
      }
      const plaintext = await observePlaintext(run);
      reports.push({ requestId: last.requestId, phase: last.phase, ciphertext: last.ciphertext,
        plaintext, incomplete: !last.complete || plaintext !== 'ABSENT' });
    } catch { reports.push({ requestId: name.slice(7), phase: 'UNKNOWN', ciphertext: 'UNKNOWN', plaintext: 'UNKNOWN', incomplete: true }); }
  }
  return reports;
}

async function cleanOwnedSource(run) {
  await checkedDirectory(run);
  const source = join(run, 'source');
  const info = await lstat(source);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(source) !== resolve(source) || dirname(source) !== run) throw Error();
  const names = await readdir(source);
  if (names.some(name => !SOURCE_FILES.includes(name))) throw Error();
  // Validate the whole narrow set before deleting anything. Never recurse or follow links.
  for (const name of names) if ((await checkedFile(join(source, name), MAX_ENVELOPE)).nlink !== 1) throw Error();
  for (const name of names) { await checkedFile(join(source, name), MAX_ENVELOPE); await unlink(join(source, name)); }
  await rmdir(source);
}

export async function createConfiguredBackup(args, { encryption, keyProvider } = {}, ports = {}) {
  const policy = backupEncryptionPolicy(encryption);
  if (!policy.enabled) return (ports.create ?? backupDatabase)(args);
  return runEncryptedBackup(args, { encryption: policy, keyProvider }, ports);
}

export async function runEncryptedBackup(args, { encryption, keyProvider } = {}, ports = {}) {
  const policy = backupEncryptionPolicy(encryption);
  if (!policy.enabled) throw fail('BACKUP_ENCRYPTION_DISABLED');
  assertSyntheticBackupEncryption(args);
  if (typeof keyProvider?.resolve !== 'function') throw fail('BACKUP_ENCRYPTION_KEY_REQUIRED');
  const create = ports.create ?? backupDatabase, encrypt = ports.encrypt ?? encryptArtifact,
    decrypt = ports.decrypt ?? withDecryptedArtifact, publish = ports.publish ?? link,
    cleanup = ports.cleanup ?? cleanOwnedSource, record = ports.record ?? appendRecord;
  const staging = await checkedDirectory(policy.stagingDirectory), outputParent = await checkedDirectory(dirname(args.outputDirectory));
  const output = resolve(args.outputDirectory);
  if (!/^[A-Za-z0-9_-]+$/.test(basename(output)) || outputParent !== dirname(output) || inside(staging, output) ||
      inside(output, staging) || staging === output || staging === outputParent) throw fail('BACKUP_ENCRYPTION_PATH_DENIED');
  if ((await inspectEncryptedBackupResidues(staging)).some(r => r.incomplete)) throw fail('BACKUP_ENCRYPTION_RESIDUE_REQUIRES_REVIEW');
  const requestId = randomUUID(), run = join(staging, 'b4-run-' + requestId);
  let state = { version: 1, requestId, phase: 'PREPARING', ciphertext: 'NOT_PUBLISHED', plaintext: 'POSSIBLE',
    complete: false, code: 'BACKUP_ENCRYPTION_IN_PROGRESS', checksum: null, artifactChecksum: null, createdAt: null };
  let sequence = 0, recorded = false, published = false, publishedValid = false, outputCreated = false, failed = null;
  const save = async patch => { state = { ...state, ...patch }; await record(run, sequence, state); sequence++; recorded = true; };
  try {
    await mkdir(run, { mode: 0o700 }); await protectNewDirectory(run);
    await save({ phase: 'CREATING' });
    const source = join(run, 'source');
    const backup = await create({ ...args, outputDirectory: source });
    if (backup.directory !== source) throw Error();
    const identity = { expectedChecksum: backup.checksum, storeId: args.storeId, ledgerId: args.ledgerId };
    await verifyArtifact(source, identity);
    await save({ phase: 'ENCRYPTING', checksum: backup.checksum, createdAt: backup.createdAt });
    const envelope = await encrypt({ directory: source, ...identity, keyId: policy.keyId, keyProvider });
    const candidate = join(run, 'ciphertext.tmp'); await durableWrite(candidate, envelope);
    await save({ phase: 'VALIDATING', artifactChecksum: digest(envelope) });
    const captured = await readEnvelope(candidate);
    if (digest(captured) !== state.artifactChecksum) throw Error();
    await decrypt({ envelope: captured, ...identity, expectedKeyId: policy.keyId, keyProvider, temporaryParent: run }, async () => {});
    await save({ phase: 'PUBLISHING', ciphertext: 'VERIFIED' });
    await checkedDirectory(run); await checkedDirectory(outputParent);
    await mkdir(output, { mode: 0o700 }); outputCreated = true; await protectNewDirectory(output);
    // A hard link exposes only the already-written/verified inode; existing names are never replaced.
    // Cross-volume publication fails, with no copy/rename fallback.
    await publish(candidate, join(output, 'backup.b4')); published = true;
    if (digest(await readEnvelope(join(output, 'backup.b4'))) !== state.artifactChecksum) throw Error();
    publishedValid = true;
    await save({ phase: 'CLEANING', ciphertext: 'PUBLISHED' });
    await cleanup(run);
    const plaintext = await observePlaintext(run);
    if (plaintext !== 'ABSENT') throw Error();
    await checkedFile(candidate, MAX_ENVELOPE); await unlink(candidate);
    await save({ phase: 'COMPLETE', plaintext: 'ABSENT', complete: true, code: 'BACKUP_ENCRYPTED_VERIFIED' });
  } catch {
    failed = 'BACKUP_ENCRYPTION_' + ({ CREATING: 'CREATE', ENCRYPTING: 'ENCRYPT', VALIDATING: 'VALIDATION',
      PUBLISHING: 'PUBLICATION', CLEANING: 'CLEANUP', COMPLETE: 'RECORD', PREPARING: 'STAGING' }[state.phase] ?? 'OPERATION') + '_FAILED';
    let plaintext = 'UNKNOWN'; try { plaintext = await observePlaintext(run); } catch {}
    try { await save({ phase: 'FAILED', code: failed, complete: false, plaintext,
      ciphertext: publishedValid ? 'PUBLISHED' : published ? 'UNKNOWN' : state.ciphertext }); } catch { recorded = false; }
    // Keep failed/stopped source snapshots protected and discoverable. No automatic retention deletion.
  }
  return Object.freeze({ code: failed ?? state.code, requestId, complete: !failed && state.complete && recorded,
    ciphertext: state.ciphertext, plaintext: state.plaintext, resultRecorded: recorded,
    checksum: state.checksum, artifactChecksum: state.artifactChecksum, createdAt: state.createdAt,
    ...(published ? { directory: output } : {}), publicationDirectoryCreated: outputCreated });
}
