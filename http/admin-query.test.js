import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../rules.js';
import { AuthorizationDenied, registerTrustedExecutionContext } from '../shared/identity.js';
import { projectAdminSnapshot } from './admin-query.js';

function context(grants, attributes = [], id = 'actor-a') {
  const principal = Object.freeze({ id, permissionIds: Object.freeze(grants),
    policyAttributeIds: Object.freeze(attributes) });
  return registerTrustedExecutionContext(Object.freeze({
    mode: 'trusted', principalId: id, principal,
    permissionIds: principal.permissionIds,
    policyAttributesConfigured: attributes.length > 0,
    policyAttributeIds: attributes.length ? principal.policyAttributeIds : null,
    sessionId: 'session-a', dbNow: '2026-10-08T00:00:00.000000Z'
  }));
}
function head() {
  const state = initialState();
  state.futureSecret = 'never-return-ledger-state';
  state.rooms[0].futureSecret = 'never-return-room-secret';
  state.roomIssueReviews.push({ id: 11, room: 'V01', status: '待审核',
    submittedByPrincipalId: 'actor-b', evidenceText: 'repair',
    evidencePhoto: 'data:image/png;base64,photo-secret' });
  state.inventoryReviews.push({ id: 12, kind: 'drink', product: 'bw',
    status: '待审核', before: 4, after: 5, submittedByPrincipalId: 'actor-b' });
  state.orders.push({
    id: 'O-1', kind: 'room', room: 'V01', status: '待审批挂账',
    credit: { amount: 80000, approver: '店长', name: 'private-customer',
      phone: 'private-phone', submittedByPrincipalId: 'actor-b' },
    giftRequests: [{ id: 13, status: '待确认', product: 'bw', bottles: 6,
      submittedByPrincipalId: 'actor-b' }],
    roundingReview: { status: '待审核', amount: 500,
      submittedByPrincipalId: 'actor-b' }
  }, {
    id: 'O-2', kind: 'room', room: 'V02', status: '待审批挂账',
    credit: { amount: 150000, approver: '老板', name: 'boss-only-customer',
      submittedByPrincipalId: 'actor-b' }
  }, {
    id: 'O-3', kind: 'room', room: 'V03', status: '已挂账',
    credit: { repaymentRequests: [{ id: 14, status: '待审核', amount: 5000,
      method: '现金', submittedByPrincipalId: 'actor-b' }] }
  });
  state.expenses.push({ id: 15, status: '待老板审批', amount: 60000,
    date: '2026-10-08', description: 'other-expense',
    submittedByPrincipalId: 'actor-b', proof: 'private-proof' },
  { id: 16, status: '已记录', amount: 100,
    description: 'own-expense', submittedByPrincipalId: 'actor-a' });
  state.procurements.push({ id: 17, item: 'other-procurement',
    submittedByPrincipalId: 'actor-b' },
  { id: 18, item: 'own-procurement',
    submittedByPrincipalId: 'actor-a' });
  state.incidents.push({ id: 19, room: 'V04', type: 'equipment',
    description: 'other-incident', submittedByPrincipalId: 'actor-b',
    resolutionReviews: [{ id: 20, status: '待审核', result: 'repair done',
      submittedByPrincipalId: 'actor-b' }] },
  { id: 21, room: 'V05', type: 'service',
    description: 'own-incident', submittedByPrincipalId: 'actor-a' });
  return { revision: 8, state };
}

test('admin snapshot requires backend.view even with approval grants', () => {
  for (const grants of [[], ['inventory.approve'], ['review.self']]) {
    assert.throws(() => projectAdminSnapshot(head(), context(grants)),
      error => error instanceof AuthorizationDenied);
  }
});

