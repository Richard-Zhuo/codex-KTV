// B4-C2 synthetic-only adapter; no CLI/scheduler/production enablement or private-key custody.
import { constants, createPublicKey, createPrivateKey, publicEncrypt, privateDecrypt, randomBytes } from 'node:crypto';
import { readBackupIdentity } from '../production/backup-identity.js';
import { readAcceptedArtifact } from '../shared/release-artifact.js';
import { assertSyntheticBackupEncryption } from './encryption-policy.js';
import { canonical, digest } from './format.js';

const ALGORITHM = 'RSA-OAEP-SHA256', POLICY = 'backup/offline-public-key-policy.js';
const fail = () => Object.assign(new Error('BACKUP_OFFLINE_KEY_REJECTED'), { code: 'BACKUP_OFFLINE_KEY_REJECTED' });
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const fields = (value, names) => value && Object.keys(value).sort().join(',') === names;
function bindingCopy(value) {
  if (!fields(value, 'checksum,keyId,ledgerId,storeId') || !id(value.keyId) || !/^[a-f0-9]{64}$/.test(value.checksum ?? '') ||
      [value.storeId, value.ledgerId].some(v => typeof v !== 'string' || !v || v.length > 64)) throw fail();
  return Object.freeze({ ...value });
}
function checkRsa(key, type) {
  if (key.type !== type || key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 3072 ||
      key.asymmetricKeyDetails?.publicExponent !== 65537n) throw fail();
  return key;
}
const fingerprint = key => digest(createPublicKey(key).export({ type: 'spki', format: 'der' }));
const publicFingerprint = key => digest(key.export({ type: 'spki', format: 'der' }));
function label(binding, wrappingKeyId, pin) {
  return Buffer.from(canonical({ domain: 'ktv-backup-dek', version: 1, algorithm: ALGORITHM, binding, wrappingKeyId, fingerprint: pin }));
}
function parsePolicy(bytes, selected) {
  const source = bytes.toString('utf8').replace(/\r\n/g, '\n');
  // Read data from verified artifact bytes, never eval/import an arbitrary policy path.
  if (bytes.length > 65536 || !source.startsWith('export default ') || !source.endsWith(';\n')) throw fail();
  const policy = JSON.parse(source.slice(15, -2));
  if (!fields(policy, 'algorithm,keys,version') || policy.version !== 1 || policy.algorithm !== ALGORITHM ||
      !Array.isArray(policy.keys) || policy.keys.length > 16) throw fail();
  const seen = new Set(); let chosen;
  for (const entry of policy.keys) {
    if (!fields(entry, 'fingerprint,publicKey,wrappingKeyId') || !id(entry.wrappingKeyId) || seen.has(entry.wrappingKeyId) ||
        !/^[a-f0-9]{64}$/.test(entry.fingerprint ?? '') || typeof entry.publicKey !== 'string' || entry.publicKey.length > 2048 ||
        !entry.publicKey.startsWith('-----BEGIN PUBLIC KEY-----\n')) throw fail();
    seen.add(entry.wrappingKeyId);
    const key = checkRsa(createPublicKey(entry.publicKey), 'public');
    if (publicFingerprint(key) !== entry.fingerprint) throw fail();
    if (entry.wrappingKeyId === selected) chosen = { key, pin: entry.fingerprint };
  }
  if (!chosen) throw fail();
  return chosen;
}

// No raw key/pin or caller-supplied identity verifier is accepted at this public constructor.
export async function loadSyntheticPublicKeyGenerator(args, options = {}) {
  try {
    assertSyntheticBackupEncryption(args);
    if (!fields(options, 'config,configFile,identityEnv,wrappingKeyId') || !id(options.wrappingKeyId)) throw fail();
    const config = JSON.parse(JSON.stringify(options.config));
    const commit = await readBackupIdentity({ configFile: options.configFile, config, env: options.identityEnv });
    const artifact = await readAcceptedArtifact({ artifact: config.releaseArtifactFile,
      expectedChecksum: config.releaseArtifactChecksum, commit });
    const policy = artifact.files.find(file => file.path === POLICY);
    if (!policy) throw fail();
    const selected = options.wrappingKeyId, { key: publicKey, pin } = parsePolicy(Buffer.from(policy.bytes, 'base64'), selected);
    return Object.freeze({ async generate(input) {
      let key;
      try {
        assertSyntheticBackupEncryption(args); const binding = bindingCopy(input);
        key = randomBytes(32);
        const ciphertext = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256', oaepLabel: label(binding, selected, pin) }, key);
        return { keyId: binding.keyId, key, wrappingKeyId: selected,
          wrappedKey: canonical({ version: 1, algorithm: ALGORITHM, ciphertext: ciphertext.toString('base64') }) };
      } catch { key?.fill(0); throw fail(); }
    } });
  } catch { throw fail(); }
}

// Trusted isolated recovery bootstrap supplies private material and an existing C1-authorized registry client.
// Reuse its scope/expiry checks at BOTH read and unwrap boundaries, including before returning plaintext.
export function createSyntheticOfflineRecovery(args, { privateKeys, registry } = {}) {
  try {
    assertSyntheticBackupEncryption(args);
    if (!Array.isArray(privateKeys) || !privateKeys.length || privateKeys.length > 16 || typeof registry?.get !== 'function') throw fail();
    const keys = new Map(); let active = true;
    for (const entry of privateKeys) {
      if (!fields(entry, 'privateKey,wrappingKeyId') || !id(entry.wrappingKeyId) || keys.has(entry.wrappingKeyId)) throw fail();
      const key = checkRsa(createPrivateKey(entry.privateKey), 'private');
      keys.set(entry.wrappingKeyId, { key, pin: fingerprint(key) });
    }
    return Object.freeze({ dispose() { active = false; keys.clear(); }, async recover(input) {
      let key, returned = false;
      try {
        assertSyntheticBackupEncryption(args);
        if (!active || !fields(input, 'binding,version,wrappedKey,wrappingKeyId') || input.version !== 1 || !id(input.wrappingKeyId) ||
            typeof input.wrappedKey !== 'string' || !input.wrappedKey.length || input.wrappedKey.length > 8192) throw fail();
        const record = JSON.parse(canonical(input)), binding = bindingCopy(record.binding);
        // A cached/stolen encrypted record cannot bypass C1 authorization or replace the registered envelope.
        if (canonical(await registry.get(binding)) !== canonical(record)) throw fail();
        const material = keys.get(record.wrappingKeyId), wrapped = JSON.parse(record.wrappedKey);
        if (!material || !fields(wrapped, 'algorithm,ciphertext,version') || wrapped.version !== 1 || wrapped.algorithm !== ALGORITHM ||
            canonical(wrapped) !== record.wrappedKey || typeof wrapped.ciphertext !== 'string' ||
            !/^[A-Za-z0-9+/]{512}$/.test(wrapped.ciphertext)) throw fail();
        key = privateDecrypt({ key: material.key, padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256', oaepLabel: label(binding, record.wrappingKeyId, material.pin) }, Buffer.from(wrapped.ciphertext, 'base64'));
        if (key.length !== 32 || canonical(await registry.get(binding)) !== canonical(record)) throw fail();
        returned = true; return { keyId: binding.keyId, key };
      } catch { throw fail(); }
      finally { if (!returned) key?.fill(0); }
    } });
  } catch { throw fail(); }
}
