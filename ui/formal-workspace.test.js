import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpApiError } from './api-client.js';
import { stateFromServerSnapshot } from './formal-workspace.js';

const session = { principalId: 'server-principal', permissionIds: ['room.clean'] };
const snapshot = workspace => ({ revision: 9, view: { workspace } });

test('employee view uses only the server workspace and principal', () => {
  const state = stateFromServerSnapshot(snapshot({
    serverNow: '2026-10-06T12:00:00.000Z',
    sections: { rooms: true, orders: false, catalog: false },
    rooms: [{ id: 'V01', status: '待清洁' }]
  }), session);
  assert.equal(state.user, 'server-principal');
  assert.equal(state.rooms[0].status, '待清洁');
  assert.deepEqual(state.orders, []);
  assert.equal(Object.hasOwn(state, 'permissions'), false);
  assert.equal(Object.hasOwn(state, 'processed'), false);
  assert.equal(Object.isFrozen(state.rooms[0]), true);
});

test('missing or malformed granted fields fail closed instead of inventing business state', () => {
  for (const workspace of [
    { serverNow: '2026-10-06T12:00:00.000Z', sections: { rooms: true } },
    { serverNow: 'bad time', sections: { rooms: true }, rooms: [] },
    { serverNow: '2026-10-06T12:00:00.000Z',
      sections: { catalog: true }, catalog: { products: [] } }
  ]) {
    assert.throws(() => stateFromServerSnapshot(snapshot(workspace), session),
      error => error instanceof HttpApiError && error.code === 'internal_error');
  }
  assert.equal(stateFromServerSnapshot({ revision: 9, view: {} }, session), null);
});