test('backend.view alone receives narrow room overview and no review or finance data', () => {
  const result = projectAdminSnapshot(head(), context(['backend.view']));
  assert.equal(result.revision, 8);
  assert.equal(result.view.serverNow, '2026-10-08T00:00:00.000000Z');
  assert.equal(result.view.dashboard.pendingReviews, 0);
  assert.deepEqual(result.view.reviewQueue, []);
  for (const field of ['orders', 'expenses', 'procurements', 'incidents', 'catalog']) {
    assert.equal(Object.hasOwn(result.view, field), false);
  }
  for (const secret of ['never-return-ledger-state', 'never-return-room-secret',
    'private-customer', 'private-proof', 'photo-secret']) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('specific approval and policy attributes filter review queue on the server', () => {
  const inventory = projectAdminSnapshot(head(),
    context(['backend.view', 'inventory.approve']));
  assert.deepEqual(inventory.view.reviewQueue.map(item => item.type), ['inventory']);
  const manager = projectAdminSnapshot(head(),
    context(['backend.view', 'credit.approve'], ['credit.approval.manager']));
  assert.deepEqual(manager.view.reviewQueue.map(item => item.orderId), ['O-1']);
  assert.equal(JSON.stringify(manager).includes('boss-only-customer'), false);
  const boss = projectAdminSnapshot(head(),
    context(['backend.view', 'credit.approve'], ['credit.approval.boss']));
  assert.deepEqual(boss.view.reviewQueue.map(item => item.orderId), ['O-1', 'O-2']);
  const expenseWithoutPolicy = projectAdminSnapshot(head(),
    context(['backend.view', 'expense.approve']));
  assert.deepEqual(expenseWithoutPolicy.view.reviewQueue, []);
  const expenseBoss = projectAdminSnapshot(head(),
    context(['backend.view', 'expense.approve'], ['expense.approval.boss']));
  assert.deepEqual(expenseBoss.view.reviewQueue.map(item => item.type), ['expense']);
  const unknown = projectAdminSnapshot(head(),
    context(['backend.view', 'unknown.approve']));
  assert.deepEqual(unknown.view.reviewQueue, []);
});

test('viewAll is exact; own expense, procurement and incident rows stay separate', () => {
  const own = projectAdminSnapshot(head(),
    context(['backend.view', 'expense.view', 'procurement.create',
      'incident.create']));
  assert.deepEqual(own.view.expenses.map(item => item.id), [16]);
  assert.deepEqual(own.view.procurements.map(item => item.id), [18]);
  assert.deepEqual(own.view.incidents.map(item => item.id), [21]);
  const all = projectAdminSnapshot(head(),
    context(['backend.view', 'expense.viewAll', 'procurement.viewAll',
      'incident.viewAll']));
  assert.deepEqual(all.view.expenses.map(item => item.id), [15, 16]);
  assert.deepEqual(all.view.procurements.map(item => item.id), [17, 18]);
  assert.deepEqual(all.view.incidents.map(item => item.id), [19, 21]);
  assert.equal(JSON.stringify(all).includes('private-proof'), false);
});
test('review availability follows self-review and expense threshold without browser roles', () => {
  const ownInventory = projectAdminSnapshot(head(),
    context(['backend.view', 'inventory.approve'], [], 'actor-b'));
  assert.equal(ownInventory.view.reviewQueue[0].canDecide, false);
  const selfAllowed = projectAdminSnapshot(head(),
    context(['backend.view', 'inventory.approve', 'review.self'], [], 'actor-b'));
  assert.equal(selfAllowed.view.reviewQueue[0].canDecide, true);
  const low = head();
  low.state.expenses[0].amount = 50000;
  const expense = projectAdminSnapshot(low,
    context(['backend.view', 'expense.approve']));
  assert.deepEqual(expense.view.reviewQueue.map(item => item.type), ['expense']);
  assert.equal(expense.view.reviewQueue[0].canDecide, true);
});
test('exceptional self rounding availability requires its independent policy attribute', () => {
  const pending = head();
  pending.state.orders[0].roundingReview.exceptionalSelfApprovalRequired = true;
  const denied = projectAdminSnapshot(pending,
    context(['backend.view', 'rounding.approve', 'review.self'], [], 'actor-b'));
  assert.equal(denied.view.reviewQueue.find(item => item.type === 'rounding').canDecide,
    false);
  const allowed = projectAdminSnapshot(pending,
    context(['backend.view', 'rounding.approve', 'review.self'],
      ['rounding.self.excess'], 'actor-b'));
  assert.equal(allowed.view.reviewQueue.find(item => item.type === 'rounding').canDecide,
    true);
});