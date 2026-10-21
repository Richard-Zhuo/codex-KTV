import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createOssOffsiteAdapter } from './oss-adapter.js';
import { digest } from './format.js';
import { mockOss } from '../test-support/mock-oss-client.js';

const databaseUrl = 'mysql://synthetic@127.0.0.1:33313/jbhh_ktv_test';
const args = () => ({ environment: 'test', databaseUrl,
  env: { STAGE5E_RUN: 'synthetic-only', NODE_ENV: 'test', LEDGER_MYSQL_TEST_URL: databaseUrl } });
const input = () => ({ objectId: 'synthetic-key.ciphertext', bytes: Buffer.from('SYNTHETIC-CIPHERTEXT') });
const denied = e => {
  assert.equal(e.code, 'BACKUP_OSS_REJECTED');
  assert.equal(e.message, 'BACKUP_OSS_REJECTED');
  assert.deepEqual(Object.keys(e), ['code']); return true;
};
function setup(options, extra) {
  const remote = mockOss(options);
  return { remote, adapter: createOssOffsiteAdapter(args(), { ...remote, ...extra }) };
}

test('OSS normal create uses exact SDK header, MD5 and fresh independent read', async () => {
  const { remote, adapter } = setup(), data = input();
  const ack = await adapter.writer.putIfAbsent(data);
  assert.deepEqual(ack, { objectId: data.objectId, version: digest(data.bytes) });
  const result = await adapter.reader.getExact(ack);
  assert.deepEqual(result, { ...ack, bytes: data.bytes });
  assert.deepEqual(remote.events.map(e => e.method), ['VERSIONING', 'PUT', 'GET', 'GET']);
  const call = remote.events[1];
  assert.equal(call.name, remote.prefix + data.objectId);
  assert.equal(call.request.headers['x-oss-forbid-overwrite'], 'true');
  assert.equal(call.request.headers['Content-MD5'], createHash('md5').update(data.bytes).digest('base64'));
  assert.equal(call.request.timeout, 5000);
  assert.equal(remote.events[2].request.headers['Accept-Encoding'], 'identity');
  assert.equal(remote.events[2].request.versionId, undefined);
  result.bytes.fill(0);
  assert.deepEqual((await adapter.reader.getExact(ack)).bytes, data.bytes);
  assert.deepEqual(Object.keys(adapter).sort(), ['reader', 'writer']);
  assert.deepEqual(Object.keys(adapter.writer), ['putIfAbsent']);
  assert.deepEqual(Object.keys(adapter.reader), ['getExact']);
});

