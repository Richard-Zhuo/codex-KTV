import { createEmployeeApiClient, HttpApiError, HttpTransportError } from './api-client.js';
import { createEmployeeServerState } from './server-state.js';
import { createEmployeeCommandFlow } from './command-flow.js';
import { createPendingCommandJournal } from './pending-command-journal.js';
import { prepareAdminDecision } from './admin-approval.js';
import { renderAdminDecisionDialog, renderAdminPage } from './admin-view.js';

export function mountAdminApp({
  app,
  client = createEmployeeApiClient(),
  eventTarget = globalThis.window,
  readLoginForm = form => new FormData(form),
  readDecisionForm = form => new FormData(form),
  journal = createPendingCommandJournal(),
  randomUUID = () => crypto.randomUUID(),
  confirmLogout = message => globalThis.window?.confirm?.(message) ?? false,
  modal = globalThis.document?.querySelector('#admin-modal')
} = {}) {
  if (!app || typeof app.addEventListener !== 'function' ||
      typeof client.getAdminSnapshot !== 'function' ||
      typeof client.executeCommand !== 'function') {
    throw new TypeError('Invalid formal admin entry');
  }
  const api = Object.freeze({
    ...client,
    getSnapshot: options => client.getAdminSnapshot(options)
  });
  const state = createEmployeeServerState(api);
  const flow = createEmployeeCommandFlow({ api, state, journal, randomUUID });
  let principalId = null;
  let activeDecision = null;
  let lastError = null;

  function closeDecision() {
    activeDecision = null;
    if (modal?.open) modal.close();
  }

  function display(model) {
    if (model.phase === 'login' || model.error?.code === 'authorization_denied') {
      closeDecision();
      flow.suspend();
      principalId = null;
      lastError = null;
    } else if (model.phase !== 'ready') {
      closeDecision();
    } else if (model.session?.principalId !== principalId) {
      closeDecision();
      flow.suspend();
      flow.restore();
      principalId = model.session?.principalId ?? null;
      lastError = null;
    }
    app.innerHTML = renderAdminPage(model, {
      flowStatus: flow.getStatus(), lastError
    });
  }
  state.subscribe(display);
  display(state.getState());

  app.addEventListener('submit', async event => {
    if (event.target?.id !== 'admin-login') return;
    event.preventDefault();
    const form = event.target;
    const submit = form.querySelector?.('[type=submit]');
    if (submit) submit.disabled = true;
    const fields = readLoginForm(form);
    lastError = null;
    await state.login(String(fields.get('loginIdentifier') ?? ''),
      String(fields.get('password') ?? ''));
  });

  app.addEventListener('click', async event => {
    const target = event.target?.closest?.('[data-action]');
    const action = target?.dataset?.action;
    if (!['adminLogout', 'adminRefresh', 'adminDecide',
      'adminRetryUnknown', 'adminRefreshKnown'].includes(action)) return;
    event.preventDefault();
    if (action === 'adminDecide') {
      const index = Number(target.dataset.index);
      const direction = target.dataset.decision;
      const model = state.getState();
      const item = model.snapshot?.view?.reviewQueue?.[index];
      if (!Number.isSafeInteger(index) || index < 0 ||
          !state.isWritable() || flow.getStatus().phase !== 'idle' ||
          !['approve', 'reject'].includes(direction) ||
          item?.[direction === 'approve' ? 'canApprove' : 'canReject'] !== true) return;
      activeDecision = { item, index, direction,
        revision: model.snapshot.revision,
        actor: model.session.principalId };
      modal.innerHTML = renderAdminDecisionDialog(item, direction);
      modal.showModal();
      return;
    }
    target.disabled = true;
    try {
      if (action === 'adminLogout') {
        if (['sending', 'unknown', 'foreign', 'storage-unavailable']
          .includes(flow.getStatus().phase) &&
          !confirmLogout('上一笔操作结果可能仍待确认。退出后本标签页保留原请求记录，请由原账号重新登录核对。确定退出？')) {
          target.disabled = false;
          return;
        }
        closeDecision();
        await state.logout();
      } else if (action === 'adminRefresh') {
        lastError = null;
        await state.reconnect();
      } else if (action === 'adminRetryUnknown') {
        const outcome = await flow.retryUnknown();
        lastError = outcome.error ?? null;
      } else {
        const refreshed = await flow.refreshKnownResult();
        lastError = refreshed ? null : new HttpTransportError('network');
      }
    } catch (error) {
      lastError = error;
    }
    display(state.getState());
  });

  modal?.addEventListener?.('click', event => {
    if (event.target?.closest?.('[data-action="adminCancelDecision"]')) {
      event.preventDefault();
      closeDecision();
    }
  });
  modal?.addEventListener?.('submit', async event => {
    if (event.target?.id !== 'admin-decision') return;
    event.preventDefault();
    const selected = activeDecision;
    const model = state.getState();
    if (!selected || !state.isWritable() || flow.getStatus().phase !== 'idle') {
      closeDecision();
      return;
    }
    if (model.snapshot.revision !== selected.revision ||
        model.session.principalId !== selected.actor ||
        model.snapshot.view.reviewQueue[selected.index] !== selected.item) {
      closeDecision();
      lastError = new HttpApiError('revision_conflict', 409);
      await state.reconnect();
      display(state.getState());
      return;
    }
    let command;
    try {
      const fields = readDecisionForm(event.target);
      command = prepareAdminDecision(selected.item, selected.direction,
        String(fields.get('decisionNote') ?? ''));
    } catch {
      lastError = new HttpApiError('invalid_input', 400);
      display(state.getState());
      return;
    }
    const submit = event.target.querySelector?.('[type=submit]');
    if (submit) submit.disabled = true;
    closeDecision();
    lastError = null;
    try {
      const outcome = await flow.submit(command.action, command.payload);
      lastError = outcome.error ?? null;
    } catch (error) {
      lastError = error;
    }
    display(state.getState());
  });

  eventTarget?.addEventListener?.('offline', () =>
    state.markUnavailable(new HttpTransportError('network')));
  eventTarget?.addEventListener?.('online', () => { void state.reconnect(); });
  void state.bootstrap();
  return Object.freeze({ state, api, flow });
}

if (globalThis.document?.body?.dataset?.appEntry === 'admin') {
  mountAdminApp({ app: document.querySelector('#app') });
}