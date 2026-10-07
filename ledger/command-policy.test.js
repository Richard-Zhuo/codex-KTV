import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeCommand, authorizeReviewCommand, createTrustedPrincipal,
  createTrustedReviewFacts, DEMO_ONLY_ACTIONS, EXCESS_ROUNDING_SELF,
  FORMAL_COMMAND_ACTIONS
} from './command-policy.js';

const principal = (id, permissionIds = [], policyAttributeIds = []) =>
  createTrustedPrincipal({ id, permissionIds, policyAttributeIds });

test('formal action list denies unknown and every demo-only mutation', () => {
  const actor = principal('synthetic-actor', ['catalog.manage', 'identity.manage']);
  assert.equal(new Set(FORMAL_COMMAND_ACTIONS).size, FORMAL_COMMAND_ACTIONS.length);
  for (const action of [...DEMO_ONLY_ACTIONS, 'refund', 'reversePayment', 'newAction']) {
    const decision = authorizeCommand({ principal: actor, action, payload: {} });
    assert.equal(decision.allowed, false, action);
    assert.equal(decision.requiresInTransactionAuthorization, false, action);
    assert.equal(FORMAL_COMMAND_ACTIONS.includes(action), false, action);
  }
  assert.equal(authorizeCommand({ principal: actor, action: 'setPermissions' }).reason, 'demo-only-action');
  assert.equal(authorizeCommand({ principal: actor, action: 'newAction' }).reason, 'unknown-action');
});

test('principal is explicit trusted input, not a JSON body or an administrator role', () => {
  assert.throws(() => authorizeCommand({
    principal: { id: 'synthetic-actor', permissionIds: ['payment.settle'] },
    action: 'settle'
  }), /可信 principal/);
  const actor = principal('synthetic-admin-label', ['backend.view']);
  const spoofed = { actorId: 'synthetic-owner', permissions: ['payment.settle'],
    role: 'administrator', principal: { id: 'synthetic-owner', permissionIds: ['payment.settle'] } };
  const decision = authorizeCommand({ principal: actor, action: 'settle', payload: spoofed });
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.requiredPermissions.allOf, ['payment.settle']);
  assert.equal(decision.trustedExecutionContext, null);
});

test('backend.view is independent from settlement, credit and inventory approval', () => {
  const viewer = principal('synthetic-viewer', ['backend.view']);
  for (const action of ['settle', 'approve', 'approveInventory']) {
    assert.equal(authorizeCommand({ principal: viewer, action }).allowed, false, action);
  }
  const approver = principal('synthetic-approver', ['credit.approve']);
  assert.equal(authorizeCommand({ principal: approver, action: 'approve' }).allowed, true);
  assert.equal(approver.permissionIds.includes('backend.view'), false);
});

test('specific grants admit sale and reject final settlement without payment.settle', () => {
  const seller = principal('synthetic-seller', ['order.sale']);
  const sale = authorizeCommand({ principal: seller, action: 'sale', payload: { order: 'D1' } });
  assert.equal(sale.allowed, true);
  assert.deepEqual(sale.requiredPermissions.allOf, ['order.sale']);
  assert.equal(sale.requiresInTransactionAuthorization, true);
  assert.equal(authorizeCommand({ principal: seller, action: 'settle' }).allowed, false);
  assert.equal(authorizeCommand({ principal: seller, action: 'pay' }).allowed, false);
  assert.equal(authorizeCommand({ principal: principal('synthetic-cashier', ['payment.settle']),
    action: 'settle' }).allowed, true);
});

test('actual actor and credited employee remain separate; attribution never grants authority', () => {
  const actor = principal('synthetic-recorder', ['staff.record']);
  const delegated = authorizeCommand({ principal: actor, action: 'sale',
    payload: { creditedEmployeeId: 'synthetic-employee', order: 'D1' } });
  assert.equal(delegated.allowed, true);
  assert.equal(delegated.trustedExecutionContext.actualActorPrincipalId, 'synthetic-recorder');
  assert.equal(delegated.attribution.creditedEmployeeId, 'synthetic-employee');
  assert.equal(delegated.attribution.validated, false);
  assert.deepEqual(delegated.requiredPermissions.allOf, ['staff.record']);

  const employee = principal('synthetic-employee', ['order.sale']);
  assert.equal(authorizeCommand({ principal: employee, action: 'sale',
    payload: { creditedEmployeeId: 'synthetic-recorder' } }).allowed, false);
  assert.equal(authorizeCommand({ principal: actor, action: 'settle',
    payload: { creditedEmployeeId: 'synthetic-employee', permissions: ['payment.settle'] } }).allowed, false);
});

