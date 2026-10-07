import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingCommandJournal, PENDING_COMMAND_KEY } from './pending-command-journal.js';

test('formal employee entry renders server snapshot without reading demo business storage', async () => {
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  };
  let testCtx;
  const listeners = {};
  const app = { innerHTML: '', addEventListener(type, listener) { listeners[type] = listener; } };
  const modal = { open: false, close() { this.open = false; },
    showModal() { this.open = true; } };
  const toast = { textContent: '', classList: { add() {}, remove() {} } };
  const reply = (status, body) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: () => null }, async json() { return body; }
  });
  try {
    globalThis.window = {
      location: { search: '' }, addEventListener() {}, scrollTo() {},
      ktvAppearance: { preference: 'auto' }, confirm: () => false
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true, value: { onLine: true }
    });
    globalThis.document = {
      body: { dataset: { appEntry: 'staff' } },
      addEventListener() {},
      querySelector(selector) {
        return ({ '#app': app, '#modal': modal, '#toast': toast })[selector] ?? null;
      }
    };
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true, get() { throw Error('formal entry read localStorage'); }
    });
    const saved = new Map();
    const sessionStorage = {
      getItem(key) { return saved.has(key) ? saved.get(key) : null; },
      setItem(key, value) { saved.set(key, value); },
      removeItem(key) { saved.delete(key); }
    };
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true, value: sessionStorage
    });
    createPendingCommandJournal({ storageProvider: () => sessionStorage }).save({
      actor: 'server-principal', action: 'clean',
      createdAt: '2026-10-06T12:00:00.000Z',
      request: { operationKey: 'pending-original-key',
        expectedRevision: 7, payload: { room: 'V01' } }
    });
    let commandCalls = 0;
    let snapshotRevision = 7;
    const commandRequests = [];
    globalThis.fetch = async (path, options) => {
      if (path === '/api/v1/auth/session') return reply(200, {
        session: { principalId: 'server-principal',
          permissionIds: ['room.clean'] },
        csrfToken: 'csrf-synthetic'
      });
      if (path === '/api/v1/auth/logout') return reply(200, {});
      if (path === '/api/v1/store/snapshot') return reply(200, {
        revision: snapshotRevision,
        view: { reviewSections: [], workspace: {
          serverNow: '2026-10-06T12:00:00.000000Z',
          sections: { rooms: true, orders: false, catalog: false },
          rooms: [{ id: 'V01', type: '小包', status: '空闲', order: null }]
        } }
      });
      if (path === '/api/v1/commands/clean') {
        commandCalls += 1;
        commandRequests.push(JSON.parse(options.body));
        if (commandCalls === 1) throw Error('connection lost');
        if (commandCalls === 3) return reply(422, {
          error: { code: 'business_rejection' }
        });
        snapshotRevision = 8;
        return reply(200, { result: { status: 'replayed', revision: 8 } });
      }
      throw Error('unexpected URL ' + path);
    };
    await import('./staff-app.js');
    for (let attempt = 0; attempt < 30 &&
         !app.innerHTML.includes('服务器版本 7'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.match(app.innerHTML, /服务器版本 7/);
    assert.match(app.innerHTML, /server-p/);
    assert.match(app.innerHTML, /V01/);
    assert.match(app.innerHTML, /上一笔操作结果待确认/);
    assert.match(app.innerHTML, /确认上一笔结果/);
    assert.ok(sessionStorage.getItem(PENDING_COMMAND_KEY));
    assert.doesNotMatch(app.innerHTML,
      /切换演示身份|调整练习时间|恢复演示数据|点这里开房/);
    const { ctx } = await import('./context.js');
    testCtx = ctx;
    const { commit } = await import('./shell.js');
    const retry = { dataset: { action: 'formalRetryUnknown' }, disabled: false };
    const clickRetry = () => listeners.click({ target: { closest: () => retry },
      preventDefault() {} });
    await clickRetry();
    assert.equal(commandCalls, 1);
    assert.ok(sessionStorage.getItem(PENDING_COMMAND_KEY));
    assert.equal(ctx.formal.lastError?.reason, 'network');
    assert.match(app.innerHTML, /上一笔操作结果待确认/);
    await clickRetry();
    assert.equal(commandCalls, 2);
    assert.deepEqual(commandRequests[1], commandRequests[0]);
    assert.equal(commandRequests[1].operationKey, 'pending-original-key');
    assert.equal(sessionStorage.getItem(PENDING_COMMAND_KEY), null);
    assert.doesNotMatch(app.innerHTML, /上一笔操作结果待确认|暂时无法确认操作结果|服务器已接收操作，但最新状态尚未读取/);
    assert.match(app.innerHTML, /服务器版本 8/);
    assert.match(app.innerHTML, /已连接正式营业状态/);
    const { roomIssueEvidenceFields } = await import('./forms.js');
    const formalPhotoFields = roomIssueEvidenceFields();
    assert.match(formalPhotoFields, /id="room-issue-photo" type="file" accept="image\/\*"/);
    assert.match(formalPhotoFields, /name="evidencePhoto"/);
    assert.match(formalPhotoFields, /name="evidencePhotoName"/);
    assert.match(roomIssueEvidenceFields(), /照片将随业务记录提交服务器/);
    assert.doesNotMatch(roomIssueEvidenceFields(), /本机演示数据/);
    ctx.formalEnabled = false;
    assert.match(roomIssueEvidenceFields(), /本机演示数据/);
    ctx.formalEnabled = true;
    assert.equal(ctx.formal.flow.getStatus().phase, 'idle');
    createPendingCommandJournal({ storageProvider: () => sessionStorage }).save({
      actor: 'server-principal', action: 'clean',
      createdAt: '2026-10-06T12:00:30.000Z',
      request: { operationKey: 'pending-terminal-key',
        expectedRevision: 8, payload: { room: 'V02' } }
    });
    ctx.formal.flow.restore();
    await clickRetry();
    assert.equal(commandCalls, 3);
    assert.equal(sessionStorage.getItem(PENDING_COMMAND_KEY), null);
    assert.equal(ctx.formal.flow.getStatus().phase, 'idle');
    assert.match(app.innerHTML, /服务器拒绝了这项业务操作/);
    assert.doesNotMatch(app.innerHTML, /上一笔操作结果待确认|暂时无法确认操作结果|服务器已接收操作，但最新状态尚未读取/);
    createPendingCommandJournal({ storageProvider: () => sessionStorage }).save({
      actor: 'server-principal', action: 'clean',
      createdAt: '2026-10-06T12:01:00.000Z',
      request: { operationKey: 'pending-before-logout',
        expectedRevision: 8, payload: { room: 'V02' } }
    });
    ctx.formal.flow.restore();
    modal.open = true;
    const logout = { dataset: { action: 'formalLogout' }, disabled: false };
    const click = () => listeners.click({ target: { closest: () => logout },
      preventDefault() {} });
    let warnings = 0;
    globalThis.window.confirm = () => { warnings += 1; return false; };
    await click();
    assert.equal(warnings, 1);
    assert.equal(logout.disabled, false);
    assert.ok(ctx.formal);
    assert.ok(sessionStorage.getItem(PENDING_COMMAND_KEY));
    globalThis.window.confirm = () => { warnings += 1; return true; };
    await click();
    assert.equal(warnings, 2);
    assert.equal(modal.open, false);
    assert.match(app.innerHTML, /staff-login/);
    assert.equal(ctx.formal, null);
    assert.ok(sessionStorage.getItem(PENDING_COMMAND_KEY));
    await assert.rejects(commit('clean', { room: 'V01' }),
      /Formal session unavailable/);

  } finally {
    if (testCtx) {
      testCtx.formalEnabled = false;
      testCtx.formal = null;
      testCtx.state = null;
    }
    if (original.window === undefined) delete globalThis.window;
    else globalThis.window = original.window;
    if (original.document === undefined) delete globalThis.document;
    else globalThis.document = original.document;
    globalThis.fetch = original.fetch;
    if (original.localStorage) {
      Object.defineProperty(globalThis, 'localStorage', original.localStorage);
    } else {
      delete globalThis.localStorage;
    }
    if (original.sessionStorage) {
      Object.defineProperty(globalThis, 'sessionStorage', original.sessionStorage);
    } else {
      delete globalThis.sessionStorage;
    }
    if (original.navigator) {
      Object.defineProperty(globalThis, 'navigator', original.navigator);
    } else {
      delete globalThis.navigator;
    }
  }
});
