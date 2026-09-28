// 房间领域：房态流转、开房/释放/清洁、预约与房间异常审核。
// Phase 5 自 rules.js 迁出：quote／canExchange／platformVoucher／reservationTarget／
// reservationReminder／reservationActiveAt 查询，open／reserve／cancelReservation／
// clean／markRoomIssue／clearRoomIssue／approveRoomIssue+rejectRoomIssue 命令，
// 以及 release 房态协调。函数体逐字节保留，房态、预约、开房赠饮/首次配酒与
// 恢复审核行为不变；失败不提交由 transact 的克隆-校验-提交边界继续保证。
// 权限闸门与自审授权经参数注入（need／authorizeReviewer），避免对 rules.js 的循环依赖。
// productSnapshot／quantity／delegatedEmployee 为模块私有副本（Phase 4 sales.js 同先例）。
import { DEFAULT_CATALOG, roomPackage, assertCatalogPackagePrices, product, saleOptions, productIdOf, categoryLabel } from './catalog.js';
import { need, recordInventoryChange } from './inventory.js';
import { slot } from './shared/time.js';
import { USERS, effectiveUser } from './shared/identity.js';

export const RESERVATION_SOURCES = ['线下', '手机', '座机', '美团', '抖音'];
export const OPENING_SOURCES = ['', '美团', '抖音'];
export const PLATFORM_OPENING_SOURCES = ['美团', '抖音'];
export const ROOM_ISSUE_TYPES = ['故障', '维护中'];

