import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpApiError, HttpTransportError } from './api-client.js';
import { mountAdminApp } from './admin-app.js';
import { renderAdminPage } from './admin-view.js';

const session = { principalId: 'formal-owner', permissionIds: ['backend.view'] };
const snapshot = revision => ({ revision, view: {
  serverNow: '2026-10-08T00:00:00.000Z',
  dashboard: { roomCount: 1, occupiedRooms: 0, issueRooms: 0,
    pendingReviews: 0 },
  rooms: [{ id: 'V01', type: 'VIP', status: '空闲' }],
  reviewQueue: []
} });

test('admin entry boots formal session, reloads server snapshot and ignores demo storage', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true,
    get() { throw Error('formal admin read demo business storage'); } });
  let authenticated = false;
  let backend = true;
  let revision = 4;
  const calls = [];
  const handlers = {};
  const app = { innerHTML: '',
    addEventListener(type, handler) { handlers[type] = handler; } };
  const modal = { open: false, close() { this.open = false; } };
  const client = {
    async getSession() {
      calls.push('session');
      if (!authenticated) throw new HttpApiError('unauthenticated', 401);
      return session;
    },
    async getAdminSnapshot() {
      calls.push('admin-snapshot');
      if (!backend) throw new HttpApiError('authorization_denied', 403);
      return snapshot(revision);
    },
    async login() { calls.push('login'); authenticated = true; return session; },
    async logout() { calls.push('logout'); authenticated = false; },
    clearSession() { calls.push('clear'); }
  };
  try {
    const mounted = mountAdminApp({ app, client, eventTarget: {
      addEventListener() {}
    }, readLoginForm: () => new Map([
      ['loginIdentifier', 'owner'], ['password', 'synthetic-password']
    ]), modal });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(mounted.state.getState().phase, 'login');
    assert.match(app.innerHTML, /后台登录/);
    assert.doesNotMatch(app.innerHTML, /演示身份|本地演示数据/);

    await handlers.submit({ target: { id: 'admin-login',
      querySelector: () => ({ disabled: false }) },
    preventDefault() {} });
    assert.equal(mounted.state.getState().phase, 'ready');
    assert.equal(mounted.state.getState().snapshot.revision, 4);
    assert.match(app.innerHTML, /已连接正式后台/);
    assert.match(app.innerHTML, /服务器版本 4/);
    assert.doesNotMatch(app.innerHTML, /data-action="identity"/);

    revision = 5;
    await mounted.state.bootstrap();
    assert.match(app.innerHTML, /服务器版本 5/);
    assert.deepEqual(calls.filter(call => call === 'admin-snapshot'),
      ['admin-snapshot', 'admin-snapshot']);

    backend = false;
    modal.open = true;
    await mounted.state.reconnect();
    assert.match(app.innerHTML, /无权访问系统后台/);
    assert.doesNotMatch(app.innerHTML, /经营概览/);
    assert.equal(modal.open, false);

    backend = true;
    await mounted.state.reconnect();
    await handlers.click({ target: {
      dataset: { action: 'adminLogout' }, disabled: false,
      closest() { return this; }
    }, preventDefault() {} });
    assert.equal(mounted.state.getState().phase, 'login');
    assert.match(app.innerHTML, /后台登录/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('admin network interruption renders last confirmed state as stale and unauthenticated clears it', async () => {
  const handlers = {};
  const app = { innerHTML: '',
    addEventListener(type, handler) { handlers[type] = handler; } };
  let sessionValid = true;
  let network = true;
  const client = {
    async getSession() {
      if (!sessionValid) throw new HttpApiError('unauthenticated', 401);
      if (!network) throw new HttpTransportError('network');
      return session;
    },
    async getAdminSnapshot() { return snapshot(8); },
    async login() { return session; },
    async logout() {},
    clearSession() {}
  };
  const mounted = mountAdminApp({ app, client, eventTarget: {
    addEventListener() {}
  }, modal: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(app.innerHTML, /服务器版本 8/);
  network = false;
  await mounted.state.reconnect();
  assert.match(app.innerHTML, /连接中断/);
  assert.match(app.innerHTML, /服务器版本 8/);
  sessionValid = false;
  network = true;
  await mounted.state.reconnect();
  assert.equal(mounted.state.getState().phase, 'login');
  assert.doesNotMatch(app.innerHTML, /服务器版本 8/);
  assert.ok(handlers.submit);
});

test('admin renderer escapes records and never generates demo identity controls', () => {
  const html = renderAdminPage({ phase: 'ready', session,
    snapshot: { revision: 2, view: {
      ...snapshot(2).view,
      reviewQueue: [{ type: 'expense', id: 1,
        description: '<img src=x onerror=alert(1)>', amount: 100 }],
      dashboard: { ...snapshot(2).view.dashboard, pendingReviews: 1 }
    } }, stale: false, error: null });
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /setUser|setClock|setPermissions|data-action="identity"/);
});