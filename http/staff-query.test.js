import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../rules.js';
import { registerTrustedExecutionContext } from '../shared/identity.js';
import { projectEmployeeWorkspace } from './staff-query.js';

function context(grants, id = 'principal-a', attributes = []) {
  const principal = Object.freeze({ id, permissionIds: Object.freeze(grants),
    policyAttributeIds: Object.freeze(attributes) });
  return registerTrustedExecutionContext(Object.freeze({
    mode: 'trusted', principalId: id, principal,
    permissionIds: principal.permissionIds,
    policyAttributesConfigured: attributes.length > 0,
    policyAttributeIds: attributes.length ? principal.policyAttributeIds : null,
    sessionId: 'session-a', dbNow: '2026-10-06T12:00:00.000000Z'
  }));
}
function state() {
  const value = initialState();
  value.rooms[0].issueEvidencePhoto = 'private-room-photo';
  value.orders.push({
    id: 'O1', kind: 'room', room: 'V01', status: '待挂账审批',
    base: 100, gift: 0, drinks: [], extras: [], sales: [],
    otherCharges: [], bonusGifts: [], giftRequests: [], payments: [],
    credit: { amount: 100, remaining: 100, name: 'Customer Private',
      phone: '13800000000', note: 'Private note',
      signature: 'private-signature', submittedByPrincipalId: 'principal-b' },
    secretFutureField: 'never-project-this'
  });
  value.expenses.push({ id: 1, description: 'Owner secret',
    submittedByPrincipalId: 'principal-a', proof: 'private-proof' },
  { id: 2, description: 'Other secret',
    submittedByPrincipalId: 'principal-b', proof: 'other-proof' });
  value.incidents.push({ id: 1, description: 'Assigned issue',
    assigneeEmployeeId: 'employee-a', submittedByPrincipalId: 'principal-b',
    resolutionReviews: [] },
  { id: 2, description: 'Unassigned issue',
    assigneeEmployeeId: 'employee-b', submittedByPrincipalId: 'principal-b',
    resolutionReviews: [] });
  value.processed.push({ secret: 'operation-journal' });
  return value;
}
const employees = [
  { employeeId: 'employee-a', displayName: 'Employee A',
    principalId: 'principal-a', enabled: true },
  { employeeId: 'employee-b', displayName: 'Employee B',
    principalId: 'principal-b', enabled: true }
];

test('ungranted and backend-only identities receive no employee workspace', () => {
  const source = state();
  assert.equal(projectEmployeeWorkspace(source, context([])), null);
  assert.equal(projectEmployeeWorkspace(source, context(['backend.view'])), null);
  assert.equal(projectEmployeeWorkspace(source, context(['review.self'])), null);
});

test('room cleaner receives room facts without orders, evidence or business secrets', () => {
  const view = projectEmployeeWorkspace(state(), context(['room.clean']),
    { employees, serverNow: '2026-10-06T12:00:00.000Z' });
  assert.equal(view.rooms[0].id, 'V01');
  assert.equal(Object.hasOwn(view.rooms[0], 'issueEvidencePhoto'), false);
  assert.equal(Object.hasOwn(view, 'orders'), false);
  assert.equal(Object.hasOwn(view, 'catalog'), false);
  assert.equal(Object.hasOwn(view, 'employees'), false);
  assert.equal(view.actorEmployee.employeeId, 'employee-a');
  assert.equal(JSON.stringify(view).includes('operation-journal'), false);
});

test('sales sees financial order lines but credit contact and signature stay restricted', () => {
  const view = projectEmployeeWorkspace(state(), context(['order.sale']));
  assert.equal(view.orders[0].base, 100);
  assert.equal(view.orders[0].credit.amount, 100);
  const serialized = JSON.stringify(view);
  for (const forbidden of ['private-signature', 'Customer Private',
    '13800000000', 'Private note', 'never-project-this',
    'operation-journal']) assert.equal(serialized.includes(forbidden), false);
  const reviewer = projectEmployeeWorkspace(state(),
    context(['credit.approve'], 'principal-a', ['credit.approval.manager']));
  assert.equal(reviewer.orders[0].credit.signature, 'private-signature');
});

test('expense and incident rows are filtered by actor, assignment and grants', () => {
  const source = state();
  const owner = projectEmployeeWorkspace(source,
    context(['expense.view', 'incident.resolve']), { employees });
  assert.deepEqual(owner.expenses.map(row => row.description), ['Owner secret']);
  assert.deepEqual(owner.incidents.map(row => row.description), ['Assigned issue']);
  const all = projectEmployeeWorkspace(source,
    context(['expense.viewAll', 'incident.viewAll']), { employees });
  assert.equal(all.expenses.length, 2);
  assert.equal(all.incidents.length, 2);
  const roster = projectEmployeeWorkspace(source,
    context(['staff.record', 'incident.create']), { employees });
  assert.deepEqual(roster.employees.map(row => row.displayName),
    ['Employee A', 'Employee B']);
  assert.equal(JSON.stringify(roster.employees).includes('principalId'), false);
});

