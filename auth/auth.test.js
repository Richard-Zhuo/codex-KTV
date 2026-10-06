import test from 'node:test';
import assert from 'node:assert/strict';
import { derivePassword, SCRYPT_V1, verifyAbsentPassword, verifyPassword } from './password.js';
import { digestSessionToken, issueSessionToken } from './session-token.js';
import { createMemoryLoginRateLimiter } from './rate-limit.js';
import { createAuthService } from './service.js';

test('scrypt v1 uses independent salts and constant-time verification', async () => {
  const first = await derivePassword('synthetic-long-password');
  const second = await derivePassword('synthetic-long-password');
  assert.equal(first.algorithm, 'scrypt');
  assert.equal(first.paramsVersion, 1);
  assert.equal(SCRYPT_V1.N, 16384);
  assert.equal(SCRYPT_V1.r, 8);
  assert.equal(SCRYPT_V1.p, 1);
  assert.equal(first.salt.length, 32);
  assert.equal(first.derivedKey.length, 32);
  assert.notDeepEqual(first.salt, second.salt);
  assert.notDeepEqual(first.derivedKey, second.derivedKey);
  assert.equal(await verifyPassword('synthetic-long-password', first), true);
  assert.equal(await verifyPassword('wrong-password', first), false);
  assert.equal(await verifyAbsentPassword('synthetic-long-password'), false);
});

test('unsupported or corrupt credential format never becomes a wrong-password result', async () => {
  const credential = await derivePassword('synthetic-long-password');
  await assert.rejects(verifyPassword('synthetic-long-password',
    { ...credential, paramsVersion: 2 }), /凭据格式/);
  await assert.rejects(verifyPassword('synthetic-long-password',
    { ...credential, salt: Buffer.alloc(1) }), /凭据格式/);
});

test('session token is random and only its SHA-256 digest is saved', () => {
  const first = issueSessionToken();
  const second = issueSessionToken();
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.token, second.token);
  assert.equal(first.digest.length, 32);
  assert.deepEqual(digestSessionToken(first.token), first.digest);
  assert.notDeepEqual(first.digest, Buffer.from(first.token));
  assert.equal(digestSessionToken('invalid token'), null);
});

test('login limiter enforces a basic failed-attempt window through an explicit port', () => {
  let time = 1000;
  const limiter = createMemoryLoginRateLimiter({ maxFailures: 2, windowMs: 500,
    now: () => time });
  assert.equal(limiter.canAttempt('synthetic-login'), true);
  limiter.recordFailure('synthetic-login');
  limiter.recordFailure('synthetic-login');
  assert.equal(limiter.canAttempt('synthetic-login'), false);
  assert.equal(limiter.canAttempt('another-login'), true);
  time += 501;
  assert.equal(limiter.canAttempt('synthetic-login'), true);
  limiter.recordFailure('synthetic-login');
  limiter.recordSuccess('synthetic-login');
  assert.equal(limiter.canAttempt('synthetic-login'), true);
});

test('auth service requires a rate-limit port and rejects wildcard administrator grants', async () => {
  const store = { runTransaction: async fn => fn({
    lockAccount: async () => ({ enabled: true }),
    addGrant: async () => true,
    appendEvent: async () => {}
  }) };
  assert.throws(() => createAuthService({ store }), /配置无效/);
  const service = createAuthService({ store, rateLimiter: createMemoryLoginRateLimiter() });
  await assert.rejects(service.grantPermission({
    principalId: '00000000-0000-4000-8000-000000000001', permissionId: 'administrator'
  }), /具体 permission/);
  await assert.rejects(service.grantPermission({
    principalId: '00000000-0000-4000-8000-000000000001', permissionId: '*'
  }), /具体 permission/);
});

test('existing mixed-case grants are stored verbatim without accepting invented IDs', async () => {
  const principalId = '00000000-0000-4000-8000-000000000001', calls = [];
  const store = { runTransaction: async work => work({
    lockAccount: async id => { calls.push(['account', id]); return { enabled: true }; },
    addGrant: async (id, permission) => { calls.push(['grant', id, permission]); return true; },
    removeGrant: async (id, permission) => { calls.push(['revoke', id, permission]); return true; },
    appendEvent: async event => calls.push(['event', event.eventType])
  }) };
  const auth = createAuthService({ store, rateLimiter: createMemoryLoginRateLimiter() });
  assert.equal(await auth.grantPermission({ principalId, permissionId: 'order.serveExtra' }), true);
  assert.equal(await auth.revokePermission({ principalId, permissionId: 'order.serveExtra' }), true);
  assert.deepEqual(calls, [['account', principalId], ['grant', principalId, 'order.serveExtra'], ['event', 'grant-added'],
    ['account', principalId], ['revoke', principalId, 'order.serveExtra'], ['event', 'grant-removed']]);
  for (const permissionId of ['expense.viewAll', 'procurement.viewAll', 'incident.viewAll']) {
    assert.equal(await auth.grantPermission({ principalId, permissionId }), true);
    assert.equal(await auth.revokePermission({ principalId, permissionId }), true);
  }
  const before = structuredClone(calls);
  for (const permissionId of ['administrator', '*', 'order.*', 'Order.serveExtra', 'order.ServeExtra', 'order.serveExtra ', 'expense.ViewAll', 'unknown.permission', 'unknown.viewAll']) {
    await assert.rejects(auth.grantPermission({ principalId, permissionId }), /具体 permission/);
    await assert.rejects(auth.revokePermission({ principalId, permissionId }), /具体 permission/);
  }
  assert.deepEqual(calls, before);
});
