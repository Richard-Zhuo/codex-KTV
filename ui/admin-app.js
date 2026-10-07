import { createEmployeeApiClient, HttpTransportError } from './api-client.js';
import { createEmployeeServerState } from './server-state.js';
import { renderAdminPage } from './admin-view.js';

export function mountAdminApp({
  app,
  client = createEmployeeApiClient(),
  eventTarget = globalThis.window,
  readLoginForm = form => new FormData(form),
  modal = globalThis.document?.querySelector('#admin-modal')
} = {}) {
  if (!app || typeof app.addEventListener !== 'function' ||
      typeof client.getAdminSnapshot !== 'function') {
    throw new TypeError('Invalid formal admin entry');
  }
  const api = Object.freeze({
    ...client,
    getSnapshot: options => client.getAdminSnapshot(options)
  });
  const state = createEmployeeServerState(api);

  function display(model) {
    if (model.phase === 'login' ||
        model.error?.code === 'authorization_denied') {
      if (modal?.open) modal.close();
    }
    app.innerHTML = renderAdminPage(model);
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
    await state.login(String(fields.get('loginIdentifier') ?? ''),
      String(fields.get('password') ?? ''));
  });
  app.addEventListener('click', async event => {
    const target = event.target?.closest?.('[data-action]');
    const action = target?.dataset?.action;
    if (action !== 'adminLogout' && action !== 'adminRefresh') return;
    event.preventDefault();
    target.disabled = true;
    if (action === 'adminLogout') {
      if (modal?.open) modal.close();
      await state.logout();
    } else {
      await state.reconnect();
    }
  });
  eventTarget?.addEventListener?.('offline', () =>
    state.markUnavailable(new HttpTransportError('network')));
  eventTarget?.addEventListener?.('online', () => { void state.reconnect(); });
  void state.bootstrap();
  return Object.freeze({ state, api });
}

if (globalThis.document?.body?.dataset?.appEntry === 'admin') {
  mountAdminApp({ app: document.querySelector('#app') });
}