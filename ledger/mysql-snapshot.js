import { createHash } from 'node:crypto';

const plainObject = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

// A digest of JSON values, independent of key order and MySQL JSON's display order.
// It is deliberately not a checksum of the original localStorage bytes.
function canonicalJson(value, active = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || active.has(value)) throw TypeError('账本快照必须是无循环的 JSON 值');
  if (!Array.isArray(value) && !plainObject(value)) throw TypeError('账本快照含非 JSON 对象');
  active.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1 ||
          !Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)) {
        throw TypeError('账本快照含稀疏数组或额外字段');
      }
      return '[' + value.map(item => canonicalJson(item, active)).join(',') + ']';
    }
    if (keys.some(key => typeof key !== 'string' ||
        !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
      throw TypeError('账本快照含隐藏字段、符号或取值函数');
    }
    return '{' + keys.sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key], active)).join(',') + '}';
  } finally {
    active.delete(value);
  }
}

export function encodeLedgerJson(value) {
  if (!plainObject(value)) throw TypeError('账本 JSON 顶层必须是对象');
  return canonicalJson(value);
}

export function decodeLedgerJson(value) {
  const parsed = typeof value === 'string' || Buffer.isBuffer(value) ? JSON.parse(String(value)) : value;
  return JSON.parse(encodeLedgerJson(parsed));
}

export function encodeLedgerSnapshot(state) {
  const json = encodeLedgerJson(state);
  return { json, checksum: createHash('sha256').update(json, 'utf8').digest('hex') };
}

export function decodeLedgerSnapshot(value, checksum) {
  const state = decodeLedgerJson(value);
  const encoded = encodeLedgerSnapshot(state);
  if (typeof checksum !== 'string' || !/^[0-9a-f]{64}$/.test(checksum) || encoded.checksum !== checksum) {
    throw Error('账本快照校验和不一致，停止写入');
  }
  return state;
}
