// Attribution only: the caller owns its transaction and actor identity.
import { EmployeeRosterError } from './errors.js';
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
