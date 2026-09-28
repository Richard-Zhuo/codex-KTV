// Serialized in-memory adapter for Stage 1A protocol tests; it is not durable storage.
export function createMemoryLedgerStore(initialState, { ledgerId, revision = 0 } = {}) {
  if (typeof ledgerId !== 'string' || !ledgerId) throw TypeError('账本标识无效');
  if (!Number.isSafeInteger(revision) || revision < 0) throw TypeError('初始 revision 无效');
  let head = { ledgerId, revision, state: structuredClone(initialState), operationResults: new Map(), audit: [] };
  let queue = Promise.resolve();

  const runAtomic = work => {
    const run = queue.then(async () => {
      let proposed = null;
      const transaction = {
        read: async () => structuredClone({ ledgerId, revision: head.revision, state: head.state }),
        findOperationResult: async key => structuredClone(head.operationResults.get(key) ?? null),
        commit: async change => {
          if (proposed) throw Error('同一事务不能记录两个终态');
          if (change.expectedRevision !== head.revision || change.revision !== head.revision + 1 || !Number.isSafeInteger(change.revision) || change.committedRevision !== change.revision || change.result?.status !== 'committed' || change.audit?.kind !== 'command.succeeded') throw Error('原子提交 revision 或结果无效');
          if (change.ledgerId !== ledgerId || head.operationResults.has(change.operationKey) || change.result?.ledgerId !== ledgerId || change.result?.actorId !== change.actorId || change.result?.operationKey !== change.operationKey || change.audit?.actorId !== change.actorId || change.audit?.ledgerId !== ledgerId || change.audit?.operationKey !== change.operationKey) throw Error('原子提交结果、审计或账本归属冲突');
          proposed = { ...structuredClone(change), kind: 'committed' };
        },
        recordTerminal: async change => {
          if (proposed) throw Error('同一事务不能记录两个终态');
          if (change.ledgerId !== ledgerId || head.operationResults.has(change.operationKey) || change.result?.ledgerId !== ledgerId || change.result?.actorId !== change.actorId || change.result?.operationKey !== change.operationKey) throw Error('拒绝终态结果或账本归属冲突');
          if (change.observedRevision !== head.revision || change.committedRevision !== null || !['revision-conflict', 'business-rejected'].includes(change.result?.status)) throw Error('拒绝终态与当前 revision 不一致');
          proposed = { ...structuredClone(change), kind: 'rejected' };
        }
      };
      const response = await work(transaction);
      if (proposed) {
        // One assignment publishes a terminal result; success also publishes state and audit.
        const committed = proposed.kind === 'committed';
        const next = {
          ledgerId,
          revision: committed ? proposed.revision : head.revision,
          state: committed ? proposed.state : head.state,
          operationResults: new Map(head.operationResults),
          audit: committed ? [...head.audit, proposed.audit] : head.audit
        };
        next.operationResults.set(proposed.operationKey, { ledgerId, actorId: proposed.actorId, operationKey: proposed.operationKey, action: proposed.action, requestFingerprint: proposed.requestFingerprint, expectedRevision: proposed.expectedRevision, result: proposed.result, committedRevision: proposed.committedRevision });
        head = next;
      }
      return structuredClone(proposed ? proposed.result : response);
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  return { ledgerId, read: async () => structuredClone(head), runAtomic };
}
