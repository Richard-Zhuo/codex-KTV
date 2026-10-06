import assert from 'node:assert/strict';
import http from 'node:http';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createPolicyAttributeService } from '../auth/policy-attributes.js';
import { createMySqlLedgerStore } from '../ledger/mysql-store.js';
import { createTrustedLedgerApplication } from '../ledger/application.js';
import { createHttpApi } from './api.js';
import { createCurrentSessionReader } from './query.js';
import { createEmployeeApiClient, HttpApiError, HttpTransportError } from '../ui/api-client.js';
import { createEmployeeServerState } from '../ui/server-state.js';
import { createEmployeeCommandFlow } from '../ui/command-flow.js';
import { stateFromServerSnapshot } from '../ui/formal-workspace.js';

export async function testHttpBoundary({ t, pool, auth, seed, inspect, database, employeeStore }) {
  const authStore = createMySqlAuthStore({ pool, database });
  const ledgerId = 'stage3a-http';
  const store = createMySqlLedgerStore({ pool, ledgerId, database,
    bindSessionRevalidation: authStore.bindSessionRevalidation,
    bindEmployeeResolver: employeeStore.bindEmployeeResolver });
  const trusted = createTrustedLedgerApplication({ store, businessTimeZone: 'Asia/Shanghai' });
  const sessionReader = createCurrentSessionReader({ pool, authStore });
  let serial = 0;
  const password = 'synthetic-http-test-password';
  const makeAccount = async (grants = []) => {
    const loginIdentifier = 'synthetic-http-' + (++serial);
    const { principalId } = await auth.createAccount({ loginIdentifier, password });
    for (const permissionId of grants) await auth.grantPermission({ principalId, permissionId });
    return { principalId, loginIdentifier };
  };
  const cleaner = await makeAccount(['room.clean']);
  const expenseOwner = await makeAccount(['expense.view']);
  const expenseAll = await makeAccount(['expense.viewAll']);
  const backend = await makeAccount(['backend.view', 'review.self']);
  const policyReviewer = await makeAccount(['expense.approve']);
  const none = await makeAccount();
  await seed(ledgerId, state => {
    state.internalAuditOnly = 'stage3a-never-return-internal-secret';
    state.rooms[0].futureSensitive = 'stage3a-never-return-room-secret';
    state.rooms[2].status = state.rooms[3].status = '待清洁';
    state.expenses.push(
      { id: 501, date: '2026-10-06', type: 'test', amount: 100,
        status: 'recorded', description: 'owner-only-secret',
        submittedByPrincipalId: expenseOwner.principalId,
        futureSensitive: 'stage3a-never-return-expense-secret' },
      { id: 502, date: '2026-10-06', type: 'test', amount: 200,
        status: 'recorded', description: 'other-only-secret',
        submittedByPrincipalId: cleaner.principalId }
    );
  });
  let api;
  const diagnostics = [];
  const server = http.createServer((req, res) => { void api.handle(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const options = { authService: auth, application: trusted, store, sessionReader,
    employeeStore,
    origin, environment: 'development', allowInsecureCookie: true,
    logger: { error: detail => diagnostics.push(detail) } };
  api = createHttpApi(options);
  const request = async (path, { method = 'GET', cookie, csrf, body,
    requestOrigin = origin, contentType = 'application/json' } = {}) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    if (method !== 'GET') headers.Origin = requestOrigin;
    if (body !== undefined) headers['Content-Type'] = contentType;
    const response = await fetch(origin + path, { method, headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: response.status, body: await response.json(),
      cookie: response.headers.get('set-cookie'),
      cacheControl: response.headers.get('cache-control'),
      requestId: response.headers.get('x-request-id') };
  };
  const login = async account => {
    const result = await request('/api/v1/auth/login',
      { method: 'POST', body: { loginIdentifier: account.loginIdentifier, password } });
    assert.equal(result.status, 200);
    assert.ok(result.cookie?.includes('HttpOnly'));
    const cookie = result.cookie.split(';')[0];
    assert.equal(JSON.stringify(result.body).includes(cookie.split('=')[1]), false);
    return { cookie, csrf: result.body.csrfToken };
  };
  const command = (session, action, operationKey, expectedRevision, payload, extra = {}) =>
    request('/api/v1/commands/' + action, { method: 'POST',
      cookie: session?.cookie, csrf: session?.csrf,
      body: { operationKey, expectedRevision, payload, ...extra } });
  const snapshot = session => request('/api/v1/store/snapshot', { cookie: session?.cookie });

  try {
    await t.test('HTTP unauthenticated, CSRF, spoof and registry gates', async () => {
      assert.deepEqual((await command(null, 'clean', 'no-session', 0, { room: 'V01' })).body.error.code,
        'unauthenticated');
      assert.equal((await snapshot(null)).body.error.code, 'unauthenticated');
      const signed = await login(cleaner);
      assert.deepEqual((await request('/api/v1/commands/clean', { method: 'POST',
        cookie: signed.cookie, body: { operationKey: 'no-csrf', expectedRevision: 0,
          payload: { room: 'V01' } } })).body.error.code, 'csrf_denied');
      assert.equal((await request('/api/v1/commands/clean', { method: 'POST',
        cookie: signed.cookie, csrf: 'A'.repeat(43),
        body: { operationKey: 'bad-csrf', expectedRevision: 0,
          payload: { room: 'V01' } } })).body.error.code, 'csrf_denied');
      assert.equal((await request('/api/v1/commands/clean', { method: 'POST',
        cookie: signed.cookie, csrf: signed.csrf, requestOrigin: 'https://attacker.example',
        body: { operationKey: 'cross-origin', expectedRevision: 0,
          payload: { room: 'V01' } } })).body.error.code, 'csrf_denied');
      const spoof = { principal: 'boss', principalId: 'boss', userId: 'boss',
        role: 'boss', permissions: ['room.clean', 'review.self', 'rounding.approve'],
        policyAttributes: ['expense.approval.boss'], trustedContext: { dbNow: '2099' },
        actualActorPrincipalId: 'boss', clock: '2099', dbNow: '2099' };
      for (const body of [
        { operationKey: 'spoof-top', expectedRevision: 0, payload: { room: 'V01' }, ...spoof },
        { operationKey: 'spoof-payload', expectedRevision: 0,
          payload: { room: 'V01', ...spoof } },
        { operationKey: 'bad-type', expectedRevision: '0', payload: { room: 'V01' } }
      ]) {
        const result = await request('/api/v1/commands/clean',
          { method: 'POST', cookie: signed.cookie, csrf: signed.csrf, body });
        assert.equal(result.body.error.code, 'invalid_input');
      }
      for (const action of ['unregistered', 'identity', 'setUser', 'clock',
        'setClock', 'reset', 'setPermissions']) {
        assert.equal((await command(signed, action, 'forbidden-' + action, 0, {})).body.error.code,
          'invalid_input');
      }
      assert.equal((await request('/api/v1/unknown')).body.error.code, 'invalid_input');
      const badType = await request('/api/v1/commands/clean', { method: 'POST',
        cookie: signed.cookie, csrf: signed.csrf, contentType: 'text/plain',
        body: '{"operationKey":"bad-type","expectedRevision":0,"payload":{"room":"V01"}}' });
      assert.equal(badType.body.error.code, 'invalid_input');
      const oversized = await command(signed, 'clean', 'oversized', 0,
        { room: 'V01', note: 'x'.repeat(1024 * 1024) });
      assert.equal(oversized.body.error.code, 'invalid_input');
      assert.equal((await inspect(ledgerId)).head.revision, 0);
    });

    await t.test('HTTP trusted commit, replay, conflicts and server actor', async () => {
      const signed = await login(cleaner);
      const first = await command(signed, 'clean', 'http-clean', 0, { room: 'V01',
        employeeId: expenseOwner.principalId, person: 'boss' });
      // clean has no employee attribution and rejects unknown business fields only if the domain does;
      // the actual actor must still be the authenticated principal.
      assert.equal(first.status, 200);
      assert.equal(first.body.result.actorId, cleaner.principalId);
      assert.equal(first.body.result.revision, 1);
      const again = await command(signed, 'clean', 'http-clean', 0, { room: 'V01',
        employeeId: expenseOwner.principalId, person: 'boss' });
      assert.deepEqual(again.body.result, first.body.result);
      const conflict = await command(signed, 'clean', 'http-clean', 0, { room: 'V02' });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.error.code, 'idempotency_conflict');
      const stale = await command(signed, 'clean', 'http-stale', 0, { room: 'V02' });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.code, 'revision_conflict');
      const saved = await inspect(ledgerId);
      assert.equal(saved.head.revision, 1);
      assert.equal(saved.operations.length, 2);
      assert.equal(saved.audit.length, 1);
      assert.equal(saved.operations[0].actor_principal_id ?? saved.operations[0].actorId,
        cleaner.principalId);
      const rejected = await command(signed, 'clean', 'http-business', 1, { room: 'UNKNOWN' });
      assert.equal(rejected.status, 422);
      assert.equal(rejected.body.error.code, 'business_rejection');
      assert.equal((await inspect(ledgerId)).head.revision, 1);
    });

    await t.test('HTTP current permission and policy-attribute filtering', async () => {
      const empty = await snapshot(await login(none));
      assert.equal(empty.status, 200);
      assert.equal(empty.cacheControl, 'no-store');
      assert.equal(empty.body.revision, 1);
      assert.deepEqual(empty.body.view, { reviewSections: [] });
      const backendView = await snapshot(await login(backend));
      assert.deepEqual(backendView.body.view, { reviewSections: [] });
      const cleanerView = await snapshot(await login(cleaner));
      assert.equal(cleanerView.body.view.rooms[0].id, 'V01');
      assert.equal('expenses' in cleanerView.body.view, false);
      assert.equal(JSON.stringify(cleanerView.body).includes('owner-only-secret'), false);
      for (const secret of ['stage3a-never-return-internal-secret',
        'stage3a-never-return-room-secret', 'stage3a-never-return-expense-secret']) {
        assert.equal(JSON.stringify(cleanerView.body).includes(secret), false);
      }
      const ownerView = await snapshot(await login(expenseOwner));
      assert.deepEqual(ownerView.body.view.expenses.map(item => item.description), ['owner-only-secret']);
      const allView = await snapshot(await login(expenseAll));
      assert.deepEqual(allView.body.view.expenses.map(item => item.description),
        ['owner-only-secret', 'other-only-secret']);
      assert.equal(JSON.stringify(allView.body).includes('stage3a-never-return-expense-secret'),
        false);
      const reviewer = await login(policyReviewer);
      assert.deepEqual((await snapshot(reviewer)).body.view.reviewSections, []);
      const policy = createPolicyAttributeService({ store: authStore });
      await policy.configurePolicyAttributes({ principalId: policyReviewer.principalId },
        { actorPrincipalId: policyReviewer.principalId });
      await policy.grantPolicyAttribute({ principalId: policyReviewer.principalId,
        attributeId: 'expense.approval.boss' }, { actorPrincipalId: policyReviewer.principalId });
      assert.deepEqual((await snapshot(reviewer)).body.view.reviewSections, ['expense.approve']);
      await policy.revokePolicyAttribute({ principalId: policyReviewer.principalId,
        attributeId: 'expense.approval.boss' }, { actorPrincipalId: policyReviewer.principalId });
      assert.deepEqual((await snapshot(reviewer)).body.view.reviewSections, []);
    });

    await t.test('HTTP denies unauthorized command and transaction-time disable', async () => {
      const backendSession = await login(backend);
      assert.equal((await command(backendSession, 'approveRounding',
        'backend-review', 1, {})).body.error.code, 'authorization_denied');
      const delayed = await makeAccount(['room.clean']);
      const signed = await login(delayed);
      api = createHttpApi({ ...options, application: {
        async execute(body, credential) {
          await auth.disableAccount({ principalId: delayed.principalId });
          return trusted.execute(body, credential);
        }
      } });
      const denied = await command(signed, 'clean', 'after-disable', 1, { room: 'V02' });
      assert.equal(denied.status, 401);
      assert.equal(denied.body.error.code, 'unauthenticated');
      assert.equal((await inspect(ledgerId)).head.revision, 1);
      api = createHttpApi(options);

      const removed = await makeAccount(['room.clean']);
      const removalSession = await login(removed);
      api = createHttpApi({ ...options, application: {
        async execute(body, credential) {
          await auth.revokePermission({ principalId: removed.principalId,
            permissionId: 'room.clean' });
          return trusted.execute(body, credential);
        }
      } });
      const deniedAfterRemoval = await command(removalSession, 'clean',
        'after-permission-removal', 1, { room: 'V02' });
      assert.equal(deniedAfterRemoval.status, 403);
      assert.equal(deniedAfterRemoval.body.error.code, 'authorization_denied');
      assert.equal((await inspect(ledgerId)).head.revision, 1);
      api = createHttpApi(options);
    });

    await t.test('HTTP revoked, expired, disabled and credential-version session status', async () => {
      const revoked = await makeAccount();
      const r = await login(revoked);
      assert.equal((await request('/api/v1/auth/logout', { method: 'POST', cookie: r.cookie,
        csrf: r.csrf })).status, 200);
      assert.equal((await snapshot(r)).body.error.code, 'unauthenticated');

      const expired = await makeAccount();
      const e = await login(expired);
      await pool.execute('UPDATE auth_sessions SET idle_expires_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND) WHERE principal_id = ?',
        [expired.principalId]);
      assert.equal((await snapshot(e)).body.error.code, 'unauthenticated');

      const disabled = await makeAccount();
      const d = await login(disabled);
      await auth.disableAccount({ principalId: disabled.principalId });
      assert.equal((await snapshot(d)).body.error.code, 'unauthenticated');

      const rotated = await makeAccount();
      const v = await login(rotated);
      await auth.rotateCredential({ principalId: rotated.principalId,
        password: 'synthetic-http-rotated-password' });
      assert.equal((await snapshot(v)).body.error.code, 'unauthenticated');
    });

    await t.test('HTTP internal error returns only generic envelope and correlated diagnostic', async () => {
      const signed = await login(cleaner);
      api = createHttpApi({ ...options, application: {
        async execute() { throw Error('synthetic SQL stack password=secret internal/path'); }
      } });
      const failed = await command(signed, 'clean', 'http-internal', 1, { room: 'V02' });
      assert.equal(failed.status, 500);
      assert.equal(failed.body.error.code, 'internal_error');
      assert.equal(failed.body.error.requestId, failed.requestId);
      assert.equal(JSON.stringify(failed.body).includes('synthetic SQL'), false);
      assert.equal(JSON.stringify(failed.body).includes('secret'), false);
      assert.equal(diagnostics.at(-1).requestId, failed.requestId);
      assert.equal((await inspect(ledgerId)).head.revision, 1);

      api = createHttpApi({ ...options, application: {
        async execute() {
          await pool.execute('SELECT * FROM stage3a_missing_table_for_error_test');
        }
      } });
      const sqlFailure = await command(signed, 'clean', 'http-sql-error', 1,
        { room: 'V02' });
      assert.equal(sqlFailure.status, 500);
      assert.equal(sqlFailure.body.error.code, 'internal_error');
      assert.equal(sqlFailure.body.error.requestId, sqlFailure.requestId);
      assert.equal(JSON.stringify(sqlFailure.body).includes('stage3a_missing_table'), false);
      assert.equal(diagnostics.at(-1).requestId, sqlFailure.requestId);
      api = createHttpApi(options);
    });

    await t.test('HTTP login replaces an existing cookie without principal fixation', async () => {
      const first = await login(cleaner);
      const replacement = await request('/api/v1/auth/login', { method: 'POST',
        cookie: first.cookie, body: { loginIdentifier: backend.loginIdentifier, password } });
      assert.equal(replacement.status, 200);
      assert.notEqual(replacement.cookie.split(';')[0], first.cookie);
      assert.equal(replacement.body.session.principalId, backend.principalId);
      assert.equal(replacement.cacheControl, 'no-store');
      const oldStatus = await request('/api/v1/auth/session', { cookie: first.cookie });
      assert.equal(oldStatus.body.session.principalId, cleaner.principalId);
      const newCookie = replacement.cookie.split(';')[0];
      assert.equal((await request('/api/v1/commands/clean', { method: 'POST',
        cookie: newCookie, csrf: first.csrf,
        body: { operationKey: 'old-csrf-new-session', expectedRevision: 1,
          payload: { room: 'V02' } } })).body.error.code, 'csrf_denied');
    });

    await t.test('HTTP snapshot keeps revision and projected state coherent across two connections', async () => {
      const outside = await pool.getConnection();
      try {
        await assert.rejects(store.readInTransaction(outside), /active transaction/);
      } finally {
        outside.release();
      }
      const reader = await makeAccount(['room.clean']);
      const readerSession = await login(reader);
      const writerSession = await login(cleaner);
      const before = (await inspect(ledgerId)).head;
      let authConnection;
      let enteredRead;
      const entered = new Promise(resolve => { enteredRead = resolve; });
      let releaseRead;
      const paused = new Promise(resolve => { releaseRead = resolve; });
      const readerAuthStore = { bindSessionRevalidation(connection) {
        authConnection = connection;
        return authStore.bindSessionRevalidation(connection);
      } };
      const raceReader = createCurrentSessionReader({ pool, authStore: readerAuthStore });
      const raceStore = { ...store, async readInTransaction(connection) {
        assert.strictEqual(connection, authConnection);
        const [[row]] = await connection.query('SELECT CONNECTION_ID() AS id');
        assert.match(String(row.id), /^\d+$/);
        enteredRead();
        await paused;
        return store.readInTransaction(connection);
      } };
      api = createHttpApi({ ...options, store: raceStore, sessionReader: raceReader });
      const pending = snapshot(readerSession);
      try {
        await Promise.race([entered, pending.then(result => {
          throw Error('Snapshot returned before read gate: ' + result.body?.error?.code);
        })]);
        const second = await pool.getConnection();
        try {
          const [[row]] = await second.query('SELECT CONNECTION_ID() AS id');
          assert.notEqual(String(row.id), String(authConnection.threadId));
        } finally {
          second.release();
        }
        const write = await command(writerSession, 'clean', 'snapshot-race-write', 1,
          { room: 'V02' });
        assert.equal(write.status, 200);
        assert.equal(write.body.result.revision, 2);
      } finally {
        releaseRead();
      }
      const result = await pending;
      api = createHttpApi(options);
      const after = (await inspect(ledgerId)).head;
      assert.equal(result.status, 200);
      assert.equal(result.cacheControl, 'no-store');
      assert.ok([before.revision, after.revision].includes(result.body.revision));
      const expected = result.body.revision === before.revision ? before : after;
      assert.deepEqual(result.body.view.rooms, expected.state.rooms.map(room =>
        ({ id: room.id, type: room.type, status: room.status })));
      assert.notDeepEqual(before.state.rooms, after.state.rooms);
    });
    await t.test('Stage 3B employee clients reload server truth, conflict, and replay a lost response', async () => {
      function browserClient() {
        let cookie = '';
        let loseNextCommandResponse = false;
        const fetchImpl = async (path, options) => {
          const headers = new Headers(options.headers);
          if (cookie) headers.set('Cookie', cookie);
          if (options.method === 'POST') headers.set('Origin', origin);
          const response = await fetch(origin + path, { ...options, headers });
          if (response.headers.get('set-cookie')) {
            cookie = response.headers.get('set-cookie').split(';')[0];
          }
          if (loseNextCommandResponse && path.startsWith('/api/v1/commands/')) {
            loseNextCommandResponse = false;
            throw new Error('response lost after server commit');
          }
          return response;
        };
        const client = createEmployeeApiClient({ fetchImpl });
        const state = createEmployeeServerState(client);
        const flow = createEmployeeCommandFlow({ api: client, state });
        return { client, state, flow, loseResponse() { loseNextCommandResponse = true; } };
      }
      const a = browserClient();
      const b = browserClient();
      for (const browser of [a, b]) {
        await browser.client.login(cleaner.loginIdentifier, password);
        await browser.state.bootstrap();
        assert.equal(browser.state.getState().phase, 'ready');
        assert.equal(browser.state.getState().snapshot.revision, 2);
        const projected = stateFromServerSnapshot(browser.state.getState().snapshot,
          browser.state.getState().session);
        assert.equal(projected.user, cleaner.principalId);
        assert.equal(projected.rooms.length, 9);
      }
      const committed = await b.flow.submit('clean', { room: 'V03' });
      assert.equal(committed.refreshed, true);
      assert.equal(b.state.getState().snapshot.revision, 3);
      await assert.rejects(a.flow.submit('clean', { room: 'V05' }),
        error => error instanceof HttpApiError && error.code === 'revision_conflict');
      assert.equal(a.state.getState().snapshot.revision, 3);
      assert.equal((await inspect(ledgerId)).head.revision, 3);
      a.loseResponse();
      await assert.rejects(a.flow.submit('clean', { room: 'V05' }),
        error => error instanceof HttpTransportError && error.ambiguous);
      const pending = a.flow.getStatus();
      assert.equal(pending.phase, 'unknown');
      assert.equal((await inspect(ledgerId)).head.revision, 4);
      const replay = await a.flow.retryUnknown();
      assert.equal(replay.refreshed, true);
      assert.equal(a.state.getState().snapshot.revision, 4);
      assert.equal(a.flow.getStatus().phase, 'idle');
      assert.equal((await inspect(ledgerId)).head.revision, 4);
    });

  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
