// Attribution only: the caller owns its transaction and actor identity.
import { EmployeeRosterError } from './errors.js';
import { assertTrustedExecutionContext } from '../shared/identity.js';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function createTransactionBoundEmployeeResolver({ port }) {
  if (typeof port?.lockEmployeeForAttribution !== 'function') throw TypeError('必须提供事务内 employee lookup port');
  async function resolveCreditedEmployeeInTransaction(input) {
    const descriptor = input && Object.getOwnPropertyDescriptor(input, 'creditedEmployeeId');
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== 1 ||
        !descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || !uuidPattern.test(descriptor.value)) {
      throw TypeError('必须显式提供 creditedEmployeeId UUID');
    }
    const employeeId = descriptor.value; // Capture ID before awaiting.
    const employee = await port.lockEmployeeForAttribution(employeeId);
    if (employee === null) throw new EmployeeRosterError('EMPLOYEE_NOT_FOUND');
    if (!employee || employee.employeeId !== employeeId || typeof employee.enabled !== 'boolean' ||
        typeof employee.displayName !== 'string' || !employee.displayName.trim()) throw TypeError('employee port 返回无效事实');
    if (!employee.enabled) throw new EmployeeRosterError('EMPLOYEE_DISABLED');
    return Object.freeze({ employeeId, displayName: employee.displayName });
  }
  return Object.freeze({ resolveCreditedEmployeeInTransaction });
}

// Identity linkage only. The caller revalidates session/account on this same transaction
// before binding; this port never accepts an untrusted principal ID or a display name.
export function createTransactionBoundPrincipalEmployeeResolver({ port }) {
  if (typeof port?.lockEmployeeForPrincipal !== 'function') throw TypeError('必须提供事务内 principal employee lookup port');
  async function resolvePrincipalEmployeeInTransaction(input) {
    const descriptor = input && Object.getOwnPropertyDescriptor(input, 'trustedContext');
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== 1 ||
        !descriptor || !Object.hasOwn(descriptor, 'value')) throw TypeError('必须提供事务内 trusted context');
    const context = assertTrustedExecutionContext(descriptor.value);
    const principalId = context.principalId;
    if (!uuidPattern.test(principalId)) throw TypeError('可信 principal UUID 无效');
    const employee = await port.lockEmployeeForPrincipal(principalId);
    if (employee === null) throw new EmployeeRosterError('EMPLOYEE_PRINCIPAL_NOT_LINKED');
    if (!employee || employee.principalId !== principalId || !uuidPattern.test(employee.employeeId) ||
        typeof employee.enabled !== 'boolean' || typeof employee.displayName !== 'string' ||
        !employee.displayName.trim()) throw TypeError('principal employee port 返回无效关联事实');
    if (!employee.enabled) throw new EmployeeRosterError('EMPLOYEE_DISABLED');
    return Object.freeze({ employeeId: employee.employeeId, displayName: employee.displayName });
  }
  return Object.freeze({ resolvePrincipalEmployeeInTransaction });
}
