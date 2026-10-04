import { seedTrustedExpense } from './trusted-expense-fixture.js';
export const EXPENSE_REVIEW_ACTIONS = ['approveExpense', 'rejectExpense'];
export const expenseReview = state => state.expenses.find(row => row.id === 902);
export const expenseReviewCommand = (action = 'approveExpense', key = 'decision', revision = 0, changes = {}) => ({
  operationKey: key, expectedRevision: revision, action, payload: { id: 902, ...changes }
});
export function seedExpenseReview(state, applicant = 'synthetic-expense-applicant', amount = 50000) {
  seedTrustedExpense(state);
  // A pending record is a precondition here; normal <=500 creation still stays 已记录.
  state.expenses.push({ id: 902, date: '2026-01-02', type: '报销', amount, method: '现金', nature: '一次性支出',
    description: 'Synthetic review', proof: 'data:image/png;base64,synthetic', proofName: 'Historical proof',
    status: '待老板审批', person: 'Applicant display snapshot', submittedById: 'legacy',
    submittedByPrincipalId: applicant, time: '2026-01-02T00:00:00Z', approver: '', approvedAt: '' });
  state.procurements.push({ id: 903, expenseId: 902, status: '报销待老板审批', person: 'Historical Employee',
    description: 'Historical procurement', amount, time: '2026-01-02T00:00:00Z' });
}
