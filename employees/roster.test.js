import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmployeeService } from './service.js';
import { EmployeeRosterError } from './errors.js';

const ids = [1,2,3].map(n => '00000000-0000-4000-8000-00000000000' + n);
const context = { actorPrincipalId: ids[0] };
const isCode = code => error => error instanceof EmployeeRosterError && error.code === code;
function fixture() {
  let state = { accounts: new Map(ids.map(principalId => [principalId, { principalId, enabled: true }])), employees: new Map(), events: [] };
  const calls = []; let eventFailure = false, changedLocator = false;
  const copy = row => row ? Object.freeze(structuredClone(row)) : null;
  const store = {
    async readEmployee(id) { calls.push(['read', id]); return copy(state.employees.get(id)); },
    async runTransaction(work) {
      calls.push(['begin']); const draft = structuredClone(state);
      const tx = {
        async lockAccount(id) { calls.push(['account', id]); return draft.accounts.get(id); },
        async locateEmployee(id) { calls.push(['locate', id]); return copy(draft.employees.get(id)); },
        async lockEmployee(id) {
          calls.push(['employee', id]);
          if (changedLocator) { changedLocator = false; draft.employees.get(id).principalId = ids[2]; }
          return copy(draft.employees.get(id));
        },
        async insertEmployee({ employeeId, displayName }) {
          draft.employees.set(employeeId, { employeeId, displayName, enabled: true, principalId: null, createdAt: 'DB-created', updatedAt: 'DB-created' });
        },
        async setPrincipal(id, principalId) {
          if (principalId && [...draft.employees.values()].some(row => row.employeeId !== id && row.principalId === principalId)) {
            throw new EmployeeRosterError('EMPLOYEE_PRINCIPAL_ALREADY_LINKED');
          }
          Object.assign(draft.employees.get(id), { principalId, updatedAt: 'DB-updated' });
        },
        async disableEmployee(id) { Object.assign(draft.employees.get(id), { enabled: false, updatedAt: 'DB-updated' }); },
        async appendEvent(event) {
          if (eventFailure) throw Error('synthetic audit failure');
          draft.events.push({ ...event, occurredAt: 'DB-event' });
        }
      };
      try { const result = await work(tx); state = draft; calls.push(['commit']); return result; }
      catch (error) { calls.push(['rollback']); throw error; }
    }
  };
  return { service: createEmployeeService({ store }), state: () => state, calls,
    failEvents(value) { eventFailure = value; }, changeLocator() { changedLocator = true; } };
}

test('employee create generates stable distinct UUIDs; same names and no-account employees are allowed', async () => {
  const f = fixture(), first = await f.service.createEmployee({ displayName: 'Synthetic Same Name' }, context);
  const second = await f.service.createEmployee({ displayName: 'Synthetic Same Name' }, context);
  assert.match(first.employeeId, /^[0-9a-f-]{36}$/); assert.notEqual(first.employeeId, second.employeeId);
  assert.equal(first.principalId, null); assert.equal(second.principalId, null); assert.equal(first.enabled, true);
  assert.equal(first.createdAt, 'DB-created'); assert.deepEqual(await f.service.getEmployee({ employeeId: first.employeeId }), first);
  assert.equal(f.state().events.length, 2); assert.ok(f.state().events.every(row => row.actorPrincipalId === ids[0]));
});

test('employee service rejects caller UUIDs, client identity/permission fields and invalid display names', async () => {
  const f = fixture();
  for (const input of [{ displayName: '' }, { displayName: ' x' }, { displayName: 'x\n' },
    { displayName: 'x'.repeat(81) }, { displayName: 'Synthetic', employeeId: ids[1] },
    { displayName: 'Synthetic', principalId: ids[1] }, { displayName: 'Synthetic', actorId: ids[1] }]) {
    await assert.rejects(f.service.createEmployee(input, context), TypeError);
  }
  for (const injected of [undefined, { actorPrincipalId: 'administrator' }, { actorPrincipalId: ids[0], permissions: ['*'] }]) {
    await assert.rejects(f.service.createEmployee({ displayName: 'Synthetic' }, injected), TypeError);
  }
  assert.equal(f.state().employees.size, 0); assert.equal(f.calls.length, 0);
});

test('employee audit actor must reference an enabled account; it is distinct from the linked principal', async () => {
  const f = fixture();
  const missing = { actorPrincipalId: '00000000-0000-4000-8000-000000000009' };
  await assert.rejects(f.service.createEmployee({ displayName: 'Synthetic' }, missing), isCode('EMPLOYEE_ACCOUNT_NOT_FOUND'));
  f.state().accounts.get(ids[0]).enabled = false;
  await assert.rejects(f.service.createEmployee({ displayName: 'Synthetic' }, context), isCode('EMPLOYEE_ACTOR_DISABLED'));
  assert.equal(f.state().events.length, 0); f.state().accounts.get(ids[0]).enabled = true;
  const employee = await f.service.createEmployee({ displayName: 'Synthetic' }, context);
  const linked = await f.service.linkPrincipal({ employeeId: employee.employeeId, principalId: ids[1] }, context);
  assert.equal(linked.employee.principalId, ids[1]); assert.equal(f.state().events.at(-1).actorPrincipalId, ids[0]);
});

