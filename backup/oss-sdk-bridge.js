// The official SDK builds/signs requests; the original B1 adapter owns all object semantics.
import OSS from 'ali-oss';
import { createRequire } from 'node:module';
import { createOssOffsiteAdapter } from './oss-adapter.js';
import { assertSyntheticBackupEncryption } from './encryption-policy.js';
import { isProductionEnvironment } from '../shared/deployment-environment.js';
import { offlineOssTransport } from './oss-sdk-offline-transport.js';

const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve('ali-oss'));
const sdkDebug = sdkRequire('debug');
export const OSS_SDK_VERSION = '6.23.0';
const rejected = () => Object.assign(Error('OSS_SDK_BRIDGE_REJECTED'), { code: 'OSS_SDK_BRIDGE_REJECTED' });
const fields = (v, required, optional = []) => v && typeof v === 'object' && !Array.isArray(v) &&
  required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => [...required, ...optional].includes(k));
function hostCheck() {
  if (isProductionEnvironment(process.env) || process.env.DEBUG || sdkDebug.enabled('ali-oss') || sdkDebug.enabled('ali-oss:object') || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
      require('ali-oss/package.json').version !== OSS_SDK_VERSION) throw rejected();
}
function configuration(value) {
  if (!fields(value, ['region', 'bucket', 'endpoint', 'prefix'], ['timeoutMs']) ||
      typeof value.region !== 'string' || !/^oss-cn-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.region) ||
      (typeof value.bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value.bucket)) ||
      value.endpoint !== 'https://' + value.region + '.aliyuncs.com' ||
      typeof value.prefix !== 'string' || !/^(?:[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/){1,4}$/.test(value.prefix) ||
      !Number.isInteger(value.timeoutMs ?? 5000) || (value.timeoutMs ?? 5000) < 1 || (value.timeoutMs ?? 5000) > 60000) throw rejected();
  return Object.freeze({ region: value.region, bucket: value.bucket, endpoint: value.endpoint,
    prefix: value.prefix, timeoutMs: value.timeoutMs ?? 5000 });
}
function credential(value) {
  if (!fields(value, ['accessKeyId', 'accessKeySecret'], ['stsToken']) ||
      ['accessKeyId', 'accessKeySecret', ...(Object.hasOwn(value, 'stsToken') ? ['stsToken'] : [])].some(k =>
        typeof value[k] !== 'string' || !value[k].length || value[k].length > 4096 || value[k].trim() !== value[k] || /[\r\n]/.test(value[k]))) throw rejected();
  return { ...value };
}
function client(config, supplied) {
  hostCheck();
  const sdk = new OSS({ ...credential(supplied), region: config.region, endpoint: config.endpoint,
    bucket: config.bucket, secure: true, authorizationV4: true, retryMax: 0,
    timeout: config.timeoutMs, enableProxy: false, cname: false, internal: false,
    urllib: offlineOssTransport, refreshSTSTokenInterval: 300000 });
  if (sdk.options.secure !== true || sdk.options.authorizationV4 !== true || sdk.options.retryMax !== 0 ||
      sdk.options.region !== config.region || sdk.options.bucket !== config.bucket ||
      sdk.options.endpoint.protocol !== 'https:' || sdk.options.endpoint.hostname !== config.region + '.aliyuncs.com' ||
      sdk.urllib !== offlineOssTransport) throw rejected();
  return sdk;
}
// Non-sensitive format/client-contract check only. Does NOT load supplied/environment credentials,
// invoke any SDK request, resolve DNS, query a Bucket or prove its region/IAM/TLS configuration.
export function validateOssSdkBridgeConfig(value) {
  try {
    hostCheck(); const config = configuration(value);
    for (const role of ['read', 'write']) client(config, {
      accessKeyId: 'SYNTHETIC_OFFLINE_' + role, accessKeySecret: 'SYNTHETIC_OFFLINE_ONLY'
    });
    return Object.freeze({ code: 'OSS_SDK_BRIDGE_VALID', sdk: 'ali-oss', sdkVersion: OSS_SDK_VERSION,
      https: true, signature: 'V4', retryMax: 0, networkEnabled: false, productionEnabled: false });
  } catch { throw rejected(); }
}
// In-memory credentials are a future bootstrap seam; this entry NEVER reads environment secrets.
// B2A still pins an unconditionally disabled transport. No live CLI or transport-injection option.
export function createOfflineOssSdkBridge(args, options) {
  try {
    hostCheck(); assertSyntheticBackupEncryption(args);
    if (!fields(options, ['config', 'readCredentials'], ['writeCredentials'])) throw rejected();
    const config = configuration(options.config), safeArgs = structuredClone(args);
    const read = credential(options.readCredentials), write = options.writeCredentials === undefined ? null : credential(options.writeCredentials);
    if (write && read.accessKeyId === write.accessKeyId) throw rejected();
    const make = (secret, writable) => {
      const sdk = client(config, secret);
      const guard = work => { hostCheck(); assertSyntheticBackupEncryption(safeArgs); return work(); };
      // Only B1's necessary SDK calls and non-secret options cross this seam; SDK/private options stay hidden.
      return Object.freeze({ options: Object.freeze({ bucket: config.bucket, secure: true, retryMax: 0 }),
        get: (...a) => guard(() => sdk.get(...a)),
        ...(writable ? { put: (...a) => guard(() => sdk.put(...a)),
          getBucketVersioning: (...a) => guard(() => sdk.getBucketVersioning(...a)) } : {}) });
    };
    return createOssOffsiteAdapter(safeArgs, { ...config, readClient: make(read, false),
      ...(write ? { writeClient: make(write, true) } : {}) });
  } catch { throw rejected(); }
}
