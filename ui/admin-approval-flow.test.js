import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpApiError, HttpTransportError } from './api-client.js';
import { mountAdminApp } from './admin-app.js';
import { createPendingCommandJournal } from './pending-command-journal.js';

function fixture({ onCommand } = {}) {
  const storage = new Map();
  const journal = createPendingCommandJournal({ storageProvider: () => ({
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key)
  }) });
  let principalId = 'reviewer-a';
  let revision = 0;
  let pending = true;
  let valid = true;
  const calls = [];
  const client = {
    async getSession() {
      if (!valid) throw new HttpApiError('unauthenticated', 401);
      return { principalId, permissionIds: ['backend.view', 'inventory.approve'] };
    },
    async getAdminSnapshot() {
      return { revision, view: {
        dashboard: { roomCount: 1, occupiedRooms: 0, issueRooms: 0,
          pendingReviews: pending ? 1 : 0 },
        rooms: [{ id: 'V01', type: 'VIP', status: '空闲' }],
        reviewQueue: pending ? [{ type: 'inventory', id: 701,
          product: 'bw', before: 3, after: 4,
          submittedByPrincipalId: 'applicant-b', canDecide: true, canApprove: true, canReject: true }] : []
      } };
    },
    async login() {},
    async logout() { valid = false; },
    clearSession() {},
    async executeCommand(action, request) {
      calls.push({ action, request });
      if (onCommand) await onCommand({ action, request, setRevision: value => {
        revision = value; pending = false;
      } });
      else { revision += 1; pending = false; }
      return { result: { status: 'committed', revision } };
    }
  };
  function mount() {
    const handlers = {};
    const modalHandlers = {};
    const app = { innerHTML: '',
      addEventListener(type, handler) { handlers[type] = handler; } };
    const modal = { innerHTML: '', open: false,
      addEventListener(type, handler) { modalHandlers[type] = handler; },
      showModal() { this.open = true; },
      close() { this.open = false; } };
    const mounted = mountAdminApp({ app, client, journal, modal,
      randomUUID: () => 'admin-operation-1',
      readDecisionForm: () => new Map([['decisionNote', 'checked']]),
      eventTarget: { addEventListener() {} } });
    return { app, modal, handlers, modalHandlers, mounted };
  }
  return { mount, calls, journal, storage,
    switchActor(id) { principalId = id; },
    invalidate() { valid = false; },
    setRevision(value) { revision = value; pending = false; } };
}

const click = (action, data = {}) => ({
  preventDefault() {},
  target: { disabled: false, dataset: { action, ...data },
    closest() { return this; } }
});
const decisionSubmit = () => ({
  preventDefault() {},
  target: { id: 'admin-decision',
    querySelector: () => ({ disabled: false }) }
});
const tick = () => new Promise(resolve => setImmediate(resolve));

async function openInventory(ui) {
  await tick();
  await ui.handlers.click(click('adminDecide',
    { index: '0', decision: 'approve' }));
  assert.equal(ui.modal.open, true);
  assert.match(ui.modal.innerHTML, /确认批准/);
}

test('admin DOM decision uses server revision, a saved operation key, HTTP adapter and confirmed reload', async () => {
  const f = fixture();
  const ui = f.mount();
  await openInventory(ui);
  await ui.modalHandlers.submit(decisionSubmit());
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { action: 'approveInventory', request: {
    operationKey: 'admin-operation-1', expectedRevision: 0,
    payload: { request: 701, decisionNote: 'checked' }
  } });
  assert.equal(ui.mounted.state.getState().snapshot.revision, 1);
  assert.equal(f.journal.load(), null);
  assert.equal(ui.modal.open, false);
  assert.doesNotMatch(ui.app.innerHTML, /data-action="adminDecide"/);
});

test('ambiguous admin decision restores in the same tab and retries the same key; another actor cannot replay', async () => {
  let uncertain = true;
  const f = fixture({ onCommand: async ({ setRevision }) => {
    if (uncertain) { uncertain = false; throw new HttpTransportError('network', true); }
    setRevision(1);
  } });
  const first = f.mount();
  await openInventory(first);
  await first.modalHandlers.submit(decisionSubmit());
  assert.match(first.app.innerHTML, /上一笔操作结果待确认/);
  assert.equal(f.journal.load().request.operationKey, 'admin-operation-1');
  const second = f.mount();
  await tick();
  assert.match(second.app.innerHTML, /上一笔操作结果待确认/);
  await second.handlers.click(click('adminRetryUnknown'));
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1], f.calls[0]);
  assert.equal(f.journal.load(), null);
  assert.equal(second.mounted.state.getState().snapshot.revision, 1);

  const foreign = fixture({ onCommand: async () => {
    throw new HttpTransportError('network', true);
  } });
  const original = foreign.mount();
  await openInventory(original);
  await original.modalHandlers.submit(decisionSubmit());
  foreign.switchActor('reviewer-b');
  const changed = foreign.mount();
  await tick();
  assert.match(changed.app.innerHTML, /另一账号留下的待确认操作/);
  await changed.handlers.click(click('adminRetryUnknown'));
  assert.equal(foreign.calls.length, 1);
});

test('revision conflict reloads server state without automatic approval, and 401 returns to login', async () => {
  const conflict = fixture({ onCommand: async ({ setRevision }) => {
    setRevision(1);
    throw new HttpApiError('revision_conflict', 409);
  } });
  const ui = conflict.mount();
  await openInventory(ui);
  await ui.modalHandlers.submit(decisionSubmit());
  assert.equal(conflict.calls.length, 1);
  assert.equal(ui.mounted.state.getState().snapshot.revision, 1);
  assert.equal(conflict.journal.load(), null);
  assert.match(ui.app.innerHTML, /事项已被他人修改/);
  assert.doesNotMatch(ui.app.innerHTML, /data-action="adminDecide"/);

  const expired = fixture({ onCommand: async () => {
    throw new HttpApiError('unauthenticated', 401);
  } });
  const other = expired.mount();
  await openInventory(other);
  await other.modalHandlers.submit(decisionSubmit());
  assert.equal(other.mounted.state.getState().phase, 'login');
  assert.equal(other.modal.open, false);
  assert.match(other.app.innerHTML, /后台登录/);
  assert.doesNotMatch(other.app.innerHTML, /data-action="adminDecide"/);
});