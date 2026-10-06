import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpApiError, HttpTransportError } from './api-client.js';
import { createEmployeeCommandFlow } from './command-flow.js';
import { createPendingCommandJournal, PENDING_COMMAND_KEY } from './pending-command-journal.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); }
  };
}

function fixture(execute, storage = memoryStorage()) {
  let revision = 3;
  let actor = 'principal-a';
  let writable = true;
  let refreshes = 0;
  let cleared = false;
  let nextKey = 0;
  const calls = [];
  const journal = createPendingCommandJournal({ storageProvider: () => storage });
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
  const createFlow = () => createEmployeeCommandFlow({ api, state,
    randomUUID: () => 'secure-key-' + (++nextKey), journal });
  const flow = createFlow();
  return { flow, createFlow, calls, journal, storage, state,
    revision: () => revision, refreshes: () => refreshes,
    cleared: () => cleared, setWritable: value => { writable = value; },
    setActor: value => { actor = value; } };
}

test('command journal is durable before POST and success clears it before snapshot refresh', async () => {
  let f;
  f = fixture(async () => {
    const saved = JSON.parse(f.storage.getItem(PENDING_COMMAND_KEY));
    assert.deepEqual(Object.keys(saved).sort(),
      ['action', 'actor', 'createdAt', 'fingerprint', 'request', 'version']);
    assert.equal(saved.actor, 'principal-a');
    assert.equal(saved.request.operationKey, 'secure-key-1');
    assert.equal(saved.request.expectedRevision, 3);
    assert.equal(saved.request.payload.payments[0].amount, 100);
    return { result: { status: 'committed', revision: 4 } };
  });
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
  assert.equal(f.storage.getItem(PENDING_COMMAND_KEY), null);
  assert.deepEqual(f.flow.getStatus(), { phase: 'idle', pending: null });
});

test('lost response survives reconstructed page flow and same-key replay has one effect', async () => {
  let effects = 0;
  const f = fixture(async (action, request, count) => {
    if (count === 1) {
      effects += 1;
      throw new HttpTransportError('timeout', true);
    }
    return { result: { status: 'replayed', revision: 4 } };
  });
  await assert.rejects(f.flow.submit('pay', { order: 8, amount: 100 }),
    error => error instanceof HttpTransportError && error.ambiguous);
  assert.equal(effects, 1);
  assert.ok(f.storage.getItem(PENDING_COMMAND_KEY));
  const afterReload = f.createFlow();
  assert.equal(afterReload.restore().phase, 'unknown');
  await assert.rejects(afterReload.submit('pay', { order: 8, amount: 100 }), TypeError);
  const result = await afterReload.retryUnknown();
  assert.equal(result.result.result.status, 'replayed');
  assert.deepEqual(f.calls[1], f.calls[0]);
  assert.equal(effects, 1);
  assert.equal(f.storage.getItem(PENDING_COMMAND_KEY), null);
  assert.equal(afterReload.getStatus().phase, 'idle');
});

test('different authenticated principal cannot replay another actor pending command', async () => {
  const f = fixture(async () => { throw new HttpTransportError('network', true); });
  await assert.rejects(f.flow.submit('pay', { order: 7 }), HttpTransportError);
  f.flow.suspend();
  f.setActor('principal-b');
  const otherPage = f.createFlow();
  assert.equal(otherPage.restore().phase, 'foreign');
  await assert.rejects(otherPage.retryUnknown(), TypeError);
  await assert.rejects(otherPage.submit('pay', { order: 7 }), TypeError);
  assert.equal(f.calls.length, 1);
  assert.ok(f.storage.getItem(PENDING_COMMAND_KEY));
  f.setActor('principal-a');
  const originalPage = f.createFlow();
  assert.equal(originalPage.restore().phase, 'unknown');
});

test('revision conflict clears pending, reloads state, and new intent gets a new key', async () => {
  const f = fixture(async (action, request, count) => {
    if (count === 1) throw new HttpApiError('revision_conflict', 409, 'request-1');
    return { result: { status: 'committed', revision: 5 } };
  });
  await assert.rejects(f.flow.submit('clean', { room: 'V01' }),
    error => error.code === 'revision_conflict');
  assert.equal(f.refreshes(), 1);
  assert.equal(f.storage.getItem(PENDING_COMMAND_KEY), null);
  assert.equal(f.calls[0].request.expectedRevision, 3);
  await f.flow.submit('clean', { room: 'V01' });
  assert.equal(f.calls[1].request.expectedRevision, 4);
  assert.notEqual(f.calls[1].request.operationKey, f.calls[0].request.operationKey);
});

