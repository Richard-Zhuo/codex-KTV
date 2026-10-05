import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from './rules.js';
import { total, outstanding, collected } from './sales.js';
let serial=0;
const run=(state,action,data={})=>transact(state,action,data,'finality-'+(++serial));
function opened(){const state=initialState();state.user='administrator';state.clock='2026-10-05T20:00:00+08:00';return run(state,'open',{room:'V01',beer:'bw'});}
const room=state=>state.rooms.find(r=>r.id==='V01');
test('K01: 168 due, 150 paid and 18 pending waiver keep the order and room active, replay only returns original state',()=>{
  const before=opened(),id=before.orders[0].id,payload={order:id,payments:[{method:'现金',amount:15000}]};
  const after=transact(before,'settle',payload,'pending-once'),order=after.orders[0];
  assert.equal(total(order),16800);assert.equal(collected(after),15000);assert.equal(outstanding(order),1800);
  assert.equal(order.roundingReview.status,'待审核');assert.equal(order.roundingReview.amount,1800);
  assert.equal(order.status,'营业中');assert.equal(Object.hasOwn(order,'closedAt'),false);
  assert.equal(room(after).status,'营业中');assert.equal(room(after).order,id);
  assert.strictEqual(transact(after,'settle',payload,'pending-once'),after);assert.equal(order.payments.length,1);
});

test('K06: 168 due, 160 paid and 8 directly effective rounding leave zero outstanding, no fictitious payment',()=>{
  const before=opened(),after=run(before,'settle',{order:before.orders[0].id,payments:[{method:'现金',amount:16000}]}),order=after.orders[0];
  assert.equal(total(order),16800);assert.equal(collected(after),16000);assert.equal(order.payments.length,1);assert.equal(order.rounding,800);
  assert.equal(order.roundingReview,null);assert.equal(outstanding(order),0);assert.equal(order.status,'已结账');assert.equal(room(after).status,'待清洁');
});

test('K01 approval: the existing 150 payment stays intact; approved 18 waiver closes and releases in the same transaction',()=>{
  const before=opened(),id=before.orders[0].id,pending=run(before,'settle',{order:id,payments:[{method:'现金',amount:15000}]}),payments=structuredClone(pending.orders[0].payments);
  const approved=run(pending,'approveRounding',{order:id}),order=approved.orders[0];
  assert.equal(order.roundingReview.status,'已批准');assert.equal(outstanding(order),0);assert.deepEqual(order.payments,payments);
  assert.equal(collected(approved),15000);assert.equal(order.status,'已结账');assert.equal(room(approved).status,'待清洁');assert.equal(room(approved).order,null);
});

test('K06: approved rounding remains effective when extra charges keep the order active and a later full payment replaces current rounding',()=>{
  let state=opened(),id=state.orders[0].id;
  state=run(state,'settle',{order:id,payments:[{method:'现金',amount:15000}]});
  state=run(state,'otherCharge',{order:id,category:'其他',item:'Additional service',amount:5000});
  state=run(state,'approveRounding',{order:id});assert.equal(outstanding(state.orders[0]),5000);assert.equal(state.orders[0].status,'营业中');
  const approved=structuredClone(state.orders[0].roundingReview);state=run(state,'pay',{order:id,payments:[{method:'微信',amount:5000}]});
  assert.equal(collected(state),20000);assert.equal(outstanding(state.orders[0]),0);assert.equal(state.orders[0].status,'已结账');
  assert.equal(state.orders[0].roundingHistory.length,1);assert.deepEqual(state.orders[0].roundingHistory[0].roundingReview,approved);
});

for (const difference of [999, 1000, 1001]) {
  test('rounding finality: ordinary ' + difference + ' cents uses the existing 10-yuan boundary', () => {
    const before = opened(), id = before.orders[0].id;
    const state = run(before, 'settle', { order: id, payments: [{ method: '现金', amount: 16800 - difference }] });
    const order = state.orders[0], needsReview = difference > 1000;
    assert.equal(order.rounding, difference);
    assert.equal(Boolean(order.roundingReview), needsReview);
    assert.equal(outstanding(order), needsReview ? difference : 0);
    assert.equal(order.status, needsReview ? '营业中' : '已结账');
    assert.equal(room(state).status, needsReview ? '营业中' : '待清洁');
    assert.equal(room(state).order, needsReview ? id : null);
  });
}

test('K01 rejection: 150 stays collected, 18 stays outstanding and the room stays occupied; later pay only collects the remainder', () => {
  const before = opened(), id = before.orders[0].id;
  const pending = run(before, 'settle', { order: id, payments: [{ method: '现金', amount: 15000 }] });
  const payments = structuredClone(pending.orders[0].payments);
  const rejected = run(pending, 'rejectRounding', { order: id, decisionNote: 'Not approved' });
  const order = rejected.orders[0];
  assert.equal(order.roundingReview.status, '已驳回');
  assert.deepEqual(order.payments, payments); assert.equal(collected(rejected), 15000);
  assert.equal(outstanding(order), 1800); assert.equal(order.status, '营业中');
  assert.equal(room(rejected).status, '营业中'); assert.equal(room(rejected).order, id);
  assert.equal(Object.hasOwn(order, 'closedAt'), false);
  const paid = run(rejected, 'pay', { order: id, payments: [{ method: '微信', amount: 1800 }] });
  assert.equal(paid.orders[0].payments.length, 2); assert.equal(collected(paid), 16800);
  assert.equal(outstanding(paid.orders[0]), 0); assert.equal(paid.orders[0].status, '已结账');
  assert.equal(paid.orders[0].roundingHistory[0].roundingReview.status, '已驳回');
});

