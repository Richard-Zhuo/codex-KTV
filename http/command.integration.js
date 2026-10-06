import assert from 'node:assert/strict';
import http from 'node:http';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createPolicyAttributeService } from '../auth/policy-attributes.js';
import { createMySqlLedgerStore } from '../ledger/mysql-store.js';
import { createTrustedLedgerApplication } from '../ledger/application.js';
import { createHttpApi } from './api.js';
import { createCurrentSessionReader } from './query.js';

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
    state.expenses.push(
      { id: 501, date: '2026-10-06', type: 'test', amount: 100,
        status: 'recorded', description: 'owner-only-secret',
        submittedByPrincipalId: expenseOwner.principalId },
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
    origin, environment: 'development', allowInsecureCookie: true,
    logger: { error: detail => diagnostics.push(detail) } };
  api = createHttpApi(options);
  const request = async (path, { method = 'GET', cookie, csrf, body, requestOrigin = origin } = {}) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    if (method !== 'GET') headers.Origin = requestOrigin;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(origin + path, { method, headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: response.status, body: await response.json(),
      cookie: response.headers.get('set-cookie'), requestId: response.headers.get('x-request-id') };
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
        policyAttributes: ['expense.approval.boss'], trustedContext: { dbNow: '2099' } };
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
      assert.equal(empty.body.revision, 1);
      assert.deepEqual(empty.body.view, { reviewSections: [] });
      const backendView = await snapshot(await login(backend));
      assert.deepEqual(backendView.body.view, { reviewSections: [] });
      const cleanerView = await snapshot(await login(cleaner));
      assert.equal(cleanerView.body.view.rooms[0].id, 'V01');
      assert.equal('expenses' in cleanerView.body.view, false);
      assert.equal(JSON.stringify(cleanerView.body).includes('owner-only-secret'), false);
      const ownerView = await snapshot(await login(expenseOwner));
      assert.deepEqual(ownerView.body.view.expenses.map(item => item.description), ['owner-only-secret']);
      const allView = await snapshot(await login(expenseAll));
      assert.deepEqual(allView.body.view.expenses.map(item => item.description),
        ['owner-only-secret', 'other-only-secret']);
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
      api = createHttpApi(options);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
