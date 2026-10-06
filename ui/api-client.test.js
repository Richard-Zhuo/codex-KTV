import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmployeeApiClient, HttpApiError, HttpTransportError } from './api-client.js';

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', ...headers }
});

test('employee client uses same-origin cookie transport and only server CSRF evidence', async () => {
  const raw = 'server-only-raw-session-token';
  const calls = [];
  const client = createEmployeeApiClient({ fetchImpl: async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/auth/login')) return json({
      session: { principalId: 'staff-id', permissionIds: ['room.clean'] },
      csrfToken: 'csrf-session-a'
    }, 200, { 'Set-Cookie': 'jbhh_session=' + raw + '; HttpOnly' });
    if (path.endsWith('/auth/session')) return json({
      session: { principalId: 'staff-id', permissionIds: ['room.clean'] },
      csrfToken: 'csrf-session-a'
    });
    return json({ result: { status: 'committed', revision: 2 } });
  } });
  await client.login('staff', 'password');
  await client.getSession();
  const result = await client.executeCommand('clean', {
    operationKey: 'intent-a', expectedRevision: 1, payload: { room: 'V01' }
  });
  assert.equal(result.result.revision, 2);
  assert.deepEqual(calls.map(call => call.path), [
    '/api/v1/auth/login', '/api/v1/auth/session', '/api/v1/commands/clean'
  ]);
  for (const { options } of calls) {
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert.equal(Object.keys(options.headers).some(key => key.toLowerCase() === 'cookie'), false);
  }
  assert.equal(calls[2].options.headers['X-CSRF-Token'], 'csrf-session-a');
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    operationKey: 'intent-a', expectedRevision: 1, payload: { room: 'V01' }
  });
  assert.equal(JSON.stringify(client.currentSession()).includes(raw), false);
});

test('employee client preserves machine errors and clears session on 401', async () => {
  let current = 0;
  const client = createEmployeeApiClient({ fetchImpl: async () => {
    current += 1;
    if (current === 1) return json({
      session: { principalId: 'staff-id', permissionIds: [] }, csrfToken: 'csrf'
    });
    return json({ error: { code: 'unauthenticated', requestId: 'req-a' } },
      401, { 'X-Request-Id': 'req-a' });
  } });
  await client.getSession();
  await assert.rejects(client.getSnapshot(), error =>
    error instanceof HttpApiError && error.code === 'unauthenticated' &&
    error.status === 401 && error.requestId === 'req-a');
  assert.equal(client.currentSession(), null);
  await assert.rejects(client.executeCommand('clean', {
    operationKey: 'intent', expectedRevision: 0, payload: {}
  }), error => error instanceof HttpApiError && error.code === 'csrf_denied');
});

test('POST response loss and timeout are ambiguous; neither causes an automatic retry', async () => {
  let calls = 0;
  const client = createEmployeeApiClient({ fetchImpl: async (path, options) => {
    calls += 1;
    if (path.endsWith('/auth/session')) return json({
      session: { principalId: 'staff-id', permissionIds: [] }, csrfToken: 'csrf'
    });
    if (calls === 2) return { ok: true, status: 200, headers: new Headers(),
      json: async () => { throw SyntaxError('truncated response'); } };
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
    });
  }, timeoutMs: 20 });
  await client.getSession();
  const intent = { operationKey: 'same-key', expectedRevision: 0, payload: {} };
  await assert.rejects(client.executeCommand('clean', intent), error =>
    error instanceof HttpTransportError && error.ambiguous &&
    error.reason === 'network');
  assert.equal(calls, 2);
  await assert.rejects(client.executeCommand('clean', intent), error =>
    error instanceof HttpTransportError && error.ambiguous &&
    error.reason === 'timeout');
  assert.equal(calls, 3);
});
