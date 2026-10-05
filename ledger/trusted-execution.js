// Migrated execution is a separate gate from Stage 2A eligibility.
import { authorizeCommand } from './command-policy.js';
import { EMPLOYEE_ATTRIBUTED_ACTIONS, employeePolicyPayload } from './employee-attribution.js';
import { assertTrustedExecutionContext, AuthorizationDenied } from '../shared/identity.js';

export const TRUSTED_ENABLED_ACTIONS = Object.freeze(['clean', 'markRoomIssue', 'clearRoomIssue',
  'createCatalogProduct', 'updateCatalogProduct', 'updateCatalogPackage', 'cancelReservation', 'deposit', 'withdraw', 'reserve', 'sale', 'retailSale', 'serveExtra', 'otherCharge', 'exchange',
  'approveRoomIssue', 'rejectRoomIssue', 'stock', 'consumableStock', 'approveInventory', 'rejectInventory', 'gift', 'approveGift', 'rejectGift', 'expense', 'approveExpense', 'rejectExpense', 'credit', 'approve', 'reject', 'repay', 'approveRepayment', 'rejectRepayment', 'incident', 'resolveIncident', 'approveIncidentResolution', 'rejectIncidentResolution', 'procurement']);
const enabled = new Set(TRUSTED_ENABLED_ACTIONS);

export class SessionAuthenticationRequired extends Error {
  constructor() {
    super('需要有效的账号与 session');
    this.name = 'SessionAuthenticationRequired';
    this.code = 'AUTHENTICATION_REQUIRED';
    this.status = 'authentication-required';
  }
}

// Authentication material is separate from the fingerprinted business request.
// Copy the digest before awaiting so the caller cannot change it in flight.
export function prepareSessionCredential(credential) {
  if (!credential || Object.getPrototypeOf(credential) !== Object.prototype ||
      Reflect.ownKeys(credential).length !== 1 ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(credential, 'tokenDigest') || {}, 'value') ||
      !Buffer.isBuffer(credential.tokenDigest) || credential.tokenDigest.length !== 32) {
    throw new SessionAuthenticationRequired();
  }
  return { tokenDigest: Buffer.from(credential.tokenDigest) };
}

export async function revalidateCommandSession(transaction, credential) {
  if (typeof transaction.sessionRevalidation?.revalidateSessionInTransaction !== 'function') {
    throw TypeError('正式账本缺少同事务 session revalidation port');
  }
  const context = await transaction.sessionRevalidation.revalidateSessionInTransaction(credential);
  if (!context) throw new SessionAuthenticationRequired();
  return assertTrustedExecutionContext(context);
}

// Called only for a new operation key, after authentication and saved-result lookup.
export function authorizeTrustedExecution(context, request) {
  assertTrustedExecutionContext(context);
  if (!enabled.has(request.action)) throw new AuthorizationDenied('trusted-action-not-enabled');
  const policy = authorizeCommand({ principal: context.principal, action: request.action, payload: EMPLOYEE_ATTRIBUTED_ACTIONS.includes(request.action) ? employeePolicyPayload(request.payload) : request.payload });
  if (!policy.allowed) throw new AuthorizationDenied(policy.reason);
  return policy;
}
