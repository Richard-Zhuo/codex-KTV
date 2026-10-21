// B4-C1 composition only. No production entry point, cloud adapter or machine-bound secret.
import { randomUUID } from 'node:crypto';
import { encryptArtifact } from './encryption.js';
import { runEncryptedBackup } from './encrypted-pipeline.js';
import { assertSyntheticBackupEncryption } from './encryption-policy.js';
import { canonical, digest } from './format.js';

const fail = code => Object.assign(new Error(code), { code });
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const wipe = value => { if (Buffer.isBuffer(value?.key)) value.key.fill(0); };
function bindingFor(args, keyId, checksum) {
  if (!id(keyId) || !/^[a-f0-9]{64}$/.test(checksum ?? '') ||
      [args.storeId, args.ledgerId].some(v => typeof v !== 'string' || !v || v.length > 64)) {
    throw fail('BACKUP_KEY_BINDING_INVALID');
  }
  // The original manifest checksum binds the exact format1 backup, including its backupId.
  return Object.freeze({ keyId, storeId: args.storeId, ledgerId: args.ledgerId, checksum });
}
function checkedTimeout(value = 5000) {
  if (!Number.isInteger(value) || value < 1 || value > 60000) throw fail('BACKUP_KEY_TIMEOUT_INVALID');
  return value;
}
async function confirmed(work, timeoutMs, disposeLate = () => {}) {
  let expired = false, timer;
  const operation = Promise.resolve().then(work).then(value => {
    if (expired) { disposeLate(value); throw fail('BACKUP_KEY_OPERATION_UNCONFIRMED'); }
    return value;
  });
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(fail('BACKUP_KEY_OPERATION_UNCONFIRMED')); }, timeoutMs);
    })]);
  } catch { throw fail('BACKUP_KEY_OPERATION_UNCONFIRMED'); }
  finally { clearTimeout(timer); }
}
function validateRecord(record, binding) {
  if (!record || Object.keys(record).sort().join(',') !== 'binding,version,wrappedKey,wrappingKeyId' || record.version !== 1 ||
      canonical(record.binding) !== canonical(binding) || !id(record.wrappingKeyId) ||
      typeof record.wrappedKey !== 'string' || !record.wrappedKey.length || record.wrappedKey.length > 8192) {
    throw fail('BACKUP_KEY_REGISTRATION_INVALID');
  }
}
function providerFor(binding, key, usages = ['encrypt', 'decrypt']) {
  let active = true;
  return { provider: Object.freeze({ resolve(request) {
    if (!active || request?.keyId !== binding.keyId || request.algorithm !== 'aes-256-gcm' ||
        !usages.includes(request.usage)) throw fail('BACKUP_KEY_ACCESS_DENIED');
    return { keyId: binding.keyId, key };
  } }), close() { active = false; key.fill(0); } };
}

// The service transfers ownership of its returned Buffer; this session zeros it, including late responses.
// A registration acknowledgement is trusted only on this adapter boundary, never from a caller/UI flag.
async function registeredSession(args, { keyId, checksum, keyService, registry, timeoutMs } = {}) {
  assertSyntheticBackupEncryption(args);
  const binding = bindingFor(args, keyId, checksum), limit = checkedTimeout(timeoutMs);
  if (typeof keyService?.generate !== 'function' || typeof registry?.register !== 'function') {
    throw fail('BACKUP_KEY_CONFIGURATION_INVALID');
  }
  let generated;
  try {
    generated = await confirmed(() => keyService.generate(binding), limit, wipe);
    if (!Buffer.isBuffer(generated?.key) || generated.key.length !== 32 || generated.keyId !== keyId) {
      throw fail('BACKUP_KEY_GENERATION_INVALID');
    }
    const record = Object.freeze({ version: 1, binding, wrappingKeyId: generated.wrappingKeyId, wrappedKey: generated.wrappedKey });
    validateRecord(record, binding);
    const registrationDigest = digest(canonical(record));
    const ack = await confirmed(() => registry.register(record), limit);
    if (!ack || ack.status !== 'CONFIRMED' || ack.keyId !== keyId || ack.registrationDigest !== registrationDigest) {
      throw fail('BACKUP_KEY_REGISTRATION_UNCONFIRMED');
    }
    return { ...providerFor(binding, generated.key), registrationDigest };
  } catch (error) { wipe(generated); throw error; }
}

export async function withRegisteredBackupKey(args, options, consume) {
  if (typeof consume !== 'function') throw fail('BACKUP_KEY_CONFIGURATION_INVALID');
  const session = await registeredSession(args, options);
  try { return await consume(Object.freeze({ keyId: options.keyId, keyProvider: session.provider, registrationDigest: session.registrationDigest })); }
  finally { session.close(); }
}

// Historical access uses separate adapter capabilities. Daily generation needs no historical read/decrypt.
export async function withHistoricalBackupKey(args, { keyId, checksum, keyService, registry, timeoutMs } = {}, consume) {
  assertSyntheticBackupEncryption(args);
  const binding = bindingFor(args, keyId, checksum), limit = checkedTimeout(timeoutMs);
  if (typeof keyService?.recover !== 'function' || typeof registry?.get !== 'function' || typeof consume !== 'function') {
    throw fail('BACKUP_KEY_CONFIGURATION_INVALID');
  }
  let recovered, session;
  try {
    const record = await confirmed(() => registry.get(binding), limit);
    validateRecord(record, binding);
    recovered = await confirmed(() => keyService.recover(record), limit, wipe);
    if (recovered?.keyId !== keyId || !Buffer.isBuffer(recovered.key) || recovered.key.length !== 32) {
      throw fail('BACKUP_KEY_RECOVERY_INVALID');
    }
    session = providerFor(binding, recovered.key, ['decrypt']);
    return await consume(Object.freeze({ keyId, keyProvider: session.provider }));
  } finally { session?.close(); wipe(recovered); }
}

export async function runSyntheticKeyBackup(args, { stagingDirectory, keyService, registry, timeoutMs } = {}, ports = {}) {
  assertSyntheticBackupEncryption(args);
  const limit = checkedTimeout(timeoutMs), keyId = 'b4c1-' + randomUUID();
  // This adapter deliberately accepts only the original snapshot creator as a test port.
  // Publication, authentication, record durability and cleanup remain B4-B's real implementations.
  if (Object.keys(ports).some(name => name !== 'create')) throw fail('BACKUP_KEY_CONFIGURATION_INVALID');
  let registration = 'NOT_ATTEMPTED', session;
  try {
    const result = await runEncryptedBackup(args, {
      encryption: { enabled: true, keyId, stagingDirectory },
      keyProvider: { resolve: request => {
        if (!session) throw fail('BACKUP_KEY_ACCESS_DENIED');
        return session.provider.resolve(request);
      } }
    }, { ...ports, encrypt: async input => {
      registration = 'UNCONFIRMED';
      if (session) throw fail('BACKUP_KEY_ACCESS_DENIED');
      session = await registeredSession(args, { keyId, checksum: input.expectedChecksum, keyService, registry, timeoutMs: limit });
      registration = 'CONFIRMED';
      return encryptArtifact(input);
    } });
    return Object.freeze({ ...result, keyId, keyRegistration: registration });
  } finally { session?.close(); }
}
