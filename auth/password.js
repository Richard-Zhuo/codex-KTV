import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export const SCRYPT_V1 = Object.freeze({
  algorithm: 'scrypt', paramsVersion: 1, N: 16384, r: 8, p: 1,
  saltBytes: 32, derivedBytes: 32, maxmem: 64 * 1024 * 1024
});
const options = { N: SCRYPT_V1.N, r: SCRYPT_V1.r, p: SCRYPT_V1.p, maxmem: SCRYPT_V1.maxmem };
const absentCredential = {
  algorithm: SCRYPT_V1.algorithm, paramsVersion: SCRYPT_V1.paramsVersion,
  salt: randomBytes(SCRYPT_V1.saltBytes), derivedKey: randomBytes(SCRYPT_V1.derivedBytes)
};

export function assertPasswordInput(password) {
  if (typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 1024) {
    throw TypeError('密码输入无效');
  }
}

export async function derivePassword(password) {
  assertPasswordInput(password);
  const salt = randomBytes(SCRYPT_V1.saltBytes);
  const derivedKey = await scrypt(password, salt, SCRYPT_V1.derivedBytes, options);
  return { algorithm: SCRYPT_V1.algorithm, paramsVersion: SCRYPT_V1.paramsVersion,
    salt, derivedKey };
}

export async function verifyPassword(password, credential) {
  assertPasswordInput(password);
  if (credential.algorithm !== SCRYPT_V1.algorithm ||
      Number(credential.paramsVersion) !== SCRYPT_V1.paramsVersion ||
      !Buffer.isBuffer(credential.salt) || credential.salt.length !== SCRYPT_V1.saltBytes ||
      !Buffer.isBuffer(credential.derivedKey) ||
      credential.derivedKey.length !== SCRYPT_V1.derivedBytes) {
    throw Error('不支持或损坏的凭据格式');
  }
  const candidate = await scrypt(password, credential.salt, SCRYPT_V1.derivedBytes, options);
  return timingSafeEqual(candidate, credential.derivedKey);
}

export async function verifyAbsentPassword(password) {
  await verifyPassword(password, absentCredential);
  return false;
}
