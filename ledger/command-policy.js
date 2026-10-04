// Stage 2A eligibility policy. Authentication and current-state checks are later boundaries.
import { PERMISSION_IDS } from '../shared/identity.js';

const trustedPrincipals = new WeakSet();
const trustedReviews = new WeakSet();
const permissionIds = new Set(PERMISSION_IDS);
export const EXCESS_ROUNDING_SELF = 'rounding.self.excess';
export const EXPENSE_APPROVAL_BOSS = 'expense.approval.boss';
export const POLICY_ATTRIBUTE_IDS = Object.freeze([EXCESS_ROUNDING_SELF, EXPENSE_APPROVAL_BOSS]);

// Only these domain actions may be considered by a future formal command path.
// The map contains grants, not domain rules, amounts, room state or stock balances.
const groups = {
  'catalog.manage': ['createCatalogProduct', 'updateCatalogProduct', 'updateCatalogPackage'],
  'room.issue': ['markRoomIssue', 'clearRoomIssue'],
  'room.issue.approve': ['approveRoomIssue', 'rejectRoomIssue'],
  'room.open': ['open'],
  'room.reserve': ['reserve', 'cancelReservation'],
  'room.clean': ['clean'],
  'order.sale': ['sale', 'otherCharge'],
  'retail.sale': ['retailSale'],
  'order.exchange': ['exchange'],
  'order.gift': ['gift'],
  'order.serveExtra': ['serveExtra'],
  'gift.approve': ['approveGift', 'rejectGift'],
  'payment.collect': ['collect'],
  'payment.settle': ['settle', 'pay'],
  'rounding.approve': ['approveRounding', 'rejectRounding'],
  'credit.apply': ['credit'],
  'credit.approve': ['approve', 'reject'],
  'credit.repay': ['repay'],
  'credit.repay.approve': ['approveRepayment', 'rejectRepayment'],
  'deposit.manage': ['deposit', 'withdraw'],
  'inventory.approve': ['approveInventory', 'rejectInventory'],
  handover: ['handover'],
  'expense.create': ['expense'],
  'expense.approve': ['approveExpense', 'rejectExpense'],
  'procurement.create': ['procurement'],
  'incident.create': ['incident'],
  'incident.resolve': ['resolveIncident'],
  'incident.resolve.approve': ['approveIncidentResolution', 'rejectIncidentResolution']
};
const actionPermissions = Object.fromEntries(Object.entries(groups).flatMap(([permission, actions]) =>
  actions.map(action => [action, permission])));
const stockActions = new Set(['stock', 'consumableStock']);
const delegatedActions = new Set(['open', 'reserve', 'sale', 'retailSale']);
const reviewActions = new Set([
  'approveRoomIssue', 'rejectRoomIssue', 'approveGift', 'rejectGift',
  'approveRounding', 'rejectRounding', 'approve', 'reject',
  'approveRepayment', 'rejectRepayment', 'approveInventory', 'rejectInventory',
  'approveIncidentResolution', 'rejectIncidentResolution',
  'approveExpense', 'rejectExpense'
]);
const demoActions = new Set(['identity', 'setUser', 'clock', 'setClock', 'reset', 'setPermissions']);
export const FORMAL_COMMAND_ACTIONS = Object.freeze([...Object.keys(actionPermissions), ...stockActions]);
export const DEMO_ONLY_ACTIONS = Object.freeze([...demoActions]);

if (Object.keys(actionPermissions).length !== Object.values(groups).flat().length ||
    Object.keys(groups).some(permission => !permissionIds.has(permission)) ||
    Object.entries(actionPermissions).some(([action, permission]) =>
      permission.endsWith('.approve') !== reviewActions.has(action))) {
  throw Error('正式 action 清单有重复动作或未知权限');
}

// Must be called by trusted server code, never with fields copied from HTTP JSON.
export function createTrustedPrincipal({ id, permissionIds: grants = [], policyAttributeIds = [] }) {
  if (typeof id !== 'string' || !id || id.trim() !== id || id.length > 191 ||
      !Array.isArray(grants) || grants.some(grant => !permissionIds.has(grant)) ||
      !Array.isArray(policyAttributeIds) ||
      policyAttributeIds.some(attribute => !POLICY_ATTRIBUTE_IDS.includes(attribute))) {
    throw TypeError('可信 principal 无效');
  }
  const principal = Object.freeze({ id, permissionIds: Object.freeze([...new Set(grants)]),
    policyAttributeIds: Object.freeze([...new Set(policyAttributeIds)]) });
  trustedPrincipals.add(principal);
  return principal;
}

