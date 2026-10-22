import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { digest } from './format.js';

// Replace only the disabled transport MODULE. All SDK construction, signing, XML/error
// parsing, put/get and B1 readback logic run unchanged. This sink has no socket/DNS API.
let state;
const response = (status, data, headers = {}) => ({ status, data: Buffer.from(data), headers, res: { status, headers } });
const xmlError = (status, code) => response(status, '<Error><Code>' + code + '</Code><Message>SYNTHETIC_PRIVATE_ERROR</Message></Error>');
const sink = { async request(url, p) {
  state.events.push({ url, ...p });
  const parsed = new URL(url);
  if (parsed.searchParams.has('versioning')) {
    if (state.mode === 'query-denied') return xmlError(403, 'AccessDenied');
    if (state.mode === 'query-malformed') return response(200, '<invalid');
    if (state.versionXml !== undefined) return response(200, state.versionXml);
    return response(200, '<VersioningConfiguration>' + (state.versionStatus === undefined ? '' : '<Status>' + state.versionStatus + '</Status>') + '</VersioningConfiguration>');
  }
  const key = parsed.pathname;
  if (p.method === 'PUT') {
    if (state.mode === 'denied') return xmlError(403, 'AccessDenied');
    if (state.mode === 'expired') return xmlError(403, 'SecurityTokenExpired');
    if (state.mode === 'unknown-no-commit') throw Object.assign(Error('SYNTHETIC_PRIVATE_REQUEST'), { status: -1, name: 'RequestError' });
    assert.equal(p.headers['x-oss-forbid-overwrite'], 'true');
    if (state.objects.has(key)) return xmlError(409, 'FileAlreadyExists');
    state.objects.set(key, Buffer.from(p.content));
    if (state.mode === 'network-after-commit') throw Object.assign(Error('SYNTHETIC_PRIVATE_REQUEST'), { status: -1, name: 'RequestError' });
    if (state.mode === 'timeout-after-commit') throw Object.assign(Error('SYNTHETIC_PRIVATE_TIMEOUT'), { status: -2, name: 'ResponseTimeoutError' });
    if (state.mode === 'pending-after-commit') return new Promise(() => {});
    if (state.mode === 'server-after-commit') return xmlError(500, 'InternalError');
    return response(200, '');
  }
  assert.equal(p.method, 'GET');
  if (state.mode === 'read-denied') return xmlError(403, 'AccessDenied');
  if (!state.objects.has(key)) return xmlError(404, 'NoSuchKey');
  const data = state.mode === 'tamper' ? Buffer.from('TAMPERED') : state.objects.get(key);
  return response(200, data, { 'content-length': String(data.length), 'x-oss-object-type': 'Normal',
    ...(state.mode === 'native-version' ? { 'x-oss-version-id': 'null' } : {}),
    ...(state.mode === 'wrong-size' ? { 'content-length': '1' } : {}) });
} };
mock.module('./oss-sdk-offline-transport.js', { exports: { offlineOssTransport: sink } });
const { createOfflineOssSdkBridge, validateOssSdkBridgeConfig, OSS_SDK_VERSION } = await import('./oss-sdk-bridge.js');
const config = () => ({ region: 'oss-cn-hangzhou', bucket: 'synthetic-b5b2a', endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', prefix: 'synthetic/bridge/', timeoutMs: 25 });
const databaseUrl = 'mysql://synthetic@127.0.0.1:33313/jbhh_ktv_test';
const args = () => ({ environment: 'test', databaseUrl, env: { NODE_ENV: 'test', STAGE5E_RUN: 'synthetic-only', LEDGER_MYSQL_TEST_URL: databaseUrl } });
const secrets = () => ({ accessKeyId: 'synthetic-' + randomBytes(8).toString('hex'), accessKeySecret: randomBytes(32).toString('base64url'), stsToken: randomBytes(16).toString('base64url') });
const input = () => ({ objectId: 'synthetic-unit.ciphertext', bytes: Buffer.from('SYNTHETIC CIPHERTEXT') });
const safe = e => { assert.equal(e.message, e.code); assert.ok(['OSS_SDK_BRIDGE_REJECTED','BACKUP_OSS_REJECTED'].includes(e.code)); assert.deepEqual(Object.keys(e), ['code']); return true; };
function setup(mode) {
  state = { events: [], objects: new Map(), mode };
  const readCredentials = secrets(), writeCredentials = secrets(), options = { config: config(), readCredentials, writeCredentials };
  return { adapter: createOfflineOssSdkBridge(args(), options), readCredentials, writeCredentials, options };
}

test('B2A real SDK signs HTTPS/V4 and sends B1 overwrite/MD5 headers through independent identities', async () => {
  const f = setup(), data = input();
  const point = await f.adapter.writer.putIfAbsent(data);
  assert.deepEqual(point, { objectId: data.objectId, version: digest(data.bytes) });
  assert.deepEqual((await f.adapter.reader.getExact(point)).bytes, data.bytes);
  assert.deepEqual(state.events.map(e => e.method), ['GET','PUT','GET','GET']);
  for (const e of state.events) {
    const u = new URL(e.url); assert.equal(u.protocol, 'https:'); assert.equal(u.hostname, 'synthetic-b5b2a.oss-cn-hangzhou.aliyuncs.com');
    assert.match(e.headers.authorization, /^OSS4-HMAC-SHA256 Credential=/);
    assert.ok(e.headers.authorization.includes('/cn-hangzhou/oss/aliyun_v4_request'));
    assert.equal(e.enableProxy, false); assert.equal(e.timeout, 25); assert.equal(e.writeStream ?? null, null);
    assert.equal(u.searchParams.has('versionId'), false); assert.equal(e.method === 'HEAD', false);
  }
  const put = state.events[1];
  assert.equal(put.headers['x-oss-forbid-overwrite'], 'true');
  assert.equal(put.headers['Content-MD5'], createHash('md5').update(data.bytes).digest('base64'));
  assert.equal(put.headers['Content-Length'], String(data.bytes.length));
  assert.equal(put.headers['x-oss-security-token'], f.writeCredentials.stsToken);
  assert.ok(put.headers.authorization.includes(f.writeCredentials.accessKeyId));
  for (const e of state.events.slice(2)) {
    assert.equal(e.headers['x-oss-security-token'], f.readCredentials.stsToken);
    assert.ok(e.headers.authorization.includes(f.readCredentials.accessKeyId));
    assert.equal(e.headers['Accept-Encoding'], 'identity');
  }
  assert.equal(OSS_SDK_VERSION, '6.23.0');
  assert.deepEqual(Object.keys(f.adapter).sort(), ['reader','writer']);
});
test('B2A real SDK identical retries reconcile conflict; different content never replaces retained bytes', async () => {
  const { adapter } = setup(), data = input(); const point = await adapter.writer.putIfAbsent(data);
  assert.deepEqual(await adapter.writer.putIfAbsent(data), point);
  await assert.rejects(adapter.writer.putIfAbsent({ ...data, bytes: Buffer.from('DIFFERENT') }), safe);
  assert.deepEqual((await adapter.reader.getExact(point)).bytes, data.bytes); assert.equal(state.objects.size, 1);
});
test('B2A real SDK concurrent different bodies retain one winner without HEAD or retry', async () => {
  const { adapter } = setup(), a = input(), b = { ...a, bytes: Buffer.from('CONCURRENT') };
  const results = await Promise.allSettled([adapter.writer.putIfAbsent(a), adapter.writer.putIfAbsent(b)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(state.events.filter(e => e.method === 'PUT').length, 2); assert.equal(state.objects.size, 1);
  assert.deepEqual((await adapter.reader.getExact(results.find(r => r.status === 'fulfilled').value)).bytes, a.bytes);
});
for (const mode of ['network-after-commit','timeout-after-commit','pending-after-commit','server-after-commit']) test('B2A real SDK unknown submission needs independent exact read: ' + mode, async () => {
  const { adapter } = setup(mode), data = input();
  assert.equal((await adapter.writer.putIfAbsent(data)).version, digest(data.bytes));
  assert.deepEqual(state.events.map(e => e.method), ['GET','PUT','GET']);
});
for (const mode of ['unknown-no-commit','denied','expired','query-denied','query-malformed']) test('B2A real SDK sanitized fail-closed: ' + mode, async () => {
  const { adapter } = setup(mode);
  await assert.rejects(adapter.writer.putIfAbsent(input()), safe);
  const writes = state.events.filter(e => e.method === 'PUT').length;
  assert.equal(writes, mode.startsWith('query') ? 0 : 1);
  if (['denied','expired'].includes(mode)) assert.equal(state.events.length, 2);
});
for (const versionStatus of ['Enabled','Suspended','UNKNOWN']) test('B2A real SDK version XML rejects before PUT: ' + versionStatus, async () => {
  const { adapter } = setup(); state.versionStatus = versionStatus;
  await assert.rejects(adapter.writer.putIfAbsent(input()), safe); assert.equal(state.events.length, 1); assert.equal(state.objects.size, 0);
});
for (const mode of ['tamper','wrong-size','native-version','read-denied']) test('B2A real SDK exact read/confirmation rejects: ' + mode, async () => {
  const { adapter } = setup(), data = input(), point = await adapter.writer.putIfAbsent(data); state.mode = mode;
  await assert.rejects(adapter.reader.getExact(point), safe);
  await assert.rejects(adapter.writer.putIfAbsent(data), safe);
});
test('B2A read-only bridge exposes no writer; wrong SHA and invalid object reject', async () => {
  const f = setup(), data = input(), point = await f.adapter.writer.putIfAbsent(data);
  const reader = createOfflineOssSdkBridge(args(), { config: config(), readCredentials: secrets() });
  assert.deepEqual(Object.keys(reader), ['reader']); assert.deepEqual((await reader.reader.getExact(point)).bytes, data.bytes);
  await assert.rejects(reader.reader.getExact({ ...point, version: 'a'.repeat(64) }), safe);
  await assert.rejects(reader.reader.getExact({ ...point, objectId: '../escape' }), safe);
});
test('B2A configuration rejects insecure endpoints, ambiguous fields and transport injection offline', () => {
  setup();
  const invalid = [{ endpoint: 'http://oss-cn-hangzhou.aliyuncs.com' }, { endpoint: 'https://oss-cn-beijing.aliyuncs.com' },
    { endpoint: 'https://user@oss-cn-hangzhou.aliyuncs.com' }, { endpoint: 'https://oss-cn-hangzhou.aliyuncs.com/' },
    { endpoint: 'https://127.0.0.1' }, { prefix: '../bad/' }, { prefix: 'synthetic' }, { region: 'cn-hangzhou' },
    { timeoutMs: 0 }, { accessKeySecret: 'MUST_NOT_ECHO' }, { retryMax: 1 }, { allowNetwork: true }, { urllib: sink }];
  for (const patch of invalid) assert.throws(() => validateOssSdkBridgeConfig({ ...config(), ...patch }), safe);
  for (const patch of [{ transport: sink }, { allowNetwork: true }, { client: {} }]) assert.throws(() => createOfflineOssSdkBridge(args(), { config: config(), readCredentials: secrets(), ...patch }), safe);
  const one = secrets(); assert.throws(() => createOfflineOssSdkBridge(args(), { config: config(), readCredentials: one, writeCredentials: one }), safe);
  assert.equal(state.events.length, 0);
});
test('B2A validate-only constructs locked SDK without credentials loading or requests', () => {
  setup(); const result = validateOssSdkBridgeConfig(config());
  assert.equal(result.networkEnabled, false); assert.equal(result.productionEnabled, false); assert.equal(result.signature, 'V4');
  assert.equal(state.events.length, 0); assert.equal(JSON.stringify(result).includes('accessKey'), false);
});
test('B2A production/TLS/debug selectors cannot hide behind synthetic args', async () => {
  const { adapter } = setup();
  for (const [key, value] of [['NODE_ENV','production'], ['KTV_HTTP_ENV','production'], ['KTV_DEPLOYMENT_ENV','production'], ['NODE_TLS_REJECT_UNAUTHORIZED','0'], ['DEBUG','ali-oss*']]) {
    const previous = process.env[key];
    try { process.env[key] = value;
      assert.throws(() => validateOssSdkBridgeConfig(config()), safe);
      assert.throws(() => createOfflineOssSdkBridge(args(), { config: config(), readCredentials: secrets() }), safe);
      await assert.rejects(adapter.writer.putIfAbsent(input()), safe);
    } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
  }
  const require = createRequire(import.meta.url), sdkRequire = createRequire(require.resolve('ali-oss')), debug = sdkRequire('debug');
  const previous = debug.disable();
  try { debug.enable('ali-oss*'); assert.throws(() => validateOssSdkBridgeConfig(config()), safe); }
  finally { debug.enable(previous); }
  assert.equal(state.events.length, 0);
});

test('B2A committed unknown write with denied verification stays unconfirmed', async () => {
  const { adapter } = setup('read-denied');
  await assert.rejects(adapter.writer.putIfAbsent(input()), safe);
  assert.equal(state.objects.size, 1);
  assert.deepEqual(state.events.map(e => e.method), ['GET','PUT','GET']);
});

// P2: exercise raw HTTP XML through the actual locked SDK, not a pre-normalized status stub.
for (const [label, xml] of [
  ['bare empty', '<VersioningConfiguration/>'],
  ['namespace empty', '<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration xmlns="http://doc.oss-cn-hangzhou.aliyuncs.com"/>'],
  ['whitespace empty', '<VersioningConfiguration> \n </VersioningConfiguration>']
]) test('B2A P2 proven unversioned response permits conditional PUT: ' + label, async () => {
  const {adapter}=setup(); state.versionXml=xml; const data=input();
  assert.equal((await adapter.writer.putIfAbsent(data)).version,digest(data.bytes));
  assert.deepEqual(state.events.map(e=>e.method),['GET','PUT','GET']);
  assert.equal(state.events[1].headers['x-oss-forbid-overwrite'],'true');
});
for (const [label, xml] of [
  ['original unknown root','<UnexpectedResponse/>'],
  ['wrong root with known status','<UnexpectedResponse><Status>Enabled</Status></UnexpectedResponse>'],
  ['empty response',''], ['whitespace response',' \n '], ['not XML','not xml'],
  ['truncated XML','<VersioningConfiguration'],
  ['extra member','<VersioningConfiguration><Unexpected/></VersioningConfiguration>'],
  ['root text','<VersioningConfiguration>unexpected</VersioningConfiguration>'],
  ['empty Status','<VersioningConfiguration><Status/></VersioningConfiguration>'],
  ['nested Status','<VersioningConfiguration><Status><Unexpected/></Status></VersioningConfiguration>'],
  ['duplicate Status','<VersioningConfiguration><Status>Enabled</Status><Status>Suspended</Status></VersioningConfiguration>'],
  ['unknown attribute','<VersioningConfiguration unexpected="true"/>'],
  ['wrong namespace','<VersioningConfiguration xmlns="urn:unexpected"/>'],
  ['multiple roots','<VersioningConfiguration/><UnexpectedResponse/>'],
  ['unknown status','<VersioningConfiguration><Status>Unknown</Status></VersioningConfiguration>'],
  ['doctype','<!DOCTYPE VersioningConfiguration><VersioningConfiguration/>']
]) test('B2A P2 unproven version response rejects with PUT=0: ' + label, async () => {
  const {adapter}=setup(); state.versionXml=xml;
  await assert.rejects(adapter.writer.putIfAbsent(input()),safe);
  assert.equal(state.events.filter(e=>e.method==='PUT').length,0); assert.equal(state.objects.size,0);
  assert.deepEqual(state.events.map(e=>e.method),['GET']);
});
