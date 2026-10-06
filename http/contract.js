import { AuthorizationDenied } from '../shared/identity.js';
import { SessionAuthenticationRequired } from '../ledger/trusted-execution.js';
import { HTTP_STATUS, HttpBoundaryError, sendError, sendJson } from './transport.js';

const terminalCodes = Object.freeze({
  'business-rejected': 'business_rejection',
  'revision-conflict': 'revision_conflict',
  'idempotency-conflict': 'idempotency_conflict'
});

export function sendCommandResult(res, result, requestId) {
  if (result?.status === 'committed') {
    sendJson(res, 200, { result }, { 'X-Request-Id': requestId });
    return;
  }
  const code = terminalCodes[result?.status];
  if (!code) throw new Error('Unknown trusted command result');
  sendJson(res, HTTP_STATUS[code], {
    error: { code, message: code, requestId }, result
  }, { 'X-Request-Id': requestId });
}

export function mappedError(error) {
  if (error instanceof HttpBoundaryError) return error.code;
  if (error instanceof SessionAuthenticationRequired) return 'unauthenticated';
  if (error instanceof AuthorizationDenied) return 'authorization_denied';
  return null;
}

export function sendMappedError(res, requestId, error, authBoundary) {
  const code = mappedError(error);
  if (code) sendError(res, code, requestId);
  else authBoundary.handleError(res, requestId, error);
}