test('retail attribution requires both retail.sale and staff.record; unverified IDs are deferred', () => {
  const retail = principal('synthetic-retail', ['retail.sale']);
  assert.equal(authorizeCommand({ principal: retail, action: 'retailSale' }).allowed, true);
  assert.equal(authorizeCommand({ principal: retail, action: 'retailSale',
    payload: { creditedEmployeeId: 'synthetic-employee' } }).allowed, false);
  const recorder = principal('synthetic-recorder', ['retail.sale', 'staff.record']);
  const decision = authorizeCommand({ principal: recorder, action: 'retailSale',
    payload: { creditedEmployeeId: 'synthetic-employee' } });
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.requiredPermissions.allOf, ['retail.sale', 'staff.record']);
  assert.equal(decision.attribution.validated, false);
});

test('approval grant and review.self are both necessary for self review', () => {
  const facts = createTrustedReviewFacts({ submittedByPrincipalId: 'synthetic-actor' });
  const approver = principal('synthetic-actor', ['inventory.approve']);
  assert.equal(authorizeCommand({ principal: approver, action: 'approveInventory' }).requiresReviewFacts, true);
  assert.equal(authorizeReviewCommand({ principal: approver, action: 'approveInventory',
    reviewFacts: facts }).reason, 'missing-review-self');
  assert.equal(authorizeReviewCommand({ principal: principal('synthetic-actor', ['review.self']),
    action: 'approveInventory', reviewFacts: facts }).allowed, false);
  const selfApprover = principal('synthetic-actor', ['inventory.approve', 'review.self']);
  const decision = authorizeReviewCommand({ principal: selfApprover, action: 'approveInventory',
    reviewFacts: facts });
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.requiredPermissions.allOf, ['inventory.approve', 'review.self']);
  assert.equal(decision.requiresInTransactionAuthorization, true);
  assert.equal(authorizeReviewCommand({ principal: approver, action: 'approveInventory',
    reviewFacts: createTrustedReviewFacts({ submittedByPrincipalId: 'synthetic-other' }) }).allowed, true);
});

test('client-supplied review identity and forged facts do not bypass self-review grants', () => {
  const actor = principal('synthetic-actor', ['credit.approve']);
  const preflight = authorizeCommand({ principal: actor, action: 'approve',
    payload: { submittedByPrincipalId: 'synthetic-other', actorId: 'synthetic-owner',
      role: 'administrator', permissions: ['review.self'] } });
  assert.equal(preflight.allowed, true);
  assert.equal(preflight.requiresReviewFacts, true);
  assert.equal(preflight.trustedExecutionContext.actualActorPrincipalId, 'synthetic-actor');
  assert.equal(authorizeReviewCommand({ principal: actor, action: 'approve',
    reviewFacts: { submittedByPrincipalId: 'synthetic-other' } }).reason, 'untrusted-review-facts');
  assert.equal(authorizeReviewCommand({ principal: actor, action: 'approve',
    reviewFacts: createTrustedReviewFacts({ submittedByPrincipalId: 'synthetic-actor' }) }).allowed, false);
});

test('exceptional self-approval is an explicit attribute, never a name comparison', () => {
  const facts = createTrustedReviewFacts({
    submittedByPrincipalId: 'synthetic-actor', exceptionalSelfApprovalRequired: true
  });
  const ordinary = principal('synthetic-actor', ['rounding.approve', 'review.self']);
  assert.equal(authorizeReviewCommand({ principal: ordinary, action: 'approveRounding',
    reviewFacts: facts }).reason, 'missing-policy-attribute');
  const exceptional = principal('synthetic-actor', ['rounding.approve', 'review.self'],
    [EXCESS_ROUNDING_SELF]);
  assert.equal(authorizeReviewCommand({ principal: exceptional, action: 'approveRounding',
    reviewFacts: facts }).allowed, true);
  assert.equal(authorizeReviewCommand({ principal: exceptional, action: 'approveInventory',
    reviewFacts: facts }).allowed, false);
  assert.equal(authorizeReviewCommand({ principal: ordinary, action: 'approveRounding',
    reviewFacts: createTrustedReviewFacts({
      submittedByPrincipalId: 'synthetic-other', exceptionalSelfApprovalRequired: true
    }) }).allowed, true);
});

