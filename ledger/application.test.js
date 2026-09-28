import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from '../rules.js';
import { createLedgerApplication } from './application.js';
import { createMemoryLedgerStore } from './memory-store.js';

const committedAt = '2026-09-29T12:00:00.000Z';
const ledgerId = 'store-1';
const actorId = 'actor-1';
const retailPayload = () => ({
  items: [{ product: 'bw', spec: 'dozen', count: 1 }],
  payments: [{ method: '微信', amount: 5000 }, { method: '现金', amount: 6800 }]
});
const sale = (operationKey, expectedRevision, payload = retailPayload()) => ({ operationKey, expectedRevision, action: 'retailSale', payload });

function fixture({ count = 24, transactCommand = transact, actor = actorId } = {}) {
  const state = initialState();
  state.clock = '2026-09-29T20:00:00+08:00';
  state.user = 'shaoBoss';
  state.inventory.bw.count = count;
  const store = createMemoryLedgerStore(state, { ledgerId });
  const app = createLedgerApplication({ store, principal: { id: actor }, transactCommand, now: () => committedAt });
  return { state, store, app };
}

test('首次合法命令原子提交状态、结果和成功审计，revision 只增一次', async () => {
  const { state, store, app } = fixture();
  const result = await app.execute(sale('retail-1', 0));
  const head = await store.read();
  assert.deepEqual({ status: result.status, previous: result.previousRevision, next: result.revision }, { status: 'committed', previous: 0, next: 1 });
  assert.match(result.requestFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(result.committedAt, committedAt);
  assert.equal(head.revision, 1);
  const saved = head.operationResults.get('retail-1');
  assert.deepEqual([saved.ledgerId, saved.actorId, saved.action, saved.expectedRevision, saved.committedRevision], [ledgerId, actorId, 'retailSale', 0, 1]);
  assert.equal(saved.requestFingerprint, result.requestFingerprint);
  assert.deepEqual(saved.result, result);
  assert.deepEqual(head.audit, [{ kind: 'command.succeeded', ledgerId, actorId, operationKey: 'retail-1', action: 'retailSale', requestFingerprint: result.requestFingerprint, previousRevision: 0, revision: 1, occurredAt: committedAt }]);
  assert.equal(head.state.processed.filter(key => key === 'retail-1').length, 1);
  assert.equal(head.state.orders.length, 1);
  assert.equal(head.state.orders[0].kind, 'retail');
  assert.equal(head.state.orders[0].room, null);
  assert.equal(head.state.orders[0].payments.length, 2);
  assert.equal(head.state.orders[0].sales[0].totalBaseQuantity, 12);
  assert.equal(head.state.inventory.bw.count, 12);
  assert.equal(head.state.inventory.qd.count, null);
  assert.deepEqual(head.state.rooms, state.rooms);
  assert.equal(head.state.ledger.filter(row => row.orderId === head.state.orders[0].id).length, 1);
  assert.equal(state.inventory.bw.count, 24);
  assert.equal(state.orders.length, 0);
  head.state.inventory.bw.count = 999;
  assert.equal((await store.read()).state.inventory.bw.count, 12);
});

test('房单命令通过同一协议提交，重试不重复占房或扣赠饮库存', async () => {
  const { store, app } = fixture();
  const command = { operationKey: 'room-1', expectedRevision: 0, action: 'open', payload: { room: 'V01', beer: 'bw' } };
  const first = await app.execute(command);
  const afterFirst = await store.read();
  assert.equal(first.revision, 1);
  assert.equal(afterFirst.state.orders[0].kind, 'room');
  assert.equal(afterFirst.state.orders[0].room, 'V01');
  assert.equal(afterFirst.state.rooms.find(room => room.id === 'V01').order, afterFirst.state.orders[0].id);
  assert.equal(afterFirst.state.inventory.bw.count, 12);
  assert.deepEqual(await app.execute(command), first);
  assert.deepEqual(await store.read(), afterFirst);
});

test('相同操作键与等价 JSON 请求返回第一次结果，不重跑付款或库存动作', async () => {
  let calls = 0;
  const { store, app } = fixture({ transactCommand: (...args) => { calls++; return transact(...args); } });
  const first = await app.execute(sale('retail-1', 0));
  const afterFirst = await store.read();
  const retry = await app.execute(sale('retail-1', 0, {
    payments: [{ amount: 5000, method: '微信' }, { amount: 6800, method: '现金' }],
    items: [{ count: 1, spec: 'dozen', product: 'bw' }]
  }));
  assert.deepEqual(retry, first);
  assert.equal(calls, 1);
  assert.deepEqual(await store.read(), afterFirst);
});

test('不同 actor 使用同一 key 和同一请求不能取得原成功结果', async () => {
  const { store, app } = fixture();
  const first = await app.execute(sale('actor-bound', 0));
  const before = await store.read();
  const other = createLedgerApplication({ store, principal: { id: 'actor-2' }, now: () => committedAt });
  assert.deepEqual(await other.execute(sale('actor-bound', 0)), { status: 'idempotency-conflict', ledgerId, operationKey: 'actor-bound', currentRevision: 1, reason: 'actor-mismatch' });
  assert.deepEqual(await store.read(), before);
  assert.deepEqual(await app.execute(sale('actor-bound', 0)), first);
});

test('第一次提交后版本继续变化，原操作键重试仍返回原结果', async () => {
  const { store, app } = fixture();
  const first = await app.execute(sale('retail-1', 0));
  const second = await app.execute(sale('retail-2', 1));
  assert.equal(second.revision, 2);
  assert.deepEqual(await app.execute(sale('retail-1', 0)), first);
  const head = await store.read();
  assert.equal(head.revision, 2);
  assert.equal(head.audit.length, 2);
  assert.equal(head.state.orders.length, 2);
  assert.equal(head.state.inventory.bw.count, 0);
});

test('同键不同请求及改写 expectedRevision 都返回幂等冲突且不改状态', async () => {
  const { store, app } = fixture();
  await app.execute(sale('retail-1', 0));
  const before = await store.read();
  const changed = retailPayload();
  changed.payments[0].method = '支付宝';
  assert.deepEqual(await app.execute(sale('retail-1', 0, changed)), { status: 'idempotency-conflict', ledgerId, operationKey: 'retail-1', currentRevision: 1, reason: 'request-mismatch' });
  assert.deepEqual(await app.execute(sale('retail-1', 1)), { status: 'idempotency-conflict', ledgerId, operationKey: 'retail-1', currentRevision: 1, reason: 'request-mismatch' });
  assert.deepEqual(await app.execute({ operationKey: 'retail-1', expectedRevision: 0, action: 'open', payload: retailPayload() }), { status: 'idempotency-conflict', ledgerId, operationKey: 'retail-1', currentRevision: 1, reason: 'request-mismatch' });
  assert.deepEqual(await store.read(), before);
});

test('旧 revision 的付款命令成为终态，刷新后旧 key 仍不执行', async () => {
  const { store, app } = fixture();
  await app.execute(sale('retail-1', 0));
  const before = await store.read();
  const conflict = await app.execute(sale('payment-2', 0));
  assert.deepEqual(conflict, { status: 'revision-conflict', ledgerId, actorId, operationKey: 'payment-2', expectedRevision: 0, currentRevision: 1 });
  const after = await store.read();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.state, before.state);
  assert.deepEqual(after.audit, before.audit);
  assert.equal(after.operationResults.get('payment-2').committedRevision, null);
  assert.deepEqual(after.operationResults.get('payment-2').result, conflict);
  await app.execute(sale('retail-3', 1));
  assert.deepEqual(await app.execute(sale('payment-2', 0)), conflict);
  assert.deepEqual(await app.execute(sale('payment-2', 2)), { status: 'idempotency-conflict', ledgerId, operationKey: 'payment-2', currentRevision: 2, reason: 'request-mismatch' });
  assert.equal((await store.read()).state.orders.length, 2);
});

