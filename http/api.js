import { createHttpAuthBoundary, exactKeys, HttpBoundaryError, readJson, sendJson } from './transport.js';
import { sendCommandResult, sendMappedError } from './contract.js';
import { isHttpCommand } from './registry.js';
import { projectStoreSnapshot } from './query.js';

const forbiddenFields = new Set([
  '__proto__', 'constructor', 'prototype',
  'principal', 'principalId', 'user', 'userId', 'role', 'roles',
  'permissions', 'permissionIds', 'capabilities', 'policyAttributes',
  'policyAttributeIds', 'trustedContext', 'actualActorPrincipalId',
  'actor', 'actorId', 'clock', 'dbNow', 'submittedByPrincipalId'
]);

function rejectAuthorityFields(value, depth = 0) {
  if (depth > 32) throw new HttpBoundaryError('invalid_input');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenFields.has(key)) throw new HttpBoundaryError('invalid_input');
    rejectAuthorityFields(child, depth + 1);
  }
}

function commandBody(body) {
  if (!exactKeys(body, ['operationKey', 'expectedRevision', 'payload']) ||
      typeof body.operationKey !== 'string' || !body.operationKey ||
      body.operationKey.length > 120 || body.operationKey.trim() !== body.operationKey ||
      !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
      !body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
    throw new HttpBoundaryError('invalid_input');
  }
  rejectAuthorityFields(body.payload);
  return body;
}

export function createHttpApi(options) {
  if (typeof options?.application?.execute !== 'function' ||
      typeof options?.store?.readInTransaction !== 'function' ||
      typeof options?.sessionReader?.withContext !== 'function') {
    throw new TypeError('Invalid HTTP API composition');
  }
  const auth = createHttpAuthBoundary(options);
  const application = options.application;
  const store = options.store;
  const sessionReader = options.sessionReader;
  return Object.freeze({
    async handle(req, res) {
      let url;
      try { url = new URL(req.url, options.origin); }
      catch { return false; }
      const path = url.pathname;
      if (!path.startsWith('/api/v1/')) return false;
      const requestId = auth.newRequestId();
      try {
        if (await auth.handleAuth(req, res, path, requestId)) return true;
        if (path.startsWith('/api/v1/commands/')) {
          const session = await auth.resolve(req);
          auth.requireCsrf(req, session);
          const match = /^\/api\/v1\/commands\/([A-Za-z][A-Za-z0-9]*)$/.exec(path);
          if (req.method !== 'POST' || url.search || !match || !isHttpCommand(match[1])) {
            throw new HttpBoundaryError('invalid_input');
          }
          const body = commandBody(await readJson(req));
          const result = await application.execute({ action: match[1], ...body }, session.credential);
          sendCommandResult(res, result, requestId);
          return true;
        }
        if (path === '/api/v1/store/snapshot' && req.method === 'GET') {
          const session = await auth.resolve(req);
          if (url.search) throw new HttpBoundaryError('invalid_input');
          const projected = await sessionReader.withContext(session.credential,
            async (context, connection) =>
              projectStoreSnapshot(await store.readInTransaction(connection), context));
          sendJson(res, 200, projected, { 'X-Request-Id': requestId });
          return true;
        }
        throw new HttpBoundaryError('invalid_input');
      } catch (error) {
        sendMappedError(res, requestId, error, auth);
        return true;
      }
    }
  });
}
