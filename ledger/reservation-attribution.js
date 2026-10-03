// Reserve is the only migrated command consuming this attribution capability.
import { EmployeeRosterError } from '../employees/errors.js';
import { BusinessRejection } from '../shared/business-error.js';
import { withTrustedCreditedEmployee } from '../shared/identity.js';

// data.employee remains a business input, but now names a stable employee UUID.
// The request itself is never changed: both aliases remain in its fingerprint.
export function reservationPolicyPayload(payload) {
  if (payload.creditedEmployeeId !== undefined || payload.employee === undefined || payload.employee === '') return payload;
  return { ...payload, creditedEmployeeId: payload.employee };
}

export async function resolveReservationContext(transaction, context, payload) {
  if (typeof transaction.employeeResolver?.resolveCreditedEmployeeInTransaction !== 'function') {
    throw TypeError('正式预约缺少同事务 employee resolver port');
  }
  const employeeId = payload.creditedEmployeeId ?? payload.employee;
  if (typeof employeeId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(employeeId) ||
      (payload.creditedEmployeeId !== undefined && payload.employee !== undefined && payload.employee !== employeeId)) {
    throw new BusinessRejection('必须显式选择一致的 employee UUID，不按姓名或 principal 推断');
  }
  let employee;
  try {
    employee = await transaction.employeeResolver.resolveCreditedEmployeeInTransaction({ creditedEmployeeId: employeeId });
  } catch (error) {
    // Translate only these explicit, expected attribution rejections. SQL and
    // other errors still roll back without occupying the operation key.
    if (error instanceof EmployeeRosterError && error.code === 'EMPLOYEE_NOT_FOUND') throw new BusinessRejection('预约归属员工不存在');
    if (error instanceof EmployeeRosterError && error.code === 'EMPLOYEE_DISABLED') throw new BusinessRejection('预约归属员工已停用');
    throw error;
  }
  if (employee?.employeeId !== employeeId) throw TypeError('员工解析结果与请求 UUID 不一致');
  return withTrustedCreditedEmployee(context, employee);
}
