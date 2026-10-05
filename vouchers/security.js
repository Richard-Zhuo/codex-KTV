import { createHmac, createHash } from 'node:crypto';
import { encodeLedgerJson } from '../ledger/mysql-snapshot.js';
export function protectVoucherCode(code, secret) {
  if (typeof code !== 'string' || !/^[0-9]{1,128}$/.test(code.trim()) ||
      !Buffer.isBuffer(secret) || secret.length < 32) throw TypeError('Invalid voucher code or server HMAC key');
  const normalized = code.trim();
  return { normalized, hash: createHmac('sha256', secret).update(normalized).digest('hex'),
    masked: '*'.repeat(normalized.length > 4 ? normalized.length - 4 : 1) + normalized.slice(normalized.length > 4 ? -4 : 1) };
}
// Reuse the existing strict, deterministic JSON-value codec, including cycle/getter rejection.
export const canonicalVoucherJson = encodeLedgerJson;
export const voucherFingerprint = value => createHash('sha256').update(canonicalVoucherJson(value)).digest('hex');
