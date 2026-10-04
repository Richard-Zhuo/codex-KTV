// Called only after auth, saved-result lookup, new-key policy and revision checks.
import { EmployeeRosterError } from '../employees/errors.js';
import { AuthorizationDenied, withTrustedActorEmployee } from '../shared/identity.js';
export async function resolveIncidentActorContext(transaction, context) {
  if (typeof transaction.employeeResolver?.resolvePrincipalEmployeeInTransaction !== 'function') {
    throw TypeError('正式处理结果提交缺少同事务 principal employee resolver port');
  }
  let employee;
  try {
    employee = await transaction.employeeResolver.resolvePrincipalEmployeeInTransaction({ trustedContext: context });
  } catch (error) {
    if (error instanceof EmployeeRosterError && ['EMPLOYEE_PRINCIPAL_NOT_LINKED', 'EMPLOYEE_DISABLED'].includes(error.code)) {
      throw new AuthorizationDenied(error.code === 'EMPLOYEE_DISABLED' ? 'actor-employee-disabled' : 'actor-employee-not-linked');
    }
    throw error;
  }
  return withTrustedActorEmployee(context, employee);
}