test('OSS identical retry reuses unchanged object after conditional conflict', async () => {
  const { remote, adapter } = setup(), data = input();
  const first = await adapter.writer.putIfAbsent(data);
  const retained = remote.objects.get(remote.prefix + data.objectId);
  assert.deepEqual(await adapter.writer.putIfAbsent(data), first);
  assert.equal(remote.objects.get(remote.prefix + data.objectId), retained);
  assert.equal(remote.objects.size, 1);
});
test('OSS conflicting content cannot overwrite retained object', async () => {
  const { remote, adapter } = setup(), data = input();
  await adapter.writer.putIfAbsent(data);
  await assert.rejects(adapter.writer.putIfAbsent({ ...data, bytes: Buffer.from('DIFFERENT') }), denied);
  assert.deepEqual(remote.objects.get(remote.prefix + data.objectId), data.bytes);
});
for (const identical of [true, false]) test('OSS concurrent conditional PUT without HEAD: identical=' + identical, async () => {
  const { remote, adapter } = setup(), first = input();
  const second = { ...first, bytes: identical ? first.bytes : Buffer.from('CONCURRENT-DIFFERENT') };
  const results = await Promise.allSettled([adapter.writer.putIfAbsent(first), adapter.writer.putIfAbsent(second)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, identical ? 2 : 1);
  assert.equal(remote.objects.size, 1);
  assert.ok(remote.objects.get(remote.prefix + first.objectId).equals(first.bytes));
  assert.equal(remote.events.filter(e => e.method === 'PUT').length, 2);
  assert.equal(remote.events.filter(e => e.method === 'HEAD').length, 0);
});

for (const mode of ['network-after-write', 'timeout-after-write', 'never-settles-after-write']) {
  test('OSS unknown submission is reconciled only by independent matching read: ' + mode, async () => {
    const { remote, adapter } = setup({ afterPut: async () => {
      if (mode === 'never-settles-after-write') return new Promise(() => {});
      throw Object.assign(Error('SYNTHETIC_AUTHORIZATION_HEADER_MUST_NOT_ESCAPE'), {
        status: mode.startsWith('timeout') ? -2 : -1, code: mode.startsWith('timeout') ? 'ResponseTimeoutError' : 'RequestError'
      });
    } }, { timeoutMs: 15 });
    const data = input();
    assert.equal((await adapter.writer.putIfAbsent(data)).version, digest(data.bytes));
    assert.deepEqual(remote.events.map(e => e.method), ['VERSIONING', 'PUT', 'GET']);
  });
}
for (const mode of ['no-commit', 'read-denied', 'read-timeout', 'wrong-content']) {
  test('OSS unconfirmed result fails closed: ' + mode, async () => {
    const { adapter } = setup({
      beforePut: async () => { if (mode === 'no-commit') throw Error('SYNTHETIC_NETWORK_SECRET'); },
      afterPut: async () => { throw Error('SYNTHETIC_UNKNOWN_SECRET'); },
      beforeGet: async () => {
        if (mode === 'read-denied') throw Object.assign(Error('SYNTHETIC_PRIVATE_HEADERS'), { status: 403 });
        if (mode === 'read-timeout') return new Promise(() => {});
      },
      changeGet: r => mode === 'wrong-content' ? { ...r, content: Buffer.from('TAMPERED') } : r
    }, { timeoutMs: 15 });
    await assert.rejects(adapter.writer.putIfAbsent(input()), denied);
  });
}
test('OSS late completion after an unconfirmed return cannot retroactively report success', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { remote, adapter } = setup({ beforePut: () => gate }, { timeoutMs: 15 });
  await assert.rejects(adapter.writer.putIfAbsent(input()), denied);
  assert.equal(remote.objects.size, 0);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(remote.objects.size, 1);
  // The same immutable operation can later be explicitly retried and verified.
  assert.equal((await adapter.writer.putIfAbsent(input())).version, digest(input().bytes));
});

for (const state of ['Enabled', 'Suspended', 'unexpected', null]) test('OSS refuses unsafe versioning: ' + state, async () => {
  const { remote, adapter } = setup({ versionStatus: state });
  await assert.rejects(adapter.writer.putIfAbsent(input()), denied);
  assert.equal(remote.events.filter(e => e.method === 'PUT').length, 0);
});
test('OSS unavailable/ambiguous Bucket versioning status rejects before upload', async () => {
  for (const response of [{ status: 200 }, { status: 403, versionStatus: undefined }, undefined]) {
    const { remote, adapter } = setup({ versioning: () => response });
    await assert.rejects(adapter.writer.putIfAbsent(input()), denied);
    assert.equal(remote.events.filter(e => e.method === 'PUT').length, 0);
  }
});
test('OSS definitive permission denial cannot be reconciled into success', async () => {
  for (const status of [403, 401, undefined]) {
    const { remote, adapter } = setup({ beforePut: async () => {
      throw Object.assign(Error('SYNTHETIC_PRIVATE_TOKEN'), { status, code: 'AccessDenied' });
    } });
    remote.objects.set(remote.prefix + input().objectId, input().bytes);
    await assert.rejects(adapter.writer.putIfAbsent(input()), denied);
    assert.equal(remote.events.filter(e => e.method === 'GET').length, 0);
  }
});

