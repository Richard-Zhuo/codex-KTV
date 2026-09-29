import { createHash, randomBytes } from 'node:crypto';

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export function issueSessionToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, digest: digestSessionToken(token) };
}

export function digestSessionToken(token) {
  if (typeof token !== 'string' || !tokenPattern.test(token)) return null;
  return createHash('sha256').update(token, 'utf8').digest();
}
