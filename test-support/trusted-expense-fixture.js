// Synthetic expense inputs and immutable historical facts; no employee attribution.
export const expenseCommand = (key = 'first', revision = 0, changes = {}) => ({
  operationKey: key, expectedRevision: revision, action: 'expense',
  payload: { date: '2026-01-02', type: '报销', amount: 60000, method: '现金', nature: '一次性支出',
    description: '  Synthetic maintenance expense  ', ...changes }
});
export function seedTrustedExpense(state) {
  state.serial = 1000; state.inventory.qd.count = null; state.inventory.bw.count = 0;
  state.expenses = [{ id: 900, date: '2026-01-01', type: '报销', amount: 70000, method: '微信',
    nature: '固定支出', description: 'Historical expense', status: '待老板审批',
    submittedById: 'legacy', person: 'Historical Applicant', time: '2026-01-01T00:00:00Z', approver: '', approvedAt: '' }];
  state.procurements = [{ id: 901, expenseId: 900, status: '报销待老板审批', person: 'Historical Employee' }];
}
