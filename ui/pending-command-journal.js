export const PENDING_COMMAND_KEY = 'jbhh-pending-command-v1';

const VERSION = 1;
const MAX_RECORD_LENGTH = 2_000_000;
const sensitiveKeys = new Set([
  'password', 'csrf', 'csrftoken', 'cookie', 'rawsessiontoken',
  'sessiontoken', 'rawtoken', 'permissions', 'permissionids',
  'policyattributes', 'principal', 'principalid', 'trustedcontext'
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function containsSensitiveKey(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    sensitiveKeys.has(key.toLowerCase()) || containsSensitiveKey(child));
}

// This detects damaged local records; the server remains the authority for replay.
function fingerprint(record) {
  const text = JSON.stringify([record.version, record.actor, record.action,
    record.request, record.createdAt]);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function valid(record) {
  return isObject(record) &&
    Object.keys(record).sort().join(',') ===
      'action,actor,createdAt,fingerprint,request,version' &&
    record.version === VERSION &&
    typeof record.actor === 'string' && record.actor.length > 0 &&
    typeof record.action === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(record.action) &&
    typeof record.createdAt === 'string' &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    isObject(record.request) &&
    Object.keys(record.request).sort().join(',') ===
      'expectedRevision,operationKey,payload' &&
    typeof record.request.operationKey === 'string' &&
    record.request.operationKey.length > 0 &&
    Number.isSafeInteger(record.request.expectedRevision) &&
    record.request.expectedRevision >= 0 &&
    isObject(record.request.payload) &&
    !containsSensitiveKey(record.request.payload) &&
    record.fingerprint === fingerprint(record);
}

function frozenRecord(record) {
  const copy = JSON.parse(JSON.stringify(record));
  function freeze(value) {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  return freeze(copy);
}

export function createPendingCommandJournal({
  storageProvider = () => globalThis.sessionStorage,
  key = PENDING_COMMAND_KEY
} = {}) {
  if (typeof storageProvider !== 'function' || typeof key !== 'string' || !key) {
    throw new TypeError('Invalid pending command journal');
  }
  function storage() {
    const target = storageProvider();
    if (!target || typeof target.getItem !== 'function' ||
        typeof target.setItem !== 'function' ||
        typeof target.removeItem !== 'function') {
      throw new TypeError('Session storage unavailable');
    }
    return target;
  }
  return Object.freeze({
    load() {
      const raw = storage().getItem(key);
      if (raw === null) return null;
      if (typeof raw !== 'string' || raw.length > MAX_RECORD_LENGTH) {
        throw new TypeError('Pending command journal damaged');
      }
      let record;
      try { record = JSON.parse(raw); }
      catch { throw new TypeError('Pending command journal damaged'); }
      if (!valid(record)) throw new TypeError('Pending command journal damaged');
      return frozenRecord(record);
    },
    save({ actor, action, request, createdAt }) {
      const target = storage();
      if (target.getItem(key) !== null) {
        throw new TypeError('Pending command already exists');
      }
      const record = { version: VERSION, actor, action, request, createdAt };
      record.fingerprint = fingerprint(record);
      if (!valid(record)) throw new TypeError('Invalid pending command');
      const raw = JSON.stringify(record);
      if (raw.length > MAX_RECORD_LENGTH) {
        throw new TypeError('Pending command too large for session storage');
      }
      target.setItem(key, raw);
      if (target.getItem(key) !== raw) {
        throw new TypeError('Pending command was not saved');
      }
      return frozenRecord(record);
    },
    clear() {
      const target = storage();
      target.removeItem(key);
      if (target.getItem(key) !== null) {
        throw new TypeError('Pending command was not cleared');
      }
    }
  });
}
