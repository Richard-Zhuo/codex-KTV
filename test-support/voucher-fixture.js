// Isolated synthetic port; production always uses explicitly configured MySQL.
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';
export function memoryVoucherFixture() {
  const credential = { tokenDigest: Buffer.alloc(32, 7) };
  const auth = { principalId: 'synthetic-actor', enabled: true, revoked: false, permissions: ['room.open'] };
  let current = { revision: 0, redemptions: new Map(), operations: new Map(), events: new Map(), exceptions: [] };
  let inTransaction = false, queue = Promise.resolve();
  const revalidate = input => revalidateSessionInTransaction({ tokenDigest: input.tokenDigest, port: {
    locateSessionByDigest: async () => ({ principalId: auth.principalId, sessionId: 'synthetic-session' }),
    lockAccount: async () => ({ principalId: auth.principalId, enabled: auth.enabled, credentialVersion: 1, policyAttributesConfigured: false }),
    lockSessionById: async () => ({ principalId: auth.principalId, sessionId: 'synthetic-session', tokenDigest: credential.tokenDigest,
      credentialVersion: 1, revoked: auth.revoked, idleExpiresAt: '2099-01-01T00:00:00.000000Z', absoluteExpiresAt: '2099-01-02T00:00:00.000000Z' }),
    listGrants: async () => auth.permissions, listPolicyAttributes: async () => [], readDbNow: async () => '2026-10-06T04:00:00.123456Z'
  } });
  const store = { testOnly: true, ledgerId: 'synthetic-ledger', storeId: 'synthetic-store', provider: 'meituan',
    runAtomic(work) {
      const run = queue.then(async () => {
        const draft = structuredClone(current); inTransaction = true;
        const tx = {
          revision: draft.revision, sessionRevalidation: { revalidateSessionInTransaction: revalidate },
          findOperation: async k => draft.operations.get(k) || null,
          findVoucher: async hash => [...draft.redemptions.values()].find(r => r.voucherCodeHash === hash) || null,
          getRedemption: async id => draft.redemptions.get(id) || null,
          writeRedemption: async (r, old) => {
            if (old !== undefined && draft.redemptions.get(r.id)?.version !== old) throw Error('version conflict');
            draft.redemptions.set(r.id, structuredClone(r));
          },
          putOperation: async r => draft.operations.set(r.operationKey, structuredClone(r)),
          completeOperation: async (k, result) => { const op = draft.operations.get(k); op.completed = true; op.result = result; },
          findEvent: async id => draft.events.get(id) || null,
          findEventRedemptions: async e => [...draft.redemptions.values()].filter(r =>
            r.externalOrderId === e.externalOrderId && (!e.externalVoucherId || r.externalVoucherId === e.externalVoucherId)),
          putEvent: async e => draft.events.set(e.externalMessageId, structuredClone(e)),
          appendException: async (id, source, reason) => {
            if (!draft.exceptions.some(e => e.id === id && e.source === source)) draft.exceptions.push({ id, source, reason });
          }
        };
        try { const result = await work(tx); current = draft; return structuredClone(result); }
        finally { inTransaction = false; }
      });
      queue = run.catch(() => {}); return run;
    }
  };
  return { store, credential, auth, active: () => inTransaction, read: () => structuredClone(current) };
}
