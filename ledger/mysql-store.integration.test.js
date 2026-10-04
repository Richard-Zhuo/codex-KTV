import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { acquireMySqlFixtureLock } from '../test-support/mysql-fixture-lock.js';
import { initialState, transact } from '../rules.js';
import { createLedgerApplication } from './application.js';
import { encodeLedgerSnapshot } from './mysql-snapshot.js';
import { createMySqlLedgerStore } from './mysql-store.js';
import { testRoundingLimit } from './rounding-limit.integration.js';

const testUrl = process.env.LEDGER_MYSQL_TEST_URL;
const database = 'jbhh_ktv_test';
const ledgerTablesInDropOrder = ['ledger_success_audit', 'ledger_operations', 'ledger_heads'];
const payload = () => ({ items: [{ product: 'bw', spec: 'dozen', count: 1 }],
  payments: [{ method: '微信', amount: 5000 }, { method: '现金', amount: 6800 }] });
const sale = (key, expectedRevision, body = payload()) =>
  ({ operationKey: key, expectedRevision, action: 'retailSale', payload: body });

function assertDedicatedTestTarget(raw) {
  const url = new URL(raw);
  const namedDatabase = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== 'mysql:' || namedDatabase !== database ||
      raw === process.env.DATABASE_URL || !url.hostname) {
    throw Error('LEDGER_MYSQL_TEST_URL 必须明确指向 jbhh_ktv_test');
  }
}

test('MySQL integration target guard rejects any other database', () => {
  assert.throws(() => assertDedicatedTestTarget('mysql://localhost/ledger_test_other'), /jbhh_ktv_test/);
  assert.throws(() => assertDedicatedTestTarget('mysql://localhost/mysql'), /jbhh_ktv_test/);
});

