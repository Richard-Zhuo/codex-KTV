// B5-B1: injected ali-oss v6.23.0 capabilities, synthetic admission only.
import { createHash } from 'node:crypto';
import { assertSyntheticBackupEncryption } from './encryption-policy.js';
import { digest } from './format.js';

const MAX = 130 * 1024 * 1024;
const rejected = () => Object.assign(Error('BACKUP_OSS_REJECTED'), { code: 'BACKUP_OSS_REJECTED' });
const validId = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(v);
const validVersion = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

async function bounded(work, ms) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = setTimeout(() => reject(rejected()), ms);
    })]);
  } finally { clearTimeout(timer); }
}
function plainResponse(response) {
  const h = response?.res?.headers;
  if (response?.res?.status !== 200 || !h || Object.hasOwn(h, 'x-oss-version-id') ||
      h['x-oss-object-type'] !== 'Normal' || h['x-oss-symlink-target'] !== undefined ||
      h['content-encoding'] !== undefined && h['content-encoding'] !== 'identity') throw rejected();
  return h;
}
function clientCheck(client, bucket, write = false) {
  // Construction belongs to the trusted bootstrap. Never read/copy/log credentials.
  if (client?.options?.bucket !== bucket || client.options.secure !== true || client.options.retryMax !== 0 ||
      typeof client.get !== 'function' || write &&
      (typeof client.put !== 'function' || typeof client.getBucketVersioning !== 'function')) throw rejected();
}

// A read-only SDK client can construct a fresh reader without any write capability or cache.
export function createOssOffsiteAdapter(args, { readClient, writeClient, bucket, prefix, timeoutMs = 5000 } = {}) {
  try {
    assertSyntheticBackupEncryption(args);
    if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
        typeof prefix !== 'string' || !/^(?:[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/){1,4}$/.test(prefix) ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw rejected();
    clientCheck(readClient, bucket);
    if (writeClient !== undefined) {
      clientCheck(writeClient, bucket, true);
      if (writeClient === readClient) throw rejected();
    }
    const get = readClient.get.bind(readClient);
    const key = objectId => {
      assertSyntheticBackupEncryption(args);
      clientCheck(readClient, bucket);
      if (!validId(objectId)) throw rejected();
      return prefix + objectId;
    };
    const reader = Object.freeze({
      async getExact({ objectId, version } = {}) {
        try {
          const name = key(objectId);
          if (!validVersion(version)) throw rejected();
          // No file destination, range, transformation, native versionId or latest-version fallback.
          const response = await bounded(() => get(name, {
            timeout: timeoutMs, headers: { 'Cache-Control': 'no-cache, no-store', 'Accept-Encoding': 'identity' }
          }), timeoutMs);
          const headers = plainResponse(response), content = response.content;
          if (!Buffer.isBuffer(content) || content.length < 1 || content.length > MAX ||
              !/^(0|[1-9][0-9]*)$/.test(String(headers['content-length'])) ||
              Number(headers['content-length']) !== content.length || digest(content) !== version) throw rejected();
          return { objectId, version, bytes: Buffer.from(content) };
        } catch { throw rejected(); }
      }
    });
    if (writeClient === undefined) return Object.freeze({ reader });
    const put = writeClient.put.bind(writeClient);
    const versioning = writeClient.getBucketVersioning.bind(writeClient);
    const writer = Object.freeze({
      async putIfAbsent({ objectId, bytes } = {}) {
        try {
          const name = key(objectId);
          clientCheck(writeClient, bucket, true);
          if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX) throw rejected();
          const snapshot = Buffer.from(bytes), version = digest(snapshot);
          // This is a Bucket configuration check, never a HEAD/existence check on the object.
          // Administrators must separately prevent versioning changes; no client-side race proof is claimed.
          const state = await bounded(() => versioning(bucket, { timeout: timeoutMs }), timeoutMs);
          if (state?.status !== 200 || !Object.hasOwn(state, 'versionStatus') ||
              state.versionStatus !== undefined && state.versionStatus !== '') throw rejected();
          let ack;
          try {
            ack = await bounded(() => put(name, Buffer.from(snapshot), {
              timeout: timeoutMs,
              headers: {
                'x-oss-forbid-overwrite': 'true',
                'Content-Type': 'application/octet-stream',
                'Content-MD5': createHash('md5').update(snapshot).digest('base64')
              }
            }), timeoutMs);
          } catch (error) {
            // A definite authorization/request rejection cannot be turned into success by an old object.
            // Only a documented existing-object conflict or an uncertain transport/server result is reconciled.
            if (['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'SecurityTokenExpired', 'InvalidSecurityToken'].includes(error?.code)) throw rejected();
            if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 &&
                !(error.status === 409 && ['FileAlreadyExists', 'FileImmutable'].includes(error.code))) throw rejected();
          }
          if (ack !== undefined && (ack?.name !== name || ack?.res?.status !== 200 ||
              !ack.res.headers || Object.hasOwn(ack.res.headers, 'x-oss-version-id'))) throw rejected();
          // Always independently read; late PUT completion alone never makes a success record.
          const recovered = await reader.getExact({ objectId, version });
          if (recovered.bytes.length !== snapshot.length || !recovered.bytes.equals(snapshot)) throw rejected();
          return { objectId, version };
        } catch { throw rejected(); }
      }
    });
    return Object.freeze({ writer, reader });
  } catch { throw rejected(); }
}
