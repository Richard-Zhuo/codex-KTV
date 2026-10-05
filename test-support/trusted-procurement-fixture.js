import { seedTrustedExpense } from './trusted-expense-fixture.js';

export const procurementPrincipalId = '50000000-0000-4000-8000-000000000001';
export const otherProcurementPrincipalId = '50000000-0000-4000-8000-000000000002';
export const procurementDbNow = '2026-10-05T12:00:00.123456Z';
export const procurementCommand = (key = 'procurement-1', revision = 0, changes = {}) => ({
  operationKey: key, expectedRevision: revision, action: 'procurement',
  payload: { date: '2026-01-02', item: '  Synthetic supplies  ', quantity: 12, unit: ' pack ',
    amount: 60000, method: '现金', type: '报销', nature: '一次性支出', description: '  Synthetic procurement  ', ...changes }
});
export const seedTrustedProcurement = seedTrustedExpense;