test('业务拒绝保留原终态，改正付款后必须使用新操作键', async () => {
  const { store, app } = fixture();
  const before = await store.read();
  const wrong = retailPayload();
  wrong.payments[1].amount = 1;
  const rejection = await app.execute(sale('retail-bad', 0, wrong));
  assert.equal(rejection.status, 'business-rejected');
  assert.match(rejection.reason, /各项收款之和必须等于/);
  const after = await store.read();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.state, before.state);
  assert.deepEqual(after.audit, before.audit);
  assert.equal(after.operationResults.get('retail-bad').committedRevision, null);
  assert.deepEqual(after.operationResults.get('retail-bad').result, rejection);
  const corrected = await app.execute(sale('retail-corrected', 0));
  assert.equal(corrected.revision, 1);
  assert.deepEqual(await app.execute(sale('retail-bad', 0, wrong)), rejection);
  assert.deepEqual(await app.execute(sale('retail-bad', 1)), { status: 'idempotency-conflict', ledgerId, operationKey: 'retail-bad', currentRevision: 1, reason: 'request-mismatch' });
  assert.equal((await store.read()).state.orders.length, 1);
});

test('即使领域函数先修改输入副本再失败，原子存储仍不泄漏部分修改', async () => {
  const { store, app } = fixture({ transactCommand: state => {
    state.orders.push({ id: 'half-order', payments: [{ amount: 1 }] });
    state.inventory.bw.count = 0;
    state.rooms[0].status = '营业中';
    throw TypeError('模拟中途失败');
  } });
  const before = await store.read();
  await assert.rejects(app.execute(sale('partial', 0)), /模拟中途失败/);
  assert.deepEqual(await store.read(), before);
});

