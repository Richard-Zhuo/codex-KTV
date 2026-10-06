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
    application: options.application ?? { execute() { throw Error('unused command'); } },
    store: { readInTransaction() { throw Error('unused query'); } },
    sessionReader: { withContext() { throw Error('unused query'); } },
    environment: options.environment ?? 'development',
    allowInsecureCookie: options.allowInsecureCookie ?? true,
    logger: { error: () => assert.fail('unexpected internal diagnostic') } });
  return { authService, actual, origin, close: () => new Promise(resolve => server.close(resolve)) };
}

async function request(f, path, { method = 'GET', cookie, csrf, body, origin = f.origin,
  contentType = 'application/json', extraHeaders = {} } = {}) {
  const headers = { ...extraHeaders };
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (method !== 'GET') headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = contentType;
  const response = await fetch(f.actual + path, { method, headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: response.status, cookie: response.headers.get('set-cookie'),
    cacheControl: response.headers.get('cache-control'),
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
  assert.equal(good.cacheControl, 'no-store');
  const sessionStatus = await request(f, '/api/v1/auth/session',
    { cookie: good.cookie.split(';')[0] });
  assert.equal(JSON.stringify(sessionStatus.body).includes(raw), false);
  assert.equal(sessionStatus.cacheControl, 'no-store');
  const production = await start({ origin: 'https://ktv.example', environment: 'production',
    allowInsecureCookie: false });
  t.after(production.close);
  const prodLogin = await login(production);
  assert.match(prodLogin.cookie, /;\s*Secure/);
  const prodLogout = await request(production, '/api/v1/auth/logout', { method: 'POST',
    cookie: prodLogin.cookie.split(';')[0], csrf: prodLogin.body.csrfToken });
  assert.match(prodLogout.cookie, /^jbhh_session=;/);
  assert.match(prodLogout.cookie, /Max-Age=0/);
  assert.match(prodLogout.cookie, /Path=\//);
  assert.match(prodLogout.cookie, /;\s*Secure/);
  assert.throws(() => createHttpAuthBoundary({ authService: fakeAuth(),
    origin: 'http://ktv.example' }), /Unsafe/);
  assert.throws(() => createHttpAuthBoundary({ authService: fakeAuth(),
    origin: 'http://ktv.example', allowInsecureCookie: true }), /Unsafe/);
  assert.throws(() => createHttpAuthBoundary({ authService: fakeAuth(),
    origin: 'http://ktv.example', environment: 'development', allowInsecureCookie: true }), /Unsafe/);
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
  assert.match(done.cookie, /^jbhh_session=;/);
  assert.match(done.cookie, /Max-Age=0/);
  assert.match(done.cookie, /Path=\//);
  assert.match(done.cookie, /SameSite=Strict/);
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
    origin: 'https://attacker.example',
    extraHeaders: { 'X-Forwarded-Host': '127.0.0.1', 'X-Forwarded-Proto': 'https',
      Forwarded: 'host=127.0.0.1;proto=https' } })).body.error.code, 'csrf_denied');
  const signed = await login(f);
  const status = await request(f, '/api/v1/auth/session?principalId=boss&role=boss',
    { cookie: signed.cookie.split(';')[0] });
  assert.equal(status.body.session.principalId, 'server-principal');
  assert.deepEqual(status.body.session.permissionIds, ['room.clean']);
  assert.ok(status.requestId);
});

test('malformed, missing and oversized JSON inputs have stable invalid_input codes', async t => {
  const f = await start(); t.after(f.close);
  for (const body of ['{', '[]', JSON.stringify({ loginIdentifier: 'staff' }),
    JSON.stringify({ loginIdentifier: 'staff', password: 'x'.repeat(17 * 1024) })]) {
    const result = await request(f, '/api/v1/auth/login', { method: 'POST', body });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'invalid_input');
  }
  const wrongType = await request(f, '/api/v1/auth/login', { method: 'POST',
    body: { loginIdentifier: 1, password: 'correct' } });
  assert.equal(wrongType.body.error.code, 'invalid_input');
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=test']) {
    const wrongContentType = await request(f, '/api/v1/auth/login', { method: 'POST',
      body: '{"loginIdentifier":"staff","password":"correct"}', contentType });
    assert.equal(wrongContentType.body.error.code, 'invalid_input');
  }
});

test('duplicate session cookies fail closed and old CSRF does not bind a new session', async t => {
  const f = await start(); t.after(f.close);
  const first = await login(f);
  const second = await request(f, '/api/v1/auth/login', { method: 'POST',
    cookie: first.cookie.split(';')[0],
    body: { loginIdentifier: 'staff', password: 'correct' } });
  const oldCookie = first.cookie.split(';')[0];
  const newCookie = second.cookie.split(';')[0];
  assert.notEqual(oldCookie, newCookie);
  assert.notEqual(first.body.csrfToken, second.body.csrfToken);
  assert.equal((await request(f, '/api/v1/auth/session',
    { cookie: oldCookie + '; ' + newCookie })).body.error.code, 'unauthenticated');
  assert.equal((await request(f, '/api/v1/auth/logout', { method: 'POST',
    cookie: newCookie, csrf: first.body.csrfToken })).body.error.code, 'csrf_denied');
  assert.equal((await request(f, '/api/v1/auth/session', { cookie: newCookie })).status, 200);
});

test('form-style logout without CSRF cannot change the session', async t => {
  const f = await start(); t.after(f.close);
  const signed = await login(f);
  const cookie = signed.cookie.split(';')[0];
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=test']) {
    const denied = await request(f, '/api/v1/auth/logout', { method: 'POST',
      cookie, body: 'logout=true', contentType });
    assert.equal(denied.body.error.code, 'csrf_denied');
    assert.equal((await request(f, '/api/v1/auth/session', { cookie })).status, 200);
  }
});

test('chunked JSON above the transport limit returns invalid_input', async t => {
  const f = await start(); t.after(f.close);
  const outcome = await new Promise((resolve, reject) => {
    const req = http.request(f.actual + '/api/v1/auth/login', { method: 'POST',
      headers: { Origin: f.origin, 'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.write('{"loginIdentifier":"staff","password":"');
    req.end('x'.repeat(17 * 1024) + '"}');
  });
  assert.equal(outcome.status, 400);
  assert.equal(outcome.body.error.code, 'invalid_input');
});

test('sensitive action names route exactly through the single trusted execute port', async t => {
  const calls = [];
  const f = await start({ application: { async execute(command, credential) {
    calls.push({ command, credential });
    return { status: 'committed', action: command.action };
  } } });
  t.after(f.close);
  const signed = await login(f);
  const cookie = signed.cookie.split(';')[0];
  for (const action of ['approve', 'reject', 'pay', 'collect', 'open', 'sale']) {
    const result = await request(f, '/api/v1/commands/' + action, { method: 'POST',
      cookie, csrf: signed.body.csrfToken,
      body: { operationKey: 'route-' + action, expectedRevision: 0, payload: {} } });
    assert.equal(result.status, 200);
    assert.equal(result.body.result.action, action);
  }
  assert.deepEqual(calls.map(call => call.command.action),
    ['approve', 'reject', 'pay', 'collect', 'open', 'sale']);
  for (const call of calls) {
    assert.deepEqual(Object.keys(call.command).sort(),
      ['action', 'expectedRevision', 'operationKey', 'payload']);
    assert.equal(Buffer.isBuffer(call.credential.tokenDigest), true);
    assert.equal(call.credential.tokenDigest.length, 32);
  }
});
