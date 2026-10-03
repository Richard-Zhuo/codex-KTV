import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { initialState, transact } from '../rules.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createAuthService } from '../auth/service.js';
import { createMemoryLoginRateLimiter } from '../auth/rate-limit.js';
import { digestSessionToken } from '../auth/session-token.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMySqlLedgerStore } from './mysql-store.js';
import { encodeLedgerSnapshot, decodeLedgerJson } from './mysql-snapshot.js';
import { acquireMySqlFixtureLock } from '../test-support/mysql-fixture-lock.js';

const testUrl = process.env.LEDGER_MYSQL_TEST_URL;
const database = 'jbhh_ktv_test';
const ledgerTables = ['ledger_heads', 'ledger_operations', 'ledger_success_audit'];
const authTables = ['auth_accounts', 'auth_credentials', 'auth_grants', 'auth_sessions', 'auth_events'];
const quote = String.fromCharCode(96);
const table = name => quote + database + quote + '.' + quote + name + quote;
const command = (key, revision = 0, payload = { room: 'V01' }, action = 'clean') =>
  ({ operationKey: key, expectedRevision: revision, action, payload });
const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
const authRequired = error => error.code === 'AUTHENTICATION_REQUIRED';

function assertTestTarget(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'mysql:' || decodeURIComponent(url.pathname.slice(1)) !== database ||
      !url.hostname || raw === process.env.DATABASE_URL) throw Error('clean 测试只允许 jbhh_ktv_test');
}

test('trusted clean fixture refuses an unknown database', () => {
  assert.throws(() => assertTestTarget('mysql://localhost/mysql'), /jbhh_ktv_test/);
  assert.throws(() => assertTestTarget('mysql://localhost/unknown'), /jbhh_ktv_test/);
});

