// Roster errors stay outside domain BusinessRejection and ledger terminal results.
export class EmployeeRosterError extends Error {
  constructor(code) {
    super(code);
    this.name = 'EmployeeRosterError';
    this.code = code;
  }
}

export class EmployeeCommitOutcomeUnknown extends Error {
  constructor(cause, employeeId = null) {
    super('员工名册事务提交结果不明；先按 employeeId 核对，不能自动重新创建', { cause });
    this.name = 'EmployeeCommitOutcomeUnknown';
    this.code = 'EMPLOYEE_COMMIT_OUTCOME_UNKNOWN';
    this.employeeId = employeeId;
  }
}
