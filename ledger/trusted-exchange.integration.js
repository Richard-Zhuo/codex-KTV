import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact } from '../rules.js';
import { total } from '../sales.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { seedTrustedExchange, exchangeOrder, exchangeLines, exchangeLineSelector, exchangeCommand,
  seedExistingExchangeTarget } from '../test-support/trusted-exchange-fixture.js';

const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
const sqlAt = (run, name, clause) => run.calls.findIndex(call => call.kind === 'sql' && call.sql.includes(name) &&
  (clause.startsWith('FOR ') ? call.sql.endsWith(clause) : call.sql.startsWith(clause + ' ')));

// Uses the guarded ten-table fixture; owns no DDL or cleanup lifecycle.
export async function testTrustedExchange({ t, pool, setup, auth, table, provision, seed, inspect, application,
  assertUnchanged, wrapConnection, poolOptions, database }) {
  const runFor = (id, options = {}) => application(id, { employeeBind: null, ...options });

  await t.test('exchange: one connection locks auth then commits both stock legs, order, operation and audit with session actor', async () => {
    const login = await provision(['order.exchange']), id = 'exchange-first';
    const original = await seed(id, seedTrustedExchange), connection = await pool.getConnection(); let borrows = 0;
    const [[activity]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [login.sessionId]);
    try {
      const run = runFor(id, { connectionPool: { getConnection: async () => { borrows++; return wrapConnection(connection, [], false); } } });
      const cmd = exchangeCommand('first', 0, { actorId: 'administrator', principalId: 'forged', role: 'administrator', permissions: ['*'],
        user: 'administrator', clock: '1900-01-01', person: 'forged', actualActorPrincipalId: 'forged', employee: 'untrusted-name' });
      const result = await run.app.execute(cmd, login.credential), actual = await inspect(id), state = actual.head.state, order = exchangeOrder(state);
      assert.equal(result.status, 'committed'); assert.equal(result.actorId, login.principalId); assert.equal(actual.head.revision, 1);
      assert.equal(run.executions(), 1); assert.equal(order.drinks[0].count, 17); assert.equal(order.drinks[1].count, 3);
      assert.equal(state.inventory.lm.count, 53); assert.equal(state.inventory.soda0.count, 17);
      assert.equal(state.inventory.qd.count, null); assert.equal(state.inventory.water.count, 0); assert.equal(state.orders[0].room, null);
      assert.equal(total(order), total(exchangeOrder(original))); assert.equal(order.exchanges.length, 1);
      assert.deepEqual(state.ledger.slice(-2).map(line => [line.product, line.delta, line.baseQuantityDelta, line.counted]),
        [['lm', 3, 3, true], ['soda0', -3, -3, true]]);
      const dbNow = run.context().dbNow;
      assert.ok([...state.ledger.slice(-2), ...order.exchanges].every(line => line.person === login.principalId &&
        line.actualActorPrincipalId === login.principalId && line.time === dbNow));
      assert.equal(actual.operations.length, 1); assert.deepEqual(actual.operations[0].terminal_result, result);
      assert.equal(actual.operations[0].actor_principal_id, login.principalId); assert.equal(actual.audit.length, 1);
      assert.equal(actual.audit[0].actor_principal_id, login.principalId); assert.equal(actual.audit[0].action, 'exchange');
      const expected = structuredClone(original); expected.inventory.lm.count += 3; expected.inventory.soda0.count -= 3;
      exchangeOrder(expected).drinks[0].count -= 3; exchangeOrder(expected).drinks.push(order.drinks[1]);
      exchangeOrder(expected).exchanges.push(order.exchanges[0]); expected.ledger.push(...state.ledger.slice(-2));
      expected.serial += 3; expected.processed.push('first'); assert.deepEqual(state, expected);
      const sequence = [run.calls.findIndex(call => call.kind === 'begin'), sqlAt(run, 'ledger_heads', 'FOR UPDATE'),
        sqlAt(run, 'auth_accounts', 'FOR UPDATE'), sqlAt(run, 'auth_sessions', 'FOR UPDATE'), sqlAt(run, 'auth_grants', 'FOR UPDATE'),
        sqlAt(run, 'AS db_now', 'SELECT'), sqlAt(run, 'ledger_operations', 'SELECT'), run.calls.findIndex(call => call.kind === 'transact'),
        sqlAt(run, 'ledger_heads', 'UPDATE'), sqlAt(run, 'ledger_operations', 'INSERT'), sqlAt(run, 'ledger_success_audit', 'INSERT'),
        run.calls.findIndex(call => call.kind === 'commit')];
      assert.ok(sequence.every(index => index >= 0)); assert.deepEqual(sequence, [...sequence].sort((a, b) => a - b));
      assert.equal(borrows, 1); assert.equal(run.calls.filter(call => call.kind === 'begin').length, 1);
      assert.equal(run.calls.filter(call => call.kind === 'commit').length, 1); assert.equal(run.calls.filter(call => call.kind === 'rollback').length, 0);
      assert.equal(run.calls.filter(call => call.kind === 'db-now').length, 1); assert.equal(dbNow, run.calls.find(call => call.kind === 'db-now').value);
      assert.equal(Object.hasOwn(run.context(), 'creditedEmployeeId'), false); assert.equal(sqlAt(run, table('employees'), 'FOR SHARE'), -1);
      const [[after]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [login.sessionId]);
      assert.deepEqual(after, activity);
    } finally { try { await connection.rollback(); } finally { connection.release(); } }
  });

  await t.test('exchange: demo/backend/sales/inventory grants cannot authorize; denied operation key stays reusable', async () => {
    const login = await provision(['backend.view', 'staff.record', 'order.sale', 'order.gift', 'inventory.adjust']), id = 'exchange-denied';
    await seed(id, state => { seedTrustedExchange(state); state.user = 'administrator'; state.clock = 'invalid-demo-clock'; });
    const before = await inspect(id), run = runFor(id), cmd = exchangeCommand('denied', 0, { actorId: 'administrator', role: 'administrator', permissions: ['order.exchange'] });
    await assert.rejects(run.app.execute(cmd, login.credential), denied); assert.equal(run.executions(), 0); await assertUnchanged(id, before);
    await auth.grantPermission({ principalId: login.principalId, permissionId: 'order.exchange' });
    assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed');
    const actual = await inspect(id); assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
  });

  await t.test('exchange: original command requires no employee resolver or new employee attribution', async () => {
    const login = await provision(['order.exchange']), id = 'exchange-attribution'; await seed(id, seedTrustedExchange);
    const before = await inspect(id), run = runFor(id);
    await assert.rejects(run.app.execute(exchangeCommand('attribution', 0, { creditedEmployeeId: '10000000-0000-4000-8000-000000000001' }), login.credential),
      error => denied(error) && error.reason === 'invalid-attribution');
    await assertUnchanged(id, before); assert.equal(run.executions(), 0);
    assert.equal((await run.app.execute(exchangeCommand('attribution'), login.credential)).status, 'committed');
    assert.equal(sqlAt(run, table('employees'), 'FOR SHARE'), -1);
  });

  await t.test('exchange: package/sale/existing approved bonus support original partial/full exchange and target merging', async () => {
    const login = await provision(['order.exchange']); let index = 0;
    for (const scope of ['套餐', '增购', '赠送']) for (const existing of [false, true]) for (const full of [false, true]) {
      const id = 'exchange-scope-' + (++index), original = await seed(id, state => {
        seedTrustedExchange(state); if (existing) seedExistingExchangeTarget(state, scope);
      });
      const originalLine = exchangeLines(original, scope)[0], originalTarget = exchangeLines(original, scope)[1], count = full ? originalLine.count : 3;
      const run = runFor(id); assert.equal((await run.app.execute(exchangeCommand('scope', 0,
        { line: exchangeLineSelector(scope), count }), login.credential)).status, 'committed');
      const { head } = await inspect(id), order = exchangeOrder(head.state), lines = exchangeLines(head.state, scope);
      assert.deepEqual(lines[0], { ...originalLine, count: originalLine.count - count });
      if (existing) assert.deepEqual(lines[1], { ...originalTarget, count: 2 + count });
      else assert.equal(lines[1].totalBaseQuantity, count);
      assert.equal(order.exchanges[0].scope, scope); assert.equal(total(order), total(exchangeOrder(original)));
      assert.equal(order.sales[0].amountCents, 11800); assert.equal(order.sales[0].pricePerSaleUnitCents, null);
      assert.equal(order.sales[0].totalBaseQuantity, 12); assert.equal(order.sales[0].baseQuantityPerSaleUnit, 12);
      assert.equal(order.bonusGifts[0].referenceValueCents, 5900);
      for (const field of ['giftRequests', 'payments', 'resolvedComponents', 'extras', 'otherCharges']) assert.deepEqual(order[field], exchangeOrder(original)[field]);
      assert.deepEqual(head.state.rooms, original.rooms); assert.equal(head.revision, 1);
    }
    await seed('exchange-opening-alias', seedTrustedExchange);
    assert.equal((await runFor('exchange-opening-alias').app.execute(exchangeCommand('alias', 0, { line: 'gift:501' }), login.credential)).status, 'committed');
  });

  await t.test('exchange: counted/null/zero inventory retains original base-unit returns and withdrawals', async () => {
    const login = await provision(['order.exchange']); let index = 0;
    for (const [sourceCount, targetCount] of [[50, 20], [0, 20], [null, 20], [50, null], [null, null]]) {
      const id = 'exchange-counted-' + (++index); await seed(id, state => { seedTrustedExchange(state);
        state.inventory.lm.count = sourceCount; state.inventory.soda0.count = targetCount; });
      assert.equal((await runFor(id).app.execute(exchangeCommand(), login.credential)).status, 'committed');
      const { head } = await inspect(id); assert.equal(head.state.inventory.lm.count, sourceCount === null ? null : sourceCount + 3);
      assert.equal(head.state.inventory.soda0.count, targetCount === null ? null : targetCount - 3);
      assert.deepEqual(head.state.ledger.slice(-2).map(line => [line.delta, line.counted]), [[3, sourceCount !== null], [-3, targetCount !== null]]);
      assert.equal(head.state.inventory.qd.count, null); assert.equal(head.state.inventory.water.count, 0);
    }
  });

  await t.test('exchange: runtime non-inventory flags preserve original no-stock/no-ledger effects', async () => {
    const login = await provision(['order.exchange']); let index = 0;
    for (const [sourceManaged, targetManaged] of [[false, true], [true, false], [false, false]]) {
      const id = 'exchange-unmanaged-' + (++index), original = await seed(id, state => { seedTrustedExchange(state);
        state.catalog.products.find(p => p.id === 'lm').inventoryManaged = sourceManaged;
        state.catalog.products.find(p => p.id === 'soda0').inventoryManaged = targetManaged; });
      assert.equal((await runFor(id).app.execute(exchangeCommand(), login.credential)).status, 'committed');
      const { head } = await inspect(id); assert.equal(head.state.inventory.lm.count, sourceManaged ? 53 : 50);
      assert.equal(head.state.inventory.soda0.count, targetManaged ? 17 : 20);
      assert.deepEqual(head.state.ledger.slice(1).map(line => [line.product, line.delta]),
        [...(sourceManaged ? [['lm', 3]] : []), ...(targetManaged ? [['soda0', -3]] : [])]);
      assert.equal(total(exchangeOrder(head.state)), total(exchangeOrder(original)));
    }
  });

  await t.test('exchange: existing room/product/quantity checks persist business rejection without a half stock return', async () => {
    const login = await provision(['order.exchange']);
    const cases = [['missing', { order: 'missing' }, () => {}, /账单已变化/],
      ['closed', {}, state => exchangeOrder(state).status = '已结账', /账单已变化/],
      ['zero', { count: 0 }, () => {}, /数量/], ['negative', { count: -1 }, () => {}, /数量/], ['fraction', { count: 1.5 }, () => {}, /数量/],
      ['overflow', { count: Number.MAX_SAFE_INTEGER + 1 }, () => {}, /数量/], ['line', { line: 'sale:999' }, () => {}, /超过可换/],
      ['quantity', { count: 21 }, () => {}, /超过可换/], ['upward', { line: 'sale:601', product: 'lm' }, () => {}, /同级或更低/],
      ['same', { product: 'lm' }, () => {}, /同级或更低/], ['selection', { product: 'drink' }, () => {}, /同级或更低/],
      ['unknown-product', { product: 'unknown' }, () => {}, /商品/],
      ['water-source', {}, state => { exchangeOrder(state).drinks[0].product = 'water'; exchangeOrder(state).drinks[0].productId = 'water'; }, /同级或更低/],
      ['target-zero', {}, state => state.inventory.soda0.count = 0, /库存不足/],
      ['target-short', {}, state => state.inventory.soda0.count = 2, /库存不足/],
      ['missing-source-stock', {}, state => delete state.inventory.lm, /库存账/], ['missing-target-stock', {}, state => delete state.inventory.soda0, /库存账/]];
    for (const [label, changes, prepare, message] of cases) {
      const id = 'exchange-rejection-' + label, original = await seed(id, state => { seedTrustedExchange(state); prepare(state); });
      const run = runFor(id), cmd = exchangeCommand('terminal', 0, changes), result = await run.app.execute(cmd, login.credential);
      assert.equal(result.status, 'business-rejected'); assert.match(result.reason, message); const before = await inspect(id);
      assert.deepEqual(before.head.state, original); assert.equal(before.head.revision, 0); assert.equal(before.operations.length, 1); assert.equal(before.audit.length, 0);
      await auth.revokePermission({ principalId: login.principalId, permissionId: 'order.exchange' });
      assert.deepEqual(await run.app.execute(cmd, login.credential), result); assert.equal(run.executions(), 1); await assertUnchanged(id, before);
      await auth.grantPermission({ principalId: login.principalId, permissionId: 'order.exchange' });
    }
  });

  await t.test('exchange: catalog rename/reprice/inactive flags never rewrite historical charges or snapshots', async () => {
    const login = await provision(['order.exchange']);
    for (const existing of [false, true]) {
      const id = 'exchange-history-' + existing, original = await seed(id, state => { seedTrustedExchange(state);
        if (existing) seedExistingExchangeTarget(state, '套餐');
        for (const p of state.catalog.products.filter(p => ['lm', 'soda0'].includes(p.id))) {
          p.name = 'Current ' + p.id; p.active = false; for (const option of p.saleOptions) option.priceCents += 100;
        } });
      assert.equal((await runFor(id).app.execute(exchangeCommand(), login.credential)).status, 'committed');
      const { head } = await inspect(id), order = exchangeOrder(head.state);
      assert.equal(order.drinks[0].productNameSnapshot, 'Historical Opening Beer'); assert.equal(order.drinks[0].referenceValueCents, null);
      assert.equal(order.drinks[1].productNameSnapshot, existing ? 'Historical Target' : 'Current soda0');
      assert.equal(total(order), total(exchangeOrder(original))); assert.deepEqual(order.sales, exchangeOrder(original).sales);
      assert.deepEqual(order.payments, exchangeOrder(original).payments); assert.deepEqual(order.resolvedComponents, exchangeOrder(original).resolvedComponents);
      assert.deepEqual(head.state.orders[0], original.orders[0]);
    }
  });

  await t.test('exchange: permission revoke and new pool reconnect replay original result without duplicate stock movement', async () => {
    const login = await provision(['order.exchange']), id = 'exchange-replay'; await seed(id, seedTrustedExchange);
    const cmd = exchangeCommand('original'), first = await runFor(id).app.execute(cmd, login.credential), before = await inspect(id);
    await auth.revokePermission({ principalId: login.principalId, permissionId: 'order.exchange' });
    const reconnect = mysql.createPool(poolOptions);
    try {
      const again = runFor(id, { connectionPool: reconnect, bind: createMySqlAuthStore({ pool: reconnect, database }).bindSessionRevalidation,
        transactCommand: () => assert.fail('terminal replay must not call transact') });
      assert.deepEqual(await again.app.execute(cmd, login.credential), first); assert.equal(again.executions(), 0);
      await assert.rejects(again.app.execute({ ...cmd, operationKey: 'new', expectedRevision: 1 }, login.credential), denied); await assertUnchanged(id, before);
    } finally { await reconnect.end(); }
  });

  await t.test('exchange: disabled/revoked/idle/absolute/credential invalidation blocks existing-operation access', async () => {
    for (const invalid of ['disabled', 'revoked', 'idle', 'absolute', 'credential']) {
      const login = await provision(['order.exchange']), id = 'exchange-auth-' + invalid; await seed(id, seedTrustedExchange);
      const run = runFor(id), cmd = exchangeCommand('private'); await run.app.execute(cmd, login.credential); const before = await inspect(id);
      if (invalid === 'disabled') await auth.disableAccount({ principalId: login.principalId });
      else if (invalid === 'revoked') assert.equal(await auth.logout(login.token), true);
      else if (invalid === 'credential') await auth.rotateCredential({ principalId: login.principalId, password: 'synthetic-exchange-rotation' });
      else if (invalid === 'idle') await pool.execute('UPDATE ' + table('auth_sessions') + ' SET idle_expires_at=created_at WHERE session_id=?', [login.sessionId]);
      else await pool.execute('UPDATE ' + table('auth_sessions') +
        ' SET idle_expires_at=created_at, absolute_expires_at=created_at+INTERVAL 1 MICROSECOND WHERE session_id=?', [login.sessionId]);
      run.calls.length = 0; await assert.rejects(run.app.execute(cmd, login.credential), error => error.code === 'AUTHENTICATION_REQUIRED');
      assert.equal(sqlAt(run, 'ledger_operations', 'SELECT'), -1); assert.equal(run.executions(), 1); await assertUnchanged(id, before);
    }
  });

  await t.test('exchange: actor/action/payload/expectedRevision conflicts precede current authorization', async () => {
    const login = await provision(['order.exchange']), other = await provision([]), id = 'exchange-conflicts'; await seed(id, seedTrustedExchange);
    const run = runFor(id), cmd = exchangeCommand('same'); await run.app.execute(cmd, login.credential); const before = await inspect(id);
    await auth.revokePermission({ principalId: login.principalId, permissionId: 'order.exchange' });
    const actorConflict = await run.app.execute(cmd, other.credential); assert.equal(actorConflict.status, 'idempotency-conflict'); assert.equal(actorConflict.reason, 'actor-mismatch');
    for (const changed of [{ ...cmd, expectedRevision: 1 }, { ...cmd, action: 'gift' }, { ...cmd, payload: { ...cmd.payload, count: 1 } }]) {
      const result = await run.app.execute(changed, login.credential); assert.equal(result.status, 'idempotency-conflict'); assert.equal(result.reason, 'request-mismatch');
    }
    assert.equal(run.executions(), 1); await assertUnchanged(id, before);
  });

  await t.test('exchange: stale revision persists unchanged terminal and never calls domain', async () => {
    const login = await provision(['order.exchange']), id = 'exchange-stale', original = await seed(id, seedTrustedExchange), run = runFor(id), cmd = exchangeCommand('stale', 99);
    const result = await run.app.execute(cmd, login.credential); assert.equal(result.status, 'revision-conflict'); assert.equal(run.executions(), 0);
    const before = await inspect(id); assert.deepEqual(before.head.state, original); assert.equal(before.head.revision, 0);
    assert.equal(before.operations.length, 1); assert.equal(before.audit.length, 0);
    await auth.revokePermission({ principalId: login.principalId, permissionId: 'order.exchange' });
    assert.deepEqual(await run.app.execute(cmd, login.credential), result); await assertUnchanged(id, before);
  });

  await t.test('exchange: unknown exception after both stock mutations rolls back and repaired original key succeeds', async () => {
    const login = await provision(['order.exchange']), id = 'exchange-program-fault'; await seed(id, seedTrustedExchange);
    const before = await inspect(id), cmd = exchangeCommand('retry'); let fail = true;
    const run = runFor(id, { transactCommand: (...args) => { const next = transact(...args); if (fail) throw Error('synthetic exchange unknown fault'); return next; } });
    await assert.rejects(run.app.execute(cmd, login.credential), /synthetic exchange unknown fault/);
    assert.ok(run.calls.some(call => call.kind === 'rollback')); await assertUnchanged(id, before);
    fail = false; assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed');
    const actual = await inspect(id); assert.equal(actual.head.revision, 1); assert.equal(actual.head.state.ledger.length, 3);
  });

  await t.test('exchange: SQL audit failure after head/operation writes rolls back both stock legs and leaves key reusable', async () => {
    const login = await provision(['order.exchange']), id = 'exchange-sql-fault'; await seed(id, seedTrustedExchange);
    const before = await inspect(id), key = 'exchange-audit-fault', cmd = exchangeCommand(key), run = runFor(id);
    await setup.query('ALTER TABLE ' + table('ledger_success_audit') + " ADD CONSTRAINT trusted_exchange_fault CHECK (operation_key <> 'exchange-audit-fault')");
    try {
      await assert.rejects(run.app.execute(cmd, login.credential), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
      assert.ok(sqlAt(run, 'ledger_heads', 'UPDATE') >= 0); assert.ok(sqlAt(run, 'ledger_operations', 'INSERT') >= 0);
      assert.ok(run.calls.some(call => call.kind === 'rollback')); await assertUnchanged(id, before);
    } finally { await setup.query('ALTER TABLE ' + table('ledger_success_audit') + ' DROP CHECK trusted_exchange_fault'); }
    assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed'); const actual = await inspect(id);
    assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1);
    assert.equal(actual.head.state.inventory.lm.count, 53); assert.equal(actual.head.state.inventory.soda0.count, 17);
    assert.equal(actual.head.state.ledger.length, 3); assert.equal(exchangeOrder(actual.head.state).exchanges.length, 1);
  });

  await t.test('exchange: two independent InnoDB connections execute only once for old revision and same-key retry', async () => {
    const login = await provision(['order.exchange']), a = await pool.getConnection(), b = await pool.getConnection();
    try {
      const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id'), [[bId]] = await b.query('SELECT CONNECTION_ID() AS id');
      assert.notEqual(aId.id, bId.id, 'requires two independent real MySQL connections');
      const aPool = { getConnection: async () => wrapConnection(a, [], false) }, bPool = { getConnection: async () => wrapConnection(b, [], false) };
      await seed('exchange-race', seedTrustedExchange);
      const first = runFor('exchange-race', { connectionPool: aPool }), second = runFor('exchange-race', { connectionPool: bPool });
      const results = await Promise.all([first.app.execute(exchangeCommand('a'), login.credential), second.app.execute(exchangeCommand('b'), login.credential)]);
      assert.deepEqual(results.map(result => result.status).sort(), ['committed', 'revision-conflict']);
      assert.equal(first.executions() + second.executions(), 1); const actual = await inspect('exchange-race');
      assert.equal(actual.head.revision, 1); assert.equal(actual.operations.length, 2); assert.equal(actual.audit.length, 1);
      await seed('exchange-same-key', seedTrustedExchange);
      const retryA = runFor('exchange-same-key', { connectionPool: aPool }), retryB = runFor('exchange-same-key', { connectionPool: bPool }), cmd = exchangeCommand('same');
      const repeated = await Promise.all([retryA.app.execute(cmd, login.credential), retryB.app.execute(cmd, login.credential)]);
      assert.deepEqual(repeated[0], repeated[1]); assert.equal(repeated[0].status, 'committed'); assert.equal(retryA.executions() + retryB.executions(), 1);
      const saved = await inspect('exchange-same-key'); assert.equal(saved.head.revision, 1); assert.equal(saved.operations.length, 1); assert.equal(saved.audit.length, 1);
      for (const { head } of [actual, saved]) {
        assert.equal(head.state.inventory.lm.count, 53); assert.equal(head.state.inventory.soda0.count, 17);
        assert.equal(head.state.ledger.length, 3); assert.equal(exchangeOrder(head.state).exchanges.length, 1);
        assert.equal(exchangeOrder(head.state).payments.length, 2); assert.equal(total(exchangeOrder(head.state)), 41100);
      }
      t.diagnostic('exchange revision/same-key races used two verified independent CONNECTION_ID values');
    } finally { try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); } }
  });
}
