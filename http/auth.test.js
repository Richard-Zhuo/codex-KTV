import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createHttpApi } from './api.js';
import { createHttpAuthBoundary } from './transport.js';

function fakeAuth() {
  const account = { id: 'server-principal', enabled: true, version: 1,
    permissions: ['room.clean'] };
  const sessions = new Map();
  return { account, sessions,
    async login({ loginIdentifier, password }) {
      if (loginIdentifier !== 'staff' || password !== 'correct' || !account.enabled) {
        return { ok: false, code: 'invalid-credentials' };
      }
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { revoked: false, expired: false, version: account.version });
      return { ok: true, token, principalId: account.id };
    },
    async authenticateSession(token) {
      const session = sessions.get(token);
      return session && !session.revoked && !session.expired && account.enabled &&
        session.version === account.version
        ? { id: account.id, permissionIds: [...account.permissions] } : null;
    },
    async logout(token) {
      const session = sessions.get(token);
      if (!session) return false;
      session.revoked = true;
      return true;
    }
  };
}

async function start(options = {}) {
  const authService = fakeAuth();
  let api;
  const server = http.createServer((req, res) => { void api.handle(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const actual = 'http://127.0.0.1:' + server.address().port;
  const origin = options.origin ?? actual;
  api = createHttpApi({ authService, origin,
    environment: options.environment ?? 'development',
    allowInsecureCookie: options.allowInsecureCookie ?? true,
    logger: { error: () => assert.fail('unexpected internal diagnostic') } });
  return { authService, actual, origin, close: () => new Promise(resolve => server.close(resolve)) };
}

async function request(f, path, { method = 'GET', cookie, csrf, body, origin = f.origin,
  contentType = 'application/json' } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (method !== 'GET') headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = contentType;
  const response = await fetch(f.actual + path, { method, headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: response.status, cookie: response.headers.get('set-cookie'),
    body: await response.json(), requestId: response.headers.get('x-request-id') };
}

async function login(f, body = { loginIdentifier: 'staff', password: 'correct' }) {
  return request(f, '/api/v1/auth/login', { method: 'POST', body });
}

test('login uses formal auth service; wrong and disabled credentials are rejected', async t => {
  const f = await start(); t.after(f.close);
  const good = await login(f);
  assert.equal(good.status, 200);
  assert.equal(good.body.session.principalId, f.authService.account.id);
  assert.equal((await login(f, { loginIdentifier: 'staff', password: 'wrong' })).status, 401);
  f.authService.account.enabled = false;
  assert.equal((await login(f)).status, 401);
});

test('raw token only leaves in HttpOnly cookie; production and explicit development attributes', async t => {
  const f = await start(); t.after(f.close);
  const good = await login(f);
  const raw = good.cookie.split(';')[0].split('=')[1];
  assert.match(good.cookie, /HttpOnly/);
  assert.match(good.cookie, /Path=\//);
  assert.match(good.cookie, /SameSite=Strict/);
  assert.doesNotMatch(good.cookie, /;\s*Secure/);
  assert.equal(JSON.stringify(good.body).includes(raw), false);
  assert.equal(JSON.stringify((await request(f, '/api/v1/auth/session',
    { cookie: good.cookie.split(';')[0] })).body).includes(raw), false);
  const production = await start({ origin: 'https://ktv.example', environment: 'production',
    allowInsecureCookie: false });
  t.after(production.close);
  assert.match((await login(production)).cookie, /;\s*Secure/);
  assert.throws(() => createHttpAuthBoundary({ authService: fakeAuth(),
    origin: 'http://ktv.example' }), /Unsafe/);
  assert.throws(() => createHttpAuthBoundary({ authService: fakeAuth(),
    origin: 'http://ktv.example', allowInsecureCookie: true }), /Unsafe/);
});

test('revoked, expired, disabled and credential-version-invalid sessions deny HTTP status', async t => {
  const f = await start(); t.after(f.close);
  for (const invalidate of [
    token => { f.authService.sessions.get(token).revoked = true; },
    token => { f.authService.sessions.get(token).expired = true; },
    () => { f.authService.account.enabled = false; },
    () => { f.authService.account.version++; }
  ]) {
    f.authService.account.enabled = true;
    const signed = await login(f);
    const cookie = signed.cookie.split(';')[0];
    const token = cookie.split('=')[1];
    invalidate(token);
    assert.equal((await request(f, '/api/v1/auth/session', { cookie })).body.error.code,
      'unauthenticated');
  }
});

test('logout requires valid CSRF and revokes the formal session', async t => {
  const f = await start(); t.after(f.close);
  const signed = await login(f);
  const cookie = signed.cookie.split(';')[0];
  const token = cookie.split('=')[1];
  assert.equal((await request(f, '/api/v1/auth/logout',
    { method: 'POST', cookie })).body.error.code, 'csrf_denied');
  assert.equal((await request(f, '/api/v1/auth/logout',
    { method: 'POST', cookie, csrf: 'A'.repeat(43) })).body.error.code, 'csrf_denied');
  const done = await request(f, '/api/v1/auth/logout',
    { method: 'POST', cookie, csrf: signed.body.csrfToken });
  assert.equal(done.status, 200);
  assert.match(done.cookie, /Max-Age=0/);
  assert.equal(f.authService.sessions.get(token).revoked, true);
  assert.equal((await request(f, '/api/v1/auth/session', { cookie })).status, 401);
});

test('same-origin JSON login and server principal reject identity spoofing', async t => {
  const f = await start(); t.after(f.close);
  const forged = { loginIdentifier: 'staff', password: 'correct', principal: 'boss',
    principalId: 'boss', userId: 'boss', role: 'boss', permissions: ['review.self'],
    policyAttributes: ['rounding.self.excess'], trustedContext: { principalId: 'boss' } };
  assert.equal((await login(f, forged)).body.error.code, 'invalid_input');
  assert.equal((await request(f, '/api/v1/auth/login', { method: 'POST',
    body: { loginIdentifier: 'staff', password: 'correct' },
    origin: 'https://attacker.example' })).body.error.code, 'csrf_denied');
  const signed = await login(f);
  const status = await request(f, '/api/v1/auth/session?principalId=boss&role=boss',
    { cookie: signed.cookie.split(';')[0] });
  assert.equal(status.body.session.principalId, 'server-principal');
  assert.deepEqual(status.body.session.permissionIds, ['room.clean']);
  assert.ok(status.requestId);
});
