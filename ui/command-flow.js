import { HttpApiError, HttpTransportError } from './api-client.js';

export function createEmployeeCommandFlow({ api, state, randomUUID = () => crypto.randomUUID(),
  journal = null } = {}) {
  if (typeof api?.executeCommand !== 'function' ||
      typeof state?.getState !== 'function' ||
      typeof state?.refreshSnapshot !== 'function' ||
      typeof state?.isWritable !== 'function' ||
      typeof randomUUID !== 'function') {
    throw new TypeError('Invalid employee command flow');
  }
  let pending = null;
  let phase = 'idle';

  function metadata() {
    return pending ? { action: pending.action, operationKey: pending.request.operationKey,
      expectedRevision: pending.request.expectedRevision, phase } : null;
  }
  function save() {
    try { journal?.save(metadata()); } catch { /* Storage is advisory, never business authority. */ }
  }
  function clear() { pending = null; phase = 'idle'; save(); }
  async function refreshAfterOutcome() {
    await state.refreshSnapshot();
    if (!state.isWritable()) {
      phase = 'refresh-needed';
      save();
      return false;
    }
    clear();
    return true;
  }
  async function send() {
    if (!pending) throw new TypeError('No pending command');
    phase = 'sending';
    save();
    let result;
    try {
      result = await api.executeCommand(pending.action, pending.request);
    } catch (error) {
      if (error instanceof HttpTransportError ||
          error instanceof HttpApiError && error.code === 'internal_error') {
        phase = 'unknown';
        save();
        throw error;
      }
      clear();
      if (error instanceof HttpApiError && error.code === 'unauthenticated') {
        state.clearForUnauthenticated?.();
      } else if (error instanceof HttpApiError && [
        'authorization_denied', 'csrf_denied', 'revision_conflict',
        'idempotency_conflict'
      ].includes(error.code)) {
        await state.reconnect?.();
      }
      throw error;
    }
    phase = 'refresh-needed';
    save();
    try {
      return { result, refreshed: await refreshAfterOutcome() };
    } catch (error) {
      return { result, refreshed: false, error };
    }
  }

  return Object.freeze({
    getStatus() { return Object.freeze({ phase, pending: metadata() }); },
    reset() { clear(); },
    async submit(action, payload) {
      if (pending || !state.isWritable()) throw new TypeError('Command unavailable');
      if (typeof action !== 'string' || !payload || typeof payload !== 'object' ||
          Array.isArray(payload)) throw new TypeError('Invalid command intent');
      const copy = JSON.parse(JSON.stringify(payload));
      const operationKey = randomUUID();
      if (typeof operationKey !== 'string' || !operationKey) {
        throw new TypeError('Secure operation key unavailable');
      }
      pending = { action, actor: state.getState().session.principalId,
        request: Object.freeze({ operationKey,
        expectedRevision: state.getState().snapshot.revision, payload: copy }) };
      save();
      return send();
    },
    async retryUnknown() {
      if (phase !== 'unknown') throw new TypeError('No unknown command to retry');
      if (!state.isWritable()) await state.reconnect?.();
      if (!state.isWritable() ||
          state.getState().session?.principalId !== pending.actor) {
        clear();
        throw new HttpApiError('unauthenticated', 401);
      }
      return send();
    },
    async refreshKnownResult() {
      if (phase !== 'refresh-needed') throw new TypeError('No confirmed command to refresh');
      return refreshAfterOutcome();
    }
  });
}