test('stock permission is provisional until current count selects opening or adjustment', () => {
  const opening = principal('synthetic-opening', ['inventory.opening']);
  const adjustment = principal('synthetic-adjustment', ['inventory.adjust']);
  const none = principal('synthetic-none');
  for (const action of ['stock', 'consumableStock']) {
    const a = authorizeCommand({ principal: opening, action, payload: { count: null } });
    const b = authorizeCommand({ principal: adjustment, action, payload: { count: 0 } });
    assert.equal(a.allowed, true);
    assert.equal(b.allowed, true);
    assert.equal(a.requiresInventoryPermissionSelection, true);
    assert.deepEqual(a.requiredPermissions.oneOf, ['inventory.opening', 'inventory.adjust']);
    assert.equal(authorizeCommand({ principal: none, action }).allowed, false);
  }
});

test('principal grants are copied; payload cannot mutate the trusted execution context', () => {
  const grants = ['order.sale'];
  const actor = principal('synthetic-actor', grants);
  grants.push('payment.settle');
  const payload = { actorId: 'synthetic-other', role: 'administrator',
    permissions: ['payment.settle'], creditedEmployeeId: 'synthetic-employee' };
  const decision = authorizeCommand({ principal: actor, action: 'sale', payload });
  assert.equal(decision.allowed, false);
  assert.equal(authorizeCommand({ principal: actor, action: 'settle', payload }).allowed, false);
  assert.equal(actor.permissionIds.includes('payment.settle'), false);
  assert.equal(Object.isFrozen(actor), true);
});

test('all listed review commands require their approval grant and review.self for self review', () => {
  const reviewGroups = {
    'room.issue.approve': ['approveRoomIssue', 'rejectRoomIssue'],
    'gift.approve': ['approveGift', 'rejectGift'],
    'rounding.approve': ['approveRounding', 'rejectRounding'],
    'credit.approve': ['approve', 'reject'],
    'credit.repay.approve': ['approveRepayment', 'rejectRepayment'],
    'inventory.approve': ['approveInventory', 'rejectInventory'],
    'incident.resolve.approve': ['approveIncidentResolution', 'rejectIncidentResolution'],
    'expense.approve': ['approveExpense', 'rejectExpense']
  };
  for (const [permission, actions] of Object.entries(reviewGroups)) {
    for (const action of actions) {
      const id = 'synthetic-' + action;
      const facts = createTrustedReviewFacts({ submittedByPrincipalId: id });
      const approvalOnly = principal(id, [permission]);
      assert.equal(authorizeCommand({ principal: approvalOnly, action }).requiresReviewFacts, true, action);
      assert.equal(authorizeReviewCommand({ principal: approvalOnly, action, reviewFacts: facts }).reason,
        'missing-review-self', action);
      assert.equal(authorizeReviewCommand({ principal: principal(id, ['review.self']),
        action, reviewFacts: facts }).allowed, false, action);
      assert.equal(authorizeReviewCommand({ principal: principal(id, [permission, 'review.self']),
        action, reviewFacts: facts }).allowed, true, action);
    }
  }
});

test('exceptional rounding requirement is named in the policy result', () => {
  const actor = principal('synthetic-actor', ['rounding.approve', 'review.self'],
    [EXCESS_ROUNDING_SELF]);
  const decision = authorizeReviewCommand({ principal: actor, action: 'approveRounding',
    reviewFacts: createTrustedReviewFacts({
      submittedByPrincipalId: 'synthetic-actor', exceptionalSelfApprovalRequired: true
    }) });
  assert.deepEqual(decision.requiredPolicyAttributes, [EXCESS_ROUNDING_SELF]);
});

test('exceptional self rounding rejection needs the review grants but not the excess attribute', () => {
  const facts = createTrustedReviewFacts({ submittedByPrincipalId: 'synthetic-actor',
    exceptionalSelfApprovalRequired: true });
  const noSelf = principal('synthetic-actor', ['rounding.approve']);
  assert.equal(authorizeReviewCommand({ principal: noSelf, action: 'rejectRounding',
    reviewFacts: facts }).reason, 'missing-review-self');
  const noAction = principal('synthetic-actor', ['review.self']);
  assert.equal(authorizeReviewCommand({ principal: noAction, action: 'rejectRounding',
    reviewFacts: facts }).reason, 'missing-permission');
  const reviewer = principal('synthetic-actor', ['rounding.approve', 'review.self']);
  assert.equal(authorizeReviewCommand({ principal: reviewer, action: 'approveRounding',
    reviewFacts: facts }).reason, 'missing-policy-attribute');
  const rejection = authorizeReviewCommand({ principal: reviewer, action: 'rejectRounding',
    reviewFacts: facts });
  assert.equal(rejection.allowed, true);
  assert.deepEqual(rejection.requiredPolicyAttributes, []);
});
