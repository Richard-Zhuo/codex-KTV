import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { createLedgerApplication } from './application.js';
import { decodeLedgerSnapshot, encodeLedgerSnapshot } from './mysql-snapshot.js';
import { createMySqlLedgerStore, LedgerCommitOutcomeUnknown } from './mysql-store.js';

const ledgerId = 'mysql-unit';
const actorId = 'actor-a';
const dbTime = '2026-09-29 12:34:56.123456';
const retailPayload = () => ({
  items: [{ product: 'bw', spec: 'dozen', count: 1 }],
  payments: [{ method: '微信', amount: 5000 }, { method: '现金', amount: 6800 }]
});
const sale = (operationKey, expectedRevision, payload = retailPayload()) =>
  ({ operationKey, expectedRevision, action: 'retailSale', payload });

function fixture({ failAt = '', bindSessionRevalidation, bindEmployeeResolver } = {}) {
  const state = initialState();
  state.user = 'shaoBoss';
  state.clock = '2026-09-29T20:00:00+08:00';
  state.inventory.bw.count = 24;
  const encoded = encodeLedgerSnapshot(state);
  let committed = {
    head: { ledger_id: ledgerId, revision: 0, state_schema_version: state.version,
      state_json: state, state_checksum: encoded.checksum },
    operations: new Map(), audit: []
  };
  const calls = [];
  let connections = 0;
  let rollbacks = 0;
  let destroyed = 0;
  const pool = {
    async getConnection() {
      connections++;
      let draft = null;
      return {
        async beginTransaction() {
          calls.push('START TRANSACTION');
          draft = structuredClone(committed);
        },
        async execute(sql, values = []) {
          calls.push(sql);
          if (failAt && sql.includes(failAt)) throw Error('simulated SQL failure');
          if (sql.startsWith('SELECT DATE_FORMAT')) return [[{ db_time: dbTime }]];
          if (sql.startsWith('SELECT ledger_id, revision')) {
            return [[structuredClone((draft ?? committed).head)]];
          }
          if (sql.startsWith('SELECT ledger_id, operation_key')) {
            const row = (draft ?? committed).operations.get(values[1]);
            return [row ? [structuredClone(row)] : []];
          }
          if (sql.startsWith('UPDATE ')) {
            const [revision, version, json, checksum, , id, before] = values;
            if (id !== ledgerId || draft.head.revision !== before) return [{ affectedRows: 0 }];
            draft.head = { ledger_id: ledgerId, revision, state_schema_version: version,
              state_json: JSON.parse(json), state_checksum: checksum };
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith('INSERT INTO ') && sql.includes('ledger_operations')) {
            const [id, key, actor, action, fingerprint, expected, observed, status, result, newRevision, completedAt] = values;
            if (draft.operations.has(key)) throw Error('duplicate operation');
            draft.operations.set(key, { ledger_id: id, operation_key: key, actor_principal_id: actor,
              action, fingerprint, fingerprint_version: 1, expected_revision: expected,
              observed_revision: observed, terminal_status: status, terminal_result: JSON.parse(result),
              committed_revision: newRevision, completed_at: completedAt ?? dbTime });
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith('INSERT INTO ') && sql.includes('ledger_success_audit')) {
            draft.audit.push(values);
            return [{ affectedRows: 1 }];
          }
          throw Error('Unexpected SQL in unit fixture: ' + sql);
        },
        async commit() {
          calls.push('COMMIT');
          if (failAt === 'COMMIT') throw Error('simulated COMMIT failure');
          committed = draft;
          draft = null;
        },
        async rollback() {
          calls.push('ROLLBACK');
          rollbacks++;
          draft = null;
        },
        release() { calls.push('release'); },
        destroy() { destroyed++; calls.push('destroy'); }
      };
    }
  };
  const store = createMySqlLedgerStore({ pool, ledgerId, database: 'ledger_unit_test', bindSessionRevalidation, bindEmployeeResolver });
  const app = (actor = actorId, transactCommand = transact) =>
    createLedgerApplication({ store, principal: { id: actor }, transactCommand,
      now: () => '1900-01-01T00:00:00.000Z' });
  return { store, app, calls, data: () => structuredClone(committed),
    connections: () => connections, rollbacks: () => rollbacks, destroyed: () => destroyed };
}

