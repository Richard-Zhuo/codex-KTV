import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAdminDecision } from './admin-approval.js';

const cases = [
  ['roomRecovery', { id: 11 }, 'approveRoomIssue', 'rejectRoomIssue',
    { request: 11, decisionNote: 'checked' }],
  ['inventory', { id: 12 }, 'approveInventory', 'rejectInventory',
    { request: 12, decisionNote: 'checked' }],
  ['gift', { id: 13, orderId: 'O-1' }, 'approveGift', 'rejectGift',
    { order: 'O-1', request: 13, decisionNote: 'checked' }],
  ['rounding', { orderId: 'O-1' }, 'approveRounding', 'rejectRounding',
    { order: 'O-1', decisionNote: 'checked' }],
  ['credit', { orderId: 'O-1' }, 'approve', 'reject', { order: 'O-1' }],
  ['repayment', { id: 14, orderId: 'O-1' }, 'approveRepayment',
    'rejectRepayment', { order: 'O-1', request: 14, decisionNote: 'checked' }],
  ['incidentResolution', { id: 15, incidentId: 16 },
    'approveIncidentResolution', 'rejectIncidentResolution',
    { id: 16, request: 15, decisionNote: 'checked' }],
  ['expense', { id: 17 }, 'approveExpense', 'rejectExpense', { id: 17 }]
];

test('admin review adapter exposes exactly the existing approval and rejection commands', () => {
  for (const [type, ids, approve, reject, payload] of cases) {
    const item = { type, ...ids, canDecide: true };
    assert.deepEqual(prepareAdminDecision(item, 'approve', 'checked'),
      { action: approve, payload });
    assert.deepEqual(prepareAdminDecision(item, 'reject', 'checked'),
      { action: reject, payload });
  }
});

test('admin review adapter refuses unreviewable, unknown, and malformed intents', () => {
  assert.throws(() => prepareAdminDecision(
    { type: 'inventory', id: 12, canDecide: false }, 'approve'));
  assert.throws(() => prepareAdminDecision(
    { type: 'setPermissions', id: 12, canDecide: true }, 'approve'));
  assert.throws(() => prepareAdminDecision(
    { type: 'inventory', id: 12, canDecide: true }, 'reject', ''));
  assert.throws(() => prepareAdminDecision(
    { type: 'inventory', id: -1, canDecide: true }, 'approve'));
  assert.throws(() => prepareAdminDecision(
    { type: 'inventory', id: 12, canDecide: true }, 'approve', 'x'.repeat(301)));
});