test('approval detail needs current policy attribute and retail sees only own orders', () => {
  const source = state();
  source.orders.push({ id: 'retail-own', kind: 'retail',
    actualActorPrincipalId: 'principal-a', sales: [], payments: [] });
  source.orders.push({ id: 'retail-other', kind: 'retail',
    actualActorPrincipalId: 'principal-b', sales: [], payments: [] });
  const withoutPolicy = projectEmployeeWorkspace(source,
    context(['credit.approve', 'expense.approve']));
  assert.equal(JSON.stringify(withoutPolicy).includes('private-signature'), false);
  assert.equal(JSON.stringify(withoutPolicy).includes('Other secret'), false);
  const withPolicy = projectEmployeeWorkspace(source,
    context(['expense.approve'], 'principal-a', ['expense.approval.boss']));
  assert.deepEqual(withPolicy.expenses.map(row => row.description),
    ['Owner secret', 'Other secret']);
  const retail = projectEmployeeWorkspace(source, context(['retail.sale']));
  assert.deepEqual(retail.orders.map(row => row.id), ['retail-own']);
  assert.equal(retail.sections.rooms, false);
});

test('deposit projection keeps the existing employee record contract', () => {
  const source = state();
  source.deposits.push({ id: 12, group: 4, room: 'V01', product: 'bw',
    productNameSnapshot: 'Beer', count: 6, initial: 12,
    name: 'Guest', phone: '13800000000', time: '2026-10-06T12:00:00Z' });
  const view = projectEmployeeWorkspace(source, context(['deposit.manage']));
  assert.equal(view.deposits[0].productNameSnapshot, 'Beer');
  assert.equal(view.deposits[0].count, 6);
  assert.equal(view.deposits[0].room, 'V01');
});

test('room-only operator does not receive another actor\'s order link', () => {
  const source = state();
  source.rooms[0].order = 'O1';
  source.orders[0].actualActorPrincipalId = 'principal-b';
  const view = projectEmployeeWorkspace(source, context(['room.open']));
  assert.equal(view.rooms[0].order, null);
  assert.deepEqual(view.orders, []);
});

test('Stage 4A server view projects DAY retail plan and migrates v1 categories without touching persisted history',()=>{
 const source=state();source.catalog.schemaVersion=1;for(const p of source.catalog.products)delete p.priceCategory;
 const old=structuredClone(source);
 source.orders[0].businessSession={sessionType:'DAY',pricePlanId:'day-v1'};
 source.orders[0].sales=[{pricePerSaleUnitCents:10000,pricePlanId:'day-v1',businessSession:{sessionType:'DAY'},priceCategorySnapshot:'ORDINARY_BEER'}];
 const view=projectEmployeeWorkspace(source,context(['order.sale']),{businessTimeZone:'Asia/Shanghai',serverNow:'2026-10-08T07:00:00.000Z'});
 assert.equal(view.retailBusinessSession.pricePlanId,'day-v1');assert.equal(view.catalog.products[0].priceCategory,'ORDINARY_BEER');
 assert.equal(view.orders[0].sales[0].pricePerSaleUnitCents,10000);assert.equal(view.orders[0].businessSession.sessionType,'DAY');
 assert.deepEqual(source.catalog,old.catalog);
 assert.equal(projectEmployeeWorkspace(source,context(['room.clean']),{businessTimeZone:'Asia/Shanghai'}).retailBusinessSession,undefined);
});

test('staff snapshot preserves charge batches for grouped sales and other charges, including prior payment allocation',async()=>{
 const {nextCollectCharge,collectableCharges}=await import('../sales.js');
 const source=state(),o=source.orders[0];o.status='营业中';o.credit=null;
 o.sales=[{id:11,batch:10,product:'bw',count:1,amount:1000},{id:12,batch:10,product:'bw',count:2,amount:2000}];
 o.otherCharges=[{id:21,batch:20,category:'其他',item:'REHEARSAL',amount:500}];o.payments=[{chargeId:'other:20',amount:500,method:'现金'}];
 const view=projectEmployeeWorkspace(source,context(['payment.collect']));
 assert.equal(nextCollectCharge(view.orders[0]).id,'sale:10');
 assert.deepEqual(collectableCharges(view.orders[0]),collectableCharges(o));
 assert.equal(nextCollectCharge(view.orders[0]).remaining,3000);
});
