import test from 'node:test';
import assert from 'node:assert/strict';

test('formal employee entry renders server snapshot without reading demo business storage', async () => {
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  };
  let testCtx;
  const app = { innerHTML: '', addEventListener() {} };
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
      ktvAppearance: { preference: 'auto' }
    };
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
    globalThis.fetch = async path => {
      if (path === '/api/v1/auth/session') return reply(200, {
        session: { principalId: 'server-principal',
          permissionIds: ['room.clean'] },
        csrfToken: 'csrf-synthetic'
      });
      if (path === '/api/v1/store/snapshot') return reply(200, {
        revision: 7,
        view: { reviewSections: [], workspace: {
          serverNow: '2026-10-06T12:00:00.000000Z',
          sections: { rooms: true, orders: false, catalog: false },
          rooms: [{ id: 'V01', type: '小包', status: '空闲', order: null }]
        } }
      });
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
    assert.doesNotMatch(app.innerHTML,
      /切换演示身份|调整练习时间|恢复演示数据|点这里开房/);
    const { ctx } = await import('./context.js');
    testCtx = ctx;
    const { commit } = await import('./shell.js');
    modal.open = true;
    ctx.formal.state.clearForUnauthenticated();
    assert.equal(modal.open, false);
    assert.match(app.innerHTML, /staff-login/);
    assert.equal(ctx.formal, null);
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
  }
});