for (const mode of ['digest', 'size', 'partial', 'native-version', 'symlink', 'encoded', 'not-buffer', 'missing-size']) {
  test('OSS exact read rejects corrupted or ambiguous response: ' + mode, async () => {
    const { remote, adapter } = setup({ changeGet: r => {
      if (mode === 'digest') r.content[0] ^= 1;
      if (mode === 'size') r.res.headers['content-length'] = '999';
      if (mode === 'partial') r.res.status = 206;
      if (mode === 'native-version') r.res.headers['x-oss-version-id'] = 'null';
      if (mode === 'symlink') r.res.headers['x-oss-object-type'] = 'Symlink';
      if (mode === 'encoded') r.res.headers['content-encoding'] = 'gzip';
      if (mode === 'not-buffer') r.content = 'SYNTHETIC-CIPHERTEXT';
      if (mode === 'missing-size') delete r.res.headers['content-length'];
      return r;
    } });
    const data = input(); remote.objects.set(remote.prefix + data.objectId, data.bytes);
    await assert.rejects(adapter.reader.getExact({ objectId: data.objectId, version: digest(data.bytes) }), denied);
  });
}
test('OSS wrong requested SHA/native version rejects; fresh read-only client needs no cache', async () => {
  const { remote, adapter } = setup(), data = input();
  const ack = await adapter.writer.putIfAbsent(data);
  const clean = createOssOffsiteAdapter(args(), { ...remote, writeClient: undefined });
  assert.deepEqual(Object.keys(clean), ['reader']);
  assert.deepEqual((await clean.reader.getExact(ack)).bytes, data.bytes);
  await assert.rejects(clean.reader.getExact({ ...ack, version: '0'.repeat(64) }), denied);
  await assert.rejects(clean.reader.getExact({ ...ack, version: 'native-oss-version' }), denied);
});
test('OSS invalid object keys, prefixes and payloads reject without SDK calls', async () => {
  const { remote, adapter } = setup();
  for (const objectId of ['../outside', '/root', 'a/b', 'a%2fb', 'a?b', 'a#b', 'a\\b', '', '.', '..', 'a'.repeat(161)]) {
    await assert.rejects(adapter.writer.putIfAbsent({ objectId, bytes: input().bytes }), denied);
    await assert.rejects(adapter.reader.getExact({ objectId, version: digest(input().bytes) }), denied);
  }
  for (const prefix of ['', '/', '../', 'a/../', 'a//', 'a%2fb/', 'a?b/', 'a\\b/']) {
    assert.throws(() => createOssOffsiteAdapter(args(), { ...remote, prefix }), denied);
  }
  for (const bytes of ['', Buffer.alloc(0), new Uint8Array(1)]) {
    await assert.rejects(adapter.writer.putIfAbsent({ objectId: input().objectId, bytes }), denied);
  }
  assert.equal(remote.events.length, 0);
});
test('OSS rejects changed/mismatched clients, insecure transport and SDK automatic retries', async () => {
  for (const change of [o => { o.bucket = 'wrong-bucket'; }, o => { o.secure = false; }, o => { o.retryMax = 1; }]) {
    const remote = mockOss(); change(remote.readClient.options);
    assert.throws(() => createOssOffsiteAdapter(args(), remote), denied);
  }
  const { remote, adapter } = setup();
  remote.writeClient.options.bucket = 'outside-bucket';
  await assert.rejects(adapter.writer.putIfAbsent(input()), denied);
  assert.equal(remote.events.length, 0);
});
test('OSS remains synthetic-only at construction and every call', async () => {
  const a = args(), remote = mockOss();
  assert.throws(() => createOssOffsiteAdapter({ ...a, environment: 'production' }, remote), denied);
  const adapter = createOssOffsiteAdapter(a, remote);
  a.env.NODE_ENV = 'production';
  await assert.rejects(adapter.writer.putIfAbsent(input()), denied);
  await assert.rejects(adapter.reader.getExact({ objectId: input().objectId, version: digest(input().bytes) }), denied);
  assert.equal(remote.events.length, 0);
});
test('OSS input buffer mutation during async upload cannot alter the bound content', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { remote, adapter } = setup({ beforePut: () => gate });
  const data = input(), original = Buffer.from(data.bytes);
  const pending = adapter.writer.putIfAbsent(data); data.bytes.fill(0); release();
  assert.equal((await pending).version, digest(original));
  assert.deepEqual(remote.objects.get(remote.prefix + data.objectId), original);
});
test('OSS malformed successful acknowledgement cannot report success', async () => {
  for (const ack of [
    { name: 'wrong-name', res: { status: 200, headers: {} } },
    { name: 'synthetic/offsite/' + input().objectId, res: { status: 200, headers: { 'x-oss-version-id': 'native' } } }
  ]) {
    const remote = mockOss(); remote.writeClient.put = async () => ack;
    const adapter = createOssOffsiteAdapter(args(), remote);
    await assert.rejects(adapter.writer.putIfAbsent(input()), denied);
  }
});