function productSnapshot(catalog, id, baseQuantity, extra = {}) {
  const p = product(id, catalog);
  return { productId: p.id, productNameSnapshot: p.name, categorySnapshot: p.category, categoryLabelSnapshot: categoryLabel(p), baseUnitSnapshot: p.baseUnit, baseQuantity, ...extra };
}
function quantity(n) { if (!Number.isSafeInteger(n) || n <= 0) throw Error('数量必须是大于零的整数'); }
function delegatedEmployee(state, data) {
  const id = String(data.employee || '').trim();
  if (!id) return null;
  need(state, [], 'staff.record');
  const employee = USERS[id];
  if (!employee || employee.legacy || id === 'administrator') throw Error('请选择有效的演示员工');
  return { id, name: employee.name, recordedBy: effectiveUser(state).name };
}
export function platformVoucher(source, amount) {
  const provider = String(source || '').trim();
  return PLATFORM_OPENING_SOURCES.includes(provider) ? { provider, status: '待验券', covered: amount, interface: 'platform-voucher-scan' } : null;
}
export function quote(type, time, beer = 'bw', openSource = '', catalog = DEFAULT_CATALOG) {
  const period = slot(time); if (period === 'closed') throw Error('现在仅接受预订，请选择营业时段到店');
  assertCatalogPackagePrices(catalog);
  const packageItem = roomPackage(catalog, type, period);
  if (period === 'day') {
    const voucher = platformVoucher(openSource, packageItem.priceCents);
    return { period, packageId: packageItem.id, packageName: packageItem.name, packageBaseCents: packageItem.basePriceCents, packageGiftValueCents: 0, base: voucher ? 0 : packageItem.priceCents, gift: 0, total: voucher ? 0 : packageItem.priceCents, bottles: 0, dozen: 0, extras: [], voucher };
  }
  const p = product(beer, catalog);
  const giftRule = packageItem.openingGift;
  if (!p.openingGiftEligible || !giftRule?.allowedProductIds?.includes(p.id)) throw Error('请选择可用于开房赠饮的酒水');
  const dozen = packageItem.giftSaleQuantity || 0;
  const gift = packageItem.includedValueCents || 0;
  const voucher = platformVoucher(openSource, packageItem.priceCents);
  const fixedExtras = (packageItem.components || []).filter(component => component.kind === 'fixed').map(component => ({ product: component.productId, productId: component.productId, count: component.baseQuantity }));
  return { period, packageId: packageItem.id, packageName: packageItem.name, packageBaseCents: packageItem.basePriceCents, packageGiftValueCents: gift, openingGift: structuredClone(giftRule), base: voucher ? 0 : packageItem.basePriceCents, gift: voucher ? 0 : gift, total: voucher ? 0 : packageItem.priceCents, dozen, bottles: giftRule.baseQuantityByProduct[p.id], extras: fixedExtras, voucher };
}
export function canExchange(from, to, catalog = DEFAULT_CATALOG) { const a = product(from, catalog), b = product(to, catalog); return a.id !== b.id && !b.selectionOnly && saleOptions(b).length > 0 && a.exchangeLevel && b.exchangeLevel && a.exchangeLevel !== 4 && b.exchangeLevel >= a.exchangeLevel; }
export function reservationTarget(baseTime, dayOffset, session) {
  const offset = Number(dayOffset);
  if (!Number.isInteger(offset) || offset < 0 || offset > 30) throw Error('预订日期只能选择今天至30天后');
  if (!['afternoon', 'night'].includes(session)) throw Error('请选择下午场或夜间场');
  const target = new Date(baseTime);
  target.setDate(target.getDate() + offset);
  target.setHours(session === 'afternoon' ? 14 : 20, 0, 0, 0);
  if (target <= new Date(baseTime)) throw Error('该场次已经开始，请选择后面的场次或日期');
  return target.toISOString();
}
export function reservationReminder(reservation, now) {
  if (!reservation || reservation.status !== '已预订') return null;
  const elapsed = Date.parse(now) - Date.parse(reservation.at);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const number = Math.floor(elapsed / 3600000) + 1;
  return { number, person: reservation.person, room: reservation.room, at: reservation.at, sessionLabel: reservation.sessionLabel || '' };
}
export function reservationActiveAt(reservation, now) {
  if (!reservation || reservation.status !== '已预订') return false;
  const start = Date.parse(reservation.at), current = Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(current)) return false;
  const duration = reservation.session === 'afternoon' ? 4 : 6;
  return current >= start && current < start + duration * 3600000;
}
function roomIssueEvidence(data) {
  const evidenceText = String(data.evidenceText ?? data.issueNote ?? '').trim().slice(0, 500);
  const evidencePhoto = String(data.evidencePhoto || '').trim();
  const evidencePhotoName = String(data.evidencePhotoName || '').trim().slice(0, 120);
  if (!evidenceText && !evidencePhoto) throw Error('请提交照片或文字说明供审核');
  if (evidencePhoto && (!evidencePhoto.startsWith('data:image/') || evidencePhoto.length > 700000)) throw Error('审核照片格式无效或超过500KB');
  return { evidenceText, evidencePhoto, evidencePhotoName };
}
function pendingRoomIssueReview(s, roomId) { return (s.roomIssueReviews ||= []).find(request => request.room === roomId && request.status === '待审核'); }
export function release(s, order) { const r = s.rooms.find(r => r.order === order.id); if (r) { r.status = '待清洁'; r.order = null; } }

// —— 命令层：由 rules.js 的 transact 分支委托调用，参数与原分支一致 ——