test('link locks all accounts in stable ID order before employee and audit', async () => {
  const f = fixture(), employee = await f.service.createEmployee({ displayName: 'Synthetic' }, context);
  f.calls.length = 0;
  await f.service.linkPrincipal({ employeeId: employee.employeeId, principalId: ids[0] }, { actorPrincipalId: ids[2] });
  assert.deepEqual(f.calls.slice(0,5), [['begin'], ['locate', employee.employeeId], ['account', ids[0]], ['account', ids[2]], ['employee', employee.employeeId]]);
  f.calls.length = 0;
  await f.service.unlinkPrincipal({ employeeId: employee.employeeId }, { actorPrincipalId: ids[2] });
  assert.deepEqual(f.calls.slice(0,5), [['begin'], ['locate', employee.employeeId], ['account', ids[0]], ['account', ids[2]], ['employee', employee.employeeId]]);
});

test('one principal cannot belong to two employees and an employee cannot be silently rebound', async () => {
  const f = fixture(), a = await f.service.createEmployee({ displayName: 'Same Synthetic' }, context);
  const b = await f.service.createEmployee({ displayName: 'Same Synthetic' }, context);
  await f.service.linkPrincipal({ employeeId: a.employeeId, principalId: ids[1] }, context);
  const before = structuredClone(f.state());
  await assert.rejects(f.service.linkPrincipal({ employeeId: b.employeeId, principalId: ids[1] }, context), isCode('EMPLOYEE_PRINCIPAL_ALREADY_LINKED'));
  await assert.rejects(f.service.linkPrincipal({ employeeId: a.employeeId, principalId: ids[2] }, context), isCode('EMPLOYEE_ALREADY_LINKED'));
  assert.deepEqual(f.state(), before);
});

test('repeated link/unlink are unchanged; explicit unlink then link retains before/after audit history', async () => {
  const f = fixture(), employee = await f.service.createEmployee({ displayName: 'Synthetic' }, context);
  const input = { employeeId: employee.employeeId, principalId: ids[1] };
  assert.equal((await f.service.linkPrincipal(input, context)).changed, true);
  assert.equal((await f.service.linkPrincipal(input, context)).changed, false);
  assert.equal((await f.service.unlinkPrincipal({ employeeId: employee.employeeId }, context)).changed, true);
  assert.equal((await f.service.unlinkPrincipal({ employeeId: employee.employeeId }, context)).changed, false);
  await f.service.linkPrincipal({ ...input, principalId: ids[2] }, context);
  assert.deepEqual(f.state().events.slice(1).map(({eventType,beforePrincipalId,afterPrincipalId}) => [eventType,beforePrincipalId,afterPrincipalId]),
    [['principal-linked',null,ids[1]], ['principal-unlinked',ids[1],null], ['principal-linked',null,ids[2]]]);
});

test('disable retains employee ID, display name and association without disabling account', async () => {
  const f = fixture(), employee = await f.service.createEmployee({ displayName: 'Synthetic' }, context);
  await f.service.linkPrincipal({ employeeId: employee.employeeId, principalId: ids[1] }, context);
  const accounts = structuredClone(f.state().accounts);
  const result = await f.service.disableEmployee({ employeeId: employee.employeeId }, context);
  assert.equal(result.employee.employeeId, employee.employeeId); assert.equal(result.employee.displayName, employee.displayName);
  assert.equal(result.employee.enabled, false); assert.equal(result.employee.principalId, ids[1]);
  assert.deepEqual(f.state().accounts, accounts); assert.equal(f.state().events.at(-1).eventType, 'employee-disabled');
  const count = f.state().events.length;
  assert.equal((await f.service.disableEmployee({ employeeId: employee.employeeId }, context)).changed, false);
  assert.equal(f.state().events.length, count);
});

test('missing employee and missing target account reject without mutation', async () => {
  const f = fixture(), employee = await f.service.createEmployee({ displayName: 'Synthetic' }, context), before = structuredClone(f.state());
  await assert.rejects(f.service.unlinkPrincipal({ employeeId: ids[2] }, context), isCode('EMPLOYEE_NOT_FOUND'));
  await assert.rejects(f.service.linkPrincipal({ employeeId: employee.employeeId, principalId: '00000000-0000-4000-8000-000000000009' }, context), isCode('EMPLOYEE_ACCOUNT_NOT_FOUND'));
  assert.deepEqual(f.state(), before); assert.equal(await f.service.getEmployee({ employeeId: ids[2] }), null);
});

test('nonlocking locator must be rechecked after account then employee locks', async () => {
  const f = fixture(), employee = await f.service.createEmployee({ displayName: 'Synthetic' }, context);
  await f.service.linkPrincipal({ employeeId: employee.employeeId, principalId: ids[1] }, context);
  const before = structuredClone(f.state()); f.changeLocator();
  await assert.rejects(f.service.unlinkPrincipal({ employeeId: employee.employeeId }, context), isCode('EMPLOYEE_ASSOCIATION_CHANGED'));
  assert.deepEqual(f.state(), before);
});

test('audit failure aborts create, link, unlink and disable with no partial change', async () => {
  const f = fixture(), employee = await f.service.createEmployee({ displayName: 'Synthetic' }, context);
  f.failEvents(true); let before = structuredClone(f.state());
  await assert.rejects(f.service.createEmployee({ displayName: 'Synthetic Extra' }, context), /synthetic audit failure/);
  await assert.rejects(f.service.linkPrincipal({ employeeId: employee.employeeId, principalId: ids[1] }, context), /synthetic audit failure/);
  assert.deepEqual(f.state(), before); f.failEvents(false);
  await f.service.linkPrincipal({ employeeId: employee.employeeId, principalId: ids[1] }, context);
  before = structuredClone(f.state()); f.failEvents(true);
  await assert.rejects(f.service.unlinkPrincipal({ employeeId: employee.employeeId }, context), /synthetic audit failure/);
  await assert.rejects(f.service.disableEmployee({ employeeId: employee.employeeId }, context), /synthetic audit failure/);
  assert.deepEqual(f.state(), before);
});
