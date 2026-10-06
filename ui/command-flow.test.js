import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpApiError, HttpTransportError } from './api-client.js';
import { createEmployeeCommandFlow } from './command-flow.js';

function fixture(execute) {
  let revision = 3;
  let actor = 'principal-a';
  let writable = true;
  let refreshes = 0;
  let cleared = false;
  const calls = [];
  const journal = [];
  const state = {
    getState: () => ({ snapshot: { revision }, session: { principalId: actor } }),
    isWritable: () => writable,
    async refreshSnapshot() { refreshes += 1; revision += 1; },
    async reconnect() { refreshes += 1; revision += 1; },
    clearForUnauthenticated() { cleared = true; writable = false; }
  };
  const api = { async executeCommand(action, request) {
    calls.push({ action, request });
    return execute(action, request, calls.length);
  } };
  const flow = createEmployeeCommandFlow({ api, state,
    randomUUID: () => 'secure-key-' + (calls.length + 1),
    journal: { save: value => journal.push(value) } });
  return { flow, calls, journal, state,
    revision: () => revision, refreshes: () => refreshes,
    cleared: () => cleared, setWritable: value => { writable = value; },
    setActor: value => { actor = value; } };
}

test('command uses confirmed revision and one key, then reloads server snapshot', async () => {
  const f = fixture(async () => ({ result: { status: 'committed', revision: 4 } }));
  const payload = { order: 7, payments: [{ method: 'cash', amount: 100 }] };
  const outcome = await f.flow.submit('collect', payload);
  payload.payments[0].amount = 999;
  assert.equal(outcome.refreshed, true);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { action: 'collect', request: {
    operationKey: 'secure-key-1', expectedRevision: 3,
    payload: { order: 7, payments: [{ method: 'cash', amount: 100 }] }
  } });
  assert.equal(f.revision(), 4);
  assert.deepEqual(f.flow.getStatus(), { phase: 'idle', pending: null });
  assert.equal(JSON.stringify(f.journal).includes('payments'), false);
});

test('lost POST response leaves unknown intent; explicit retry sends identical request', async () => {
  const f = fixture(async (action, request, count) => {
    if (count === 1) throw new HttpTransportError('timeout', true);
    return { result: { status: 'replayed', revision: 4 } };
  });
  await assert.rejects(f.flow.submit('pay', { order: 8, amount: 100 }), error =>
    error instanceof HttpTransportError && error.ambiguous);
  assert.equal(f.calls.length, 1);
  assert.equal(f.flow.getStatus().phase, 'unknown');
  await assert.rejects(f.flow.submit('pay', { order: 8, amount: 100 }), TypeError);
  const result = await f.flow.retryUnknown();
  assert.equal(result.result.result.status, 'replayed');
  assert.deepEqual(f.calls[1], f.calls[0]);
  assert.equal(f.flow.getStatus().phase, 'idle');
});

test('revision conflict reloads server and requires a new user intent', async () => {
  const f = fixture(async (action, request, count) => {
    if (count === 1) throw new HttpApiError('revision_conflict', 409, 'request-1');
    return { result: { status: 'committed', revision: 5 } };
  });
  await assert.rejects(f.flow.submit('clean', { room: 'V01' }), error =>
    error.code === 'revision_conflict');
  assert.equal(f.refreshes(), 1);
  assert.equal(f.calls[0].request.expectedRevision, 3);
  assert.equal(f.flow.getStatus().phase, 'idle');
  await f.flow.submit('clean', { room: 'V01' });
  assert.equal(f.calls[1].request.expectedRevision, 4);
  assert.notEqual(f.calls[1].request.operationKey, f.calls[0].request.operationKey);
});

test('401 clears front-end identity and 403 never reports a successful commit', async () => {
  const unauth = fixture(async () => { throw new HttpApiError('unauthenticated', 401); });
  await assert.rejects(unauth.flow.submit('sale', { order: 1 }), error =>
    error.code === 'unauthenticated');
  assert.equal(unauth.cleared(), true);
  assert.equal(unauth.flow.getStatus().phase, 'idle');

  const denied = fixture(async () => { throw new HttpApiError('authorization_denied', 403); });
  await assert.rejects(denied.flow.submit('approve', { order: 1 }), error =>
    error.code === 'authorization_denied');
  assert.equal(denied.refreshes(), 1);
  assert.equal(denied.flow.getStatus().phase, 'idle');
});

test('known command result with failed snapshot refresh blocks new writes without resending', async () => {
  const f = fixture(async () => ({ result: { status: 'committed', revision: 4 } }));
  f.state.refreshSnapshot = async () => { throw new HttpTransportError('network'); };
  const result = await f.flow.submit('deposit', { name: 'A' });
  assert.equal(result.refreshed, false);
  assert.equal(result.error.reason, 'network');
  assert.equal(f.flow.getStatus().phase, 'refresh-needed');
  await assert.rejects(f.flow.submit('deposit', { name: 'A' }), TypeError);
  assert.equal(f.calls.length, 1);
  f.state.refreshSnapshot = async () => {};
  assert.equal(await f.flow.refreshKnownResult(), true);
  assert.equal(f.calls.length, 1);
});

test('internal error remains unknown; no automatic repeat or new key', async () => {
  const f = fixture(async () => { throw new HttpApiError('internal_error', 500, 'request-5'); });
  await assert.rejects(f.flow.submit('settle', { order: 1 }), error =>
    error.code === 'internal_error');
  assert.equal(f.calls.length, 1);
  assert.equal(f.flow.getStatus().phase, 'unknown');
  assert.equal(f.flow.getStatus().pending.operationKey, 'secure-key-1');
});

test('unknown command cannot be retried under a different authenticated actor', async () => {
  const f = fixture(async () => { throw new HttpTransportError('network', true); });
  await assert.rejects(f.flow.submit('pay', { order: 7 }),
    error => error instanceof HttpTransportError);
  f.setActor('principal-b');
  await assert.rejects(f.flow.retryUnknown(),
    error => error instanceof HttpApiError && error.code === 'unauthenticated');
  assert.equal(f.calls.length, 1);
  assert.equal(f.flow.getStatus().phase, 'idle');
});
