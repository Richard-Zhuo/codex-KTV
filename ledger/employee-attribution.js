// Shared attribution for the three migrated employee-credited commands.
import { EmployeeRosterError } from '../employees/errors.js';
import { BusinessRejection } from '../shared/business-error.js';
import { withTrustedCreditedEmployee, withTrustedAssigneeEmployee } from '../shared/identity.js';

export const EMPLOYEE_ATTRIBUTED_ACTIONS = Object.freeze(['reserve', 'sale', 'retailSale']);

// data.employee remains a business input, but now names a stable employee UUID.
// The request itself is never changed: both aliases remain in its fingerprint.
export function employeePolicyPayload(payload) {
  if (payload.creditedEmployeeId !== undefined || payload.employee === undefined || payload.employee === '') return payload;
  return { ...payload, creditedEmployeeId: payload.employee };
}

export async function resolveEmployeeContext(transaction, context, payload, action) {
  if (!EMPLOYEE_ATTRIBUTED_ACTIONS.includes(action) && action !== 'incident') throw TypeError('未迁移的员工归属动作');
  const incident = action === 'incident';
  const label = incident ? '客诉／异常负责人' : action === 'reserve' ? '预约' : '销售';
  if (typeof transaction.employeeResolver?.resolveCreditedEmployeeInTransaction !== 'function') {
    throw TypeError(`正式${label}缺少同事务 employee resolver port`);
  }
  const employeeId = incident ? (payload.assigneeEmployeeId ?? payload.assignee) : (payload.creditedEmployeeId ?? payload.employee);
  if (typeof employeeId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(employeeId) ||
      (incident ? payload.assigneeEmployeeId !== undefined && payload.assignee !== undefined && payload.assignee !== employeeId :
        payload.creditedEmployeeId !== undefined && payload.employee !== undefined && payload.employee !== employeeId)) {
    throw new BusinessRejection('必须显式选择一致的 employee UUID，不按姓名或 principal 推断');
  }
  let employee;
  try {
    employee = await transaction.employeeResolver.resolveCreditedEmployeeInTransaction({ creditedEmployeeId: employeeId });
  } catch (error) {
    // Translate only these explicit, expected attribution rejections. SQL and
    // other errors still roll back without occupying the operation key.
    if (error instanceof EmployeeRosterError && error.code === 'EMPLOYEE_NOT_FOUND') throw new BusinessRejection(`${label}归属员工不存在`);
    if (error instanceof EmployeeRosterError && error.code === 'EMPLOYEE_DISABLED') throw new BusinessRejection(`${label}归属员工已停用`);
    throw error;
  }
  if (employee?.employeeId !== employeeId) throw TypeError('员工解析结果与请求 UUID 不一致');
  return incident ? withTrustedAssigneeEmployee(context, employee) : withTrustedCreditedEmployee(context, employee);
}