test('MySQL trusted clean vertical slice in jbhh_ktv_test',
  { skip: !testUrl && '未配置 LEDGER_MYSQL_TEST_URL；未取得 clean 真实 MySQL 证据' }, async t => {
    assertTestTarget(testUrl);
    const setup = await mysql.createConnection(testUrl);
    let pool;
    const created = [];
    try {
      const [[target]] = await setup.query('SELECT VERSION() AS version, DATABASE() AS database_name, @@default_storage_engine AS engine');
      assert.match(target.version, /^8\.4\./);
      assert.equal(target.database_name, database);
      assert.equal(target.engine, 'InnoDB');
      t.diagnostic('MySQL ' + target.version + '; database ' + database + '; engine ' + target.engine);
      await acquireMySqlFixtureLock(setup);
      const [existingAuth] = await setup.execute('SELECT table_name FROM information_schema.tables ' +
        'WHERE table_schema = ? AND table_name IN (?, ?, ?, ?, ?)', [database, ...authTables]);
      assert.equal(existingAuth.length, 0, '拒绝删除预存 auth 表');
      // The user explicitly designated these three ledger tables as disposable test tables.
      for (const name of [...ledgerTables].reverse()) await setup.query('DROP TABLE IF EXISTS ' + table(name));
      for (const [file, names] of [['001_mysql_ledger_core.sql', ledgerTables], ['002_mysql_auth_core.sql', authTables]]) {
        const sql = await readFile(new URL('../database/migrations/' + file, import.meta.url), 'utf8');
        const statements = sql.split(/\r?\n/).filter(line => !line.trim().startsWith('--'))
          .join('\n').split(';').map(part => part.trim()).filter(Boolean);
        assert.equal(statements.length, names.length);
        for (let index = 0; index < statements.length; index++) {
          await setup.query(statements[index]); created.push(names[index]);
        }
      }
      const [engines] = await setup.execute('SELECT engine FROM information_schema.tables WHERE table_schema = ? ' +
        'AND table_name IN (?, ?, ?, ?, ?, ?, ?, ?)', [database, ...ledgerTables, ...authTables]);
      assert.equal(engines.length, 8); assert.ok(engines.every(row => row.ENGINE === 'InnoDB' || row.engine === 'InnoDB'));
      const poolOptions = { uri: testUrl, database, connectionLimit: 5, waitForConnections: true,
        supportBigNumbers: true, bigNumberStrings: true };
      pool = mysql.createPool(poolOptions);
      const authStore = createMySqlAuthStore({ pool, database });
      const auth = createAuthService({ store: authStore, rateLimiter: createMemoryLoginRateLimiter() });
      let nextAccount = 0;
      const provision = async (permissions = ['room.clean']) => {
        const loginIdentifier = 'synthetic-clean-' + (++nextAccount);
        const password = 'synthetic-2C2-only-password';
        const { principalId } = await auth.createAccount({ loginIdentifier, password });
        for (const permissionId of permissions) await auth.grantPermission({ principalId, permissionId });
        const login = await auth.login({ loginIdentifier, password }); assert.equal(login.ok, true);
        return { ...login, credential: { tokenDigest: digestSessionToken(login.token) } };
      };
      const seed = async id => {
        const state = initialState();
        state.user = 'unmapped-demo-user'; state.clock = 'invalid-demo-clock';
        state.permissions = { administrator: ['administrator'] };
        state.capabilities = { administrator: ['*'] }; state.administrator = true;
        state.rooms[0].status = state.rooms[1].status = '待清洁';
        state.inventory.bw.count = 0;
        state.orders = [{ id: 'historical-retail', kind: 'retail', room: null,
          sales: [{ productNameSnapshot: 'historical-name', saleOptionNameSnapshot: 'historical-spec',
            pricePerSaleUnitCents: null, baseQuantityPerSaleUnit: 12, totalBaseQuantity: 12 }],
          payments: [{ method: '现金', amount: 100 }, { method: '微信', amount: 200 }] }];
        const snapshot = encodeLedgerSnapshot(state);
        await pool.execute('INSERT INTO ' + table('ledger_heads') +
          ' (ledger_id, revision, state_schema_version, state_json, state_checksum) VALUES (?, 0, ?, ?, ?)',
          [id, state.version, snapshot.json, snapshot.checksum]);
        return state;
      };
      const inspect = async id => {
        const head = await createMySqlLedgerStore({ pool, ledgerId: id, database }).read();
        const [operations] = await pool.execute('SELECT operation_key, actor_principal_id, action, terminal_status, terminal_result FROM ' +
          table('ledger_operations') + ' WHERE ledger_id = ? ORDER BY operation_key', [id]);
        const [audit] = await pool.execute('SELECT operation_key, actor_principal_id, action, before_revision, after_revision FROM ' +
          table('ledger_success_audit') + ' WHERE ledger_id = ? ORDER BY operation_key', [id]);
        return { head, operations: operations.map(row => ({ ...row, terminal_result: decodeLedgerJson(row.terminal_result) })), audit };
      };
      const wrapConnection = (connection, calls, release = true) => ({
        async execute(sql, values) {
          calls.push({ kind: 'sql', sql });
          const result = await connection.execute(sql, values);
          if (sql.includes('AS db_now')) calls.push({ kind: 'db-now', value: result[0][0].db_now });
          return result;
        },
        query: (...args) => connection.query(...args),
        async beginTransaction() { calls.push({ kind: 'begin' }); return connection.beginTransaction(); },
        async commit() { calls.push({ kind: 'commit' }); return connection.commit(); },
        async rollback() { calls.push({ kind: 'rollback' }); return connection.rollback(); },
        release() { if (release) connection.release(); },
        destroy() { connection.destroy(); }
      });
      const application = (id, { connectionPool = pool, bind = authStore.bindSessionRevalidation,
        transactCommand = transact, calls = [] } = {}) => {
        let executions = 0, context;
        const watched = { async getConnection() { return wrapConnection(await connectionPool.getConnection(), calls); } };
        const store = createMySqlLedgerStore({ pool: watched, ledgerId: id, database, bindSessionRevalidation: bind });
        const app = createTrustedLedgerApplication({ store, transactCommand: (...args) => {
          executions++; context = args[4].context; calls.push({ kind: 'transact' });
          return transactCommand(...args);
        } });
        return { app, calls, executions: () => executions, context: () => context };
      };
      const assertUnchanged = async (id, before) => assert.deepEqual(await inspect(id), before);

      await t.test('clean commits session actor, revision and audit; DB locks precede lookup and domain', async () => {
        const login = await provision(); const original = await seed('clean-first');
        const [[activity]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id = ?', [login.sessionId]);
        const run = application('clean-first');
        const result = await run.app.execute(command('first'), login.credential);
        assert.equal(result.status, 'committed'); assert.equal(result.actorId, login.principalId);
        assert.equal(result.revision, 1); assert.equal(run.executions(), 1);
        const sqlAt = (name, extra) => run.calls.findIndex(call => call.kind === 'sql' && call.sql.includes(name) &&
          (extra === 'FOR UPDATE' ? call.sql.includes(extra) : call.sql.startsWith(extra + ' ')));
        const order = [run.calls.findIndex(call => call.kind === 'begin'), sqlAt('ledger_heads', 'FOR UPDATE'),
          sqlAt('auth_accounts', 'FOR UPDATE'), sqlAt('auth_sessions', 'FOR UPDATE'),
          sqlAt('auth_grants', 'FOR UPDATE'), sqlAt('AS db_now', 'SELECT'),
          sqlAt('ledger_operations', 'SELECT'), run.calls.findIndex(call => call.kind === 'transact'),
          sqlAt('ledger_heads', 'UPDATE'), sqlAt('ledger_operations', 'INSERT'),
          sqlAt('ledger_success_audit', 'INSERT'), run.calls.findIndex(call => call.kind === 'commit')];
        assert.ok(order.every(index => index >= 0));
        assert.deepEqual([...order].sort((a, b) => a - b), order);
        assert.equal(run.calls.filter(call => call.kind === 'begin').length, 1);
        assert.equal(run.calls.filter(call => call.kind === 'commit').length, 1);
        assert.equal(run.calls.filter(call => call.kind === 'rollback').length, 0);
        assert.equal(run.calls.filter(call => call.kind === 'db-now').length, 1);
        assert.equal(run.context().dbNow, run.calls.find(call => call.kind === 'db-now').value);
        assert.deepEqual(run.context().permissionIds, ['room.clean']);
        assert.equal(run.context().policyAttributesConfigured, false); assert.equal(run.context().policyAttributeIds, null);
        const actual = await inspect('clean-first');
        original.rooms[0].status = '空闲'; original.processed.push('first');
        assert.deepEqual(actual.head.state, original);
        assert.equal(actual.operations[0].actor_principal_id, login.principalId);
        assert.equal(actual.audit[0].actor_principal_id, login.principalId);
        assert.equal(actual.audit[0].after_revision, '1');
        const [[after]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id = ?', [login.sessionId]);
        assert.deepEqual(after, activity);
      });

      await t.test('forged payload and demo administrator cannot authorize; denied key can later succeed', async () => {
        const login = await provision(['backend.view']); await seed('clean-no-grant');
        const run = application('clean-no-grant'); const before = await inspect('clean-no-grant');
        const forged = { room: 'V01', actorId: 'administrator', principalId: 'forged', permissions: ['*', 'room.clean'],
          role: 'administrator', clock: '1900-01-01' };
        const request = command('denied-key', 0, forged);
        await assert.rejects(run.app.execute(request, login.credential), denied);
        await assertUnchanged('clean-no-grant', before); assert.equal(run.executions(), 0);
        await auth.grantPermission({ principalId: login.principalId, permissionId: 'room.clean' });
        const result = await run.app.execute(request, login.credential);
        assert.equal(result.actorId, login.principalId); assert.equal(result.revision, 1);
        assert.ok(!run.context().permissionIds.includes('*'));
      });

      await t.test('revoke then reconnect replays original terminal; a new key is denied', async () => {
        const login = await provision(); await seed('clean-replay');
        const run = application('clean-replay'); const request = command('original');
        const first = await run.app.execute(request, login.credential);
        await auth.revokePermission({ principalId: login.principalId, permissionId: 'room.clean' });
        const before = await inspect('clean-replay');
        const reconnect = mysql.createPool(poolOptions);
        try {
          const reconnectAuth = createMySqlAuthStore({ pool: reconnect, database });
          const again = application('clean-replay', { connectionPool: reconnect, bind: reconnectAuth.bindSessionRevalidation,
            transactCommand: () => assert.fail('replay must not execute domain') });
          assert.deepEqual(await again.app.execute(request, login.credential), first);
          await assert.rejects(again.app.execute(command('new-key', 1, { room: 'V02' }), login.credential), denied);
          assert.equal(again.executions(), 0);
        } finally { await reconnect.end(); }
        await assertUnchanged('clean-replay', before);
      });

      for (const state of ['disabled', 'revoked', 'idle-expired', 'absolute-expired', 'credential-version']) {
        await t.test(state + ' cannot read an existing terminal operation', async () => {
          const login = await provision(); const id = 'clean-' + state; await seed(id);
          const run = application(id); const request = command('already-done');
          await run.app.execute(request, login.credential);
          const before = await inspect(id);
          if (state === 'disabled') await auth.disableAccount({ principalId: login.principalId });
          else if (state === 'revoked') await auth.logout(login.token);
          else if (state === 'credential-version') await auth.rotateCredential({ principalId: login.principalId, password: 'synthetic-rotated-only' });
          else if (state === 'idle-expired') await pool.execute('UPDATE ' + table('auth_sessions') +
            ' SET idle_expires_at = created_at WHERE session_id = ?', [login.sessionId]);
          else await pool.execute('UPDATE ' + table('auth_sessions') +
            ' SET idle_expires_at = created_at, absolute_expires_at = created_at + INTERVAL 1 MICROSECOND WHERE session_id = ?', [login.sessionId]);
          run.calls.length = 0;
          await assert.rejects(run.app.execute(request, login.credential), authRequired);
          assert.ok(!run.calls.some(call => call.kind === 'sql' && call.sql.includes('ledger_operations')));
          assert.equal(run.executions(), 1); await assertUnchanged(id, before);
        });
      }

      await t.test('different actor, payload or expected revision keeps original conflict behavior', async () => {
        const a = await provision(), b = await provision([]); await seed('clean-conflict');
        const run = application('clean-conflict'); const request = command('key');
        await run.app.execute(request, a.credential);
        await auth.revokePermission({ principalId: a.principalId, permissionId: 'room.clean' });
        const before = await inspect('clean-conflict');
        const actorConflict = await run.app.execute(request, b.credential);
        assert.equal(actorConflict.status, 'idempotency-conflict'); assert.equal(actorConflict.reason, 'actor-mismatch');
        for (const changed of [command('key', 1), command('key', 0, { room: 'V02' })]) {
          const result = await run.app.execute(changed, a.credential);
          assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'request-mismatch');
        }
        assert.equal(run.executions(), 1); await assertUnchanged('clean-conflict', before);
      });

      for (const status of ['revision-conflict', 'business-rejected']) {
        await t.test(status + ' is a persistent terminal without success effects', async () => {
          const login = await provision(); const id = 'clean-' + status; const original = await seed(id);
          const run = application(id);
          const request = status === 'revision-conflict' ? command('terminal', 9) : command('terminal', 0, { room: 'V03' });
          const result = await run.app.execute(request, login.credential); assert.equal(result.status, status);
          const before = await inspect(id);
          assert.deepEqual(before.head.state, original); assert.equal(before.head.revision, 0);
          assert.equal(before.operations.length, 1); assert.equal(before.audit.length, 0);
          await auth.revokePermission({ principalId: login.principalId, permissionId: 'room.clean' });
          assert.deepEqual(await run.app.execute(request, login.credential), result);
          await assertUnchanged(id, before);
        });
      }

      await t.test('no revalidation, fake context and unenabled action fail without demo fallback', async () => {
        const login = await provision(); await seed('clean-closed'); const before = await inspect('clean-closed');
        const missing = createTrustedLedgerApplication({ store: createMySqlLedgerStore({ pool, ledgerId: 'clean-closed', database }) });
        await assert.rejects(missing.execute(command('missing'), login.credential), /revalidation port/);
        const fake = application('clean-closed', { bind: () => ({ revalidateSessionInTransaction: async () =>
          Object.freeze({ mode: 'trusted', principalId: login.principalId, permissionIds: ['room.clean'], dbNow: '2026-10-03T00:00:00.000000Z' }) }) });
        await assert.rejects(fake.app.execute(command('fake'), login.credential), TypeError);
        const run = application('clean-closed');
        await assert.rejects(run.app.execute(command('not-enabled', 0, {}, 'settle'), login.credential), denied);
        assert.equal(fake.executions(), 0); assert.equal(run.executions(), 0); await assertUnchanged('clean-closed', before);
      });

      await t.test('unknown domain error rolls back and does not reserve the operation key', async () => {
        const login = await provision(); await seed('clean-unknown'); const before = await inspect('clean-unknown');
        let fault = true;
        const run = application('clean-unknown', { transactCommand: (...args) => {
          if (fault) { args[0].rooms[0].status = '空闲'; args[0].inventory.bw.count = 999; throw Error('synthetic-unknown'); }
          return transact(...args);
        } });
        await assert.rejects(run.app.execute(command('retry'), login.credential), /synthetic-unknown/);
        await assertUnchanged('clean-unknown', before); fault = false;
        assert.equal((await run.app.execute(command('retry'), login.credential)).status, 'committed');
      });

      await t.test('SQL failure after state and operation writes rolls back the whole trusted command', async () => {
        const login = await provision(); await seed('clean-sql-fault'); const before = await inspect('clean-sql-fault');
        await setup.query('ALTER TABLE ' + table('ledger_success_audit') +
          " ADD CONSTRAINT chk_clean_slice_fault CHECK (ledger_id <> 'clean-sql-fault' OR action <> 'clean')");
        const run = application('clean-sql-fault');
        try {
          await assert.rejects(run.app.execute(command('sql-retry'), login.credential), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
          assert.ok(run.calls.some(call => call.kind === 'sql' && call.sql.includes('ledger_heads') && call.sql.startsWith('UPDATE ')));
          assert.ok(run.calls.some(call => call.kind === 'sql' && call.sql.includes('ledger_operations') && call.sql.includes('INSERT')));
          assert.ok(run.calls.some(call => call.kind === 'rollback')); await assertUnchanged('clean-sql-fault', before);
        } finally { await setup.query('ALTER TABLE ' + table('ledger_success_audit') + ' DROP CHECK chk_clean_slice_fault'); }
        assert.equal((await run.app.execute(command('sql-retry'), login.credential)).status, 'committed');
      });

      await t.test('two real connections preserve revision competition and same-key single execution', async () => {
        const login = await provision(); await seed('clean-race');
        const a = await pool.getConnection(), b = await pool.getConnection();
        try {
          const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id');
          const [[bId]] = await b.query('SELECT CONNECTION_ID() AS id');
          assert.notEqual(aId.id, bId.id, 'requires two independent real MySQL connections');
          await a.query('SET SESSION innodb_lock_wait_timeout = 5'); await b.query('SET SESSION innodb_lock_wait_timeout = 5');
          const aPool = { getConnection: async () => wrapConnection(a, [], false) };
          const bPool = { getConnection: async () => wrapConnection(b, [], false) };
          const first = application('clean-race', { connectionPool: aPool });
          const second = application('clean-race', { connectionPool: bPool });
          const results = await Promise.all([first.app.execute(command('a'), login.credential),
            second.app.execute(command('b', 0, { room: 'V02' }), login.credential)]);
          assert.deepEqual(results.map(result => result.status).sort(), ['committed', 'revision-conflict']);
          const actual = await inspect('clean-race');
          assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 2); assert.equal(actual.audit.length, 1);
          assert.equal(first.executions() + second.executions(), 1);
          await seed('clean-key-race');
          const retryA = application('clean-key-race', { connectionPool: aPool });
          const retryB = application('clean-key-race', { connectionPool: bPool });
          const repeated = await Promise.all([retryA.app.execute(command('one-key'), login.credential),
            retryB.app.execute(command('one-key'), login.credential)]);
          assert.deepEqual(repeated[0], repeated[1]); assert.equal(repeated[0].status, 'committed');
          assert.equal(retryA.executions() + retryB.executions(), 1);
          const saved = await inspect('clean-key-race');
          assert.equal(saved.head.revision, 1); assert.equal(saved.operations.length, 1); assert.equal(saved.audit.length, 1);
          t.diagnostic('two independent CONNECTION_ID values verified; both races completed');
        } finally { try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); } }
      });
    } finally {
      try { if (pool) await pool.end(); }
      finally {
        try { for (const name of created.reverse()) await setup.query('DROP TABLE ' + table(name)); }
        finally { await setup.end(); }
      }
    }
  });
