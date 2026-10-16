import { initialState } from '../rules.js';
import { createMemoryLedgerStore } from '../ledger/memory-store.js';
import { createTrustedLedgerApplication } from '../ledger/application.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
export const paymentId = '70000000-0000-4000-8000-000000000001';
export const ownerId = '70000000-0000-4000-8000-000000000002';
export const applicantId = '70000000-0000-4000-8000-000000000003';
export const reviewerId = '70000000-0000-4000-8000-000000000004';
export const orderId = 'financial-order';
export const actorGrants = ['payment.reverse', 'payment.refund'];
export function seedFinancialState(state) {
  state.orders.push({ id: orderId, kind: 'room', room: state.rooms[0].id, status: '营业中',
    packageBaseCents: 10000, packageGiftValueCents: 0, sales: [], otherCharges: [], giftRequests: [],
    rounding: 0, roundingType: '', roundingReview: null, credit: null,
    businessDate: '2026-01-01', businessDayRuleVersion: 'noon-v1', businessTimeZone: 'Asia/Shanghai',
    payments: [{ paymentId, amount: 10000, method: '现金', chargeId: 'open',
      occurredAt: '2026-01-01T12:00:00.000000Z', recordedByPrincipalId: ownerId }] });
  state.rooms[0].status = '营业中'; state.rooms[0].order = orderId;
}
export const financialOrder = state => state.orders.find(o => o.id === orderId);
export const financialCommand = (action, operationKey, expectedRevision, changes = {}) => ({
  action, operationKey, expectedRevision, payload: { order: orderId, originalPaymentId: paymentId,
    amount: action === 'reversePayment' ? 10000 : 3000, reason: '现场核对',
    ...(action === 'refundPayment' ? { refundChannel: '现金', refundFundingSource: 'CURRENT_DRAWER' } : {}), ...changes }
});
export function financialFixture({ prepare = () => {}, businessTimeZone = 'Asia/Shanghai', transactCommand } = {}) {
  const state = initialState(); state.user = 'administrator'; state.clock = '1900-01-01'; seedFinancialState(state); prepare(state);
  const memory = createMemoryLedgerStore(state, { ledgerId: 'financial-unit' });
  const accounts = new Map([
    [ownerId, { grants: [...actorGrants, 'financial.direct', 'financial.approve'] }],
    [applicantId, { grants: [...actorGrants, 'financial.approve', 'review.self'] }],
    [reviewerId, { grants: ['financial.approve', ...actorGrants] }]
  ]);
  const credentials = new Map([...accounts.keys()].map((id, i) => [id, { tokenDigest: Buffer.alloc(32, i + 1) }]));
  let dbNow = '2026-10-15T21:59:59.000000Z';
  const store = { ledgerId: memory.ledgerId, runAtomic: work => memory.runAtomic(tx => {
    tx.sessionRevalidation = { revalidateSessionInTransaction: credential => {
      const id = [...credentials].find(([, c]) => c.tokenDigest.equals(credential.tokenDigest))?.[0];
      if (!id) return null;
      const account = accounts.get(id);
      return revalidateSessionInTransaction({ credential, ...credential, port: {
        locateSessionByDigest: async () => ({ principalId: id, sessionId: id }),
        lockAccount: async () => ({ principalId: id, enabled: true, credentialVersion: 1, policyAttributesConfigured: false }),
        lockSessionById: async () => ({ principalId: id, sessionId: id, tokenDigest: credential.tokenDigest,
          revoked: false, credentialVersion: 1, idleExpiresAt: '2099-01-01T00:00:00.000000Z', absoluteExpiresAt: '2099-01-02T00:00:00.000000Z' }),
        listGrants: async () => account.grants, listPolicyAttributes: async () => [], readDbNow: async () => dbNow
      } });
    } };
    return work(tx);
  }) };
  const app = createTrustedLedgerApplication({ store, businessTimeZone, ...(transactCommand ? { transactCommand } : {}) });
  return { state, memory, app, store, accounts, credentials, setTime: value => { dbNow = value; },
    execute: (command, id = ownerId) => app.execute(command, credentials.get(id)) };
}