// Stage 2C must construct these facts from the locked ledger state, not payload.
export function createTrustedReviewFacts({ submittedByPrincipalId, exceptionalSelfApprovalRequired = false }) {
  if (typeof submittedByPrincipalId !== 'string' || !submittedByPrincipalId ||
      submittedByPrincipalId.trim() !== submittedByPrincipalId ||
      typeof exceptionalSelfApprovalRequired !== 'boolean') throw TypeError('审核事实无效');
  const facts = Object.freeze({ submittedByPrincipalId, exceptionalSelfApprovalRequired });
  trustedReviews.add(facts);
  return facts;
}

function principalId(principal) {
  if (!principal || !trustedPrincipals.has(principal)) throw TypeError('必须注入可信 principal');
  return principal.id;
}

function result(allowed, action, reason, allOf = [], oneOf = [], principal = null, creditedEmployeeId = null, requiredPolicyAttributes = []) {
  return Object.freeze({ allowed, action, reason,
    requiredPermissions: Object.freeze({ allOf: Object.freeze(allOf), oneOf: Object.freeze(oneOf) }),
    requiredPolicyAttributes: Object.freeze([...requiredPolicyAttributes]),
    trustedExecutionContext: allowed ? Object.freeze({ actualActorPrincipalId: principal.id }) : null,
    attribution: allowed ? Object.freeze({ creditedEmployeeId, validated: creditedEmployeeId === null }) : null,
    requiresInTransactionAuthorization: allowed,
    requiresReviewFacts: allowed && reviewActions.has(action),
    requiresInventoryPermissionSelection: allowed && stockActions.has(action) });
}

export function authorizeCommand({ principal, action, payload = {} }) {
  principalId(principal);
  if (!Object.hasOwn(actionPermissions, action) && !stockActions.has(action)) {
    return result(false, action, demoActions.has(action) ? 'demo-only-action' : 'unknown-action');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return result(false, action, 'invalid-payload');
  const creditedEmployeeId = payload.creditedEmployeeId;
  if (creditedEmployeeId !== undefined && (!delegatedActions.has(action) ||
      typeof creditedEmployeeId !== 'string' || !creditedEmployeeId ||
      creditedEmployeeId.trim() !== creditedEmployeeId || creditedEmployeeId.length > 191)) {
    return result(false, action, 'invalid-attribution');
  }
  const delegated = creditedEmployeeId !== undefined;
  const permission = actionPermissions[action];
  const allOf = delegated && action !== 'retailSale' ? ['staff.record'] :
    [permission, ...(delegated ? ['staff.record'] : [])].filter(Boolean);
  const oneOf = stockActions.has(action) ? ['inventory.opening', 'inventory.adjust'] : [];
  const allowed = allOf.every(grant => principal.permissionIds.includes(grant)) &&
    (!oneOf.length || oneOf.some(grant => principal.permissionIds.includes(grant)));
  return result(allowed, action, allowed ? null : 'missing-permission', allOf, oneOf,
    principal, creditedEmployeeId ?? null);
}

export function authorizeReviewCommand({ principal, action, reviewFacts }) {
  principalId(principal);
  if (!reviewActions.has(action)) return result(false, action, 'not-review-action');
  const base = authorizeCommand({ principal, action });
  if (!base.allowed) return base;
  if (!reviewFacts || !trustedReviews.has(reviewFacts)) return result(false, action, 'untrusted-review-facts');
  if (reviewFacts.exceptionalSelfApprovalRequired && !['approveRounding', 'rejectRounding'].includes(action)) {
    return result(false, action, 'invalid-review-facts');
  }
  const self = reviewFacts.submittedByPrincipalId === principal.id;
  const allOf = [...base.requiredPermissions.allOf, ...(self ? ['review.self'] : [])];
  if (self && !principal.permissionIds.includes('review.self')) {
    return result(false, action, 'missing-review-self', allOf);
  }
  if (self && reviewFacts.exceptionalSelfApprovalRequired &&
      !principal.policyAttributeIds.includes(EXCESS_ROUNDING_SELF)) {
    return result(false, action, 'missing-policy-attribute', allOf, [], null, null, [EXCESS_ROUNDING_SELF]);
  }
  return result(true, action, null, allOf, [], principal, null,
    self && reviewFacts.exceptionalSelfApprovalRequired ? [EXCESS_ROUNDING_SELF] : []);
}