test('snapshot checksum is key-order independent and preserves historical values, null and zero', () => {
  const first = { version: 1, inventory: { a: { count: null }, b: { count: 0 } },
    orders: [{ kind: 'retail', room: null, sales: [{ name: '旧名称', specName: '旧规格',
      pricePerSaleUnitCents: 1234, baseQuantityPerSaleUnit: 12, totalBaseQuantity: 12 }] }] };
  const reordered = { orders: first.orders, inventory: { b: { count: 0 }, a: { count: null } }, version: 1 };
  assert.equal(encodeLedgerSnapshot(first).checksum, encodeLedgerSnapshot(reordered).checksum);
  const restored = decodeLedgerSnapshot(JSON.stringify(reordered), encodeLedgerSnapshot(first).checksum);
  assert.equal(restored.orders[0].room, null);
  assert.equal(restored.inventory.a.count, null);
  assert.equal(restored.inventory.b.count, 0);
  assert.deepEqual(restored.orders[0].sales[0], first.orders[0].sales[0]);
  assert.throws(() => decodeLedgerSnapshot(first, '0'.repeat(64)), /校验和/);
  assert.throws(() => encodeLedgerSnapshot({ value: undefined }), /JSON/);
  assert.throws(() => encodeLedgerSnapshot({ value: new Date() }), /JSON/);
});

test('store rejects implicit or unsafe database configuration', () => {
  assert.throws(() => createMySqlLedgerStore({ ledgerId, database: 'ledger_unit_test' }), /无效/);
  assert.throws(() => createMySqlLedgerStore({ pool: fixture().store, ledgerId, database: 'live;drop' }), /无效/);
});

test('first success persists one snapshot, terminal result and audit using database time', async () => {
  const db = fixture();
  const result = await db.app().execute(sale('first', 0));
  const data = db.data();
  assert.equal(result.status, 'committed');
  assert.equal(result.committedAt, '2026-09-29T12:34:56.123456Z');
  assert.equal(data.head.revision, 1);
  assert.equal(data.operations.size, 1);
  assert.equal(data.audit.length, 1);
  assert.equal(data.head.state_json.orders[0].kind, 'retail');
  assert.equal(data.head.state_json.orders[0].room, null);
  assert.equal(data.head.state_json.orders[0].payments.length, 2);
  assert.equal(data.head.state_json.inventory.bw.count, 12);
  assert.equal(data.head.state_json.inventory.qd.count, null);
  assert.equal(data.head.state_checksum, encodeLedgerSnapshot(data.head.state_json).checksum);
  assert.equal(db.calls.filter(item => item === 'START TRANSACTION').length, 1);
  assert.equal(db.calls.filter(item => item === 'COMMIT').length, 1);
  assert.equal(db.calls.filter(item => typeof item === 'string' && item.includes('FOR UPDATE')).length, 1);
  assert.equal(db.connections(), 1);
});

test('same key reuses terminal; actor and fingerprint conflicts do not rerun business action', async () => {
  const db = fixture();
  const original = await db.app().execute(sale('repeat', 0));
  const before = db.data();
  let reruns = 0;
  const noRerun = () => { reruns++; throw Error('must not rerun'); };
  assert.deepEqual(await db.app(actorId, noRerun).execute(sale('repeat', 0)), original);
  const actorConflict = await db.app('actor-b', noRerun).execute(sale('repeat', 0));
  assert.equal(actorConflict.reason, 'actor-mismatch');
  const changed = retailPayload();
  changed.payments[0].method = '支付宝';
  const fingerprintConflict = await db.app(actorId, noRerun).execute(sale('repeat', 0, changed));
  assert.equal(fingerprintConflict.reason, 'request-mismatch');
  assert.equal(reruns, 0);
  assert.deepEqual(db.data(), before);
  assert.equal(db.connections(), 4);
});

test('revision conflict and business rejection are terminal without revision or audit changes', async () => {
  const db = fixture();
  await db.app().execute(sale('first', 0));
  const stale = await db.app().execute(sale('stale', 0));
  assert.equal(stale.status, 'revision-conflict');
  const bad = retailPayload();
  bad.payments[1].amount = 1;
  const rejected = await db.app().execute(sale('bad', 1, bad));
  assert.equal(rejected.status, 'business-rejected');
  assert.equal(db.data().head.revision, 1);
  assert.equal(db.data().audit.length, 1);
  await db.app().execute(sale('later', 1));
  assert.deepEqual(await db.app().execute(sale('stale', 0)), stale);
  assert.deepEqual(await db.app().execute(sale('bad', 1, bad)), rejected);
});

test('unexpected Error rolls back without occupying the key; repaired command can commit', async () => {
  const db = fixture();
  await assert.rejects(db.app(actorId, () => { throw Error('unexpected fault'); }).execute(sale('same', 0)), /unexpected fault/);
  assert.equal(db.data().head.revision, 0);
  assert.equal(db.data().operations.size, 0);
  assert.equal(db.data().audit.length, 0);
  assert.equal(db.rollbacks(), 1);
  assert.equal((await db.app().execute(sale('same', 0))).status, 'committed');
});

