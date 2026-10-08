import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { digestSessionToken } from '../auth/session-token.js';

const COOKIE = 'jbhh_session';
const MAX_BODY = 16 * 1024;
const csrfPattern = /^[A-Za-z0-9_-]{43}$/;

export class HttpBoundaryError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export const HTTP_STATUS = Object.freeze({
  unauthenticated: 401, authorization_denied: 403, csrf_denied: 403,
  business_rejection: 422, revision_conflict: 409, idempotency_conflict: 409,
  invalid_input: 400, internal_error: 500, payload_too_large:413, rate_limited:429
});

export function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(value));
}

export function sendError(res, code, requestId, headers = {}) {
  sendJson(res, HTTP_STATUS[code] ?? 500, { error: { code, message: code, requestId } },
    { 'X-Request-Id': requestId, ...headers });
}

export function logInternal(logger, requestId, error) {
  // No headers, request body, SQL text/values, tokens, passwords or raw Error properties.
  logger.error({ requestId, name: error?.name ?? 'Error', code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : null,
    frames: typeof error?.stack === 'string'
      ? error.stack.split('\n').filter(line => /^\s*at /.test(line)).slice(0, 6).map(line => line.trim()) : [] });
}

export async function readJson(req, maxBody = MAX_BODY) {
  if (!Number.isSafeInteger(maxBody) || maxBody < 1 || maxBody > 1024 * 1024) {
    throw new TypeError('Invalid HTTP JSON body limit');
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpBoundaryError('invalid_input');
  }
  const declared = Number(req.headers['content-length']);
  if (req.headers['content-length'] !== undefined &&
      (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBody)) {
    throw new HttpBoundaryError(req.ktvProduction&&declared>maxBody?'payload_too_large':'invalid_input');
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBody) throw new HttpBoundaryError(req.ktvProduction?'payload_too_large':'invalid_input');
      chunks.push(chunk);
    }
    if (!size) throw new HttpBoundaryError('invalid_input');
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpBoundaryError('invalid_input');
    }
    return parsed;
  } catch (error) {
    if (error instanceof HttpBoundaryError) throw error;
    if (error instanceof SyntaxError) throw new HttpBoundaryError('invalid_input');
    throw error;
  }
}

export function exactKeys(value, keys) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function cookieToken(req) {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > 8192) return null;
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(COOKIE + '='));
  if (values.length !== 1) return null;
  const token = values[0].slice(COOKIE.length + 1);
  return digestSessionToken(token) ? token : null;
}

function csrfToken(token) {
  return createHmac('sha256', token).update('jbhh-ktv-csrf-v1').digest('base64url');
}

export function createHttpAuthBoundary({
  authService, origin, environment = 'production', allowInsecureCookie = false, logger = console, loginGate
}) {
  if (typeof authService?.login !== 'function' ||
      typeof authService?.authenticateSession !== 'function' ||
      typeof authService?.logout !== 'function' || typeof logger?.error !== 'function' ||
      !['production', 'development'].includes(environment) || typeof origin !== 'string' || !origin) {
    throw new TypeError('Invalid HTTP auth configuration');
  }
  const parsedOrigin = new URL(origin);
  const insecure = environment === 'development' && allowInsecureCookie === true;
  if (parsedOrigin.origin !== origin || parsedOrigin.username || parsedOrigin.password ||
      (insecure ? !['http:', 'https:'].includes(parsedOrigin.protocol) : parsedOrigin.protocol !== 'https:') ||
      (allowInsecureCookie && environment !== 'development') ||
      (insecure && !['localhost', '127.0.0.1', '[::1]'].includes(parsedOrigin.hostname))) {
    throw new TypeError('Unsafe HTTP origin or cookie configuration');
  }
  const cookieAttributes = 'Path=/; HttpOnly; SameSite=Strict' + (insecure ? '' : '; Secure');
  const sessionCookie = token => COOKIE + '=' + token + '; ' + cookieAttributes;
  const clearCookie = COOKIE + '=; Max-Age=0; ' + cookieAttributes;

  function requireSameOrigin(req) {
    if (req.headers.origin !== origin ||
        (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
      throw new HttpBoundaryError('csrf_denied');
    }
  }

  async function resolve(req) {
    const token = cookieToken(req);
    if (!token) throw new HttpBoundaryError('unauthenticated');
    const session = await authService.authenticateSession(token);
    if (!session) throw new HttpBoundaryError('unauthenticated');
    return { token, credential: { tokenDigest: digestSessionToken(token) },
      principalId: session.id, permissionIds: session.permissionIds,
      csrfToken: csrfToken(token) };
  }

  function requireCsrf(req, resolved) {
    requireSameOrigin(req);
    const supplied = req.headers['x-csrf-token'];
    if (typeof supplied !== 'string' || !csrfPattern.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(resolved.csrfToken))) {
      throw new HttpBoundaryError('csrf_denied');
    }
  }

  async function handleAuth(req, res, path, requestId) {
    if (path === '/api/v1/auth/login' && req.method === 'POST') {
      requireSameOrigin(req);
      const body = await readJson(req);
      if (!exactKeys(body, ['loginIdentifier', 'password']) ||
          typeof body.loginIdentifier !== 'string' || !body.loginIdentifier ||
          body.loginIdentifier !== body.loginIdentifier.trim() || body.loginIdentifier.length > 191 ||
          /[\u0000-\u001f\u007f]/.test(body.loginIdentifier) ||
          typeof body.password !== 'string' || !body.password ||
          Buffer.byteLength(body.password, 'utf8') > 1024) {
        throw new HttpBoundaryError('invalid_input');
      }
      if(loginGate&&!loginGate(req,body.loginIdentifier))throw new HttpBoundaryError('rate_limited');
      const result = await authService.login(body);
      if (!result.ok) throw new HttpBoundaryError('unauthenticated');
      const session = await authService.authenticateSession(result.token);
      if (!session) throw new HttpBoundaryError('unauthenticated');
      sendJson(res, 200, { session: { principalId: session.id,
        permissionIds: session.permissionIds }, csrfToken: csrfToken(result.token) },
      { 'Set-Cookie': sessionCookie(result.token), 'X-Request-Id': requestId });
      return true;
    }
    if (path === '/api/v1/auth/session' && req.method === 'GET') {
      const session = await resolve(req);
      sendJson(res, 200, { session: { principalId: session.principalId,
        permissionIds: session.permissionIds }, csrfToken: session.csrfToken },
      { 'X-Request-Id': requestId });
      return true;
    }
    if (path === '/api/v1/auth/logout' && req.method === 'POST') {
      const session = await resolve(req);
      requireCsrf(req, session);
      await authService.logout(session.token);
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie, 'X-Request-Id': requestId });
      return true;
    }
    return false;
  }

  return Object.freeze({ handleAuth, resolve, requireCsrf, newRequestId: randomUUID,
    handleError(res, requestId, error) {
      if (error instanceof HttpBoundaryError) sendError(res, error.code, requestId);
      else { logInternal(logger, requestId, error); sendError(res, 'internal_error', requestId); }
    } });
}
