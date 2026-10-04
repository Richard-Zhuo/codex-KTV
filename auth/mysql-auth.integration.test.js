import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { acquireMySqlFixtureLock } from '../test-support/mysql-fixture-lock.js';
import { createMySqlAuthStore } from './mysql-store.js';
import { createAuthService } from './service.js';
import { createMemoryLoginRateLimiter } from './rate-limit.js';
import { digestSessionToken } from './session-token.js';
import { verifyPolicyAttributes } from './policy-attributes.integration.js';
import { verifySessionRevalidation } from './session-revalidation.integration.js';
import { applyPolicyAttributeMigration, policyAttributeTables } from '../test-support/mysql-policy-attributes-fixture.js';

const testUrl = process.env.AUTH_MYSQL_TEST_URL || process.env.LEDGER_MYSQL_TEST_URL;
const database = 'jbhh_ktv_test';
const tables = ['auth_accounts', 'auth_credentials', 'auth_grants', 'auth_sessions', 'auth_events'];
const allTables = [...tables, ...policyAttributeTables];
const password = 'synthetic-password-2B-only';
const quote = String.fromCharCode(96);
const qualified = name => quote + database + quote + '.' + quote + name + quote;

function assertDedicatedTestTarget(raw) {
  const url = new URL(raw);
  const namedDatabase = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== 'mysql:' || namedDatabase !== database || !url.hostname ||
      raw === process.env.DATABASE_URL) {
    throw Error('auth 测试 URL 必须明确指向 jbhh_ktv_test');
  }
}

test('auth MySQL target guard refuses any other database', () => {
  assert.throws(() => assertDedicatedTestTarget('mysql://localhost/mysql'), /jbhh_ktv_test/);
  assert.throws(() => assertDedicatedTestTarget('mysql://localhost/unknown'), /jbhh_ktv_test/);
});