test('MySQL 8.4 InnoDB ledger integration in jbhh_ktv_test',
  { skip: !testUrl && '未配置 LEDGER_MYSQL_TEST_URL；未取得真实 MySQL 集成证据' },
  async t => {
    assertDedicatedTestTarget(testUrl);
    const quote = String.fromCharCode(96);
    const qualified = name => quote + database + quote + '.' + quote + name + quote;
    const setupConnection = await mysql.createConnection(testUrl);
    const dropLedgerTables = async () => {
      for (const name of ledgerTablesInDropOrder) {
        await setupConnection.query('DROP TABLE IF EXISTS ' + qualified(name));
      }
    };
    let verifiedTarget = false;
    let pool = null;
    try {
      const [[target]] = await setupConnection.query(
        'SELECT DATABASE() AS database_name, VERSION() AS version, @@default_storage_engine AS default_engine');
      assert.equal(target.database_name, database, '实际连接必须位于专用账本测试数据库');
      assert.match(target.version, /^8\.4\./, '必须使用 MySQL 8.4 LTS');
      assert.equal(target.default_engine.toLowerCase(), 'innodb', '默认存储引擎必须是 InnoDB');
      await acquireMySqlFixtureLock(setupConnection);
      verifiedTarget = true;
      t.diagnostic(`MySQL ${target.version}; database ${target.database_name}; default engine ${target.default_engine}`);
      await dropLedgerTables();
      const poolOptions = { uri: testUrl, database, waitForConnections: true,
        connectionLimit: 5, supportBigNumbers: true, bigNumberStrings: true };
      pool = mysql.createPool(poolOptions);
      const [[poolTarget]] = await pool.query('SELECT DATABASE() AS database_name');
      assert.equal(poolTarget.database_name, database, '账本连接池必须位于专用账本测试数据库');
      const migration = await readFile(new URL('../database/migrations/001_mysql_ledger_core.sql', import.meta.url), 'utf8');
      const statements = migration.split(/\r?\n/).filter(line => !line.trim().startsWith('--'))
        .join('\n').split(';').map(part => part.trim()).filter(Boolean);
      assert.equal(statements.length, 3);
      for (const statement of statements) await setupConnection.query(statement);
      const [engines] = await pool.query(
        'SELECT table_name AS table_name, engine AS engine FROM information_schema.tables WHERE table_schema = ? AND table_name IN (?, ?, ?)',
        [database, 'ledger_heads', 'ledger_operations', 'ledger_success_audit']);
      assert.equal(engines.length, 3);
      assert.ok(engines.every(row => row.engine === 'InnoDB'));
      await assert.rejects(pool.query(statements[0]), error => error.code === 'ER_TABLE_EXISTS_ERROR');

      const seed = async (id, prepareState = () => {}) => {
        const state = initialState();
        state.user = 'shaoBoss';
        state.clock = '2026-09-29T20:00:00+08:00';
        state.inventory.bw.count = 24;
        prepareState(state);
        const encoded = encodeLedgerSnapshot(state);
        await pool.execute('INSERT INTO ' + qualified('ledger_heads') +
          ' (ledger_id, revision, state_schema_version, state_json, state_checksum) VALUES (?, 0, ?, ?, ?)',
        [id, state.version, encoded.json, encoded.checksum]);
        return state;
      };
      const app = (id, actor = 'actor-a', connectionPool = pool, transactCommand = transact) =>
        createLedgerApplication({ store: createMySqlLedgerStore({ pool: connectionPool, ledgerId: id, database }),
          principal: { id: actor }, transactCommand, now: () => '1900-01-01T00:00:00.000Z' });
      const inspect = async id => {
        const store = createMySqlLedgerStore({ pool, ledgerId: id, database });
        const head = await store.read();
        const [operations] = await pool.execute('SELECT operation_key, actor_principal_id, terminal_status, terminal_result, committed_revision FROM ' +
          qualified('ledger_operations') + ' WHERE ledger_id = ? ORDER BY operation_key', [id]);
        const [audit] = await pool.execute('SELECT operation_key, actor_principal_id, before_revision, after_revision FROM ' +
          qualified('ledger_success_audit') + ' WHERE ledger_id = ? ORDER BY operation_key', [id]);
        return { head, operations, audit };
      };

      await t.test('first commit persists state, result, audit, checksum and historical sale snapshots', async () => {
        const seeded = await seed('retail');
        const expectedSale = transact(seeded, 'retailSale', payload(), 'retail-1').orders[0].sales[0];
        const result = await app('retail').execute(sale('retail-1', 0));
        const actual = await inspect('retail');
        assert.equal(result.status, 'committed');
        assert.notEqual(result.committedAt, '1900-01-01T00:00:00.000Z');
        assert.equal(actual.head.revision, 1);
        assert.equal(actual.operations.length, 1);
        assert.equal(Number(actual.operations[0].committed_revision), 1);
        assert.equal(actual.audit.length, 1);
        assert.equal(actual.head.state.orders[0].kind, 'retail');
        assert.equal(actual.head.state.orders[0].room, null);
        assert.equal(actual.head.state.orders[0].payments.length, 2);
        assert.equal(actual.head.state.inventory.bw.count, 12);
        assert.equal(actual.head.state.inventory.qd.count, null);
        for (const field of ['productNameSnapshot', 'saleOptionNameSnapshot', 'pricePerSaleUnitCents',
          'baseQuantityPerSaleUnit', 'totalBaseQuantity']) {
          assert.equal(actual.head.state.orders[0].sales[0][field], expectedSale[field]);
        }
      });

      await t.test('new connection and same key return original result without payment or stock duplication', async () => {
        const before = await inspect('retail');
        const freshPool = mysql.createPool({ uri: testUrl, database, connectionLimit: 1 });
        try {
          const retry = await app('retail', 'actor-a', freshPool,
            () => { throw Error('transact must not rerun'); }).execute(sale('retail-1', 0));
          assert.deepEqual(retry, before.operations[0].terminal_result);
          assert.deepEqual(await inspect('retail'), before);
        } finally { await freshPool.end(); }
      });

      await t.test('actor and fingerprint conflicts do not disclose or alter the saved result', async () => {
        const before = await inspect('retail');
        const actorConflict = await app('retail', 'actor-b').execute(sale('retail-1', 0));
        assert.equal(actorConflict.status, 'idempotency-conflict');
        assert.equal(actorConflict.reason, 'actor-mismatch');
        const changed = payload();
        changed.payments[0].method = '支付宝';
        const fingerprintConflict = await app('retail').execute(sale('retail-1', 0, changed));
        assert.equal(fingerprintConflict.reason, 'request-mismatch');
        assert.deepEqual(await inspect('retail'), before);
      });

      await t.test('stale revision and business rejection persist terminal operations only', async () => {
        await seed('rejected');
        await app('rejected').execute(sale('first', 0));
        const stale = await app('rejected').execute(sale('stale', 0));
        assert.equal(stale.status, 'revision-conflict');
        const bad = payload();
        bad.payments[1].amount = 1;
        const rejected = await app('rejected').execute(sale('bad', 1, bad));
        assert.equal(rejected.status, 'business-rejected');
        const before = await inspect('rejected');
        assert.equal(before.head.revision, 1);
        assert.equal(before.operations.length, 3);
        assert.equal(before.audit.length, 1);
        await app('rejected').execute(sale('later', 1));
        assert.deepEqual(await app('rejected').execute(sale('stale', 0)), stale);
        assert.deepEqual(await app('rejected').execute(sale('bad', 1, bad)), rejected);
      });

      await t.test('unknown ordinary Error rolls back and leaves the same key available', async () => {
        await seed('unknown');
        await assert.rejects(app('unknown', 'actor-a', pool,
          () => { throw Error('unexpected fault'); }).execute(sale('same-key', 0)), /unexpected fault/);
        const before = await inspect('unknown');
        assert.equal(before.head.revision, 0);
        assert.equal(before.head.state.orders.length, 0);
        assert.equal(before.operations.length, 0);
        assert.equal(before.audit.length, 0);
        assert.equal((await app('unknown').execute(sale('same-key', 0))).status, 'committed');
      });

      await t.test('SQL failure after state and operation writes rolls everything back', async () => {
        await seed('sql-failure');
        await pool.query('ALTER TABLE ' + qualified('ledger_success_audit') +
          " ADD CONSTRAINT chk_test_reject_actor CHECK (actor_principal_id <> 'actor-sql-fail')");
        await assert.rejects(app('sql-failure', 'actor-sql-fail').execute(sale('sql-fault', 0)));
        const actual = await inspect('sql-failure');
        assert.equal(actual.head.revision, 0);
        assert.equal(actual.head.state.orders.length, 0);
        assert.equal(actual.head.state.inventory.bw.count, 24);
        assert.equal(actual.operations.length, 0);
        assert.equal(actual.audit.length, 0);
      });

      await t.test('two independent connections can initialize one ledger head only once', async () => {
        const first = await mysql.createConnection(testUrl);
        const second = await mysql.createConnection(testUrl);
        try {
          const [[[firstId]], [[secondId]]] = await Promise.all([
            first.query('SELECT CONNECTION_ID() AS id'),
            second.query('SELECT CONNECTION_ID() AS id')
          ]);
          assert.notEqual(firstId.id, secondId.id);
          const initialize = async (connection, clock) => {
            const state = initialState();
            state.clock = clock;
            const encoded = encodeLedgerSnapshot(state);
            await connection.beginTransaction();
            try {
              await connection.execute('INSERT INTO ' + qualified('ledger_heads') +
                ' (ledger_id, revision, state_schema_version, state_json, state_checksum) VALUES (?, 0, ?, ?, ?)',
              ['initialization-race', state.version, encoded.json, encoded.checksum]);
              await connection.commit();
              return clock;
            } catch (error) {
              await connection.rollback();
              throw error;
            }
          };
          const outcomes = await Promise.allSettled([
            initialize(first, '2026-09-29T20:00:00+08:00'),
            initialize(second, '2026-09-29T21:00:00+08:00')
          ]);
          assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
          assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1);
          assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.code, 'ER_DUP_ENTRY');
          const actual = await inspect('initialization-race');
          assert.equal(actual.head.revision, 0);
          assert.equal(actual.head.state.clock, outcomes.find(outcome => outcome.status === 'fulfilled').value);
          assert.equal(actual.operations.length, 0);
          assert.equal(actual.audit.length, 0);
        } finally { await first.end(); await second.end(); }
      });

      await t.test('two independent InnoDB connections competing on one revision yield one success', async () => {
        await seed('race');
        const a = mysql.createPool({ uri: testUrl, database, connectionLimit: 1 });
        const b = mysql.createPool({ uri: testUrl, database, connectionLimit: 1 });
        try {
          const [[aRow]] = await a.query('SELECT CONNECTION_ID() AS connection_id');
          const [[bRow]] = await b.query('SELECT CONNECTION_ID() AS connection_id');
          assert.notEqual(aRow.connection_id, bRow.connection_id);
          const outcomes = await Promise.all([
            app('race', 'actor-a', a).execute(sale('race-a', 0)),
            app('race', 'actor-b', b).execute(sale('race-b', 0))
          ]);
          assert.deepEqual(outcomes.map(item => item.status).sort(), ['committed', 'revision-conflict']);
          const actual = await inspect('race');
          assert.equal(actual.head.revision, 1);
          assert.equal(actual.operations.length, 2);
          assert.equal(actual.audit.length, 1);
          assert.equal(actual.head.state.orders.length, 1);
          assert.equal(actual.head.state.inventory.bw.count, 12);
        } finally { await a.end(); await b.end(); }
      });

      await t.test('room order, room state, stock and revision commit together; zero differs from null', async () => {
        await seed('room');
        const opened = await app('room').execute({ operationKey: 'room-open', expectedRevision: 0,
          action: 'open', payload: { room: 'V01', beer: 'bw' } });
        assert.equal(opened.status, 'committed');
        const actual = await inspect('room');
        assert.equal(actual.head.revision, 1);
        assert.equal(actual.audit.length, 1);
        assert.equal(actual.head.state.orders[0].kind, 'room');
        assert.equal(actual.head.state.orders[0].room, 'V01');
        assert.equal(actual.head.state.rooms.find(room => room.id === 'V01').order,
          actual.head.state.orders[0].id);
        assert.equal(actual.head.state.inventory.bw.count, 12);
        await seed('zero');
        await app('zero').execute(sale('zero-1', 0));
        await app('zero').execute(sale('zero-2', 1));
        const zero = await inspect('zero');
        assert.equal(zero.head.state.inventory.bw.count, 0);
        assert.equal(zero.head.state.inventory.qd.count, null);
      });

      await testRoundingLimit(t, { seed, app, inspect, pool, qualified });
    } finally {
      try { if (pool) await pool.end(); }
      finally {
        try {
          if (verifiedTarget) await dropLedgerTables();
        } finally { await setupConnection.end(); }
      }
    }
  });