export function openRoom(s, room, data, person, operator, time) {
  const delegated = delegatedEmployee(s, data);
  if (delegated) person = delegated.name; else need(s, ['开单员','老板'], 'room.open');
  if (!room || !['空闲','待清洁','已预订'].includes(room.status)) throw Error('房间已在使用');
  if (pendingRoomIssueReview(s, room.id)) throw Error('房间恢复申请正在审核，暂不能开房');
  if (room.status === '待清洁' && !data.acceptDirty) throw Error('请先确认房间可以接待客人');
  const openSource = String(data.openSource ?? '').trim();
  if (!OPENING_SOURCES.includes(openSource)) throw Error('请选择有效的开房渠道');
  const q = quote(room.type, time, data.beer, openSource, s.catalog);
  const booking = s.reservations.find(r => r.room === room.id && reservationActiveAt(r, time));
  const id = `D${++s.serial}`;
  let drinks = [];
  if (q.bottles && data.beer === 'drink') {
    if (!Array.isArray(data.initialMix) || !data.initialMix.length) throw Error('请选择首次配给客人的酒水种类和支数');
    const merged = new Map();
    for (const item of data.initialMix) {
      quantity(item.count);
      if (!canExchange('drink', item.product, s.catalog)) throw Error('首次配酒水只能选择同级或更低级商品');
      merged.set(item.product, (merged.get(item.product) || 0) + item.count);
    }
    if ([...merged.values()].reduce((sum, count) => sum + count, 0) !== q.bottles) throw Error(`首次配酒水合计必须是${q.bottles}支`);
    drinks = [...merged].map(([productId, count]) => ({ id: ++s.serial, product: productId, productId, ...productSnapshot(s.catalog, productId, count), count }));
    for (const line of drinks) recordInventoryChange(s, line.product, -line.count, '开房首次配酒水', time);
  } else if (q.bottles) {
    drinks = [{ id: ++s.serial, product: data.beer, productId: data.beer, ...productSnapshot(s.catalog, data.beer, q.bottles), count: q.bottles }];
    recordInventoryChange(s, data.beer, -q.bottles, '开房赠饮', time);
  }
  const resolvedComponents = [
    ...drinks.map(line => productSnapshot(s.catalog, productIdOf(line), line.count, { kind: 'opening-drink', totalBaseQuantity: line.count })),
    ...q.extras.map(extra => productSnapshot(s.catalog, extra.productId || extra.product, extra.count, { kind: 'package-component', totalBaseQuantity: extra.count }))
  ];
  s.orders.push({ id, kind: 'room', room: room.id, time, createdAt: time, person, recordedBy: operator, employeeId: delegated?.id || '', openedBy: person, openSource: openSource || '线下', voucher: q.voucher, reservedBy: booking?.person || '', reservationSource: booking?.source || '', status: '营业中', packageId: q.packageId, packageNameSnapshot: q.packageName, packagePriceCents: q.total, packageBaseCents: q.base, packageGiftValueCents: q.gift, packageReferenceGiftValueCents: q.packageGiftValueCents, base: q.base, gift: q.gift, period: q.period, openingGiftReferenceValueCents: q.packageGiftValueCents, drinks, resolvedComponents, extras: q.extras.map(extra => ({ ...extra, served: false })), sales: [], otherCharges: [], bonusGifts: [], giftRequests: [], payments: [], rounding: 0, roundingType: '', roundingNote: '', roundingReview: null, credit: null, exchanges: [] });
  room.status = '营业中'; room.order = id;
  if (booking) booking.status = '已到店';
}
export function reserveRoom(s, room, data, person, operator, time) {
  const delegated = delegatedEmployee(s, data);
  if (delegated) person = delegated.name; else need(s, ['开单员','老板'], 'room.reserve');
  if (!room || !['空闲','营业中','待清洁','已预订'].includes(room.status)) throw Error('当前房间状态不能预订');
  if (pendingRoomIssueReview(s, room.id)) throw Error('房间恢复申请正在审核，暂不能预订');
  if (!RESERVATION_SOURCES.includes(data.source)) throw Error('请选择预订方式');
  const at = reservationTarget(time, data.dayOffset, data.session);
  if (s.reservations.some(r => r.room === room.id && r.status === '已预订' && Date.parse(r.at) === Date.parse(at))) throw Error('该房间该场次已经有预订');
  const sessionLabel = data.session === 'afternoon' ? '下午场（14:00—18:00）' : '夜间场（20:00—次日02:00）';
  s.reservations.push({ id: ++s.serial, room: room.id, at, dayOffset: Number(data.dayOffset), session: data.session, sessionLabel, source: data.source, note: String(data.note || '').slice(0,100), status: '已预订', person, employeeId: delegated?.id || '', recordedBy: operator });
}
export function cancelReservation(s, room, data, time) {
  need(s, ['开单员','老板'], 'room.reserve'); if (!room) throw Error('房间状态已变化');
  const pending = s.reservations.filter(r => r.room === room.id && r.status === '已预订');
  const reservationId = data.id === undefined || data.id === '' ? null : Number(data.id);
  const booking = reservationId === null ? (pending.length === 1 ? pending[0] : null) : pending.find(r => r.id === reservationId);
  if (!booking) throw Error('预订状态已变化，请重新查看房间');
  booking.status = '已取消';
  if (room.status === '已预订' && !pending.some(r => r.id !== booking.id && reservationActiveAt(r, time))) room.status = '空闲';
}
export function cleanRoom(s, room) {
  need(s, ['服务员','老板'], 'room.clean'); if (!room || room.status !== '待清洁') throw Error('房间状态已变化'); room.status = '空闲';
}
export function markRoomIssue(s, room, data, person, time) {
  need(s, [], 'room.issue');
  if (!room) throw Error('请选择有效房间');
  if (!['空闲', '待清洁'].includes(room.status)) throw Error('营业中的房间不能直接标记为故障或维护中');
  if (pendingRoomIssueReview(s, room.id)) throw Error('该房间已有恢复申请待审核');
  const issueType = String(data.issueType || '').trim();
  if (!ROOM_ISSUE_TYPES.includes(issueType)) throw Error('请选择故障或维护中状态');
  const evidence = roomIssueEvidence(data);
  const fromStatus = room.status;
  room.status = '故障/维护中';
  room.issueType = issueType;
  room.issueNote = evidence.evidenceText || '已提交照片凭证';
  room.issueAt = time;
  room.issueBy = person;
  room.issueApprovedBy = '';
  room.issueEvidencePhoto = evidence.evidencePhoto;
  room.issueEvidencePhotoName = evidence.evidencePhotoName;
  s.roomIssueReviews.push({ id: ++s.serial, room: room.id, change: '标记异常', fromStatus, requestedStatus: '故障/维护中', issueType, ...evidence, status: '无需审核', submittedBy: person, submittedById: s.user, submittedAt: time, decidedBy: '', decidedAt: time, decisionNote: '故障／维护标记提交后立即生效' });
}
export function clearRoomIssue(s, room, data, person, time) {
  need(s, [], 'room.issue');
  if (!room || room.status !== '故障/维护中') throw Error('房间异常状态已经变化');
  if (pendingRoomIssueReview(s, room.id)) throw Error('该房间已有恢复申请待审核');
  const evidence = roomIssueEvidence(data);
  s.roomIssueReviews.push({ id: ++s.serial, room: room.id, change: '恢复空房', fromStatus: room.status, requestedStatus: '空闲', issueType: room.issueType || '故障', ...evidence, status: '待审核', submittedBy: person, submittedById: s.user, submittedAt: time, decidedBy: '', decidedAt: '', decisionNote: '' });
}
export function decideRoomIssue(s, action, data, person, time, authorizeReviewer) {
  need(s, [], 'room.issue.approve');
  const request = (s.roomIssueReviews || []).find(item => item.id === Number(data.request));
  if (!request || request.status !== '待审核') throw Error('该房间恢复申请已经处理');
  if (request.requestedStatus !== '空闲') throw Error('只有恢复为空房的申请需要审核');
  const selfReview = authorizeReviewer(request.submittedById);
  if (action === 'approveRoomIssue') {
    const targetRoom = s.rooms.find(item => item.id === request.room);
    if (!targetRoom || targetRoom.status !== request.fromStatus) throw Error('房间状态已经变化，请驳回后重新提交');
    targetRoom.status = '空闲';
    targetRoom.issueType = '';
    targetRoom.issueNote = '';
    targetRoom.issueAt = '';
    targetRoom.issueBy = '';
    targetRoom.issueApprovedBy = '';
    targetRoom.issueEvidencePhoto = '';
    targetRoom.issueEvidencePhotoName = '';
    request.status = '已批准';
    request.decidedBy = person;
    request.decidedAt = time;
    request.decisionNote = String(data.decisionNote || '').trim().slice(0, 300);
    request.selfReviewAuthorized = selfReview;
  } else {
    const decisionNote = String(data.decisionNote || '').trim().slice(0, 300);
    if (!decisionNote) throw Error('请填写驳回原因');
    request.status = '已驳回';
    request.decidedBy = person;
    request.decidedAt = time;
    request.decisionNote = decisionNote;
    request.selfReviewAuthorized = selfReview;
  }
}
