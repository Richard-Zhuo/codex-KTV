import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { HttpBoundaryError, readJson } from './transport.js';

function request(value, declared = true) {
  const bytes = Buffer.from(JSON.stringify(value));
  const req = Readable.from([bytes]);
  req.headers = { 'content-type': 'application/json' };
  if (declared) req.headers['content-length'] = String(bytes.length);
  return req;
}

test('auth JSON keeps the small default limit while bounded command evidence fits', async () => {
  const evidence = { proof: 'x'.repeat(500 * 1024) };
  await assert.rejects(readJson(request(evidence)), error =>
    error instanceof HttpBoundaryError && error.code === 'invalid_input');
  const accepted = await readJson(request(evidence), 1024 * 1024);
  assert.equal(accepted.proof.length, 500 * 1024);
});

test('oversized command JSON is rejected with and without declared length', async () => {
  const tooLarge = { proof: 'x'.repeat(1024 * 1024) };
  for (const declared of [true, false]) {
    await assert.rejects(readJson(request(tooLarge, declared), 1024 * 1024), error =>
      error instanceof HttpBoundaryError && error.code === 'invalid_input');
  }
  await assert.rejects(readJson(request({}), 1024 * 1024 + 1), TypeError);
});
