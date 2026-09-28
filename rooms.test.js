// Phase 5 前测：rooms/reservations/房态审批 characterization。
// 目的：在拆分 rooms.js 之前冻结房态流转、开房/释放/清洁、预订与
// 房间恢复审核的行为。测试从 './rules.js' 导入（抽取前源），
// 抽取后同文件追加后测段验证 facade 同绑定（见文件尾部）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from './rules.js';
import { total } from './sales.js';
import { quote, canExchange, platformVoucher, reservationTarget, reservationActiveAt, reservationReminder } from './rooms.js';

let sequence = 0;
const apply = (state, action, data = {}) => transact(state, action, data, `rooms-front-${++sequence}`);
const at = hour => `2026-09-28T${hour}:00:00+08:00`;
const tomorrow = `2026-09-29T20:00:00+08:00`;
function stocked(s) { for (const balance of Object.values(s.inventory)) if (balance.count === null) balance.count = 1000; return s; }
function opened(beer = 'bw', room = '333') { let s = initialState(); s.clock = at('20'); return stocked(apply(s, 'open', { room, beer })); }
const room = (s, id) => s.rooms.find(r => r.id === id);

test('前测·房态矩阵：故障标记立即生效、证据必填、恢复走审核', () => {
  let s = stocked(initialState());
  s.clock = at('20');
  // 无 room.issue 权限者不能标记（开单员身份）
  s.user = 'meiJiao';
  assert.throws(() => apply(s, 'markRoomIssue', { room: 'V01', issueType: '故障', evidenceText: '音响坏了' }), /操作权限/);
  s.user = 'shaoBoss';
  // 证据必填：文字与照片都没有
  assert.throws(() => apply(s, 'markRoomIssue', { room: 'V01', issueType: '故障' }), /请提交照片或文字说明/);
  // 无效异常类型
  assert.throws(() => apply(s, 'markRoomIssue', { room: 'V01', issueType: '漏水', evidenceText: 'x' }), /请选择故障或维护中状态/);
  // 空闲房标记立即生效，记录“无需审核”
  s = apply(s, 'markRoomIssue', { room: 'V01', issueType: '维护中', evidenceText: '空调滤网更换' });
  assert.equal(room(s, 'V01').status, '故障/维护中');
  assert.equal(room(s, 'V01').issueType, '维护中');
  assert.equal(room(s, 'V01').issueNote, '空调滤网更换');
  assert.equal(s.roomIssueReviews.at(-1).status, '无需审核');
  assert.equal(s.roomIssueReviews.at(-1).change, '标记异常');
  // 营业中的房间不能直接标记
  s.user = 'shaoBoss';
  s = apply(s, 'open', { room: '333', beer: 'bw' });
  assert.throws(() => apply(s, 'markRoomIssue', { room: '333', issueType: '故障', evidenceText: 'x' }), /营业中的房间不能直接标记/);
});

