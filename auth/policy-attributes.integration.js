// Runs only inside the guarded auth fixture; no separate DDL owner or database cleanup.
import assert from 'node:assert/strict';
import { applyExpenseApprovalAttributeMigration, applyCreditApprovalAttributesMigration } from '../test-support/mysql-policy-attributes-fixture.js';
import { createMySqlAuthStore } from './mysql-store.js';
import { createAuthService } from './service.js';
import { createPolicyAttributeService } from './policy-attributes.js';
import { createMemoryLoginRateLimiter } from './rate-limit.js';
import { digestSessionToken } from './session-token.js';
import { requireConfiguredPolicyAttributes } from './session-revalidation.js';
import { authorizeReviewCommand, createTrustedReviewFacts } from '../ledger/command-policy.js';
import { TRUSTED_ENABLED_ACTIONS, authorizeTrustedExecution } from '../ledger/trusted-execution.js';

export async function verifyPolicyAttributes(t, { pool, database, qualified, attributeStatements }) {
  const attributeId = 'rounding.self.excess', password = 'synthetic-attributes-only-password';
  const store = createMySqlAuthStore({ pool, database });
  const auth = createAuthService({ store, rateLimiter: createMemoryLoginRateLimiter() });
  const api = createPolicyAttributeService({ store });
  let next = 0;
  const provision = async () => {
    const loginIdentifier = 'synthetic-attributes-' + (++next);
    const { principalId } = await auth.createAccount({ loginIdentifier, password });
    const login = await auth.login({ loginIdentifier, password });
    assert.equal(login.ok, true);
    return { ...login, principalId, digest: digestSessionToken(login.token) };
  };
  const actor = await provision(), actorContext = { actorPrincipalId: actor.principalId };
  const input = login => ({ principalId: login.principalId, attributeId });
  const configure = (login, context = actorContext) => api.configurePolicyAttributes({ principalId: login.principalId }, context);
  const events = async id => (await pool.execute('SELECT * FROM ' + qualified('auth_events') +
    ' WHERE principal_id = ? AND event_type LIKE ? ORDER BY event_id', [id, 'policy-%']))[0];
  const snapshot = async id => ({
    account: (await pool.execute('SELECT * FROM ' + qualified('auth_accounts') + ' WHERE principal_id = ?', [id]))[0],
    attributes: (await pool.execute('SELECT * FROM ' + qualified('auth_policy_attributes') +
      ' WHERE principal_id = ? ORDER BY attribute_id', [id]))[0], events: await events(id)
  });
  const read = async (login, inspect = () => {}) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const context = await store.bindSessionRevalidation(connection)
        .revalidateSessionInTransaction({ tokenDigest: login.digest });
      await inspect(context, connection); return context;
    } finally { try { await connection.rollback(); } finally { connection.release(); } }
  };
  const utc = async () => (await pool.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%dT%H:%i:%s.%fZ') AS now"))[0][0].now;
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const wait = async promise => {
    let timer;
    try { return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('policy attributes concurrency barrier timed out')), 8000);
    })]); } finally { clearTimeout(timer); }
  };
  const proxy = (connection, { onExecute = () => {}, beforeCommit = async () => {} } = {}) => ({
    query: (...args) => connection.query(...args),
    async execute(sql, args) { onExecute(sql, args); return connection.execute(sql, args); },
    beginTransaction: () => connection.beginTransaction(),
    async commit() { await beforeCommit(); return connection.commit(); },
    rollback: () => connection.rollback(), release() {}, destroy: () => connection.destroy()
  });
  const connectionApi = connection => createPolicyAttributeService({ store: createMySqlAuthStore({
    database, pool: { async getConnection() { return connection; } }
  }) });
  const withPair = async work => {
    const a = await pool.getConnection(), b = await pool.getConnection();
    try {
      const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id');
      const [[bId]] = await b.query('SELECT CONNECTION_ID() AS id');
      assert.notEqual(aId.id, bId.id, 'requires two real independent MySQL connections');
      await a.query('SET SESSION innodb_lock_wait_timeout = 5');
      await b.query('SET SESSION innodb_lock_wait_timeout = 5');
      return await work(a, b);
    } finally { try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); } }
  };
  const isTargetLock = (sql, args, login) => sql.includes('auth_accounts') &&
    sql.includes('FOR UPDATE') && args[0] === login.principalId;
  async function readFirst(login, mutation) {
    return withPair(async (a, b) => {
      await a.beginTransaction();
      const context = await store.bindSessionRevalidation(a).revalidateSessionInTransaction({ tokenDigest: login.digest });
      await assert.rejects(b.execute('SELECT principal_id FROM ' + qualified('auth_accounts') +
        ' WHERE principal_id = ? FOR UPDATE NOWAIT', [login.principalId]), error => error.code === 'ER_LOCK_NOWAIT');
      const attempted = deferred(); let finished = false;
      const pending = mutation(connectionApi(proxy(b, { onExecute(sql, args) {
        if (isTargetLock(sql, args, login)) attempted.resolve();
      } })), login).finally(() => { finished = true; });
      pending.catch(() => attempted.resolve());
      try { await wait(attempted.promise); await pool.query('SELECT 1'); assert.equal(finished, false); }
      finally { await a.commit(); }
      await pending; return context;
    });
  }
  async function mutationFirst(login, mutation) {
    return withPair(async (a, b) => {
      const written = deferred(), allowCommit = deferred();
      const pendingMutation = mutation(connectionApi(proxy(b, {
        async beforeCommit() { written.resolve(); await allowCommit.promise; }
      })), login);
      pendingMutation.catch(() => written.resolve());
      await wait(written.promise);
      const attempted = deferred(); let pendingRead, finished = false;
      try {
        await a.beginTransaction();
        pendingRead = store.bindSessionRevalidation(proxy(a, { onExecute(sql, args) {
          if (isTargetLock(sql, args, login)) attempted.resolve();
        } })).revalidateSessionInTransaction({ tokenDigest: login.digest }).finally(() => { finished = true; });
        pendingRead.catch(() => attempted.resolve());
        await wait(attempted.promise); await pool.query('SELECT 1'); assert.equal(finished, false);
      } finally { allowCommit.resolve(); }
      await pendingMutation; return await pendingRead;
    });
  }

  await t.test('attributes: 004 migration creates InnoDB metadata only; explicit run-once repeat refusal', async () => {
    const [[table]] = await pool.execute('SELECT engine AS engine FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
      [database, 'auth_policy_attributes']);
    assert.equal(table.engine, 'InnoDB');
    const [[column]] = await pool.execute('SELECT column_default AS initial, is_nullable AS nullable FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?',
      [database, 'auth_accounts', 'policy_attributes_configured']);
    assert.equal(String(column.initial), '0'); assert.equal(column.nullable, 'NO');
    const [[rows]] = await pool.query('SELECT COUNT(*) AS n FROM ' + qualified('auth_policy_attributes'));
    assert.equal(Number(rows.n), 0);
    await assert.rejects(pool.query(attributeStatements[0]), error => ['ER_DUP_FIELDNAME', 'ER_CHECK_CONSTRAINT_DUP_NAME'].includes(error.code));
  });

  await t.test('attributes: new account false/null; explicit configure true/[] without grants or session touch', async () => {
    const login = await provision(), before = (await pool.execute('SELECT * FROM ' + qualified('auth_sessions') + ' WHERE session_id = ?', [login.sessionId]))[0];
    const initial = await read(login);
    assert.equal(initial.policyAttributesConfigured, false); assert.equal(initial.policyAttributeIds, null);
    assert.throws(() => requireConfiguredPolicyAttributes(initial), error => error.code === 'AUTH_POLICY_ATTRIBUTES_UNCONFIGURED');
    await assert.rejects(api.grantPolicyAttribute(input(login), actorContext), error => error.code === 'AUTH_POLICY_ATTRIBUTES_UNCONFIGURED');
    assert.equal(await configure(login), true); assert.equal(await configure(login), false);
    const empty = await read(login);
    assert.equal(empty.policyAttributesConfigured, true); assert.deepEqual(empty.policyAttributeIds, []);
    assert.deepEqual(requireConfiguredPolicyAttributes(empty), []); assert.deepEqual(empty.permissionIds, []);
    assert.equal((await events(login.principalId)).length, 1);
    assert.deepEqual((await pool.execute('SELECT * FROM ' + qualified('auth_sessions') + ' WHERE session_id = ?', [login.sessionId]))[0], before);
    // Deliberately corrupt only this synthetic fixture account to verify fail-closed configuration.
    const inconsistent = await provision();
    await pool.execute('INSERT INTO ' + qualified('auth_policy_attributes') +
      ' (principal_id, attribute_id) VALUES (?, ?)', [inconsistent.principalId, attributeId]);
    const corrupted = await snapshot(inconsistent.principalId);
    await assert.rejects(read(inconsistent));
    await assert.rejects(configure(inconsistent), error => error.code === 'AUTH_POLICY_ATTRIBUTES_INCONSISTENT');
    assert.deepEqual(await snapshot(inconsistent.principalId), corrupted);
  });

  await t.test('attributes: grant/revoke immediately reach DB-derived principal; duplicate grant is harmless', async () => {
    const login = await provision(); await configure(login);
    assert.equal(await api.grantPolicyAttribute(input(login), actorContext), true);
    assert.equal(await api.grantPolicyAttribute(input(login), actorContext), false);
    const granted = await read(login);
    assert.deepEqual(granted.policyAttributeIds, [attributeId]);
    assert.equal(granted.policyAttributeIds, granted.principal.policyAttributeIds);
    assert.ok(Object.isFrozen(granted.policyAttributeIds));
    assert.equal(await api.revokePolicyAttribute(input(login), actorContext), true);
    assert.equal(await api.revokePolicyAttribute(input(login), actorContext), false);
    assert.deepEqual((await read(login)).policyAttributeIds, []);
    assert.deepEqual(granted.policyAttributeIds, [attributeId]);
    assert.equal((await auth.authenticateSession(login.token)).id, login.principalId);
    assert.equal((await events(login.principalId)).length, 3);
  });

  await t.test('attributes: audit records actual actor separately from target and uses database UTC without secrets', async () => {
    const login = await provision(), before = await utc();
    await configure(login); await api.grantPolicyAttribute(input(login), actorContext);
    await api.revokePolicyAttribute(input(login), actorContext); const after = await utc();
    const rows = await events(login.principalId);
    assert.deepEqual(rows.map(row => [row.principal_id, row.actor_principal_id, row.event_type, row.policy_attribute_id]), [
      [login.principalId, actor.principalId, 'policy-attributes-configured', null],
      [login.principalId, actor.principalId, 'policy-attribute-granted', attributeId],
      [login.principalId, actor.principalId, 'policy-attribute-revoked', attributeId]
    ]);
    const [times] = await pool.execute("SELECT DATE_FORMAT(occurred_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS time FROM " + qualified('auth_events') +
      ' WHERE principal_id = ? AND event_type LIKE ?', [login.principalId, 'policy-%']);
    assert.ok(times.every(row => row.time >= before && row.time <= after));
    const [[credential]] = await pool.execute('SELECT salt, derived_key FROM ' + qualified('auth_credentials') + ' WHERE principal_id = ?', [login.principalId]);
    const serialized = JSON.stringify(rows);
    for (const secret of [password, login.token, actor.token, credential.salt.toString('hex'), credential.derived_key.toString('hex')]) assert.ok(!serialized.includes(secret));
    assert.ok(rows.every(row => !Object.keys(row).some(key => /password|salt|derived|token|hash|digest|payload/.test(key))));
  });

  await t.test('attributes: disabled actors/targets and unknown principals cannot configure; disabled session stays invalid', async () => {
    const login = await provision(); await configure(login); await api.grantPolicyAttribute(input(login), actorContext);
    await auth.disableAccount({ principalId: login.principalId }); const before = await snapshot(login.principalId);
    assert.equal(await read(login), null);
    await assert.rejects(api.revokePolicyAttribute(input(login), actorContext), error => error.code === 'AUTH_POLICY_ACCOUNT_DISABLED');
    assert.deepEqual(await snapshot(login.principalId), before);
    const disabledActor = await provision(), target = await provision();
    await auth.disableAccount({ principalId: disabledActor.principalId });
    await assert.rejects(configure(target, { actorPrincipalId: disabledActor.principalId }), error => error.code === 'AUTH_POLICY_ACCOUNT_DISABLED');
    await assert.rejects(api.configurePolicyAttributes({ principalId: '00000000-0000-4000-8000-000000000099' }, actorContext),
      error => error.code === 'AUTH_POLICY_ACCOUNT_NOT_FOUND');
    assert.equal((await snapshot(target.principalId)).account[0].policy_attributes_configured, 0);
  });

  await t.test('attributes: locking reads see committed configure/grant after an older repeatable-read snapshot', async () => {
    const login = await provision(), connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[old]] = await connection.execute('SELECT policy_attributes_configured FROM ' + qualified('auth_accounts') + ' WHERE principal_id = ?', [login.principalId]);
      assert.equal(old.policy_attributes_configured, 0);
      assert.deepEqual((await connection.execute('SELECT attribute_id FROM ' + qualified('auth_policy_attributes') + ' WHERE principal_id = ?', [login.principalId]))[0], []);
      await configure(login); await api.grantPolicyAttribute(input(login), actorContext);
      const context = await store.bindSessionRevalidation(connection).revalidateSessionInTransaction({ tokenDigest: login.digest });
      assert.equal(context.policyAttributesConfigured, true); assert.deepEqual(context.policyAttributeIds, [attributeId]);
    } finally { try { await connection.rollback(); } finally { connection.release(); } }
  });

  await t.test('attributes: caller connection/lifecycle, frozen DB time and read-only activity hold with a configured set', async () => {
    const login = await provision(); await configure(login);
    const before = await snapshot(login.principalId), connection = await pool.getConnection();
    const sessionBefore = (await pool.execute('SELECT * FROM ' + qualified('auth_sessions') + ' WHERE session_id = ?', [login.sessionId]))[0];
    const calls = []; let actualDbNow;
    try {
      await connection.beginTransaction();
      await connection.execute('SELECT principal_id FROM ' + qualified('auth_accounts') + ' WHERE principal_id = ? FOR UPDATE', [login.principalId]);
      await connection.execute('INSERT INTO ' + qualified('auth_policy_attributes') + ' (principal_id, attribute_id) VALUES (?, ?)', [login.principalId, attributeId]);
      const narrow = { async execute(sql, args) { calls.push(sql); const result = await connection.execute(sql, args);
        if (sql.includes('AS db_now')) actualDbNow = result[0][0].db_now; return result; },
        beginTransaction() { assert.fail('must not BEGIN'); }, commit() { assert.fail('must not COMMIT'); },
        rollback() { assert.fail('must not ROLLBACK'); }, release() { assert.fail('must not release'); } };
      const isolated = createMySqlAuthStore({ database, pool: { getConnection() { assert.fail('must use caller connection'); } } });
      const context = await isolated.bindSessionRevalidation(narrow).revalidateSessionInTransaction({ tokenDigest: login.digest });
      assert.deepEqual(context.policyAttributeIds, [attributeId]); assert.equal(context.dbNow, actualDbNow);
      assert.equal(calls.filter(sql => sql.includes('AS db_now')).length, 1);
      assert.ok(calls.every(sql => sql.startsWith('SELECT ') || sql === 'DO 0'));
      assert.deepEqual(calls.filter(sql => sql.includes('FOR UPDATE')).map(sql =>
        ['auth_accounts','auth_sessions','auth_grants','auth_policy_attributes'].find(name => sql.includes(name))),
      ['auth_accounts','auth_sessions','auth_grants','auth_policy_attributes']);
    } finally { try { await connection.rollback(); } finally { connection.release(); } }
    assert.deepEqual(await snapshot(login.principalId), before);
    assert.deepEqual((await pool.execute('SELECT * FROM ' + qualified('auth_sessions') + ' WHERE session_id = ?', [login.sessionId]))[0], sessionBefore);
  });

  await t.test('attributes: two real connections grant/revoke vs revalidation have both explicit serialization orders', async () => {
    const grant = (service, login) => service.grantPolicyAttribute(input(login), actorContext);
    const revoke = (service, login) => service.revokePolicyAttribute(input(login), actorContext);
    const a = await provision(); await configure(a);
    assert.deepEqual((await readFirst(a, grant)).policyAttributeIds, []);
    assert.deepEqual((await read(a)).policyAttributeIds, [attributeId]);
    assert.deepEqual((await readFirst(a, revoke)).policyAttributeIds, [attributeId]);
    assert.deepEqual((await read(a)).policyAttributeIds, []);
    const b = await provision(); await configure(b);
    assert.deepEqual((await mutationFirst(b, grant)).policyAttributeIds, [attributeId]);
    assert.deepEqual((await mutationFirst(b, revoke)).policyAttributeIds, []);
  });

  await t.test('attributes: configure vs revalidation also serializes false/null then true/[] on two connections', async () => {
    const mutation = (service, login) => service.configurePolicyAttributes({ principalId: login.principalId }, actorContext);
    const a = await provision();
    const old = await readFirst(a, mutation);
    assert.equal(old.policyAttributesConfigured, false); assert.equal(old.policyAttributeIds, null);
    assert.deepEqual((await read(a)).policyAttributeIds, []);
    const next = await mutationFirst(await provision(), mutation);
    assert.equal(next.policyAttributesConfigured, true); assert.deepEqual(next.policyAttributeIds, []);
  });

  await t.test('attributes: concurrent duplicate grant creates one row and one event on independent connections', async () => {
    const login = await provision(); await configure(login);
    await withPair(async (a, b) => {
      const outcome = await Promise.all([connectionApi(proxy(a)).grantPolicyAttribute(input(login), actorContext),
        connectionApi(proxy(b)).grantPolicyAttribute(input(login), actorContext)]);
      assert.deepEqual(outcome.sort(), [false, true]);
    });
    assert.equal((await snapshot(login.principalId)).attributes.length, 1);
    assert.equal((await events(login.principalId)).filter(row => row.event_type === 'policy-attribute-granted').length, 1);
  });

  await t.test('attributes: cross actor/target mutations lock both accounts in stable order without deadlock', async () => {
    const a = await provision(), b = await provision(); await configure(a); await configure(b);
    await withPair(async (first, second) => {
      const traces = [[], []];
      const outcome = await Promise.all([
        connectionApi(proxy(first, { onExecute(sql,args) { if (sql.includes('auth_accounts') && sql.includes('FOR UPDATE')) traces[0].push(args[0]); } }))
          .grantPolicyAttribute(input(b), { actorPrincipalId: a.principalId }),
        connectionApi(proxy(second, { onExecute(sql,args) { if (sql.includes('auth_accounts') && sql.includes('FOR UPDATE')) traces[1].push(args[0]); } }))
          .grantPolicyAttribute(input(a), { actorPrincipalId: b.principalId })
      ]);
      assert.deepEqual(outcome, [true,true]);
      assert.deepEqual(traces[0], [a.principalId,b.principalId].sort()); assert.deepEqual(traces[1], traces[0]);
    });
  });

  await t.test('attributes: real audit SQL failure rolls back configure, grant and revoke as complete transactions', async () => {
    const login = await provision();
    const operations = [
      service => service.configurePolicyAttributes({ principalId: login.principalId }, actorContext),
      service => service.grantPolicyAttribute(input(login), actorContext),
      service => service.revokePolicyAttribute(input(login), actorContext)
    ];
    for (const [index, operation] of operations.entries()) {
      const before = await snapshot(login.principalId), connection = await pool.getConnection(), calls = [];
      try {
        const faulty = proxy(connection, { onExecute(sql) { calls.push(sql); } });
        const execute = faulty.execute.bind(faulty);
        faulty.execute = (sql,args) => execute(sql.includes('(principal_id, actor_principal_id, event_type, policy_attribute_id)') ?
          sql.replace('(principal_id,', '(missing_attributes_test_column,') : sql,args);
        await assert.rejects(operation(connectionApi(faulty)), error => error.code === 'ER_BAD_FIELD_ERROR');
        assert.ok(calls.some(sql => sql.startsWith(index === 0 ? 'UPDATE ' : index === 1 ? 'INSERT INTO ' : 'DELETE FROM ')));
      } finally { connection.release(); }
      assert.deepEqual(await snapshot(login.principalId), before);
      assert.equal(await operation(api), true); // Recovery succeeds: no partial flag, row or audit remains.
    }
  });

  await t.test('attributes: MySQL enforces principal FK, unique set, supported attribute and actor/target audit facts', async () => {
    const login = await provision(); await configure(login); await api.grantPolicyAttribute(input(login), actorContext);
    const insert = 'INSERT INTO ' + qualified('auth_policy_attributes') + ' (principal_id, attribute_id) VALUES (?, ?)';
    await assert.rejects(pool.execute(insert,[login.principalId,attributeId]), error => error.code === 'ER_DUP_ENTRY');
    await assert.rejects(pool.execute(insert,['00000000-0000-4000-8000-000000000099',attributeId]), error => error.code === 'ER_NO_REFERENCED_ROW_2');
    await assert.rejects(pool.execute(insert,[login.principalId,'administrator']), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
    await assert.rejects(pool.execute('INSERT INTO ' + qualified('auth_events') + ' (principal_id, event_type) VALUES (?, ?)',
      [login.principalId,'policy-attributes-configured']), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
    assert.equal((await events(login.principalId)).length, 2);
  });

  await t.test('attributes: rounding.self.excess remains an additional policy fact, not an approve permission or new trusted action', async () => {
    const login = await provision(); await configure(login); await api.grantPolicyAttribute(input(login), actorContext);
    const reviewFacts = createTrustedReviewFacts({ submittedByPrincipalId: login.principalId, exceptionalSelfApprovalRequired: true });
    let context = await read(login);
    assert.equal(authorizeReviewCommand({ principal: context.principal, action:'approveRounding',reviewFacts }).allowed,false);
    await auth.grantPermission({ principalId: login.principalId,permissionId:'rounding.approve' });
    context = await read(login);
    assert.equal(authorizeReviewCommand({ principal: context.principal,action:'approveRounding',reviewFacts }).reason,'missing-review-self');
    await auth.grantPermission({ principalId: login.principalId,permissionId:'review.self' });
    context = await read(login);
    assert.equal(authorizeReviewCommand({ principal: context.principal,action:'approveRounding',reviewFacts }).allowed,true);
    assert.equal(TRUSTED_ENABLED_ACTIONS.length,35);
    assert.equal(TRUSTED_ENABLED_ACTIONS.includes('approveRounding'),false);
    assert.throws(()=>authorizeTrustedExecution(context,{action:'approveRounding',payload:{}}),error=>error.reason==='trusted-action-not-enabled');
  });
  await t.test('expense attribute: 005 repeats safely, preserves rounding, and grants/revokes current boss facts with actor/target audit', async () => {
    const login=await provision(),boss='expense.approval.boss';await configure(login);
    await api.grantPolicyAttribute(input(login),actorContext);
    const bossInput={principalId:login.principalId,attributeId:boss};
    assert.equal(await api.grantPolicyAttribute(bossInput,actorContext),true);assert.equal(await api.grantPolicyAttribute(bossInput,actorContext),false);
    let current=await read(login);assert.equal(current.policyAttributesConfigured,true);assert.deepEqual(current.policyAttributeIds,[boss,attributeId]);
    const before=await snapshot(login.principalId);const statements=await applyExpenseApprovalAttributeMigration(pool);
    assert.equal(statements.length,2);await applyExpenseApprovalAttributeMigration(pool);assert.deepEqual(await snapshot(login.principalId),before);
    const audit=(await events(login.principalId)).find(e=>e.policy_attribute_id===boss);
    assert.equal(audit.actor_principal_id,actor.principalId);assert.equal(audit.principal_id,login.principalId);assert.equal(audit.session_id,null);
    const serialized=JSON.stringify(await events(login.principalId));assert.equal(serialized.includes(password),false);assert.equal(serialized.includes(login.token),false);
    for(const unsupported of ['boss','expense.approval.*','expense.approve'])await assert.rejects(pool.execute('INSERT INTO '+qualified('auth_policy_attributes')+' (principal_id,attribute_id) VALUES (?,?)',
      [login.principalId,unsupported]),e=>e.code==='ER_CHECK_CONSTRAINT_VIOLATED');
    assert.equal(await api.revokePolicyAttribute(bossInput,actorContext),true);current=await read(login);assert.deepEqual(current.policyAttributeIds,[attributeId]);
  });

  await t.test('expense attribute: real audit SQL failure rolls back boss grant and revoke without changing rounding or session', async () => {
    const login=await provision();await configure(login);await api.grantPolicyAttribute(input(login),actorContext);
    const bossInput={principalId:login.principalId,attributeId:'expense.approval.boss'};
    for(const method of ['grantPolicyAttribute','revokePolicyAttribute']){
      const before=await snapshot(login.principalId),connection=await pool.getConnection();
      try{
        const faulty=proxy(connection),execute=faulty.execute.bind(faulty);
        faulty.execute=(sql,args)=>execute(sql.includes('(principal_id, actor_principal_id, event_type, policy_attribute_id)')?sql.replace('(principal_id,','(missing_expense_attribute_test_column,'):sql,args);
        await assert.rejects(connectionApi(faulty)[method](bossInput,actorContext),e=>e.code==='ER_BAD_FIELD_ERROR');
      }finally{connection.release();}
      assert.deepEqual(await snapshot(login.principalId),before);assert.equal(await api[method](bossInput,actorContext),true);
    }
    assert.deepEqual((await read(login)).policyAttributeIds,[attributeId]);
  });

  await t.test('credit attributes: 006 repeats safely, keeps old facts, reads both specific tiers and audits independent actor/target',async()=>{
    // The preceding 005 repeat deliberately restored its older CHECK; extend it again.
    const statements=await applyCreditApprovalAttributesMigration(pool);assert.equal(statements.length,2);
    const login=await provision();await configure(login);await api.grantPolicyAttribute(input(login),actorContext);
    for(const attributeId of ['expense.approval.boss','credit.approval.manager','credit.approval.boss']){
      const attrInput={principalId:login.principalId,attributeId};assert.equal(await api.grantPolicyAttribute(attrInput,actorContext),true);
      assert.equal(await api.grantPolicyAttribute(attrInput,actorContext),false);
    }
    const before=await snapshot(login.principalId);await applyCreditApprovalAttributesMigration(pool);await applyCreditApprovalAttributesMigration(pool);
    assert.deepEqual(await snapshot(login.principalId),before);
    let current=await read(login);assert.equal(current.policyAttributesConfigured,true);
    assert.deepEqual(current.policyAttributeIds,['credit.approval.boss','credit.approval.manager','expense.approval.boss','rounding.self.excess']);
    for(const attributeId of ['credit.approval.manager','credit.approval.boss']){
      const audit=(await events(login.principalId)).find(e=>e.policy_attribute_id===attributeId);
      assert.equal(audit.actor_principal_id,actor.principalId);assert.equal(audit.principal_id,login.principalId);assert.notEqual(audit.actor_principal_id,audit.principal_id);
      assert.equal(audit.session_id,null);assert.equal(audit.reason_code,null);assert.ok(audit.occurred_at);
      await api.revokePolicyAttribute({principalId:login.principalId,attributeId},actorContext);
      assert.equal((await read(login)).policyAttributeIds.includes(attributeId),false);
    }
    const serialized=JSON.stringify(await events(login.principalId));assert.equal(serialized.includes(password),false);assert.equal(serialized.includes(login.token),false);
    assert.deepEqual((await read(login)).policyAttributeIds,['expense.approval.boss','rounding.self.excess']);
    for(const unsupported of ['manager','boss','credit.approval.*','credit.approve'])await assert.rejects(pool.execute('INSERT INTO '+qualified('auth_policy_attributes')+' (principal_id,attribute_id) VALUES (?,?)',
      [login.principalId,unsupported]),e=>e.code==='ER_CHECK_CONSTRAINT_VIOLATED');
  });

  await t.test('credit attributes: audit SQL failure fully rolls back manager/boss grant and revoke',async()=>{
    const login=await provision();await configure(login);await api.grantPolicyAttribute(input(login),actorContext);
    for(const attributeId of ['credit.approval.manager','credit.approval.boss'])for(const method of ['grantPolicyAttribute','revokePolicyAttribute']){
      const attrInput={principalId:login.principalId,attributeId},before=await snapshot(login.principalId),connection=await pool.getConnection();
      try{
        const faulty=proxy(connection),execute=faulty.execute.bind(faulty);
        faulty.execute=(sql,args)=>execute(sql.includes('(principal_id, actor_principal_id, event_type, policy_attribute_id)')?sql.replace('(principal_id,','(missing_credit_attribute_test_column,'):sql,args);
        await assert.rejects(connectionApi(faulty)[method](attrInput,actorContext),e=>e.code==='ER_BAD_FIELD_ERROR');
      }finally{connection.release();}
      assert.deepEqual(await snapshot(login.principalId),before);assert.equal(await api[method](attrInput,actorContext),true);
    }
    assert.deepEqual((await read(login)).policyAttributeIds,[attributeId]);
  });

}