test('MySQL 8.4 InnoDB auth integration in jbhh_ktv_test',
  { skip: !testUrl && '未配置专用 MySQL 测试 URL；未取得真实 auth 集成证据' },
  async t => {
    assertDedicatedTestTarget(testUrl);
    const setup = await mysql.createConnection(testUrl);
    const created = [];
    let pool = null;
    try {
      const [[target]] = await setup.query(
        'SELECT DATABASE() AS database_name, VERSION() AS version, @@default_storage_engine AS default_engine');
      assert.equal(target.database_name, database);
      assert.match(target.version, /^8\.4\./);
      assert.equal(target.default_engine.toLowerCase(), 'innodb');
      t.diagnostic('MySQL ' + target.version + '; database ' + target.database_name +
        '; default engine ' + target.default_engine);

      await acquireMySqlFixtureLock(setup);
      const [existing] = await setup.execute(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_name IN (?, ?, ?, ?, ?, ?)',
        [database, ...allTables]);
      assert.equal(existing.length, 0,
        'auth 表已存在；停止，不清理来源不明的表');
      const migration = await readFile(
        new URL('../database/migrations/002_mysql_auth_core.sql', import.meta.url), 'utf8');
      const statements = migration.replace(/^\uFEFF/, '').split(/\r?\n/)
        .filter(line => !line.trim().startsWith('--')).join('\n')
        .split(';').map(part => part.trim()).filter(Boolean);
      assert.equal(statements.length, tables.length);
      for (let index = 0; index < statements.length; index++) {
        await setup.query(statements[index]);
        created.push(tables[index]);
      }
      const attributeStatements = await applyPolicyAttributeMigration(setup, created);
      const [engines] = await setup.execute(
        'SELECT table_name AS table_name, engine AS engine FROM information_schema.tables WHERE table_schema = ? AND table_name IN (?, ?, ?, ?, ?, ?)',
        [database, ...allTables]);
      assert.equal(engines.length, allTables.length);
      assert.ok(engines.every(row => row.engine === 'InnoDB'));
      await assert.rejects(setup.query(statements[0]),
        error => error.code === 'ER_TABLE_EXISTS_ERROR');

      const poolOptions = { uri: testUrl, database, waitForConnections: true,
        connectionLimit: 5, supportBigNumbers: true, bigNumberStrings: true };
      pool = mysql.createPool(poolOptions);
      const makeService = (connectionPool = pool, rateLimiter = createMemoryLoginRateLimiter()) =>
        createAuthService({ store: createMySqlAuthStore({ pool: connectionPool, database }),
          rateLimiter });
      const auth = makeService();
      const accountRow = async principalId => {
        const [[row]] = await pool.execute('SELECT * FROM ' + qualified('auth_accounts') +
          ' WHERE principal_id = ?', [principalId]);
        return row;
      };
      const sessionRows = async principalId => {
        const [rows] = await pool.execute('SELECT * FROM ' + qualified('auth_sessions') +
          ' WHERE principal_id = ? ORDER BY session_id', [principalId]);
        return rows;
      };
      const events = async (principalId, eventType) => {
        const [rows] = await pool.execute('SELECT * FROM ' + qualified('auth_events') +
          ' WHERE principal_id = ? AND event_type = ? ORDER BY event_id',
        [principalId, eventType]);
        return rows;
      };

      let first;
      await t.test('synthetic accounts, independent scrypt salts, no plaintext', async () => {
        first = await auth.createAccount({ loginIdentifier: 'synthetic-alpha', password });
        const second = await auth.createAccount({ loginIdentifier: 'synthetic-beta', password });
        assert.notEqual(first.principalId, second.principalId);
        assert.match(first.principalId, /^[0-9a-f-]{36}$/);
        const [rows] = await pool.query('SELECT login_identifier, password_algorithm, ' +
          'password_params_version, salt, derived_key FROM ' + qualified('auth_credentials') +
          ' ORDER BY login_identifier');
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.map(row => row.login_identifier),
          ['synthetic-alpha', 'synthetic-beta']);
        assert.ok(rows.every(row => row.password_algorithm === 'scrypt' &&
          row.password_params_version === 1));
        assert.notDeepEqual(rows[0].salt, rows[1].salt);
        assert.notDeepEqual(rows[0].derived_key, rows[1].derived_key);
        assert.ok(rows.every(row => row.salt.length === 32 && row.derived_key.length === 32));
        assert.ok(!JSON.stringify(rows).includes(password));
        assert.equal((await events(first.principalId, 'account-created')).length, 1);
      });

      let login;
      await t.test('correct login; unknown account and wrong password have one public result', async () => {
        login = await auth.login({ loginIdentifier: 'synthetic-alpha', password });
        assert.equal(login.ok, true);
        const wrong = await auth.login({
          loginIdentifier: 'synthetic-alpha', password: 'synthetic-wrong-password'
        });
        const absent = await auth.login({
          loginIdentifier: 'synthetic-absent', password: 'synthetic-wrong-password'
        });
        assert.deepEqual(wrong, { ok: false, code: 'invalid-credentials' });
        assert.deepEqual(absent, wrong);
        assert.equal((await events(first.principalId, 'login-success')).length, 1);
        assert.equal((await events(first.principalId, 'login-failure')).length, 1);
        const [[unknownCount]] = await pool.query('SELECT COUNT(*) AS count FROM ' +
          qualified('auth_events') +
          " WHERE principal_id IS NULL AND event_type = 'login-failure'");
        assert.equal(Number(unknownCount.count), 1);
      });

      await t.test('only token digest is stored; grants are fresh on every authentication', async () => {
        const [session] = await sessionRows(first.principalId);
        assert.deepEqual(session.token_digest, digestSessionToken(login.token));
        assert.equal(session.token_digest.length, 32);
        assert.ok(!JSON.stringify(session).includes(login.token));
        const before = await auth.authenticateSession(login.token);
        assert.equal(before.id, first.principalId);
        assert.deepEqual(before.permissionIds, []);
        assert.equal(await auth.grantPermission({
          principalId: first.principalId, permissionId: 'backend.view'
        }), true);
        const afterGrant = await auth.authenticateSession(login.token);
        assert.deepEqual(afterGrant.permissionIds, ['backend.view']);
        assert.equal(await auth.revokePermission({
          principalId: first.principalId, permissionId: 'backend.view'
        }), true);
        assert.deepEqual((await auth.authenticateSession(login.token)).permissionIds, []);
        await assert.rejects(auth.grantPermission({
          principalId: first.principalId, permissionId: 'administrator'
        }), /具体 permission/);
      });

      await t.test('new database connection can authenticate; logout and revoke invalidate', async () => {
        const freshPool = mysql.createPool({ uri: testUrl, database, connectionLimit: 1 });
        try {
          const fresh = makeService(freshPool);
          assert.equal((await fresh.authenticateSession(login.token)).id, first.principalId);
          assert.equal(await fresh.logout(login.token), true);
          assert.equal(await auth.authenticateSession(login.token), null);
        } finally { await freshPool.end(); }
        const another = await auth.login({ loginIdentifier: 'synthetic-alpha', password });
        assert.equal(await auth.revokeSession({ sessionId: another.sessionId }), true);
        assert.equal(await auth.authenticateSession(another.token), null);
        assert.equal((await events(first.principalId, 'logout')).length, 1);
        assert.equal((await events(first.principalId, 'session-revoked')).length, 1);
      });

      await t.test('activity renews idle expiry without extending absolute expiry', async () => {
        const active = await auth.login({ loginIdentifier: 'synthetic-beta', password });
        await pool.execute('UPDATE ' + qualified('auth_sessions') +
          ' SET idle_expires_at = UTC_TIMESTAMP(6) + INTERVAL 1 SECOND, ' +
          'absolute_expires_at = UTC_TIMESTAMP(6) + INTERVAL 10 SECOND WHERE session_id = ?',
        [active.sessionId]);
        assert.equal((await auth.authenticateSession(active.token)).id,
          (await pool.execute('SELECT principal_id FROM ' + qualified('auth_sessions') +
            ' WHERE session_id = ?', [active.sessionId]))[0][0].principal_id);
        const [[expiry]] = await pool.execute(
          'SELECT (idle_expires_at = absolute_expires_at) AS capped FROM ' +
          qualified('auth_sessions') + ' WHERE session_id = ?', [active.sessionId]);
        assert.equal(Number(expiry.capped), 1);
      });

      await t.test('idle and absolute expiry use database time', async () => {
        const idle = await auth.login({ loginIdentifier: 'synthetic-alpha', password });
        await pool.execute('UPDATE ' + qualified('auth_sessions') +
          ' SET idle_expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE session_id = ?',
        [idle.sessionId]);
        assert.equal(await auth.authenticateSession(idle.token), null);
        const absolute = await auth.login({ loginIdentifier: 'synthetic-alpha', password });
        await pool.execute('UPDATE ' + qualified('auth_sessions') +
          ' SET created_at = UTC_TIMESTAMP(6) - INTERVAL 2 DAY, ' +
          'idle_expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND, ' +
          'absolute_expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE session_id = ?',
        [absolute.sessionId]);
        assert.equal(await auth.authenticateSession(absolute.token), null);
      });

      await t.test('credential version rotation invalidates old token immediately', async () => {
        const old = await auth.login({ loginIdentifier: 'synthetic-alpha', password });
        const before = (await accountRow(first.principalId)).credential_version;
        await auth.rotateCredential({
          principalId: first.principalId, password: 'synthetic-rotated-password'
        });
        assert.equal(Number((await accountRow(first.principalId)).credential_version),
          Number(before) + 1);
        assert.equal(await auth.authenticateSession(old.token), null);
        assert.deepEqual(await auth.login({ loginIdentifier: 'synthetic-alpha', password }),
          { ok: false, code: 'invalid-credentials' });
        assert.equal((await auth.login({
          loginIdentifier: 'synthetic-alpha', password: 'synthetic-rotated-password'
        })).ok, true);
      });

      await t.test('account disable revokes sessions and audits in one transaction', async () => {
        const account = await auth.createAccount({
          loginIdentifier: 'synthetic-disabled', password
        });
        const a = await auth.login({ loginIdentifier: 'synthetic-disabled', password });
        const b = await auth.login({ loginIdentifier: 'synthetic-disabled', password });
        assert.equal(await auth.disableAccount({ principalId: account.principalId }), true);
        const row = await accountRow(account.principalId);
        assert.equal(row.enabled, 0);
        assert.notEqual(row.disabled_at, null);
        assert.ok((await sessionRows(account.principalId)).every(item => item.revoked_at));
        assert.equal((await events(account.principalId, 'session-revoked')).length, 2);
        assert.equal((await events(account.principalId, 'account-disabled')).length, 1);
        assert.equal(await auth.authenticateSession(a.token), null);
        assert.equal(await auth.authenticateSession(b.token), null);
        assert.deepEqual(await auth.login({
          loginIdentifier: 'synthetic-disabled', password
        }), { ok: false, code: 'invalid-credentials' });
      });

      await t.test('explicit rate-limit port blocks repeated failures with the same public result', async () => {
        let now = 100;
        const limiter = createMemoryLoginRateLimiter({
          maxFailures: 2, windowMs: 1000, now: () => now
        });
        const limited = makeService(pool, limiter);
        for (let index = 0; index < 2; index++) {
          assert.deepEqual(await limited.login({
            loginIdentifier: 'synthetic-beta', password: 'synthetic-wrong-password'
          }), { ok: false, code: 'invalid-credentials' });
        }
        assert.deepEqual(await limited.login({
          loginIdentifier: 'synthetic-beta', password
        }), { ok: false, code: 'invalid-credentials' });
        now += 1001;
        assert.equal((await limited.login({
          loginIdentifier: 'synthetic-beta', password
        })).ok, true);
      });

      await t.test('two independent connections can create sessions concurrently', async () => {
        const a = mysql.createPool({ uri: testUrl, database, connectionLimit: 1 });
        const b = mysql.createPool({ uri: testUrl, database, connectionLimit: 1 });
        try {
          const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id');
          const [[bId]] = await b.query('SELECT CONNECTION_ID() AS id');
          assert.notEqual(aId.id, bId.id);
          const before = (await sessionRows(first.principalId)).length;
          const outcomes = await Promise.all([
            makeService(a).login({
              loginIdentifier: 'synthetic-alpha', password: 'synthetic-rotated-password'
            }),
            makeService(b).login({
              loginIdentifier: 'synthetic-alpha', password: 'synthetic-rotated-password'
            })
          ]);
          assert.ok(outcomes.every(item => item.ok));
          assert.notEqual(outcomes[0].token, outcomes[1].token);
          assert.equal((await sessionRows(first.principalId)).length, before + 2);
          assert.equal(Number((await accountRow(first.principalId)).credential_version), 2);
          assert.equal((await auth.authenticateSession(outcomes[0].token)).id, first.principalId);
          assert.equal((await auth.authenticateSession(outcomes[1].token)).id, first.principalId);
        } finally { await a.end(); await b.end(); }
      });

      await t.test('audit SQL failure rolls back account disable and all revocations', async () => {
        const account = await auth.createAccount({
          loginIdentifier: 'synthetic-disable-fault', password
        });
        const active = await auth.login({
          loginIdentifier: 'synthetic-disable-fault', password
        });
        await pool.query('ALTER TABLE ' + qualified('auth_events') +
          " ADD CONSTRAINT chk_auth_test_no_disable CHECK (event_type <> 'account-disabled' OR principal_id <> ?)",
        [account.principalId]);
        await assert.rejects(auth.disableAccount({ principalId: account.principalId }),
          error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
        assert.equal((await accountRow(account.principalId)).enabled, 1);
        assert.equal((await sessionRows(account.principalId))[0].revoked_at, null);
        assert.equal((await events(account.principalId, 'account-disabled')).length, 0);
        assert.equal((await events(account.principalId, 'session-revoked')).length, 0);
        assert.equal((await auth.authenticateSession(active.token)).id, account.principalId);
        await pool.query('ALTER TABLE ' + qualified('auth_events') +
          ' DROP CHECK chk_auth_test_no_disable');
      });

      await t.test('auth events exclude secrets and use database-generated time', async () => {
        const [rows] = await pool.query('SELECT * FROM ' + qualified('auth_events'));
        assert.ok(rows.length > 0);
        assert.ok(rows.every(row => row.occurred_at));
        const serialized = JSON.stringify(rows);
        assert.ok(!serialized.includes(password));
        assert.ok(!serialized.includes(login.token));
        const [columns] = await pool.execute(
          'SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?',
          [database, 'auth_events']);
        const names = columns.map(row => row.COLUMN_NAME.toLowerCase());
        assert.ok(!names.some(name => /password|salt|derived|token|hash|digest|payload/.test(name)));
      });

      await t.test('SQL failure after session insert rolls back session and success audit', async () => {
        const fault = await auth.createAccount({
          loginIdentifier: 'synthetic-fault-login', password
        });
        await pool.query('ALTER TABLE ' + qualified('auth_events') +
          " ADD CONSTRAINT chk_auth_test_no_login_success CHECK (event_type <> 'login-success' OR principal_id <> ?)",
        [fault.principalId]);
        await assert.rejects(auth.login({
          loginIdentifier: 'synthetic-fault-login', password
        }), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
        assert.equal((await sessionRows(fault.principalId)).length, 0);
        assert.equal((await events(fault.principalId, 'login-success')).length, 0);
        assert.equal((await accountRow(fault.principalId)).enabled, 1);
        await pool.query('ALTER TABLE ' + qualified('auth_events') +
          ' DROP CHECK chk_auth_test_no_login_success');
      });

      await t.test('SQL failure during credential insert rolls back account creation', async () => {
        const [[beforeAccounts]] = await pool.query(
          'SELECT COUNT(*) AS count FROM ' + qualified('auth_accounts'));
        const [[beforeCredentials]] = await pool.query(
          'SELECT COUNT(*) AS count FROM ' + qualified('auth_credentials'));
        await pool.query('ALTER TABLE ' + qualified('auth_credentials') +
          " ADD CONSTRAINT chk_auth_test_no_credential CHECK (login_identifier <> 'synthetic-fault-account')");
        await assert.rejects(auth.createAccount({
          loginIdentifier: 'synthetic-fault-account', password
        }), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
        const [[afterAccounts]] = await pool.query(
          'SELECT COUNT(*) AS count FROM ' + qualified('auth_accounts'));
        const [[afterCredentials]] = await pool.query(
          'SELECT COUNT(*) AS count FROM ' + qualified('auth_credentials'));
        assert.equal(afterAccounts.count, beforeAccounts.count);
        assert.equal(afterCredentials.count, beforeCredentials.count);
        const [uncommitted] = await pool.execute(
          'SELECT principal_id FROM ' + qualified('auth_credentials') +
          ' WHERE login_identifier = ?', ['synthetic-fault-account']);
        assert.equal(uncommitted.length, 0);
      });
      await verifySessionRevalidation(t, { pool, database, qualified });
      await verifyPolicyAttributes(t, { pool, database, qualified, attributeStatements });
    } finally {
      try { if (pool) await pool.end(); }
      finally {
        try {
          for (const name of created.reverse()) {
            await setup.query('DROP TABLE ' + qualified(name));
          }
        } finally { await setup.end(); }
      }
    }
  });
