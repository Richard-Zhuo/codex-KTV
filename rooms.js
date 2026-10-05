// 房间领域：房态流转、开房/释放/清洁、预约与房间异常审核。
// Phase 5 自 rules.js 迁出：quote／canExchange／platformVoucher／reservationTarget／
// reservationReminder／reservationActiveAt 查询，open／reserve／cancelReservation／
// clean／markRoomIssue／clearRoomIssue／approveRoomIssue+rejectRoomIssue 命令，
// 以及 release 房态协调。函数体逐字节保留，房态、预约、开房赠饮/首次配酒与
// 恢复审核行为不变；失败不提交由 transact 的克隆-校验-提交边界继续保证。
// 权限闸门与自审授权经参数注入（need／authorizeReviewer），避免对 rules.js 的循环依赖。
// productSnapshot／quantity／delegatedEmployee 为模块私有副本（Phase 4 sales.js 同先例）。
import { BusinessRejection } from './shared/business-error.js';
import { DEFAULT_CATALOG, roomPackage, assertCatalogPackagePrices, product, saleOptions, productIdOf, categoryLabel } from './catalog.js';
import { need, recordInventoryChange } from './inventory.js';
import { slot } from './shared/time.js';
import { USERS, effectiveUser, requireTrustedPermission, assertTrustedExecutionContext, AuthorizationDenied } from './shared/identity.js';

export const RESERVATION_SOURCES = ['线下', '手机', '座机', '美团', '抖音'];
export const OPENING_SOURCES = ['', '美团', '抖音'];
export const PLATFORM_OPENING_SOURCES = ['美团', '抖音'];
export const ROOM_ISSUE_TYPES = ['故障', '维护中'];

function productSnapshot(catalog, id, baseQuantity, extra = {}) {
  const p = product(id, catalog);
  return { productId: p.id, productNameSnapshot: p.name, categorySnapshot: p.category, categoryLabelSnapshot: categoryLabel(p), baseUnitSnapshot: p.baseUnit, baseQuantity, ...extra };
}
function quantity(n) { if (!Number.isSafeInteger(n) || n <= 0) throw new BusinessRejection('数量必须是大于零的整数'); }
function delegatedEmployee(state, data) {
  const id = String(data.employee || '').trim();
  if (!id) return null;
  need(state, [], 'staff.record');
  const employee = USERS[id];
  if (!employee || employee.legacy || id === 'administrator') throw new BusinessRejection('请选择有效的演示员工');
  return { id, name: employee.name, recordedBy: effectiveUser(state).name };
}
export function platformVoucher(source, amount) {
  const provider = String(source || '').trim();
  return PLATFORM_OPENING_SOURCES.includes(provider) ? { provider, status: '待验券', covered: 0, referenceValueCents: amount, interface: 'platform-voucher-scan' } : null;
}
export function quote(type, time, beer = 'bw', openSource = '', catalog = DEFAULT_CATALOG, timeZone) {
  const period = slot(time, timeZone); if (period === 'closed') throw new BusinessRejection('现在仅接受预订，请选择营业时段到店');
  assertCatalogPackagePrices(catalog);
  const packageItem = roomPackage(catalog, type, period);
  if (period === 'day') {
    const voucher = platformVoucher(openSource, packageItem.priceCents);
    return { period, packageId: packageItem.id, packageName: packageItem.name, packageBaseCents: packageItem.basePriceCents, packageGiftValueCents: 0, base: packageItem.priceCents, gift: 0, total: packageItem.priceCents, bottles: 0, dozen: 0, extras: [], voucher };
  }
  const p = product(beer, catalog);
  const giftRule = packageItem.openingGift;
  if (!p.openingGiftEligible || !giftRule?.allowedProductIds?.includes(p.id)) throw new BusinessRejection('请选择可用于开房赠饮的酒水');
  const dozen = packageItem.giftSaleQuantity || 0;
  const gift = packageItem.includedValueCents || 0;
  const voucher = platformVoucher(openSource, packageItem.priceCents);
  const fixedExtras = (packageItem.components || []).filter(component => component.kind === 'fixed').map(component => ({ product: component.productId, productId: component.productId, count: component.baseQuantity }));
  return { period, packageId: packageItem.id, packageName: packageItem.name, packageBaseCents: packageItem.basePriceCents, packageGiftValueCents: gift, openingGift: structuredClone(giftRule), base: packageItem.basePriceCents, gift, total: packageItem.priceCents, dozen, bottles: giftRule.baseQuantityByProduct[p.id], extras: fixedExtras, voucher };
}
export function canExchange(from, to, catalog = DEFAULT_CATALOG) { const a = product(from, catalog), b = product(to, catalog); return a.id !== b.id && !b.selectionOnly && saleOptions(b).length > 0 && a.exchangeLevel && b.exchangeLevel && a.exchangeLevel !== 4 && b.exchangeLevel >= a.exchangeLevel; }
export function reservationTarget(baseTime, dayOffset, session) {
  const offset = Number(dayOffset);
  if (!Number.isInteger(offset) || offset < 0 || offset > 30) throw new BusinessRejection('预订日期只能选择今天至30天后');
  if (!['afternoon', 'night'].includes(session)) throw new BusinessRejection('请选择下午场或夜间场');
  const target = new Date(baseTime);
  target.setDate(target.getDate() + offset);
  target.setHours(session === 'afternoon' ? 14 : 20, 0, 0, 0);
  if (target <= new Date(baseTime)) throw new BusinessRejection('该场次已经开始，请选择后面的场次或日期');
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
  if (!evidenceText && !evidencePhoto) throw new BusinessRejection('请提交照片或文字说明供审核');
  if (evidencePhoto && (!evidencePhoto.startsWith('data:image/') || evidencePhoto.length > 700000)) throw new BusinessRejection('审核照片格式无效或超过500KB');
  return { evidenceText, evidencePhoto, evidencePhotoName };
}
function pendingRoomIssueReview(s, roomId) { return (s.roomIssueReviews ||= []).find(request => request.room === roomId && request.status === '待审核'); }
export function release(s, order) { const r = s.rooms.find(r => r.order === order.id); if (r) { r.status = '待清洁'; r.order = null; } }

