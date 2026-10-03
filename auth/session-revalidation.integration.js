// Invoked by the existing auth integration fixture: no second auth DDL owner.
import assert from 'node:assert/strict';
import { createMySqlAuthStore } from './mysql-store.js';
import { createAuthService } from './service.js';
import { createMemoryLoginRateLimiter } from './rate-limit.js';
import { digestSessionToken } from './session-token.js';
import { requireConfiguredPolicyAttributes } from './session-revalidation.js';

export async function verifySessionRevalidation(t, { pool, database, qualified }) {
  const password = 'synthetic-2C1-only-password';
  const store = createMySqlAuthStore({ pool, database });
  const service = createAuthService({ store, rateLimiter: createMemoryLoginRateLimiter() });
  let next = 0;
  const provision = async () => {
    const loginIdentifier = 'synthetic-revalidation-' + (++next);
    const { principalId } = await service.createAccount({ loginIdentifier, password });
    await service.grantPermission({ principalId, permissionId: 'room.clean' });
    const login = await service.login({ loginIdentifier, password });
    assert.equal(login.ok, true);
    return { ...login, digest: digestSessionToken(login.token) };
  };
  const sessionRow = async id => {
    const [[row]] = await pool.execute('SELECT revoked_at, credential_version, ' +
      "DATE_FORMAT(last_seen_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS last_seen, " +
      "DATE_FORMAT(idle_expires_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS idle_expiry, " +
      "DATE_FORMAT(absolute_expires_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS absolute_expiry FROM " +
      qualified('auth_sessions') + ' WHERE session_id = ?', [id]);
    return row;
  };
  const read = async (login, inspect = () => {}) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const context = await store.bindSessionRevalidation(connection)
        .revalidateSessionInTransaction({ tokenDigest: login.digest });
      await inspect(context, connection);
      return context;
    } finally { try { await connection.rollback(); } finally { connection.release(); } }
  };
  const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  };
  const wait = async promise => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Error('auth concurrency test barrier timed out')), 8000);
      })]);
    } finally { clearTimeout(timer); }
  };
  const isAccountLock = sql => sql.includes('auth_accounts') && sql.includes('FOR UPDATE');
  const proxy = (connection, { onExecute = () => {}, beforeCommit = async () => {} } = {}) => ({
    async query(...args) { return connection.query(...args); },
    async execute(sql, args) { onExecute(sql); return connection.execute(sql, args); },
    async beginTransaction() { return connection.beginTransaction(); },
    async commit() { await beforeCommit(); return connection.commit(); },
    async rollback() { return connection.rollback(); },
    release() {}, // Pair owner releases after both operations finish.
    destroy() { connection.destroy(); }
  });
  const connectionService = connection => createAuthService({
    store: createMySqlAuthStore({ database, pool: { async getConnection() { return connection; } } }),
    rateLimiter: createMemoryLoginRateLimiter()
  });
  const withPair = async work => {
    const a = await pool.getConnection();
    const b = await pool.getConnection();
    try {
      const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id');
      const [[bId]] = await b.query('SELECT CONNECTION_ID() AS id');
      assert.notEqual(aId.id, bId.id, 'race requires two real independent MySQL connections');
      await a.query('SET SESSION innodb_lock_wait_timeout = 5');
      await b.query('SET SESSION innodb_lock_wait_timeout = 5');
      return await work(a, b);
    } finally {
      try { await a.rollback(); await b.rollback(); }
      finally { a.release(); b.release(); }
    }
  };
  const assertAccountHeld = async (other, login) => {
    await assert.rejects(other.execute('SELECT principal_id FROM ' + qualified('auth_accounts') +
      ' WHERE principal_id = ? FOR UPDATE NOWAIT', [login.principalId]),
    error => error.code === 'ER_LOCK_NOWAIT');
  };

  await t.test('2C.1 caller connection owns lifecycle; one DB time; no session activity write', async () => {
    const login = await provision();
    const before = await sessionRow(login.sessionId);
    const connection = await pool.getConnection();
    const calls = [];
    let returnedDbNow;
    try {
      await connection.beginTransaction();
      // An uncommitted grant detects an accidental internal COMMIT or ROLLBACK.
      await connection.execute('INSERT INTO ' + qualified('auth_grants') +
        ' (principal_id, permission_id) VALUES (?, ?)', [login.principalId, 'order.sale']);
      const narrow = {
        async execute(sql, values) {
          calls.push(sql);
          const result = await connection.execute(sql, values);
          if (sql.includes('AS db_now')) returnedDbNow = result[0][0].db_now;
          return result;
        },
        beginTransaction() { assert.fail('port must not BEGIN'); },
        commit() { assert.fail('port must not COMMIT'); },
        rollback() { assert.fail('port must not ROLLBACK'); },
        release() { assert.fail('port must not release'); }
      };
      const isolated = createMySqlAuthStore({
        database, pool: { getConnection() { assert.fail('no pool borrowing'); } }
      });
      const context = await isolated.bindSessionRevalidation(narrow)
        .revalidateSessionInTransaction({ tokenDigest: login.digest });
      assert.equal(context.principalId, login.principalId);
      assert.deepEqual(context.permissionIds, ['order.sale', 'room.clean']);
      assert.equal(context.dbNow, returnedDbNow);
      assert.match(context.dbNow, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      assert.equal(calls.filter(sql => sql.includes('AS db_now')).length, 1);
      const locked = calls.filter(sql => sql.includes('FOR UPDATE'));
      assert.ok(locked[0].includes('auth_accounts'));
      assert.ok(locked[1].includes('auth_sessions'));
      assert.ok(locked[2].includes('auth_grants'));
      assert.equal(context.policyAttributesConfigured, false);
      assert.equal(context.policyAttributeIds, null);
      assert.equal(context.actorSnapshot, null);
      assert.throws(() => requireConfiguredPolicyAttributes(context),
        error => error.code === 'AUTH_POLICY_ATTRIBUTES_UNCONFIGURED');
      const [status] = await connection.execute('DO 0');
      assert.ok(status.serverStatus & 1);
      assert.ok(calls.every(sql => sql === 'DO 0' || sql.startsWith('SELECT ')));
      const [[ownGrant]] = await connection.execute('SELECT COUNT(*) AS n FROM ' +
        qualified('auth_grants') + ' WHERE principal_id = ? AND permission_id = ?',
      [login.principalId, 'order.sale']);
      assert.equal(Number(ownGrant.n), 1);
    } finally { try { await connection.rollback(); } finally { connection.release(); } }
    const [[rolledBack]] = await pool.execute('SELECT COUNT(*) AS n FROM ' +
      qualified('auth_grants') + ' WHERE principal_id = ? AND permission_id = ?',
    [login.principalId, 'order.sale']);
    assert.equal(Number(rolledBack.n), 0);
    assert.deepEqual(await sessionRow(login.sessionId), before);
  });

  await t.test('2C.1 real autocommit connection is refused', async () => {
    const login = await provision();
    const connection = await pool.getConnection();
    try {
      await assert.rejects(store.bindSessionRevalidation(connection)
        .revalidateSessionInTransaction({ tokenDigest: login.digest }), /事务/);
    } finally { connection.release(); }
  });

  await t.test('2C.1 disabled account cannot revalidate', async () => {
    const login = await provision();
    await service.disableAccount({ principalId: login.principalId });
    assert.equal(await read(login), null);
  });
  await t.test('2C.1 revoked session cannot revalidate', async () => {
    const login = await provision();
    await service.revokeSession({ sessionId: login.sessionId });
    assert.equal(await read(login), null);
  });
  await t.test('2C.1 idle expiry uses DB time', async () => {
    const login = await provision();
    await pool.execute('UPDATE ' + qualified('auth_sessions') +
      ' SET idle_expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE session_id = ?', [login.sessionId]);
    assert.equal(await read(login), null);
  });
  await t.test('2C.1 absolute expiry uses DB time', async () => {
    const login = await provision();
    await pool.execute('UPDATE ' + qualified('auth_sessions') +
      ' SET created_at = UTC_TIMESTAMP(6) - INTERVAL 2 DAY, ' +
      'idle_expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND, ' +
      'absolute_expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE session_id = ?', [login.sessionId]);
    assert.equal(await read(login), null);
  });
  await t.test('2C.1 credential version mismatch cannot revalidate', async () => {
    const login = await provision();
    await service.rotateCredential({ principalId: login.principalId, password });
    assert.equal(await read(login), null);
  });

  await t.test('2C.1 locking grants read ignores an older REPEATABLE READ snapshot', async () => {
    const login = await provision();
    const connection = await pool.getConnection();
    try {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.beginTransaction();
      const [original] = await connection.execute('SELECT permission_id FROM ' +
        qualified('auth_grants') + ' WHERE principal_id = ?', [login.principalId]);
      assert.deepEqual(original.map(row => row.permission_id), ['room.clean']);
      await service.revokePermission({ principalId: login.principalId, permissionId: 'room.clean' });
      await service.grantPermission({ principalId: login.principalId, permissionId: 'order.sale' });
      const [snapshot] = await connection.execute('SELECT permission_id FROM ' +
        qualified('auth_grants') + ' WHERE principal_id = ?', [login.principalId]);
      assert.deepEqual(snapshot.map(row => row.permission_id), ['room.clean']);
      const context = await store.bindSessionRevalidation(connection)
        .revalidateSessionInTransaction({ tokenDigest: login.digest });
      assert.deepEqual(context.permissionIds, ['order.sale']);
    } finally { try { await connection.rollback(); } finally { connection.release(); } }
  });

  async function commandFirst(login, mutation) {
    return withPair(async (a, b) => {
      await a.beginTransaction();
      const context = await store.bindSessionRevalidation(a)
        .revalidateSessionInTransaction({ tokenDigest: login.digest });
      assert.ok(context);
      await assertAccountHeld(b, login);
      const attempted = deferred();
      let finished = false;
      const bProxy = proxy(b, { onExecute(sql) {
        if (isAccountLock(sql)) attempted.resolve();
      } });
      const pending = mutation(connectionService(bProxy), login)
        .finally(() => { finished = true; });
      pending.catch(() => attempted.resolve());
      try {
        await wait(attempted.promise);
        // Observer roundtrip while account remains locked; mutation cannot finish.
        await pool.query('SELECT 1');
        assert.equal(finished, false);
      } finally { await a.commit(); }
      await pending;
      return context;
    });
  }

  async function mutationFirst(login, mutation) {
    return withPair(async (a, b) => {
      const written = deferred();
      const allowCommit = deferred();
      const pendingMutation = mutation(connectionService(proxy(b, {
        async beforeCommit() { written.resolve(); await allowCommit.promise; }
      })), login);
      // A failure must not leave the barrier or its connection hanging.
      pendingMutation.catch(() => { written.resolve(); });
      await wait(written.promise);
      const attempted = deferred();
      const aProxy = proxy(a, { onExecute(sql) {
        if (isAccountLock(sql)) attempted.resolve();
      } });
      let pendingRead;
      try {
        await a.beginTransaction();
        pendingRead = store.bindSessionRevalidation(aProxy)
          .revalidateSessionInTransaction({ tokenDigest: login.digest });
        await wait(attempted.promise);
      } finally { allowCommit.resolve(); }
      await pendingMutation;
      return await pendingRead;
    });
  }

  await t.test('2C.1 grant and revoke serialize with revalidation through account lock', async () => {
    const remove = (api, login) => api.revokePermission({
      principalId: login.principalId, permissionId: 'room.clean'
    });
    const add = (api, login) => api.grantPermission({
      principalId: login.principalId, permissionId: 'order.sale'
    });
    const first = await provision();
    assert.deepEqual((await commandFirst(first, remove)).permissionIds, ['room.clean']);
    assert.deepEqual((await read(first)).permissionIds, []);
    const second = await provision();
    assert.deepEqual((await mutationFirst(second, remove)).permissionIds, []);
    const third = await provision();
    assert.deepEqual((await commandFirst(third, add)).permissionIds, ['room.clean']);
    assert.deepEqual((await read(third)).permissionIds, ['order.sale', 'room.clean']);
    const fourth = await provision();
    assert.deepEqual((await mutationFirst(fourth, add)).permissionIds, ['order.sale', 'room.clean']);
  });

  await t.test('2C.1 account disable and revalidation have a defined order on two connections', async () => {
    const disable = (api, login) => api.disableAccount({ principalId: login.principalId });
    const first = await provision();
    assert.ok(await commandFirst(first, disable));
    assert.equal(await read(first), null);
    assert.equal(await mutationFirst(await provision(), disable), null);
  });

  await t.test('2C.1 revoke and logout lock account before session without deadlock', async () => {
    for (const mutation of [
      (api, login) => api.revokeSession({ sessionId: login.sessionId }),
      (api, login) => api.logout(login.token)
    ]) {
      const first = await provision();
      assert.ok(await commandFirst(first, mutation));
      assert.equal(await read(first), null);
      assert.equal(await mutationFirst(await provision(), mutation), null);
    }
  });

  await t.test('2C.1 two real caller connections revalidate the same session serially', async () => {
    const login = await provision();
    await withPair(async (a, b) => {
      await a.beginTransaction();
      await b.beginTransaction();
      const first = await store.bindSessionRevalidation(a)
        .revalidateSessionInTransaction({ tokenDigest: login.digest });
      assert.ok(first);
      await assertAccountHeld(b, login);
      const attempted = deferred();
      const pending = store.bindSessionRevalidation(proxy(b, { onExecute(sql) {
        if (isAccountLock(sql)) attempted.resolve();
      } })).revalidateSessionInTransaction({ tokenDigest: login.digest });
      try { await wait(attempted.promise); } finally { await a.commit(); }
      const second = await pending;
      assert.equal(second.principalId, first.principalId);
      assert.deepEqual(second.permissionIds, first.permissionIds);
      await b.commit();
    });
  });

  await t.test('2C.1 SQL fault propagates; only caller rolls back its earlier writes', async () => {
    const login = await provision();
    const before = await sessionRow(login.sessionId);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('INSERT INTO ' + qualified('auth_grants') +
        ' (principal_id, permission_id) VALUES (?, ?)', [login.principalId, 'order.sale']);
      const faulty = {
        async execute(sql, args) {
          if (sql.includes('auth_sessions') && sql.includes('FOR UPDATE')) {
            return connection.execute('SELECT missing_revalidation_test_column FROM ' +
              qualified('auth_sessions') + ' WHERE session_id = ? FOR UPDATE', args);
          }
          return connection.execute(sql, args);
        }
      };
      await assert.rejects(store.bindSessionRevalidation(faulty)
        .revalidateSessionInTransaction({ tokenDigest: login.digest }),
      error => error.code === 'ER_BAD_FIELD_ERROR');
      const [status] = await connection.execute('DO 0');
      assert.ok(status.serverStatus & 1, 'port did not rollback the caller transaction');
    } finally { try { await connection.rollback(); } finally { connection.release(); } }
    assert.deepEqual((await read(login)).permissionIds, ['room.clean']);
    assert.deepEqual(await sessionRow(login.sessionId), before);
  });
}
