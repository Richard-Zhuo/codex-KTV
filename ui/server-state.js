import { HttpApiError } from './api-client.js';

export function createEmployeeServerState(api) {
  if (typeof api?.getSession !== 'function' ||
      typeof api?.getSnapshot !== 'function' ||
      typeof api?.login !== 'function' ||
      typeof api?.logout !== 'function') {
    throw new TypeError('Invalid employee session state');
  }
  const listeners = new Set();
  let value = Object.freeze({
    phase: 'loading', session: null, snapshot: null, stale: false, error: null
  });
  let generation = 0;

  function update(next) {
    value = Object.freeze({ ...value, ...next });
    for (const listener of listeners) listener(value);
    return value;
  }
  function unauthenticated() {
    api.clearSession?.();
    return update({ phase: 'login', session: null, snapshot: null,
      stale: false, error: null });
  }
  function failed(error, previous) {
    if (error instanceof HttpApiError && error.code === 'unauthenticated') {
      return unauthenticated();
    }
    return update({ phase: 'unavailable', session: previous.session,
      snapshot: previous.snapshot, stale: !!previous.snapshot, error });
  }

  async function loadCurrent() {
    const turn = ++generation;
    const previous = value;
    update({ phase: 'loading', error: null });
    try {
      const session = await api.getSession();
      const snapshot = await api.getSnapshot();
      if (turn !== generation) return value;
      return update({ phase: 'ready', session, snapshot, stale: false, error: null });
    } catch (error) {
      if (turn !== generation) return value;
      return failed(error, previous);
    }
  }

  return Object.freeze({
    getState() { return value; },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Listener required');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bootstrap: loadCurrent,
    reconnect: loadCurrent,
    async login(loginIdentifier, password) {
      const turn = ++generation;
      update({ phase: 'loading', session: null, snapshot: null,
        stale: false, error: null });
      try {
        await api.login(loginIdentifier, password);
        const session = await api.getSession();
        const snapshot = await api.getSnapshot();
        if (turn !== generation) return value;
        return update({ phase: 'ready', session, snapshot, stale: false, error: null });
      } catch (error) {
        if (turn !== generation) return value;
        if (error instanceof HttpApiError && error.code === 'unauthenticated') {
          api.clearSession?.();
          return update({ phase: 'login', session: null, snapshot: null,
            stale: false, error });
        }
        return failed(error, { session: null, snapshot: null });
      }
    },
    async logout() {
      const turn = ++generation;
      const previous = value;
      update({ phase: 'loading', error: null });
      try {
        await api.logout();
        if (turn !== generation) return value;
        return unauthenticated();
      } catch (error) {
        if (turn !== generation) return value;
        return failed(error, previous);
      }
    },
    async refreshSnapshot() {
      const turn = ++generation;
      const previous = value;
      if (!previous.session) return loadCurrent();
      update({ phase: 'loading', error: null });
      try {
        const snapshot = await api.getSnapshot();
        if (turn !== generation) return value;
        return update({ phase: 'ready', snapshot, stale: false, error: null });
      } catch (error) {
        if (turn !== generation) return value;
        return failed(error, previous);
      }
    },
    clearForUnauthenticated: unauthenticated,
    isWritable() { return value.phase === 'ready' && !!value.session &&
      !!value.snapshot && !value.stale; }
  });
}
