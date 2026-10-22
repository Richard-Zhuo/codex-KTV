import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createOfflineOssSdkBridge, validateOssSdkBridgeConfig } from './oss-sdk-bridge.js';
const config = { region: 'oss-cn-hangzhou', bucket: 'synthetic-b5b2a', endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', prefix: 'synthetic/bridge/' };
const databaseUrl = 'mysql://synthetic@127.0.0.1:33313/jbhh_ktv_test';
const args = { environment: 'test', databaseUrl, env: { NODE_ENV: 'test', STAGE5E_RUN: 'synthetic-only', LEDGER_MYSQL_TEST_URL: databaseUrl } };
const credentials = role => ({ accessKeyId: 'SYNTHETIC_' + role, accessKeySecret: 'SYNTHETIC_OFFLINE_ONLY' });
const child = (argv, input, env = {}) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, argv, { windowsHide: true, stdio: ['pipe','pipe','pipe'],
    env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '', TEMP: process.env.TEMP ?? '', ...env } });
  let stdout = '', stderr = '';
  p.on('error', reject); p.stdout.on('data', b => { stdout += b; }); p.stderr.on('data', b => { stderr += b; });
  p.stdin.on('error', () => {}); p.on('close', code => resolve({ code, stdout, stderr })); p.stdin.end(input);
});
const cli = fileURLToPath(new URL('./oss-sdk-validate.js', import.meta.url));

test('B2A default compiled bridge cannot use sockets/DNS even with synthetic send calls', async () => {
  let calls = 0; const forbidden = () => { calls++; throw Error('UNEXPECTED_NETWORK'); };
  const mocks = [mock.method(dns, 'lookup', forbidden), mock.method(http, 'request', forbidden),
    mock.method(https, 'request', forbidden), mock.method(net, 'connect', forbidden)];
  try {
    assert.equal(validateOssSdkBridgeConfig(config).networkEnabled, false);
    const adapter = createOfflineOssSdkBridge(args, { config, readCredentials: credentials('READ'), writeCredentials: credentials('WRITE') });
    await assert.rejects(adapter.writer.putIfAbsent({ objectId: 'synthetic.object', bytes: Buffer.from('SYNTHETIC') }), { code: 'BACKUP_OSS_REJECTED' });
    await assert.rejects(adapter.reader.getExact({ objectId: 'synthetic.object', version: 'a'.repeat(64) }), { code: 'BACKUP_OSS_REJECTED' });
    assert.equal(calls, 0);
  } finally { for (const m of mocks) m.mock.restore(); }
});
test('B2A validate-only CLI accepts non-sensitive stdin with SDK installed; no credentials required', async () => {
  const r = await child([cli, '--validate-only'], JSON.stringify(config));
  assert.equal(r.code, 0, r.stderr); assert.equal(r.stderr, '');
  const result = JSON.parse(r.stdout); assert.equal(result.sdkVersion, '6.23.0'); assert.equal(result.networkEnabled, false);
});
for (const [label, argv, input, env] of [
  ['live flag', ['--connect'], JSON.stringify(config), {}],
  ['secret field', ['--validate-only'], JSON.stringify({ ...config, accessKeySecret: 'SYNTHETIC_MUST_NOT_ECHO' }), {}],
  ['malformed', ['--validate-only'], 'SYNTHETIC_MUST_NOT_ECHO', {}],
  ['oversized', ['--validate-only'], 'x'.repeat(8193), {}],
  ['production', ['--validate-only'], JSON.stringify(config), { NODE_ENV: 'production' }]
]) test('B2A validate-only CLI rejects safely: ' + label, async () => {
  const r = await child([cli, ...argv], input, env);
  assert.equal(r.code, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, 'OSS_SDK_BRIDGE_REJECTED\n');
});
