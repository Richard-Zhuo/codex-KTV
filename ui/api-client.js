export class HttpApiError extends Error {
  constructor(code, status, requestId = null, result = null) {
    super(code);
    this.name = 'HttpApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.result = result;
  }
}

export class HttpTransportError extends Error {
  constructor(reason, ambiguous = false) {
    super(reason);
    this.name = 'HttpTransportError';
    this.reason = reason;
    this.ambiguous = ambiguous;
  }
}

export function createEmployeeApiClient({
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000
} = {}) {
  if (typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('Invalid employee HTTP client configuration');
  }
  let csrfToken = null;
  let session = null;

  async function request(method, path, body, { csrf = false, signal } = {}) {
    if (csrf && !csrfToken) throw new HttpApiError('csrf_denied', 403);
    const controller = new AbortController();
    let timedOut = false;
    const onCancel = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onCancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let response;
    let data;
    try {
      response = await fetchImpl(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(csrf ? { 'X-CSRF-Token': csrfToken } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      });
      data = await response.json();
    } catch {
      throw new HttpTransportError(
        timedOut ? 'timeout' : signal?.aborted ? 'cancelled' : 'network',
        method === 'POST'
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCancel);
    }
    const requestId = response.headers?.get('x-request-id') ?? null;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new HttpApiError('internal_error', response.status, requestId);
    }
    if (!response.ok) {
      const code = typeof data.error?.code === 'string' ? data.error.code : 'internal_error';
      if (code === 'unauthenticated') {
        session = null;
        csrfToken = null;
      }
      throw new HttpApiError(code, response.status,
        data.error?.requestId ?? requestId, data.result ?? null);
    }
    return data;
  }

  function captureSession(data) {
    if (!data.session || typeof data.session.principalId !== 'string' ||
        !Array.isArray(data.session.permissionIds) ||
        typeof data.csrfToken !== 'string') {
      throw new HttpApiError('internal_error', 200);
    }
    session = Object.freeze({
      principalId: data.session.principalId,
      permissionIds: Object.freeze([...data.session.permissionIds])
    });
    csrfToken = data.csrfToken;
    return session;
  }

  return Object.freeze({
    async login(loginIdentifier, password, options) {
      const data = await request('POST', '/api/v1/auth/login',
        { loginIdentifier, password }, options);
      return captureSession(data);
    },
    async getSession(options) {
      return captureSession(await request('GET', '/api/v1/auth/session',
        undefined, options));
    },
    async logout(options) {
      await request('POST', '/api/v1/auth/logout', undefined,
        { ...options, csrf: true });
      session = null;
      csrfToken = null;
    },
    async getSnapshot(options) {
      const data = await request('GET', '/api/v1/store/snapshot',
        undefined, options);
      if (!Number.isSafeInteger(data.revision) || data.revision < 0 ||
          !data.view || typeof data.view !== 'object' || Array.isArray(data.view)) {
        throw new HttpApiError('internal_error', 200);
      }
      return Object.freeze({ revision: data.revision, view: data.view });
    },
    async executeCommand(action, { operationKey, expectedRevision, payload }, options) {
      if (typeof action !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(action)) {
        throw new HttpApiError('invalid_input', 400);
      }
      return request('POST', '/api/v1/commands/' + action,
        { operationKey, expectedRevision, payload }, { ...options, csrf: true });
    },
    currentSession() { return session; },
    clearSession() { session = null; csrfToken = null; }
  });
}
