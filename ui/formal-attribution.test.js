import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewHistoryRows } from '../reviewInbox.js';

const originalWindow = globalThis.window;
globalThis.window ??= { addEventListener() {} };
const { ctx } = await import('./context.js');
const { incidentPage } = await import('./pages/incidents.js');
const { myReservationSection } = await import('./pages/mine.js');
if (originalWindow === undefined) delete globalThis.window;

test('formal incident action uses assigned employee ID, never matching name or viewAll', () => {
  const previous = { state: ctx.state, formal: ctx.formal };
  try {
    ctx.formal = { session: { principalId: 'actor-1',
      permissionIds: ['incident.resolve', 'incident.viewAll'] },
      reviewSections: [] };
    ctx.state = {
      user: 'actor-1', clock: '2026-10-06T12:00:00.000Z',
      actorEmployee: { employeeId: 'employee-1', displayName: 'same-name' },
      incidents: [
        { id: 1, room: 'V01', date: '2026-10-06', type: 'test',
          status: '处理中', assignee: 'same-name', assigneeEmployeeId: 'employee-1',
          description: 'assigned', resolutionReviews: [] },
        { id: 2, room: 'V02', date: '2026-10-06', type: 'test',
          status: '处理中', assignee: 'same-name', assigneeEmployeeId: 'employee-2',
          description: 'different employee', resolutionReviews: [] }
      ]
    };
    const html = incidentPage();
    assert.equal((html.match(/data-action="resolveIncident"/g) ?? []).length, 1);
    assert.match(html, /data-action="resolveIncident" data-id="1"/);
    assert.doesNotMatch(html, /data-action="resolveIncident" data-id="2"/);
  } finally {
    ctx.state = previous.state;
    ctx.formal = previous.formal;
  }
});

test('formal personal reservation and sale attribution uses employee IDs', () => {
  const previous = { state: ctx.state, formal: ctx.formal };
  try {
    ctx.formal = { session: { principalId: 'actor-1', permissionIds: [] },
      reviewSections: [] };
    ctx.state = {
      user: 'actor-1', actorEmployee: {
        employeeId: 'employee-1', displayName: 'same-name' },
      reservations: [
        { id: 1, room: 'V01', at: '2026-10-06T12:00:00.000Z',
          session: 'afternoon', source: 'test', person: 'same-name',
          employeeId: 'employee-1', status: '已预订' },
        { id: 2, room: 'V02', at: '2026-10-06T12:00:00.000Z',
          session: 'afternoon', source: 'test', person: 'same-name',
          employeeId: 'employee-2', status: '已预订' }
      ],
      orders: [
        { id: 'one', room: 'V01', time: '2026-10-06T12:30:00.000Z',
          employeeId: 'employee-1', reservedBy: 'same-name', sales: [] },
        { id: 'two', room: 'V02', time: '2026-10-06T12:30:00.000Z',
          employeeId: 'employee-2', reservedBy: 'same-name', sales: [] }
      ]
    };
    const html = myReservationSection();
    assert.match(html, /V01/);
    assert.doesNotMatch(html, /V02/);
    assert.equal((html.match(/<strong>1<\/strong>/g) ?? []).length, 2);
  } finally {
    ctx.state = previous.state;
    ctx.formal = previous.formal;
  }
});

test('formal review history rejects a different principal with the same display name', () => {
  const state = { orders: [], catalog: { products: [] },
    roomIssueReviews: [
      { id: 1, room: 'V01', status: '已批准', decidedBy: 'same-name',
        decidedByPrincipalId: 'actor-1', decidedAt: '2026-10-06T12:00:00Z' },
      { id: 2, room: 'V02', status: '已批准', decidedBy: 'same-name',
        decidedByPrincipalId: 'actor-2', decidedAt: '2026-10-06T12:01:00Z' }
    ] };
  const user = { name: 'same-name' };
  const formal = reviewHistoryRows(state, user, ['roomRecovery'], 'actor-1');
  assert.equal(formal.length, 1);
  assert.match(formal[0].title, /V01/);
  assert.equal(reviewHistoryRows(state, user, ['roomRecovery']).length, 2);
});
