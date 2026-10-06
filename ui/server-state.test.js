import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpApiError, HttpTransportError } from './api-client.js';
import { createEmployeeServerState } from './server-state.js';

const session = { principalId: 'staff-id', permissionIds: ['room.clean'] };
const snapshot = revision => ({ revision, view: { rooms: [{ id: 'V01', status: '空闲' }] } });

test('staff bootstrap requires formal session; login and reload use server snapshots', async () => {
  let authenticated = false;
  let revision = 4;
  const calls = [];
  const api = {
    clearSession() { calls.push('clear'); },
    async getSession() {
      calls.push('session');
      if (!authenticated) throw new HttpApiError('unauthenticated', 401);
      return session;
    },
    async login(identifier, password) {
      calls.push('login:' + identifier + ':' + password);
      authenticated = true;
      return session;
    },
    async getSnapshot() { calls.push('snapshot'); return snapshot(revision); },
    async logout() { calls.push('logout'); authenticated = false; }
  };
  const state = createEmployeeServerState(api);
  await state.bootstrap();
  assert.equal(state.getState().phase, 'login');
  assert.equal(state.getState().snapshot, null);
  await state.login('employee', 'secret');
  assert.equal(state.getState().phase, 'ready');
  assert.equal(state.getState().snapshot.revision, 4);
  assert.equal(state.isWritable(), true);
  revision = 5;
  await state.bootstrap();
  assert.equal(state.getState().snapshot.revision, 5);
  await state.logout();
  assert.equal(state.getState().phase, 'login');
  assert.equal(state.getState().snapshot, null);
  assert.deepEqual(calls.filter(call => call === 'snapshot'), ['snapshot', 'snapshot']);
});

test('snapshot network failure retains only a stale read-only view; recovery reloads server', async () => {
  let fail = false;
  let revision = 1;
  const api = {
    async getSession() { return session; },
    async getSnapshot() {
      if (fail) throw new HttpTransportError('network');
      return snapshot(revision);
    },
    async login() { return session; },
    async logout() {},
    clearSession() {}
  };
  const state = createEmployeeServerState(api);
  await state.bootstrap();
  fail = true;
  await state.refreshSnapshot();
  assert.equal(state.getState().phase, 'unavailable');
  assert.equal(state.getState().stale, true);
  assert.equal(state.getState().snapshot.revision, 1);
  assert.equal(state.isWritable(), false);
  fail = false;
  revision = 2;
  await state.reconnect();
  assert.equal(state.getState().phase, 'ready');
  assert.equal(state.getState().snapshot.revision, 2);
  assert.equal(state.isWritable(), true);
});

test('revoked session clears snapshot and failed login stays on login screen', async () => {
  let valid = true;
  const api = {
    async getSession() {
      if (!valid) throw new HttpApiError('unauthenticated', 401);
      return session;
    },
    async getSnapshot() { return snapshot(1); },
    async login() { throw new HttpApiError('unauthenticated', 401); },
    async logout() {},
    clearSession() {}
  };
  const state = createEmployeeServerState(api);
  await state.bootstrap();
  valid = false;
  await state.reconnect();
  assert.equal(state.getState().phase, 'login');
  assert.equal(state.getState().snapshot, null);
  await state.login('wrong', 'wrong');
  assert.equal(state.getState().phase, 'login');
  assert.equal(state.getState().error.code, 'unauthenticated');
});

test('post-command refresh reloads current grants and principal before the snapshot', async () => {
  let grants = ['room.clean'];
  let revision = 1;
  const calls = [];
  const api = {
    async getSession() {
      calls.push('session');
      return { principalId: 'staff-id', permissionIds: [...grants] };
    },
    async getSnapshot() {
      calls.push('snapshot');
      return snapshot(revision);
    },
    async login() {}, async logout() {}, clearSession() {}
  };
  const state = createEmployeeServerState(api);
  await state.bootstrap();
  grants = ['room.open'];
  revision = 2;
  calls.length = 0;
  await state.refreshSnapshot();
  assert.deepEqual(calls, ['session', 'snapshot']);
  assert.deepEqual(state.getState().session.permissionIds, ['room.open']);
  assert.equal(state.getState().snapshot.revision, 2);
});
