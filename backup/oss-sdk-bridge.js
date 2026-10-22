// The official SDK builds/signs requests; the original B1 adapter owns all object semantics.
import OSS from 'ali-oss';
import { createRequire } from 'node:module';
import { createOssOffsiteAdapter } from './oss-adapter.js';
import { assertSyntheticBackupEncryption } from './encryption-policy.js';
import { isProductionEnvironment } from '../shared/deployment-environment.js';
import { offlineOssTransport } from './oss-sdk-offline-transport.js';
import { consumeOssAcceptancePermit } from './oss-acceptance-authorization.js';

const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve('ali-oss'));
const sdkDebug = sdkRequire('debug');
// Reuse the locked SDK's own XML lexer; no new parser dependency or vendor patch.
const sdkXmlRequire = createRequire(sdkRequire.resolve('xml2js'));
const sdkXml = sdkXmlRequire('sax');
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
// Complete whitelist for this bounded response language, not a general XML parser.
// SAX strict mode does not validate XML declarations. Validate the entire document,
// including XML 1.0 declaration order and exact EOF, before either parser sees it.
const xmlSpace = '[\\x20\\x09\\x0A\\x0D]';
const xmlEquals = xmlSpace + '*=' + xmlSpace + '*';
const xmlQuoted = pattern => '(?:"' + pattern + '"|\'' + pattern + '\')';
const xmlDeclaration = '<\\?xml' + xmlSpace + '+version' + xmlEquals + xmlQuoted('1\\.0') +
  '(?:' + xmlSpace + '+encoding' + xmlEquals + xmlQuoted('[Uu][Tt][Ff]-8') + ')?' +
  '(?:' + xmlSpace + '+standalone' + xmlEquals + xmlQuoted('(?:yes|no)') + ')?' + xmlSpace + '*\\?>';
const xmlNamespace = xmlSpace + '+xmlns' + xmlEquals + xmlQuoted('http://doc\\.oss-cn-hangzhou\\.aliyuncs\\.com');
const xmlStatus = '<Status' + xmlSpace + '*>(?:Enabled|Suspended)</Status' + xmlSpace + '*>';
const versionDocument = new RegExp('^(?:\\uFEFF)?(?:' + xmlDeclaration + ')?' + xmlSpace + '*' +
  '<VersioningConfiguration(?:' + xmlNamespace + ')?' + xmlSpace + '*' +
  '(?:/>|>' + xmlSpace + '*(?:' + xmlStatus + xmlSpace + '*)?</VersioningConfiguration' + xmlSpace + '*>)' +
  xmlSpace + '*(?![\\s\\S])');

// Preserve schema evidence BEFORE ali-oss parseXML discards the root element.
function versionResponseEvidence(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > 8192) throw rejected();
  const bytes = Buffer.from(raw), text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || !versionDocument.test(text)) throw rejected();
  let depth = 0, roots = 0, statusSeen = false, status = '';
  const parser = sdkXml.parser(true, { strictEntities: true });
  parser.onopentag = node => {
    depth++;
    if (depth === 1) {
      if (++roots !== 1 || node.name !== 'VersioningConfiguration' ||
          Object.entries(node.attributes).some(([k,v]) => k !== 'xmlns' || v !== 'http://doc.oss-cn-hangzhou.aliyuncs.com')) throw rejected();
    } else if (depth === 2) {
      if (node.name !== 'Status' || statusSeen || Object.keys(node.attributes).length) throw rejected();
      statusSeen = true;
    } else { throw rejected(); }
  };
  parser.onclosetag = () => { depth--; };
  parser.ontext = parser.oncdata = value => {
    if (depth === 2) status += value;
    else if (value.trim()) throw rejected();
  };
  parser.ondoctype = parser.onerror = () => { throw rejected(); };
  parser.write(text).close();
  if (roots !== 1 || depth !== 0 || statusSeen && !['Enabled','Suspended'].includes(status)) throw rejected();
  return { bytes, status: statusSeen ? status : undefined }; // Absence requires a validated empty root.
}
function client(config, supplied, transport = offlineOssTransport) {
  hostCheck();
  const sdk = new OSS({ ...credential(supplied), region: config.region, endpoint: config.endpoint,
    bucket: config.bucket, secure: true, authorizationV4: true, retryMax: 0,
    timeout: config.timeoutMs, enableProxy: false, cname: false, internal: false,
    urllib: transport, refreshSTSTokenInterval: 300000 });
  if (sdk.options.secure !== true || sdk.options.authorizationV4 !== true || sdk.options.retryMax !== 0 ||
      sdk.options.region !== config.region || sdk.options.bucket !== config.bucket ||
      sdk.options.endpoint.protocol !== 'https:' || sdk.options.endpoint.hostname !== config.region + '.aliyuncs.com' ||
      sdk.urllib !== transport) throw rejected();
  const request = sdk.request.bind(sdk);
  sdk.request = async params => {
    if (params.subres !== 'versioning') return request(params);
    if (params.method !== 'GET' || params.bucket !== config.bucket || params.xmlResponse !== true || params.object !== undefined) throw rejected();
    // Keep the actual SDK signing, transport, HTTP-status/error handling and final parser.
    // Disable only its lossy eager XML conversion for this private GET, never other calls.
    const result = await request({ ...params, xmlResponse: false });
    if (result.status !== 200) throw rejected();
    const evidence = versionResponseEvidence(result.data);
    const data = await sdk.parseXML(evidence.bytes);
    if (data?.Status !== evidence.status) throw rejected();
    return { ...result, data };
  };
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
// This existing factory still pins disabled transport; B2B uses a separate one-use manual permit.
export function createOfflineOssSdkBridge(args, options) {
  return createBridge(args, options, () => offlineOssTransport);
}
function createBridge(args, options, transportFor) {
  try {
    hostCheck(); assertSyntheticBackupEncryption(args);
    if (!fields(options, ['config', 'readCredentials'], ['writeCredentials'])) throw rejected();
    const config = configuration(options.config), safeArgs = structuredClone(args);
    const read = credential(options.readCredentials), write = options.writeCredentials === undefined ? null : credential(options.writeCredentials);
    if (write && read.accessKeyId === write.accessKeyId) throw rejected();
    const make = (secret, writable) => {
      const sdk = client(config, secret, transportFor(writable));
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

// Only a one-use permit minted by the dedicated interactive operator entry can select
// this scope-limited transport. No transport/client/allowNetwork configuration crosses it.
export function createOssSdkAcceptanceBridge(permit, credentials) {
  try {
    hostCheck();
    const {config, transportFor, observations} = consumeOssAcceptancePermit(permit);
    const databaseUrl = 'mysql://synthetic@127.0.0.1:33313/jbhh_ktv_test';
    const args = {environment:'test', databaseUrl, env:{NODE_ENV:'test',
      STAGE5E_RUN:'synthetic-only', LEDGER_MYSQL_TEST_URL:databaseUrl}};
    if (!fields(credentials, ['readCredentials','writeCredentials'])) throw rejected();
    return Object.freeze({...createBridge(args, {config, ...credentials}, transportFor), observations});
  } catch { throw rejected(); }
}
