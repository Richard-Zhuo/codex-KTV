// Stage 2C.1: trusted internal authentication on a caller-owned transaction.
// No pool, transaction lifecycle, session activity writes or business command dispatch.
import { timingSafeEqual } from 'node:crypto';
import { createTrustedPrincipal } from '../ledger/command-policy.js';
import { assertTrustedExecutionContext, registerTrustedExecutionContext } from '../shared/identity.js';
export { assertTrustedExecutionContext } from '../shared/identity.js';
const utcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const isDigest = value => Buffer.isBuffer(value) && value.length === 32;

function assertUtc(value) {
  if (typeof value !== 'string' || !utcPattern.test(value) || !Number.isFinite(Date.parse(value))) {
    throw Error('事务数据库 UTC 时间无效');
  }
}

// The non-locking locator is a hint only. Authoritative reads lock account first.
export async function lockSessionForDigest(port, tokenDigest) {
  if (!isDigest(tokenDigest)) return null;
  const located = await port.locateSessionByDigest(tokenDigest);
  if (!located) return null;
  const account = await port.lockAccount(located.principalId);
  if (!account) return null;
  const session = await port.lockSessionById(located.sessionId);
  if (!session || account.principalId !== located.principalId ||
      session.principalId !== account.principalId || session.sessionId !== located.sessionId ||
      !isDigest(session.tokenDigest) || !timingSafeEqual(session.tokenDigest, tokenDigest)) return null;
  return { account, session };
}

export function sessionValidAt({ account, session }, dbNow) {
  assertUtc(dbNow);
  assertUtc(session.idleExpiresAt);
  assertUtc(session.absoluteExpiresAt);
  return account.enabled === true && session.revoked === false &&
    session.credentialVersion === account.credentialVersion &&
    session.idleExpiresAt > dbNow && session.absoluteExpiresAt > dbNow;
}

export async function revalidateSessionInTransaction({ port, tokenDigest }) {
  const locked = await lockSessionForDigest(port, tokenDigest);
  if (!locked) return null;
  const { account, session } = locked;
  if (!account.enabled || session.revoked ||
      session.credentialVersion !== account.credentialVersion) return null;
  const permissionIds = await port.listGrants(account.principalId);
  const attributeIds = await port.listPolicyAttributes(account.principalId);
  if (typeof account.policyAttributesConfigured !== 'boolean' || !Array.isArray(attributeIds) ||
      (!account.policyAttributesConfigured && attributeIds.length)) throw Error('policy attributes 配置事实无效');
  const dbNow = await port.readDbNow(); // Exactly once, after account/session/grant/attribute locks.
  if (!sessionValidAt(locked, dbNow)) return null;
  const principal = createTrustedPrincipal({ id: account.principalId, permissionIds, policyAttributeIds: attributeIds });
  const context = Object.freeze({
    mode: 'trusted', principal, principalId: principal.id, sessionId: session.sessionId,
    permissionIds: principal.permissionIds,
    policyAttributesConfigured: account.policyAttributesConfigured,
    policyAttributeIds: account.policyAttributesConfigured ? principal.policyAttributeIds : null,
    dbNow, actorSnapshot: null
  });
  return registerTrustedExecutionContext(context);
}

export function requireConfiguredPolicyAttributes(context) {
  assertTrustedExecutionContext(context);
  if (!context.policyAttributesConfigured) {
    const error = Error('正式 policy attributes 尚未配置');
    error.code = 'AUTH_POLICY_ATTRIBUTES_UNCONFIGURED';
    throw error;
  }
  return context.policyAttributeIds;
}