test('领域在局部修改后业务拒绝，仅原子保存拒绝终态', async () => {
  const { store, app } = fixture({ transactCommand: state => {
    state.orders.push({ id: 'half-order', payments: [{ amount: 1 }] });
    state.inventory.bw.count = 0;
    throw Error('业务条件不满足');
  } });
  const before = await store.read();
  const result = await app.execute(sale('partial-rejected', 0));
  const after = await store.read();
  assert.equal(result.status, 'business-rejected');
  assert.equal(after.revision, 0);
  assert.deepEqual(after.state, before.state);
  assert.deepEqual(after.audit, before.audit);
  assert.deepEqual(after.operationResults.get('partial-rejected').result, result);
});

test('同一旧 revision 的两个不同操作键竞争，最多一笔成功', async () => {
  const { store, app } = fixture();
  const outcomes = await Promise.all([app.execute(sale('compete-1', 0)), app.execute(sale('compete-2', 0))]);
  assert.deepEqual(outcomes.map(item => item.status).sort(), ['committed', 'revision-conflict']);
  const head = await store.read();
  assert.equal(head.revision, 1);
  assert.equal(head.operationResults.size, 2); // success and terminal revision conflict
  assert.equal(head.audit.length, 1);
  assert.equal(head.state.orders.length, 1);
  assert.equal(head.state.orders[0].payments.length, 2);
  assert.equal(head.state.inventory.bw.count, 12);
});

test('同键并发重试在读取已提交结果后返回，不第二次执行领域事务', async () => {
  let calls = 0;
  const { store, app } = fixture({ transactCommand: (...args) => { calls++; return transact(...args); } });
  const [first, retry] = await Promise.all([app.execute(sale('same-key', 0)), app.execute(sale('same-key', 0))]);
  assert.deepEqual(retry, first);
  assert.equal(calls, 1);
  assert.equal((await store.read()).revision, 1);
});

test('领域 processed 有无结果的旧操作键时停写，不伪造成功回执', async () => {
  const state = initialState();
  state.processed.push('legacy-key');
  const store = createMemoryLedgerStore(state, { ledgerId });
  const app = createLedgerApplication({ store, principal: { id: actorId }, now: () => committedAt });
  const before = await store.read();
  assert.deepEqual(await app.execute(sale('legacy-key', 0)), { status: 'idempotency-conflict', ledgerId, operationKey: 'legacy-key', currentRevision: 0, reason: 'untracked-domain-key' });
  assert.deepEqual(await store.read(), before);
});

test('内存适配器在提议提交后发生异常也不暴露状态、结果或审计', async () => {
  const { store } = fixture();
  const before = await store.read();
  await assert.rejects(store.runAtomic(async transaction => {
    const { state, revision } = await transaction.read();
    await transaction.commit({ ledgerId, actorId, expectedRevision: revision, revision: revision + 1, committedRevision: revision + 1, operationKey: 'not-committed', action: 'retailSale', requestFingerprint: 'x', state, result: { status: 'committed', ledgerId, actorId, operationKey: 'not-committed' }, audit: { kind: 'command.succeeded', ledgerId, actorId, operationKey: 'not-committed' } });
    throw Error('模拟持久化失败');
  }), /模拟持久化失败/);
  assert.deepEqual(await store.read(), before);
});

test('首次响应由已提交结果产生，不被事务回调的临时返回值替换', async () => {
  const { store } = fixture();
  const persistedResult = { status: 'committed', ledgerId, actorId, operationKey: 'direct', revision: 1 };
  const response = await store.runAtomic(async transaction => {
    const { state, revision } = await transaction.read();
    await transaction.commit({ ledgerId, actorId, expectedRevision: revision, revision: revision + 1, committedRevision: revision + 1, operationKey: 'direct', action: 'retailSale', requestFingerprint: 'fingerprint', state, result: persistedResult, audit: { kind: 'command.succeeded', ledgerId, actorId, operationKey: 'direct' } });
    return { status: 'wrong-result' };
  });
  assert.deepEqual(response, persistedResult);
  assert.deepEqual((await store.read()).operationResults.get('direct').result, persistedResult);
});

test('适配器拒绝 actor 与回执不一致的原子提交', async () => {
  const { store } = fixture();
  const before = await store.read();
  await assert.rejects(store.runAtomic(async transaction => {
    const { state, revision } = await transaction.read();
    await transaction.commit({ ledgerId, actorId, expectedRevision: revision, revision: revision + 1, committedRevision: revision + 1, operationKey: 'wrong-actor', action: 'retailSale', requestFingerprint: 'x', state, result: { status: 'committed', ledgerId, actorId: 'actor-2', operationKey: 'wrong-actor' }, audit: { kind: 'command.succeeded', ledgerId, actorId, operationKey: 'wrong-actor' } });
  }), /归属/);
  assert.deepEqual(await store.read(), before);
});

test('非法请求与非 JSON payload 在执行业务前被拒绝', async () => {
  const { store, app } = fixture();
  const before = await store.read();
  await assert.rejects(app.execute(sale('bad', -1)), /revision/);
  await assert.rejects(app.execute(sale('bad', 0, { items: undefined })), /JSON/);
  await assert.rejects(app.execute({ ...sale('bad', 0), traceId: 'random-transport-value' }), /只能包含/);
  assert.deepEqual(await store.read(), before);
});