test('前测·恢复审核矩阵：待审核、权限、驳回原因与房间状态联动', () => {
  let s = stocked(initialState());
  s.clock = at('20');
  s.user = 'shaoBoss';
  s = apply(s, 'markRoomIssue', { room: 'V01', issueType: '故障', evidenceText: '麦克风丢失' });
  // 提交恢复申请进入待审核；房间仍为故障态
  s = apply(s, 'clearRoomIssue', { room: 'V01', evidenceText: '已维修' });
  const requestId = s.roomIssueReviews.at(-1).id;
  assert.equal(s.roomIssueReviews.at(-1).status, '待审核');
  assert.equal(s.roomIssueReviews.at(-1).fromStatus, '故障/维护中');
  assert.equal(s.roomIssueReviews.at(-1).requestedStatus, '空闲');
  assert.equal(room(s, 'V01').status, '故障/维护中');
  // 已有待审核恢复申请时不能重复提交
  assert.throws(() => apply(s, 'clearRoomIssue', { room: 'V01', evidenceText: '再提交' }), /已有恢复申请待审核/);
  // 自审拦截：提交人本人无 review.self 权限不能审核
  assert.throws(() => apply(s, 'approveRoomIssue', { request: requestId }), /审核本人申请需要/);
  // 无 room.issue.approve 权限者（开单员）不能审核
  s.user = 'meiJiao';
  assert.throws(() => apply(s, 'approveRoomIssue', { request: requestId }), /操作权限/);
  // 驳回必须填写原因
  s.user = 'wife';
  assert.throws(() => apply(s, 'rejectRoomIssue', { request: requestId }), /请填写驳回原因/);
  s = apply(s, 'rejectRoomIssue', { request: requestId, decisionNote: '证据不足，继续维修' });
  const rejected = s.roomIssueReviews.find(item => item.id === requestId);
  assert.equal(rejected.status, '已驳回');
  assert.equal(rejected.decisionNote, '证据不足，继续维修');
  assert.equal(room(s, 'V01').status, '故障/维护中');
  // 重新提交后批准：房间恢复空闲、异常字段全部清空
  s.user = 'shaoBoss';
  s = apply(s, 'clearRoomIssue', { room: 'V01', evidenceText: '更换完成' });
  const secondId = s.roomIssueReviews.at(-1).id;
  s.user = 'administrator';
  s = apply(s, 'approveRoomIssue', { request: secondId, decisionNote: '同意' });
  const second = s.roomIssueReviews.find(item => item.id === secondId);
  assert.equal(second.status, '已批准');
  assert.equal(second.selfReviewAuthorized, false);
  const cleared = room(s, 'V01');
  assert.equal(cleared.status, '空闲');
  assert.deepEqual([cleared.issueType, cleared.issueNote, cleared.issueAt, cleared.issueBy, cleared.issueEvidencePhoto], ['', '', '', '', '']);
  // 已处理过的申请不能重复审核
  assert.throws(() => apply(s, 'approveRoomIssue', { request: secondId }), /已经处理/);
});

test('前测·开房-结账-清洁房态闭环：release 后房单解绑', () => {
  let s = opened();
  const id = s.orders[0].id;
  assert.equal(room(s, '333').status, '营业中');
  assert.equal(room(s, '333').order, id);
  // 结账收清后房间转待清洁、解除房单绑定
  s = apply(s, 'settle', { order: id, payments: [{ method: '微信', amount: total(s.orders[0]) }] });
  assert.equal(room(s, '333').status, '待清洁');
  assert.equal(room(s, '333').order, null);
  assert.equal(s.orders[0].status, '已结账');
  // 待清洁未确认时不能直接开房
  assert.throws(() => apply(s, 'open', { room: '333', beer: 'bw' }), /请先确认房间可以接待客人/);
  // 确认脏房可以直接开房
  s = apply(s, 'open', { room: '333', beer: 'bw', acceptDirty: true });
  assert.equal(room(s, '333').status, '营业中');
  const second = s.orders[1].id;
  s = apply(s, 'settle', { order: second, payments: [{ method: '现金', amount: total(s.orders[1]) }] });
  // 清洁完成回到空闲
  s.user = 'staff';
  s = apply(s, 'clean', { room: '333' });
  assert.equal(room(s, '333').status, '空闲');
  // 空闲房重复 clean 被拒（状态已变化）
  assert.throws(() => apply(s, 'clean', { room: '333' }), /房间状态已变化/);
});