test('401 and authorization denial are definitive and clear journal', async () => {
  const unauth = fixture(async () => { throw new HttpApiError('unauthenticated', 401); });
  await assert.rejects(unauth.flow.submit('sale', { order: 1 }),
    error => error.code === 'unauthenticated');
  assert.equal(unauth.cleared(), true);
  assert.equal(unauth.storage.getItem(PENDING_COMMAND_KEY), null);

  const denied = fixture(async () => { throw new HttpApiError('authorization_denied', 403); });
  await assert.rejects(denied.flow.submit('approve', { order: 1 }),
    error => error.code === 'authorization_denied');
  assert.equal(denied.refreshes(), 1);
  assert.equal(denied.storage.getItem(PENDING_COMMAND_KEY), null);
});

test('business and idempotency terminal rejections clear journal', async () => {
  for (const code of ['business_rejection', 'idempotency_conflict', 'invalid_input']) {
    const f = fixture(async () => { throw new HttpApiError(code, 409); });
    await assert.rejects(f.flow.submit('clean', { room: 'V01' }),
      error => error.code === code);
    assert.equal(f.storage.getItem(PENDING_COMMAND_KEY), null);
  }
});

test('known command result with failed snapshot refresh has no pending replay', async () => {
  const f = fixture(async () => ({ result: { status: 'committed', revision: 4 } }));
  f.state.refreshSnapshot = async () => { throw new HttpTransportError('network'); };
  const result = await f.flow.submit('deposit', { name: 'A' });
  assert.equal(result.refreshed, false);
  assert.equal(result.error.reason, 'network');
  assert.equal(f.storage.getItem(PENDING_COMMAND_KEY), null);
  assert.equal(f.flow.getStatus().phase, 'refresh-needed');
  await assert.rejects(f.flow.submit('deposit', { name: 'A' }), TypeError);
  assert.equal(f.calls.length, 1);
  f.state.refreshSnapshot = async () => {};
  assert.equal(await f.flow.refreshKnownResult(), true);
  assert.equal(f.calls.length, 1);
});

test('internal error remains unknown and survives reload without a new key', async () => {
  const f = fixture(async () => { throw new HttpApiError('internal_error', 500, 'request-5'); });
  await assert.rejects(f.flow.submit('settle', { order: 1 }),
    error => error.code === 'internal_error');
  assert.equal(f.calls.length, 1);
  assert.equal(f.flow.getStatus().phase, 'unknown');
  assert.equal(f.createFlow().restore().pending.operationKey, 'secure-key-1');
});

test('unavailable or full session storage prevents POST before sending', async () => {
  const storage = memoryStorage();
  storage.setItem = () => { throw new Error('quota'); };
  const f = fixture(async () => ({ result: {} }), storage);
  await assert.rejects(f.flow.submit('clean', { room: 'V01' }), /quota/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.flow.getStatus().phase, 'storage-unavailable');
  await assert.rejects(f.flow.submit('clean', { room: 'V01' }), TypeError);
});

test('damaged journal is preserved and blocks a new business write', async () => {
  const storage = memoryStorage();
  storage.setItem(PENDING_COMMAND_KEY, '{broken');
  const f = fixture(async () => ({ result: {} }), storage);
  assert.equal(f.flow.restore().phase, 'storage-unavailable');
  await assert.rejects(f.flow.submit('clean', { room: 'V01' }), TypeError);
  assert.equal(f.calls.length, 0);
  assert.equal(storage.getItem(PENDING_COMMAND_KEY), '{broken');
});

test('journal rejects secret and authority fields in submitted payload', async () => {
  const f = fixture(async () => ({ result: {} }));
  await assert.rejects(f.flow.submit('clean',
    { room: 'V01', nested: { password: 'do-not-store' } }), TypeError);
  assert.equal(f.calls.length, 0);
  assert.equal(f.storage.getItem(PENDING_COMMAND_KEY), null);
});