// —— 命令层：由 rules.js 的 transact 分支委托调用，参数与原分支一致 ——

export function openRoom(s, room, data, person, operator, time, execution = { mode: 'demo' }) {
  let delegated, attribution = {}, context = null;
  if (execution?.mode === 'trusted') {
    context = assertTrustedExecutionContext(execution.context);
    requireTrustedPermission(context, 'room.open'); requireTrustedPermission(context, 'staff.record');
    if (!context.creditedEmployeeId || (data.creditedEmployeeId ?? data.employee) !== context.creditedEmployeeId ||
        (data.employee !== undefined && data.employee !== context.creditedEmployeeId) ||
        typeof context.creditedEmployeeNameSnapshot !== 'string' || !context.openingOrderId ||
        !Object.isFrozen(context.orderBusinessDay)) throw TypeError('缺少事务内可信开房员工／订单／营业日快照');
    person = context.creditedEmployeeNameSnapshot; operator = context.principalId; time = context.dbNow;
    delegated = { id: context.creditedEmployeeId };
    attribution = { actualActorPrincipalId: context.principalId, creditedEmployeeId: context.creditedEmployeeId,
      creditedEmployeeNameSnapshot: context.creditedEmployeeNameSnapshot, ...context.orderBusinessDay,
      ...(context.voucherRedemption ? { voucherRedemptionId: context.voucherRedemption.redemptionId } : {}) };
  } else if (execution?.mode === 'demo') {
    delegated = delegatedEmployee(s, data);
    if (delegated) person = delegated.name; else need(s, ['开单员','老板'], 'room.open');
  } else throw TypeError('开房执行模式无效');
  if (!room || !['空闲','待清洁','已预订'].includes(room.status)) throw new BusinessRejection('房间已在使用');
  if (pendingRoomIssueReview(s, room.id)) throw new BusinessRejection('房间恢复申请正在审核，暂不能开房');
  if (room.status === '待清洁' && !data.acceptDirty) throw new BusinessRejection('请先确认房间可以接待客人');
  let openSource = String(data.openSource ?? '').trim();
  if (!OPENING_SOURCES.includes(openSource)) throw new BusinessRejection('请选择有效的开房渠道');
  const proof = context?.voucherRedemption;
  if (proof) {
    const providerSource = proof.provider === 'meituan' ? '美团' : '抖音';
    if (openSource && openSource !== providerSource) throw new BusinessRejection('平台券与开房渠道不一致');
    openSource = providerSource;
  } else if (PLATFORM_OPENING_SOURCES.includes(openSource) || data.voucherRedemptionId !== undefined) {
    throw new BusinessRejection('平台券须先完成服务端可信核销，不能按待验券开房');
  }
  const q = quote(room.type, time, data.beer, '', s.catalog, context?.orderBusinessDay.businessTimeZone);
  if (proof) {
    if (!proof.allowedPackageIds.includes(q.packageId)) throw new BusinessRejection('已核销券不能覆盖当前套餐');
    q.voucher = { provider: openSource, status: 'REDEEMED', covered: q.total,
      redemptionId: proof.redemptionId, providerFlowId: proof.providerFlowId,
      productId: proof.productId, productNameSnapshot: proof.productNameSnapshot, interface: 'server-redemption' };
    q.base = 0; q.gift = 0; q.total = 0;
  }
  const booking = s.reservations.find(r => r.room === room.id && reservationActiveAt(r, time));
  const sequence = ++s.serial; const id = context ? context.openingOrderId : `D${sequence}`;
  let drinks = [];
  if (q.bottles && data.beer === 'drink') {
    if (!Array.isArray(data.initialMix) || !data.initialMix.length) throw new BusinessRejection('请选择首次配给客人的酒水种类和支数');
    const merged = new Map();
    for (const item of data.initialMix) {
      quantity(item.count);
      if (!canExchange('drink', item.product, s.catalog)) throw new BusinessRejection('首次配酒水只能选择同级或更低级商品');
      merged.set(item.product, (merged.get(item.product) || 0) + item.count);
    }
    if ([...merged.values()].reduce((sum, count) => sum + count, 0) !== q.bottles) throw new BusinessRejection(`首次配酒水合计必须是${q.bottles}支`);
    drinks = [...merged].map(([productId, count]) => ({ id: ++s.serial, product: productId, productId, ...productSnapshot(s.catalog, productId, count), count }));
    for (const line of drinks) recordInventoryChange(s, line.product, -line.count, '开房首次配酒水', time, {}, execution);
  } else if (q.bottles) {
    drinks = [{ id: ++s.serial, product: data.beer, productId: data.beer, ...productSnapshot(s.catalog, data.beer, q.bottles), count: q.bottles }];
    recordInventoryChange(s, data.beer, -q.bottles, '开房赠饮', time, {}, execution);
  }
  const resolvedComponents = [
    ...drinks.map(line => productSnapshot(s.catalog, productIdOf(line), line.count, { kind: 'opening-drink', totalBaseQuantity: line.count })),
    ...q.extras.map(extra => productSnapshot(s.catalog, extra.productId || extra.product, extra.count, { kind: 'package-component', totalBaseQuantity: extra.count }))
  ];
  s.orders.push({ id, kind: 'room', room: room.id, time, createdAt: time, person, recordedBy: operator, employeeId: delegated?.id || '', ...attribution, openedBy: person, openSource: openSource || '线下', voucher: q.voucher, reservedBy: booking?.person || '', reservationSource: booking?.source || '', status: '营业中', packageId: q.packageId, packageNameSnapshot: q.packageName, packagePriceCents: q.total, packageBaseCents: q.base, packageGiftValueCents: q.gift, packageReferenceGiftValueCents: q.packageGiftValueCents, base: q.base, gift: q.gift, period: q.period, openingGiftReferenceValueCents: q.packageGiftValueCents, drinks, resolvedComponents, extras: q.extras.map(extra => ({ ...extra, served: false })), sales: [], otherCharges: [], bonusGifts: [], giftRequests: [], payments: [], rounding: 0, roundingType: '', roundingNote: '', roundingReview: null, credit: null, exchanges: [] });
  room.status = '营业中'; room.order = id;
  if (booking) booking.status = '已到店';
}
export function reserveRoom(s, room, data, person, operator, time, execution = { mode: 'demo' }) {
  let delegated, attribution = {};
  if (execution?.mode === 'trusted') {
    const context = execution.context;
    // Explicit employee attribution retains the original staff.record gate.
    requireTrustedPermission(context, 'staff.record');
    if (!context.creditedEmployeeId || typeof context.creditedEmployeeNameSnapshot !== 'string' ||
        (data.creditedEmployeeId ?? data.employee) !== context.creditedEmployeeId ||
        (data.employee !== undefined && data.employee !== context.creditedEmployeeId)) throw TypeError('缺少事务内可信预约员工快照');
    person = context.creditedEmployeeNameSnapshot;
    operator = context.principalId; time = context.dbNow;
    delegated = { id: context.creditedEmployeeId };
    attribution = { actualActorPrincipalId: context.principalId, creditedEmployeeId: context.creditedEmployeeId,
      creditedEmployeeNameSnapshot: context.creditedEmployeeNameSnapshot };
  } else if (execution?.mode === 'demo') {
    delegated = delegatedEmployee(s, data);
    if (delegated) person = delegated.name; else need(s, ['开单员','老板'], 'room.reserve');
  } else throw TypeError('预约执行模式无效');
  if (!room || !['空闲','营业中','待清洁','已预订'].includes(room.status)) throw new BusinessRejection('当前房间状态不能预订');
  if (pendingRoomIssueReview(s, room.id)) throw new BusinessRejection('房间恢复申请正在审核，暂不能预订');
  if (!RESERVATION_SOURCES.includes(data.source)) throw new BusinessRejection('请选择预订方式');
  const at = reservationTarget(time, data.dayOffset, data.session);
  if (s.reservations.some(r => r.room === room.id && r.status === '已预订' && Date.parse(r.at) === Date.parse(at))) throw new BusinessRejection('该房间该场次已经有预订');
  const sessionLabel = data.session === 'afternoon' ? '下午场（14:00—18:00）' : '夜间场（20:00—次日02:00）';
  s.reservations.push({ id: ++s.serial, room: room.id, at, dayOffset: Number(data.dayOffset), session: data.session, sessionLabel, source: data.source, note: String(data.note || '').slice(0,100), status: '已预订', person, employeeId: delegated?.id || '', recordedBy: operator, ...attribution });
}
export function cancelReservation(s, room, data, time, execution = { mode: 'demo' }) {
  if (execution?.mode === 'trusted') {
    requireTrustedPermission(execution.context, 'room.reserve');
    time = execution.context.dbNow;
  } else if (execution?.mode === 'demo') need(s, ['开单员','老板'], 'room.reserve');
  else throw TypeError('取消预订执行模式无效');
  if (!room) throw new BusinessRejection('房间状态已变化');
  const pending = s.reservations.filter(r => r.room === room.id && r.status === '已预订');
  const reservationId = data.id === undefined || data.id === '' ? null : Number(data.id);
  const booking = reservationId === null ? (pending.length === 1 ? pending[0] : null) : pending.find(r => r.id === reservationId);
  if (!booking) throw new BusinessRejection('预订状态已变化，请重新查看房间');
  booking.status = '已取消';
  if (room.status === '已预订' && !pending.some(r => r.id !== booking.id && reservationActiveAt(r, time))) room.status = '空闲';
}
export function cleanRoom(s, room, execution = { mode: 'demo' }) {
  if (execution?.mode === 'trusted') requireTrustedPermission(execution.context, 'room.clean');
  else if (execution?.mode === 'demo') need(s, ['服务员','老板'], 'room.clean');
  else throw TypeError('清洁执行模式无效');
  if (!room || room.status !== '待清洁') throw new BusinessRejection('房间状态已变化'); room.status = '空闲';
}
function roomIssueSubmission(s, person, time, execution) {
  if (execution?.mode === 'trusted') {
    const context = execution.context;
    requireTrustedPermission(context, 'room.issue');
    // A principal is not a legacy demo user ID. Future trusted review uses the
    // separate stable field; do not infer any real-person/demo-account mapping.
    return { submittedBy: context.principalId, submittedById: '',
      submittedByPrincipalId: context.principalId, submittedAt: context.dbNow };
  }
  if (execution?.mode !== 'demo') throw TypeError('房间异常执行模式无效');
  need(s, [], 'room.issue');
  return { submittedBy: person, submittedById: s.user, submittedAt: time };
}
export function markRoomIssue(s, room, data, person, time, execution = { mode: 'demo' }) {
  const submission = roomIssueSubmission(s, person, time, execution);
  if (!room) throw new BusinessRejection('请选择有效房间');
  if (!['空闲', '待清洁'].includes(room.status)) throw new BusinessRejection('营业中的房间不能直接标记为故障或维护中');
  if (pendingRoomIssueReview(s, room.id)) throw new BusinessRejection('该房间已有恢复申请待审核');
  const issueType = String(data.issueType || '').trim();
  if (!ROOM_ISSUE_TYPES.includes(issueType)) throw new BusinessRejection('请选择故障或维护中状态');
  const evidence = roomIssueEvidence(data);
  const fromStatus = room.status;
  room.status = '故障/维护中';
  room.issueType = issueType;
  room.issueNote = evidence.evidenceText || '已提交照片凭证';
  room.issueAt = submission.submittedAt;
  room.issueBy = submission.submittedBy;
  room.issueApprovedBy = '';
  room.issueEvidencePhoto = evidence.evidencePhoto;
  room.issueEvidencePhotoName = evidence.evidencePhotoName;
  s.roomIssueReviews.push({ id: ++s.serial, room: room.id, change: '标记异常', fromStatus, requestedStatus: '故障/维护中', issueType, ...evidence, status: '无需审核', ...submission, decidedBy: '', decidedAt: submission.submittedAt, decisionNote: '故障／维护标记提交后立即生效' });
}
export function clearRoomIssue(s, room, data, person, time, execution = { mode: 'demo' }) {
  const submission = roomIssueSubmission(s, person, time, execution);
  if (!room || room.status !== '故障/维护中') throw new BusinessRejection('房间异常状态已经变化');
  if (pendingRoomIssueReview(s, room.id)) throw new BusinessRejection('该房间已有恢复申请待审核');
  const evidence = roomIssueEvidence(data);
  s.roomIssueReviews.push({ id: ++s.serial, room: room.id, change: '恢复空房', fromStatus: room.status, requestedStatus: '空闲', issueType: room.issueType || '故障', ...evidence, status: '待审核', ...submission, decidedBy: '', decidedAt: '', decisionNote: '' });
}
export function decideRoomIssue(s, action, data, person, time, authorizeReviewer, execution = { mode: 'demo' }) {
  const context = execution?.mode === 'trusted' ? assertTrustedExecutionContext(execution.context) : null;
  if (context) requireTrustedPermission(context, 'room.issue.approve');
  else if (execution?.mode === 'demo') need(s, [], 'room.issue.approve');
  else throw TypeError('房间恢复审核执行模式无效');
  const request = (s.roomIssueReviews || []).find(item => item.id === Number(data.request));
  if (!request || request.status !== '待审核') throw new BusinessRejection('该房间恢复申请已经处理');
  if (request.requestedStatus !== '空闲') throw new BusinessRejection('只有恢复为空房的申请需要审核');
  let selfReview;
  if (context) {
    // This request is read from the ledger's locked state (cloned by transact).
    // Neither names, demo IDs nor payload applicant fields establish identity.
    const applicant = request.submittedByPrincipalId;
    if (typeof applicant !== 'string' || !applicant || applicant.trim() !== applicant || applicant.length > 191) {
      throw new AuthorizationDenied('untrusted-room-issue-applicant');
    }
    selfReview = applicant === context.principalId;
    if (selfReview) requireTrustedPermission(context, 'review.self');
    person = context.actorSnapshot?.displayName ?? null;
    time = context.dbNow;
  } else selfReview = authorizeReviewer(request.submittedById);
  if (action === 'approveRoomIssue') {
    const targetRoom = s.rooms.find(item => item.id === request.room);
    if (!targetRoom || targetRoom.status !== request.fromStatus) throw new BusinessRejection('房间状态已经变化，请驳回后重新提交');
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
    if (!decisionNote) throw new BusinessRejection('请填写驳回原因');
    request.status = '已驳回';
    request.decidedBy = person;
    request.decidedAt = time;
    request.decisionNote = decisionNote;
    request.selfReviewAuthorized = selfReview;
  }
  if (context) request.decidedByPrincipalId = context.principalId;
}
