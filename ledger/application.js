// Stage 1A application protocol. No browser storage, transport, login, or database binding.
import { createHash } from 'node:crypto';
import { transact } from '../rules.js';
import { BusinessRejection } from '../shared/business-error.js';

const plainObject = value => value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

// Hash the JSON values actually passed to transact, independent of object key order.
function canonicalJson(value, stack = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || stack.has(value)) throw TypeError('命令内容必须是无循环的 JSON 值');
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1 || !Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)) {
        throw TypeError('命令数组必须是完整的 JSON 数组');
      }
      return `[${value.map(item => canonicalJson(item, stack)).join(',')}]`;
    }
    if (!plainObject(value)) throw TypeError('命令内容必须是普通 JSON 对象');
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || !Object.getOwnPropertyDescriptor(value, key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
      throw TypeError('命令对象不能含隐藏字段、符号或取值函数');
    }
    return `{${keys.sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], stack)}`).join(',')}}`;
  } finally {
    stack.delete(value);
  }
}

function prepare(command) {
  if (!plainObject(command) || Reflect.ownKeys(command).some(key => !['operationKey', 'expectedRevision', 'action', 'payload'].includes(key))) {
    throw TypeError('账本命令只能包含 operationKey、expectedRevision、action、payload');
  }
  const { operationKey, expectedRevision, action, payload } = command;
  if (typeof operationKey !== 'string' || !operationKey || operationKey.length > 120 || operationKey.trim() !== operationKey) throw TypeError('操作键无效');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw TypeError('期望 revision 无效');
  if (typeof action !== 'string' || !action || action.length > 100 || action.trim() !== action) throw TypeError('操作类型无效');
  if (!plainObject(payload)) throw TypeError('业务 payload 必须是 JSON 对象');
  const payloadJson = canonicalJson(payload);
  const requestJson = `{"action":${JSON.stringify(action)},"expectedRevision":${expectedRevision},"payload":${payloadJson}}`;
  return {
    operationKey, expectedRevision, action,
    payload: JSON.parse(payloadJson),
    requestFingerprint: createHash('sha256').update(requestJson, 'utf8').digest('hex')
  };
}

// Store port: runAtomic holds one ledger's transaction lock from read to commit;
// commit stages state, result and success audit together, or persists none of them.
export function createLedgerApplication({ store, principal, transactCommand = transact, now = () => new Date().toISOString() }) {
  const ledgerId = store?.ledgerId;
  const actorId = principal?.id; // Trusted caller input; authentication is a later stage.
  if (typeof ledgerId !== 'string' || !ledgerId || typeof actorId !== 'string' || !actorId || actorId.trim() !== actorId || typeof store?.runAtomic !== 'function' || typeof transactCommand !== 'function' || typeof now !== 'function') throw TypeError('账本、可信操作者或执行边界未配置');
  return {
    async execute(command) {
      const request = prepare(command);
      return store.runAtomic(async transaction => {
        const { ledgerId: observedLedgerId, state, revision: currentRevision } = await transaction.read();
        if (observedLedgerId !== ledgerId) throw Error('账本标识不一致，停止提交');
        const saved = await transaction.findOperationResult(request.operationKey);
        if (saved) {
          if (saved.ledgerId !== ledgerId || saved.result?.ledgerId !== ledgerId || saved.result?.actorId !== saved.actorId || saved.result?.operationKey !== request.operationKey) throw Error('操作结果归属不一致，停止提交');
          if (saved.actorId !== actorId) return { status: 'idempotency-conflict', ledgerId, operationKey: request.operationKey, currentRevision, reason: 'actor-mismatch' };
          if (saved.requestFingerprint !== request.requestFingerprint) return { status: 'idempotency-conflict', ledgerId, operationKey: request.operationKey, currentRevision, reason: 'request-mismatch' };
          if (saved.action !== request.action || saved.expectedRevision !== request.expectedRevision) throw Error('操作结果请求元数据不一致，停止提交');
          return saved.result;
        }
        const finishRejected = async result => {
          await transaction.recordTerminal({ ledgerId, actorId, operationKey: request.operationKey, action: request.action, requestFingerprint: request.requestFingerprint, expectedRevision: request.expectedRevision, observedRevision: currentRevision, committedRevision: null, result });
          return result;
        };
        if (request.expectedRevision !== currentRevision) {
          return finishRejected({ status: 'revision-conflict', ledgerId, actorId, operationKey: request.operationKey, expectedRevision: request.expectedRevision, currentRevision });
        }
        if (!Array.isArray(state?.processed)) throw Error('领域操作键状态不可核对，停止提交');
        if (state.processed.includes(request.operationKey)) {
          return { status: 'idempotency-conflict', ledgerId, operationKey: request.operationKey, currentRevision, reason: 'untracked-domain-key' };
        }
        if (!Number.isSafeInteger(currentRevision + 1)) throw RangeError('revision 已达到安全整数上限');
        let nextState;
        try {
          nextState = transactCommand(state, request.action, request.payload, request.operationKey);
        } catch (error) {
          // Only explicit domain rejections reserve the key; unknown failures roll back.
          if (!(error instanceof BusinessRejection)) throw error;
          return finishRejected({ status: 'business-rejected', ledgerId, actorId, operationKey: request.operationKey, expectedRevision: request.expectedRevision, currentRevision, reason: error.message });
        }
        if (nextState === state || !Array.isArray(nextState?.processed) || !nextState.processed.includes(request.operationKey)) {
          throw Error('领域事务未确认操作键，停止提交');
        }
        const revision = currentRevision + 1;
        const committedAt = await (transaction.commitTimestamp?.() ?? now());
        if (typeof committedAt !== 'string' || !/T.+(?:Z|[+-]\d{2}:\d{2})$/.test(committedAt) || !Number.isFinite(Date.parse(committedAt))) throw TypeError('成功审计时间无效');
        const result = {
          status: 'committed', ledgerId, actorId, operationKey: request.operationKey, requestFingerprint: request.requestFingerprint,
          previousRevision: currentRevision, revision, committedAt
        };
        const audit = {
          kind: 'command.succeeded', ledgerId, actorId, operationKey: request.operationKey, action: request.action,
          requestFingerprint: request.requestFingerprint, previousRevision: currentRevision, revision, occurredAt: committedAt
        };
        await transaction.commit({ ledgerId, actorId, expectedRevision: currentRevision, revision, committedRevision: revision, operationKey: request.operationKey, action: request.action, requestFingerprint: request.requestFingerprint, state: nextState, result, audit });
        return result;
      });
    }
  };
}
