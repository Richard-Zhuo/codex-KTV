import { randomUUID } from 'node:crypto';
import { assertPasswordInput, derivePassword, verifyAbsentPassword, verifyPassword } from './password.js';
import { digestSessionToken, issueSessionToken } from './session-token.js';
import { PERMISSION_IDS } from '../shared/identity.js';

const invalidCredentials = Object.freeze({ ok: false, code: 'invalid-credentials' });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const formalPermissions = new Set(PERMISSION_IDS);

function assertLoginIdentifier(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() ||
      value.length > 191 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw TypeError('登录标识无效');
  }
}
function assertPrincipalId(value) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw TypeError('principal ID 无效');
}
function assertPermissionId(value) {
  // Reuse the existing formal permission catalog; unknown grants would poison trusted reads.
  if (typeof value !== 'string' || !formalPermissions.has(value)) {
    throw TypeError('只能保存具体 permission');
  }
}

export function createAuthService({
  store, rateLimiter, idleSeconds = 30 * 60, absoluteSeconds = 12 * 60 * 60
}) {
  if (!store || typeof store.runTransaction !== 'function' ||
      !rateLimiter || typeof rateLimiter.canAttempt !== 'function' ||
      typeof rateLimiter.recordFailure !== 'function' ||
      typeof rateLimiter.recordSuccess !== 'function' ||
      !Number.isSafeInteger(idleSeconds) || idleSeconds < 1 ||
      !Number.isSafeInteger(absoluteSeconds) || absoluteSeconds < idleSeconds) {
    throw TypeError('auth service 配置无效');
  }

  async function createAccount({ loginIdentifier, password }) {
    assertLoginIdentifier(loginIdentifier);
    const credential = await derivePassword(password);
    const principalId = randomUUID();
    await store.runTransaction(async tx => {
      await tx.insertAccount({ principalId, loginIdentifier, credential });
      await tx.appendEvent({ principalId, eventType: 'account-created' });
    });
    return Object.freeze({ principalId });
  }

  async function login({ loginIdentifier, password }) {
    assertLoginIdentifier(loginIdentifier);
    assertPasswordInput(password);
    if (!rateLimiter.canAttempt(loginIdentifier)) {
      await store.runTransaction(tx => tx.appendEvent({
        eventType: 'login-failure', reasonCode: 'rate-limited'
      }));
      return invalidCredentials;
    }
    const result = await store.runTransaction(async tx => {
      const candidate = await tx.findCredentialForLogin(loginIdentifier);
      const matches = candidate
        ? await verifyPassword(password, candidate.credential)
        : await verifyAbsentPassword(password);
      if (!candidate || !candidate.enabled || !matches) {
        await tx.appendEvent({ principalId: candidate?.principalId ?? null,
          eventType: 'login-failure', reasonCode: 'invalid-credentials' });
        return invalidCredentials;
      }
      const { token, digest } = issueSessionToken();
      const sessionId = randomUUID();
      await tx.insertSession({ sessionId, principalId: candidate.principalId, digest,
        credentialVersion: candidate.credentialVersion, idleSeconds, absoluteSeconds });
      await tx.appendEvent({ principalId: candidate.principalId, sessionId,
        eventType: 'login-success' });
      return Object.freeze({ ok: true, token, sessionId, principalId: candidate.principalId });
    });
    if (result.ok) rateLimiter.recordSuccess(loginIdentifier);
    else rateLimiter.recordFailure(loginIdentifier);
    return result;
  }

  async function authenticateSession(token) {
    const digest = digestSessionToken(token);
    if (!digest) return null;
    return store.runTransaction(async tx => {
      const session = await tx.findSessionByDigestForUpdate(digest);
      if (!session || session.revoked || !session.enabled || !session.idleValid ||
          !session.absoluteValid || session.sessionVersion !== session.accountVersion) return null;
      await tx.touchSession(session.sessionId, idleSeconds);
      const permissionIds = await tx.listGrants(session.principalId);
      return Object.freeze({ id: session.principalId, sessionId: session.sessionId,
        permissionIds: Object.freeze(permissionIds) });
    });
  }

  async function logout(token) {
    const digest = digestSessionToken(token);
    if (!digest) return false;
    return store.runTransaction(async tx => {
      const session = await tx.findSessionByDigestForUpdate(digest);
      if (!session || session.revoked) return false;
      await tx.revokeSession(session.sessionId);
      await tx.appendEvent({ principalId: session.principalId, sessionId: session.sessionId,
        eventType: 'logout' });
      return true;
    });
  }

  // Trusted internal administration ports only. Stage 2C must authorize their callers.
  async function revokeSession({ sessionId }) {
    assertPrincipalId(sessionId);
    return store.runTransaction(async tx => {
      const session = await tx.findSessionByIdForUpdate(sessionId);
      if (!session || session.revoked) return false;
      await tx.revokeSession(sessionId);
      await tx.appendEvent({ principalId: session.principalId, sessionId,
        eventType: 'session-revoked' });
      return true;
    });
  }

  async function disableAccount({ principalId }) {
    assertPrincipalId(principalId);
    return store.runTransaction(async tx => {
      const account = await tx.lockAccount(principalId);
      if (!account) throw Error('账号不存在');
      if (!account.enabled) return false;
      const activeSessionIds = await tx.listUnrevokedSessions(principalId);
      await tx.disableAccount(principalId);
      for (const sessionId of activeSessionIds) {
        await tx.revokeSession(sessionId);
        await tx.appendEvent({ principalId, sessionId, eventType: 'session-revoked' });
      }
      await tx.appendEvent({ principalId, eventType: 'account-disabled' });
      return true;
    });
  }

  async function rotateCredential({ principalId, password }) {
    assertPrincipalId(principalId);
    const credential = await derivePassword(password);
    return store.runTransaction(async tx => {
      const account = await tx.lockAccount(principalId);
      if (!account || !account.enabled) throw Error('账号不可更新凭据');
      await tx.listUnrevokedSessions(principalId);
      await tx.replaceCredential(principalId, credential);
      await tx.appendEvent({ principalId, eventType: 'credential-rotated' });
      return true;
    });
  }

  async function grantPermission({ principalId, permissionId }) {
    assertPrincipalId(principalId);
    assertPermissionId(permissionId);
    return store.runTransaction(async tx => {
      if (!await tx.lockAccount(principalId)) throw Error('账号不存在');
      const added = await tx.addGrant(principalId, permissionId);
      if (added) await tx.appendEvent({ principalId, eventType: 'grant-added' });
      return added;
    });
  }

  async function revokePermission({ principalId, permissionId }) {
    assertPrincipalId(principalId);
    assertPermissionId(permissionId);
    return store.runTransaction(async tx => {
      if (!await tx.lockAccount(principalId)) throw Error('账号不存在');
      const removed = await tx.removeGrant(principalId, permissionId);
      if (removed) await tx.appendEvent({ principalId, eventType: 'grant-removed' });
      return removed;
    });
  }

  return Object.freeze({ createAccount, login, authenticateSession, logout, revokeSession,
    disableAccount, rotateCredential, grantPermission, revokePermission });
}
