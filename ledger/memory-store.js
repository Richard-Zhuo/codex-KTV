// Serialized in-memory adapter for Stage 1A protocol tests; it is not durable storage.
export function createMemoryLedgerStore(initialState, { revision = 0 } = {}) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw TypeError('初始 revision 无效');
  let head = { revision, state: structuredClone(initialState), operationResults: new Map(), audit: [] };
  let queue = Promise.resolve();

  const runAtomic = work => {
    const run = queue.then(async () => {
      let proposed = null;
      const transaction = {
        read: async () => structuredClone({ revision: head.revision, state: head.state }),
        findOperationResult: async key => structuredClone(head.operationResults.get(key) ?? null),
        commit: async change => {
          if (proposed) throw Error('同一事务不能提交两次');
          if (change.expectedRevision !== head.revision || change.revision !== head.revision + 1 || !Number.isSafeInteger(change.revision)) throw Error('原子提交 revision 冲突');
          if (head.operationResults.has(change.operationKey)) throw Error('原子提交 operationKey 冲突');
          proposed = structuredClone(change);
        }
      };
      const response = await work(transaction);
      if (proposed) {
        // One assignment is the only visibility point for state, result, revision and audit.
        const next = {
          revision: proposed.revision,
          state: proposed.state,
          operationResults: new Map(head.operationResults),
          audit: [...head.audit, proposed.audit]
        };
        next.operationResults.set(proposed.operationKey, { requestFingerprint: proposed.requestFingerprint, result: proposed.result });
        head = next;
      }
      return structuredClone(proposed ? proposed.result : response);
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  return { read: async () => structuredClone(head), runAtomic };
}
