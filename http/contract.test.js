import test from 'node:test';
import assert from 'node:assert/strict';
import { FORMAL_COMMAND_ACTIONS, DEMO_ONLY_ACTIONS } from '../ledger/command-policy.js';
import { TRUSTED_ENABLED_ACTIONS } from '../ledger/trusted-execution.js';
import { HTTP_COMMAND_ACTIONS, isHttpCommand } from './registry.js';
import { HTTP_STATUS } from './transport.js';
import { sendCommandResult } from './contract.js';
import { createHttpApi } from './api.js';

test('HTTP registry exposes only explicit policy-defined trusted-enabled actions', () => {
  assert.equal(new Set(HTTP_COMMAND_ACTIONS).size, HTTP_COMMAND_ACTIONS.length);
  for (const action of HTTP_COMMAND_ACTIONS) {
    assert.ok(FORMAL_COMMAND_ACTIONS.includes(action));
    assert.ok(TRUSTED_ENABLED_ACTIONS.includes(action));
    assert.equal(isHttpCommand(action), true);
  }
  for (const action of [...DEMO_ONLY_ACTIONS, 'unregistered', 'toString',
    '__proto__', 'constructor']) assert.equal(isHttpCommand(action), false);
});

test('HTTP API composition fails at startup when any trusted handler is missing', () => {
  const base = {
    authService: { login() {}, authenticateSession() {}, logout() {} },
    origin: 'https://ktv.example',
    application: { execute() {} },
    store: { readInTransaction() {} },
    sessionReader: { withContext() {} }
  };
  assert.doesNotThrow(() => createHttpApi(base));
  for (const [key, value] of [
    ['application', {}], ['store', {}], ['sessionReader', {}]
  ]) {
    assert.throws(() => createHttpApi({ ...base, [key]: value }),
      /Invalid HTTP API composition/);
  }
});

test('stable machine-readable HTTP status map distinguishes boundary failures', () => {
  assert.deepEqual(HTTP_STATUS, {
    unauthenticated: 401,
    authorization_denied: 403,
    csrf_denied: 403,
    business_rejection: 422,
    revision_conflict: 409,
    idempotency_conflict: 409,
    invalid_input: 400,
    internal_error: 500
  });
});

test('trusted command terminals share one response contract', () => {
  const capture = result => {
    const response = { writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { this.body = JSON.parse(body); } };
    sendCommandResult(response, result, 'request-1');
    return response;
  };
  assert.equal(capture({ status: 'committed' }).status, 200);
  for (const [status, code, httpStatus] of [
    ['business-rejected', 'business_rejection', 422],
    ['revision-conflict', 'revision_conflict', 409],
    ['idempotency-conflict', 'idempotency_conflict', 409]
  ]) {
    const response = capture({ status });
    assert.equal(response.status, httpStatus);
    assert.equal(response.body.error.code, code);
    assert.equal(response.body.error.requestId, 'request-1');
  }
});