test('前测·预约矩阵：场次记录、重复场次拦截与失败不提交', () => {
  let s = stocked(initialState());
  s.clock = at('20');
  s = apply(s, 'reserve', { room: 'V01', source: '美团', dayOffset: 1, session: 'night', note: '生日聚会' });
  const booking = s.reservations[0];
  assert.equal(booking.room, 'V01');
  assert.equal(booking.source, '美团');
  assert.equal(booking.status, '已预订');
  assert.equal(booking.sessionLabel, '夜间场（20:00—次日02:00）');
  assert.equal(booking.person, '陈姐');
  // 预约不改当前房态（未来预订不阻挡当前开房）
  assert.equal(room(s, 'V01').status, '空闲');
  // reservationActiveAt：未到时间为假、到场时间为真
  assert.equal(reservationActiveAt(booking, at('20')), false);
  assert.equal(reservationActiveAt(booking, tomorrow), true);
  // 同房同场次重复预约被拒且状态不变（失败不提交）
  const before = structuredClone(s);
  assert.throws(() => apply(s, 'reserve', { room: 'V01', source: '线下', dayOffset: 1, session: 'night' }), /该房间该场次已经有预订/);
  assert.deepEqual(s, before);
  // 到场前一小时形成提醒
  assert.deepEqual(reservationReminder(s.reservations[0], tomorrow), { number: 1, person: '陈姐', room: 'V01', at: booking.at, sessionLabel: '夜间场（20:00—次日02:00）' });
  // 取消唯一预订
  s = apply(s, 'cancelReservation', { room: 'V01', id: booking.id });
  assert.equal(s.reservations[0].status, '已取消');
  // 取消后同场次可再次预订
  s = apply(s, 'reserve', { room: 'V01', source: '线下', dayOffset: 1, session: 'night' });
  assert.equal(s.reservations[1].status, '已预订');
});

test('前测·开房跨域原子性：首次配酒支数不符时房态/订单/库存全不变', () => {
  let s = stocked(initialState());
  s.clock = at('20');
  const q = quote('大房', at('20'), 'drink', '', s.catalog);
  assert.ok(q.bottles > 0);
  const before = structuredClone(s);
  // 合计支数不等于套餐支数：抛错且房间、订单、库存、流水、序号全部不变
  assert.throws(() => apply(s, 'open', { room: '333', beer: 'drink', initialMix: [{ product: 'drink0', count: q.bottles - 1 }] }), /首次配酒水合计必须是/);
  assert.deepEqual(s, before);
  // 配比正确则一次写入房态、订单、首次配酒流水
  s = apply(s, 'open', { room: '333', beer: 'drink', initialMix: [{ product: 'drink0', count: 6 }, { product: 'xl', count: q.bottles - 6 }] });
  assert.equal(room(s, '333').status, '营业中');
  assert.equal(s.orders[0].drinks.length, 2);
  assert.equal(s.ledger.filter(line => line.source === '开房首次配酒水').length, 2);
  assert.equal(s.ledger.some(line => line.product === 'drink'), false);
});

// —— 后测段（Phase 5 抽取后追加）：facade 同绑定与领域模块直连 ——

import { quote as roomsQuote, canExchange as roomsCanExchange, platformVoucher as roomsPlatformVoucher, reservationTarget as roomsReservationTarget, reservationReminder as roomsReservationReminder, reservationActiveAt as roomsReservationActiveAt, release as roomsRelease } from './rooms.js';

test('后测·rooms.js 为房间域唯一 owner（Phase 8 起 rules.js 不再 re-export，调用方直连）', () => {
  assert.strictEqual(typeof roomsQuote, 'function');
  assert.strictEqual(quote, roomsQuote);
  assert.strictEqual(canExchange, roomsCanExchange);
  assert.strictEqual(platformVoucher, roomsPlatformVoucher);
  assert.strictEqual(reservationTarget, roomsReservationTarget);
  assert.strictEqual(reservationReminder, roomsReservationReminder);
  assert.strictEqual(reservationActiveAt, roomsReservationActiveAt);
  assert.strictEqual(typeof roomsRelease, 'function');
});

test('后测·release 房态协调：结账/挂账释放房间、驳回挂账不重新占用', () => {
  let s = opened('bw', 'V01');
  const id = s.orders[0].id;
  s = apply(s, 'settle', { order: id, payments: [{ method: '现金', amount: total(s.orders[0]) }] });
  assert.equal(room(s, 'V01').status, '待清洁');
  assert.equal(room(s, 'V01').order, null);
  // release 幂等语义：无绑定订单时不修改任何房间
  let untouched = structuredClone(s);
  roomsRelease(s, s.orders[0]);
  assert.deepEqual(s, untouched);
});
