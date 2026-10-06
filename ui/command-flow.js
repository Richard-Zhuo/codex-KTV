import { HttpApiError, HttpTransportError } from './api-client.js';

const terminalErrors = new Set([
  'unauthenticated', 'authorization_denied', 'csrf_denied',
  'business_rejection', 'revision_conflict', 'idempotency_conflict',
  'invalid_input'
]);

export function createEmployeeCommandFlow({ api, state,
  randomUUID = () => crypto.randomUUID(), journal } = {}) {
  if (typeof api?.executeCommand !== 'function' ||
      typeof state?.getState !== 'function' ||
      typeof state?.refreshSnapshot !== 'function' ||
      typeof state?.isWritable !== 'function' ||
      typeof randomUUID !== 'function' ||
      typeof journal?.load !== 'function' ||
      typeof journal?.save !== 'function' ||
      typeof journal?.clear !== 'function') {
    throw new TypeError('Invalid employee command flow');
  }
  let pending = null;
  let phase = 'idle';

  function metadata() {
    return pending ? { action: pending.action,
      operationKey: pending.request.operationKey,
      expectedRevision: pending.request.expectedRevision,
      createdAt: pending.createdAt, phase } : null;
  }
  function clearTerminal() {
    try { journal.clear(); }
    catch (error) {
      phase = 'storage-unavailable';
      throw error;
    }
    pending = null;
    phase = 'idle';
  }
  async function refreshKnownResult() {
    await state.refreshSnapshot();
    if (!state.isWritable()) return false;
    phase = 'idle';
    return true;
  }
  async function send() {
    if (!pending) throw new TypeError('No pending command');
    phase = 'sending';
    let result;
    try {
      result = await api.executeCommand(pending.action, pending.request);
    } catch (error) {
      if (error instanceof HttpTransportError ||
          !(error instanceof HttpApiError) ||
          !terminalErrors.has(error.code)) {
        phase = 'unknown';
        throw error;
      }
      clearTerminal();
      if (error.code === 'unauthenticated') {
        state.clearForUnauthenticated?.();
      } else if (['authorization_denied', 'csrf_denied',
        'revision_conflict', 'idempotency_conflict'].includes(error.code)) {
        await state.reconnect?.();
      }
      throw error;
    }
    clearTerminal();
    phase = 'refresh-needed';
    try {
      return { result, refreshed: await refreshKnownResult() };
    } catch (error) {
      return { result, refreshed: false, error };
    }
  }

  return Object.freeze({
    getStatus() { return Object.freeze({ phase, pending: metadata() }); },
    // Logout or actor changes discard only memory. The unresolved record stays in this tab.
    suspend() { pending = null; phase = 'idle'; },
    restore() {
      if (phase === 'sending') return this.getStatus();
      try { pending = journal.load(); }
      catch {
        pending = null;
        phase = 'storage-unavailable';
        return this.getStatus();
      }
      phase = pending
        ? pending.actor === state.getState().session?.principalId ? 'unknown' : 'foreign'
        : 'idle';
      return this.getStatus();
    },
    async submit(action, payload) {
      if (pending || phase !== 'idle' || !state.isWritable()) {
        throw new TypeError('Command unavailable');
      }
      if (typeof action !== 'string' || !payload || typeof payload !== 'object' ||
          Array.isArray(payload)) throw new TypeError('Invalid command intent');
      const copy = JSON.parse(JSON.stringify(payload));
      const operationKey = randomUUID();
      if (typeof operationKey !== 'string' || !operationKey) {
        throw new TypeError('Secure operation key unavailable');
      }
      const actor = state.getState().session?.principalId;
      const candidate = { action, actor, createdAt: new Date().toISOString(),
        request: { operationKey,
          expectedRevision: state.getState().snapshot.revision, payload: copy } };
      try { pending = journal.save(candidate); }
      catch (error) {
        phase = 'storage-unavailable';
        throw error;
      }
      return send();
    },
    async retryUnknown() {
      if (phase !== 'unknown' || !pending) {
        throw new TypeError('No unknown command to retry');
      }
      if (state.getState().session?.principalId !== pending.actor) {
        phase = 'foreign';
        throw new HttpApiError('unauthenticated', 401);
      }
      if (!state.isWritable()) await state.reconnect?.();
      if (state.getState().session?.principalId !== pending.actor) {
        phase = 'foreign';
        throw new HttpApiError('unauthenticated', 401);
      }
      if (!state.isWritable()) throw new TypeError('Confirmed server state unavailable');
      return send();
    },
    async refreshKnownResult() {
      if (phase !== 'refresh-needed') {
        throw new TypeError('No confirmed command to refresh');
      }
      return refreshKnownResult();
    }
  });
}