test('SQL failure after state and operation staging rolls back all effects', async () => {
  const db = fixture({ failAt: 'ledger_success_audit' });
  await assert.rejects(db.app().execute(sale('sql-fault', 0)), /simulated SQL failure/);
  assert.equal(db.data().head.revision, 0);
  assert.equal(db.data().head.state_json.orders.length, 0);
  assert.equal(db.data().head.state_json.inventory.bw.count, 24);
  assert.equal(db.data().operations.size, 0);
  assert.equal(db.data().audit.length, 0);
  assert.equal(db.rollbacks(), 1);
});

test('room order uses the same atomic port; null inventory remains uncounted', async () => {
  const db = fixture();
  const command = { operationKey: 'room-open', expectedRevision: 0, action: 'open',
    payload: { room: 'V01', beer: 'bw' } };
  assert.equal((await db.app().execute(command)).status, 'committed');
  const state = db.data().head.state_json;
  assert.equal(state.orders[0].kind, 'room');
  assert.equal(state.orders[0].room, 'V01');
  assert.equal(state.rooms.find(room => room.id === 'V01').order, state.orders[0].id);
  assert.equal(state.inventory.bw.count, 12);
  assert.equal(state.inventory.qd.count, null);
});

test('ambiguous COMMIT destroys its connection and preserves the operation key for lookup', async () => {
  const db = fixture({ failAt: 'COMMIT' });
  await assert.rejects(db.app().execute(sale('uncertain', 0)),
    error => error instanceof LedgerCommitOutcomeUnknown && error.operationKey === 'uncertain');
  assert.equal(db.destroyed(), 1);
  assert.equal(db.data().head.revision, 0);
});

test('optional revalidation capability is bound to ledger connection after head lock', async () => {
  let connection;
  const capability = { async revalidateSessionInTransaction(input) {
    assert.deepEqual(input, { tokenDigest: 'test-only-marker' });
    return { principalId: 'synthetic', policyAttributesConfigured: false };
  } };
  const db = fixture({ bindSessionRevalidation(bound) {
    assert.ok(db.calls.at(-1).includes('ledger_heads') && db.calls.at(-1).endsWith('FOR UPDATE'));
    connection = bound;
    return capability;
  } });
  const result = await db.store.runAtomic(async transaction => {
    assert.equal(transaction.sessionRevalidation, capability);
    assert.equal(typeof connection.execute, 'function');
    return transaction.sessionRevalidation.revalidateSessionInTransaction({ tokenDigest: 'test-only-marker' });
  });
  assert.equal(result.principalId, 'synthetic');
  assert.equal(db.connections(), 1);
  assert.equal(db.rollbacks(), 1);
  assert.equal(db.data().head.revision, 0);
  assert.equal(db.data().operations.size, 0);
  assert.equal(db.data().audit.length, 0);
});

test('invalid optional revalidation capability rolls back ledger without business execution', async () => {
  const db = fixture({ bindSessionRevalidation: () => null });
  await assert.rejects(db.store.runAtomic(() => assert.fail('must not dispatch callback')), /port/);
  assert.equal(db.rollbacks(), 1);
  assert.equal(db.data().head.revision, 0);
});


test('employee resolver capability is bound to the same ledger connection after head lock', async () => {
  let bound;
  const capability = { async resolveCreditedEmployeeInTransaction(input) {
    assert.deepEqual(input, { creditedEmployeeId: 'synthetic-marker' });
    return { employeeId: 'synthetic-marker', displayName: 'Synthetic' };
  } };
  const db = fixture({ bindEmployeeResolver(connection) {
    assert.ok(db.calls.at(-1).includes('ledger_heads') && db.calls.at(-1).endsWith('FOR UPDATE'));
    bound = connection; return capability;
  } });
  const result = await db.store.runAtomic(tx => {
    assert.equal(tx.employeeResolver, capability); assert.equal(typeof bound.execute, 'function');
    return tx.employeeResolver.resolveCreditedEmployeeInTransaction({ creditedEmployeeId: 'synthetic-marker' });
  });
  assert.equal(result.displayName, 'Synthetic'); assert.equal(db.connections(), 1);
  assert.equal(db.rollbacks(), 1); assert.equal(db.data().head.revision, 0);
  assert.equal(db.data().operations.size, 0); assert.equal(db.data().audit.length, 0);
});

test('invalid employee resolver binding fails closed and rolls back without dispatch', async () => {
  const db = fixture({ bindEmployeeResolver: () => null });
  await assert.rejects(db.store.runAtomic(() => assert.fail('no work allowed')), TypeError);
  assert.equal(db.rollbacks(), 1); assert.equal(db.data().head.revision, 0);
  assert.equal(db.data().operations.size, 0); assert.equal(db.data().audit.length, 0);
  assert.throws(() => createMySqlLedgerStore({ pool: {getConnection() {}}, ledgerId, database:'ledger_unit_test', bindEmployeeResolver: true }), TypeError);
});
