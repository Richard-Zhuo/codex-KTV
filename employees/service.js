import { randomUUID } from 'node:crypto';
import { EmployeeRosterError } from './errors.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function uuid(value) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw TypeError('必须提供规范 UUID');
}
function fields(input, expected) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== expected.length || expected.some(key => !Object.hasOwn(input, key))) {
    throw TypeError('员工名册参数字段无效');
  }
}
function actor(context) {
  fields(context, ['actorPrincipalId']);
  uuid(context.actorPrincipalId);
  return context.actorPrincipalId;
}
function displayName(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value ||
      [...value].length > 80 || /[\u0000-\u001f\u007f]/.test(value)) throw TypeError('员工显示名无效');
}

// Internal management capability: caller supplies an already trusted audit actor.
// This is not an authenticated command/API and must not be exposed to client JSON.
export function createEmployeeService({ store }) {
  if (typeof store?.runTransaction !== 'function' || typeof store?.readEmployee !== 'function') {
    throw TypeError('员工名册 store 无效');
  }

  async function lockAccounts(tx, actorPrincipalId, otherIds = []) {
    for (const principalId of [...new Set([actorPrincipalId, ...otherIds].filter(Boolean))].sort()) {
      const account = await tx.lockAccount(principalId);
      if (!account) throw new EmployeeRosterError('EMPLOYEE_ACCOUNT_NOT_FOUND');
      if (principalId === actorPrincipalId && !account.enabled) {
        throw new EmployeeRosterError('EMPLOYEE_ACTOR_DISABLED');
      }
    }
  }

  async function lockEmployee(tx, employeeId, actorPrincipalId, targetPrincipalId = null) {
    // Locator is not a locked fact. All audit FK accounts are locked before employee.
    const located = await tx.locateEmployee(employeeId);
    if (!located) throw new EmployeeRosterError('EMPLOYEE_NOT_FOUND');
    await lockAccounts(tx, actorPrincipalId, [located.principalId, targetPrincipalId]);
    const current = await tx.lockEmployee(employeeId);
    if (!current) throw new EmployeeRosterError('EMPLOYEE_NOT_FOUND');
    if (current.principalId !== located.principalId) {
      throw new EmployeeRosterError('EMPLOYEE_ASSOCIATION_CHANGED');
    }
    return current;
  }

  async function createEmployee(input, context) {
    fields(input, ['displayName']); displayName(input.displayName);
    const actorPrincipalId = actor(context), employeeId = randomUUID();
    return store.runTransaction(async tx => {
      await lockAccounts(tx, actorPrincipalId);
      await tx.insertEmployee({ employeeId, displayName: input.displayName });
      await tx.appendEvent({ employeeId, actorPrincipalId, eventType: 'employee-created',
        beforePrincipalId: null, afterPrincipalId: null });
      return tx.lockEmployee(employeeId);
    });
  }

  async function getEmployee(input) {
    fields(input, ['employeeId']); uuid(input.employeeId);
    return store.readEmployee(input.employeeId);
  }

  async function linkPrincipal(input, context) {
    fields(input, ['employeeId', 'principalId']); uuid(input.employeeId); uuid(input.principalId);
    const actorPrincipalId = actor(context);
    return store.runTransaction(async tx => {
      const employee = await lockEmployee(tx, input.employeeId, actorPrincipalId, input.principalId);
      if (employee.principalId === input.principalId) return { changed: false, employee };
      if (employee.principalId !== null) throw new EmployeeRosterError('EMPLOYEE_ALREADY_LINKED');
      await tx.setPrincipal(input.employeeId, input.principalId);
      await tx.appendEvent({ employeeId: input.employeeId, actorPrincipalId, eventType: 'principal-linked',
        beforePrincipalId: null, afterPrincipalId: input.principalId });
      return { changed: true, employee: await tx.lockEmployee(input.employeeId) };
    });
  }

  async function unlinkPrincipal(input, context) {
    fields(input, ['employeeId']); uuid(input.employeeId);
    const actorPrincipalId = actor(context);
    return store.runTransaction(async tx => {
      const employee = await lockEmployee(tx, input.employeeId, actorPrincipalId);
      if (employee.principalId === null) return { changed: false, employee };
      await tx.setPrincipal(input.employeeId, null);
      await tx.appendEvent({ employeeId: input.employeeId, actorPrincipalId, eventType: 'principal-unlinked',
        beforePrincipalId: employee.principalId, afterPrincipalId: null });
      return { changed: true, employee: await tx.lockEmployee(input.employeeId) };
    });
  }

  async function disableEmployee(input, context) {
    fields(input, ['employeeId']); uuid(input.employeeId);
    const actorPrincipalId = actor(context);
    return store.runTransaction(async tx => {
      const employee = await lockEmployee(tx, input.employeeId, actorPrincipalId);
      if (!employee.enabled) return { changed: false, employee };
      await tx.disableEmployee(input.employeeId);
      await tx.appendEvent({ employeeId: input.employeeId, actorPrincipalId, eventType: 'employee-disabled',
        beforePrincipalId: employee.principalId, afterPrincipalId: employee.principalId });
      return { changed: true, employee: await tx.lockEmployee(input.employeeId) };
    });
  }

  return Object.freeze({ createEmployee, getEmployee, linkPrincipal, unlinkPrincipal, disableEmployee });
}