test('K01: a special-case 8-yuan waiver still waits for approval and becomes effective only after the decision', () => {
  const before = opened(), id = before.orders[0].id;
  const pending = run(before, 'settle', { order: id, payments: [{ method: '现金', amount: 16000 }],
    differenceType: '特殊情况', differenceNote: 'Requires review' });
  assert.equal(outstanding(pending.orders[0]), 800); assert.equal(pending.orders[0].status, '营业中');
  assert.equal(room(pending).order, id);
  const approved = run(pending, 'approveRounding', { order: id });
  assert.equal(outstanding(approved.orders[0]), 0); assert.equal(room(approved).status, '待清洁');
  assert.equal(collected(approved), 16000);
});

test('K06: several collect payments and channels plus one effective waiver reconcile without altering charge or payment amounts', () => {
  let state = opened(); const id = state.orders[0].id;
  state = run(state, 'collect', { order: id, charge: 'open', payments: [{ method: '微信', amount: 10000 }, { method: '现金', amount: 6800 }] });
  state = run(state, 'otherCharge', { order: id, category: '其他', item: 'First service', amount: 4000 });
  const firstCharge = 'other:' + state.orders[0].otherCharges[0].batch;
  state = run(state, 'collect', { order: id, charge: firstCharge, payments: [{ method: '支付宝', amount: 2000 }, { method: '现金', amount: 2000 }] });
  state = run(state, 'otherCharge', { order: id, category: '其他', item: 'Second service', amount: 3000 });
  const previous = structuredClone(state.orders[0].payments);
  state = run(state, 'settle', { order: id, payments: [{ method: '现金', amount: 2200 }] });
  assert.equal(total(state.orders[0]), 23800); assert.equal(collected(state), 23000);
  assert.equal(state.orders[0].rounding, 800); assert.equal(outstanding(state.orders[0]), 0);
  assert.deepEqual(state.orders[0].payments.slice(0, 4), previous); assert.equal(state.orders[0].payments.length, 5);
});

test('K06: a later settlement retains prior approved waivers and all real payments, each waiver is effective once', () => {
  let state = opened(); const id = state.orders[0].id;
  state = run(state, 'settle', { order: id, payments: [{ method: '现金', amount: 15000 }] });
  state = run(state, 'otherCharge', { order: id, category: '其他', item: 'Additional service', amount: 5000 });
  state = run(state, 'approveRounding', { order: id });
  const earlier = structuredClone(state.orders[0].roundingReview);
  state = run(state, 'settle', { order: id, payments: [{ method: '微信', amount: 3000 }] });
  assert.equal(state.orders[0].rounding, 2000); assert.equal(outstanding(state.orders[0]), 2000);
  assert.equal(state.orders[0].roundingHistory.length, 1);
  assert.deepEqual(state.orders[0].roundingHistory[0].roundingReview, earlier);
  state = run(state, 'approveRounding', { order: id });
  assert.equal(collected(state), 18000); assert.equal(total(state.orders[0]), 21800);
  assert.equal(outstanding(state.orders[0]), 0); assert.equal(state.orders[0].status, '已结账');
  assert.equal(room(state).status, '待清洁');
});

const uncertainWaivers = [
  ['pending', { rounding: 1800, roundingType: '免零', roundingReview: { status: '待审核', amount: 1800 } }],
  ['rejected', { rounding: 1800, roundingType: '免零', roundingReview: { status: '已驳回', amount: 1800 } }],
  ['missing review', { rounding: 800, roundingType: '免零' }],
  ['missing review status', { rounding: 800, roundingType: '免零', roundingReview: { amount: 800 } }],
  ['missing waiver kind', { rounding: 800, roundingReview: null }],
  ['mismatched approved amount', { rounding: 1800, roundingType: '免零', roundingReview: { status: '已批准', amount: 800 } }],
  ['unreviewed excess', { rounding: 1800, roundingType: '免零', roundingReview: null }],
  ['unreviewed special case', { rounding: 800, roundingType: '特殊情况', roundingReview: null }]
];
for (const [label, waiver] of uncertainWaivers) {
  test('K06: ' + label + ' is not effective in current or retained legacy records', () => {
    const order = opened().orders[0]; order.payments = [{ method: '现金', amount: 15000 }];
    delete order.roundingReview; delete order.roundingType;
    Object.assign(order, waiver); assert.equal(outstanding(order), 1800);
    order.roundingHistory = [structuredClone(waiver)];
    order.rounding = 0; order.roundingReview = null; order.roundingType = '';
    assert.equal(outstanding(order), 1800);
  });
}

test('K06: explicitly approved and ordinary direct waivers reduce balance, which never becomes negative; payments stay intact', () => {
  const order = opened().orders[0], payments = [{ method: '现金', amount: 15000 }];
  order.payments = payments; order.rounding = 1800;
  order.roundingReview = { status: '已批准', amount: 1800 }; order.roundingType = '免零';
  assert.equal(outstanding(order), 0);
  order.roundingHistory = [{ rounding: 800, roundingType: '免零', roundingReview: null }];
  assert.equal(outstanding(order), 0); assert.deepEqual(order.payments, payments);
});
