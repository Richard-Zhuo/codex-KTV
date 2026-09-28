// 只承载演示业务：整数分计价、事务式状态变更，不依赖 DOM。
// 商品与套餐的运行时唯一来源是 state.catalog。DEFAULT_CATALOG 只由目录模块负责初始化、迁移和恢复演示数据。
import { DEFAULT_CATALOG, cloneCatalog, mergeCatalog, findProduct, roomPackage, saleOption, saleOptions, inventoryProducts, consumableProducts, productIdOf, categoryLabel, product } from './catalog.js';
// 库存领域（记账、盘点与审核命令）已迁至 inventory.js；rules.js 的事务分支委托调用，行为不变。
import { need, pendingInventoryReview, recordInventoryChange, submitStock, submitConsumableStock, decideInventory } from './inventory.js';
// 销售领域（成交管道、收款、结账抹零、挂账回款命令与金额查询）已迁至 sales.js（Phase 4）；rules.js 的事务分支委托调用，行为不变。
// productSnapshot 等销售侧基础函数随迁；rules.js 仅保留跨域使用的导入。
import { PAYMENT_METHODS as SALES_PAYMENT_METHODS, total, outstanding, collectableCharges, nextCollectCharge, submitSale, submitRetailSale, collectPayment, settleOrder, payOrder, decideRounding, applyCredit, decideCredit, submitRepay, decideRepayment } from './sales.js';
// product 查询包装已迁至 catalog.js（Phase 3）；re-export 保持 rules.js 既有导入路径兼容（facade，Phase 8 再清理）。
export { product };
// 共同基础（金额、时段、身份与权限选择器）已迁移到 shared/*；此处 re-export 保持既有导入路径兼容（facade，Phase 8 再清理）。
import { money, cents } from './shared/money.js';
import { slot } from './shared/time.js';
import { USERS, USER_ALIASES, PERMISSION_ROLES, PERMISSION_DEFINITIONS, PERMISSION_IDS, BUSINESS_REVIEW_SECTIONS, businessReviewSections, permissionsForRoles, defaultPermissions, defaultCapabilities, effectiveUser, hasPermission, hasRole } from './shared/identity.js';
export { money, cents, slot, USERS, USER_ALIASES, PERMISSION_ROLES, PERMISSION_DEFINITIONS, PERMISSION_IDS, BUSINESS_REVIEW_SECTIONS, businessReviewSections, permissionsForRoles, defaultPermissions, defaultCapabilities, effectiveUser, hasPermission, hasRole };

export const OTHER_CHARGE_CATEGORIES = ['小吃', '热食', '烧鸡烤肉', '代驾', '其他'];
export const RESERVATION_SOURCES = ['线下', '手机', '座机', '美团', '抖音'];
export const OPENING_SOURCES = ['', '美团', '抖音'];
export const PLATFORM_OPENING_SOURCES = ['美团', '抖音'];
export const PAYMENT_METHODS = SALES_PAYMENT_METHODS;
export { total, outstanding, collectableCharges, nextCollectCharge };
export const EXPENSE_NATURES = ['一次性支出', '固定支出', '资金周转'];
export const EXPENSE_TYPES = ['支出', '报销'];
export const EXPENSE_APPROVAL_THRESHOLD = 50000;
export const ROOM_ISSUE_TYPES = ['故障', '维护中'];
export const INCIDENT_TYPES = ['客诉', '设备异常', '卫生异常', '库存异常', '员工交接', '其他'];
// product 查询包装已迁至 catalog.js（Phase 3）；此处保留导入使用。
export function productSnapshot(catalog, id, baseQuantity, extra = {}) {
  const p = product(id, catalog);
  return { productId: p.id, productNameSnapshot: p.name, categorySnapshot: p.category, categoryLabelSnapshot: categoryLabel(p), baseUnitSnapshot: p.baseUnit, baseQuantity, ...extra };
}
function quantity(n) { if (!Number.isSafeInteger(n) || n <= 0) throw Error('数量必须是大于零的整数'); }
export function platformVoucher(source, amount) {
  const provider = String(source || '').trim();
  return PLATFORM_OPENING_SOURCES.includes(provider) ? { provider, status: '待验券', covered: amount, interface: 'platform-voucher-scan' } : null;
}
export function quote(type, time, beer = 'bw', openSource = '', catalog = DEFAULT_CATALOG) {
  const period = slot(time); if (period === 'closed') throw Error('现在仅接受预订，请选择营业时段到店');
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
export function searchDeposits(deposits, query) {
  const term = String(query || '').trim().toLocaleLowerCase('zh-CN');
  if (!term) return [];
  return deposits.filter(d => String(d.phone || '').includes(term) || String(d.name || '').toLocaleLowerCase('zh-CN').includes(term));
}
export function bonusAllowance(order, productId) {
  const purchased = (order?.sales || []).filter(line => productIdOf(line) === productId).reduce((sum, line) => sum + (line.totalBaseQuantity ?? line.bottles ?? 0), 0);
  const entitledHalves = Math.floor(purchased / 24);
  const grantedHalves = (order?.bonusGifts || []).filter(line => productIdOf(line) === productId).reduce((sum, line) => sum + line.halves, 0);
  const pendingHalves = (order?.giftRequests || []).filter(line => productIdOf(line) === productId && line.status === '待确认').reduce((sum, line) => sum + line.halves, 0);
  return { purchased, entitledHalves, grantedHalves, pendingHalves, availableHalves: Math.max(0, entitledHalves - grantedHalves - pendingHalves) };
}
export function initialState() {
  const today = new Date(); today.setHours(20,0,0,0);
  const roomType = id => id === '888' ? 'VIP房' : ['V05', 'V06'].includes(id) ? '中房' : id.startsWith('V') ? '小房' : '大房';
  const catalog = cloneCatalog(DEFAULT_CATALOG);
  return { version: 1, capabilitySchemaVersion: 4, catalogSchemaVersion: catalog.schemaVersion, catalog, clock: today.toISOString(), user: 'staff', permissions: defaultPermissions(), capabilities: defaultCapabilities(), rooms: ['V01','V02','V03','V05','V06','333','666','999','888'].map(id => ({ id, type: roomType(id), status: '空闲', order: null, issueType: '', issueNote: '', issueAt: '', issueBy: '', issueApprovedBy: '', issueEvidencePhoto: '', issueEvidencePhotoName: '' })), orders: [], reservations: [], deposits: [], withdrawals: [], expenses: [], procurements: [], incidents: [], roomIssueReviews: [], inventoryReviews: [], inventory: Object.fromEntries(inventoryProducts(catalog).map(item => [item.id, { count: null, threshold: item.inventoryThreshold ?? 10, unit: item.baseUnit }])), consumables: Object.fromEntries(consumableProducts(catalog).map(item => [item.id, { count: null, opened: 0, unit: item.baseUnit, threshold: item.inventoryThreshold ?? 10 }])), ledger: [], notices: [], handovers: [], processed: [], serial: 0 };
}
export const collected = state => state.orders.reduce((sum, o) => sum + (o.payments || []).reduce((n,p) => n+p.amount, 0), 0);
// normalizeSaleOptions 服务 createCatalogProduct/updateCatalogProduct 分支（目录命令，Phase 4/5 范围），函数体自 HEAD 逐字保留。
// grantBonus 服务 gift/approveGift 分支（赠酒域，Phase 5 范围），函数体自 HEAD 逐字保留。
function grantBonus(state, order, productId, halves, source, time, requestedBy) {
  const bottles = halves * 6;
  recordInventoryChange(state, productId, -bottles, source, time);
  order.bonusGifts ??= [];
  const giftId = ++state.serial;
  const p = product(productId, state.catalog);
  const halfOption = saleOption(p, 'half');
  const snapshot = productSnapshot(state.catalog, productId, bottles, { saleOptionId: halfOption.id, saleOptionNameSnapshot: halfOption.name, saleQuantity: halves, baseQuantityPerSaleUnit: halfOption.baseQuantity, totalBaseQuantity: bottles, referenceValueCents: halves * halfOption.priceCents, snapshotStatus: 'current' });
  order.bonusGifts.push({ id: giftId, product: productId, productId, ...snapshot, halves, bottles, drinks: [{ id: ++state.serial, product: productId, productId, productNameSnapshot: snapshot.productNameSnapshot, baseUnitSnapshot: snapshot.baseUnitSnapshot, count: bottles, totalBaseQuantity: bottles }], source, person: effectiveUser(state).name, requestedBy: requestedBy || effectiveUser(state).name, time });
}
function normalizeSaleOptions(options, sellable) {
  if (!Array.isArray(options) || (sellable && !options.length)) throw Error('可售商品至少需要一种销售规格');
  const ids = new Set();
  return options.map(option => {
    const id = String(option?.id || '').trim(), name = String(option?.name || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,39}$/.test(id) || ids.has(id) || !name || name.length > 30 || !Number.isSafeInteger(option.baseQuantity) || option.baseQuantity <= 0 || !Number.isSafeInteger(option.priceCents) || option.priceCents < 0 || (sellable && option.priceCents === 0)) throw Error('销售规格 ID、基础数量或价格无效，且 ID 不得重复');
    ids.add(id);
    return { id, name, baseQuantity: option.baseQuantity, priceCents: option.priceCents };
  });
}
export function visibleExpenses(state, user = effectiveUser(state)) {
  const rows = Array.isArray(state?.expenses) ? state.expenses : [];
  return hasPermission(user, 'expense.viewAll') ? rows : rows.filter(row => row.person === user?.name);
}
export function visibleProcurements(state, user = effectiveUser(state)) {
  const rows = Array.isArray(state?.procurements) ? state.procurements : [];
  return hasPermission(user, 'procurement.viewAll') ? rows : rows.filter(row => row.person === user?.name);
}
export function visibleIncidents(state, user = effectiveUser(state)) {
  const rows = Array.isArray(state?.incidents) ? state.incidents : [];
  if (hasPermission(user, 'incident.viewAll') || hasPermission(user, 'incident.resolve.approve')) return rows;
  return rows.filter(row => row.person === user?.name || row.assignee === user?.name);
}
export function pendingIncidentReminders(stateOrRows, now = new Date().toISOString()) {
  const rows = Array.isArray(stateOrRows) ? stateOrRows : (stateOrRows?.incidents || []);
  const current = new Date(now), hour = current.getHours();
  if (!Number.isFinite(current.getTime()) || hour < 14) return [];
  const today = `${current.getFullYear()}-${String(current.getMonth()+1).padStart(2,'0')}-${String(current.getDate()).padStart(2,'0')}`;
  return rows.filter(row => row?.status !== '已完成' && row?.date && row.date <= today && row?.lastReminderDate !== today);
}
// 先修改克隆，全部校验成功才返回；失败不产生部分扣库或半张账单。
export function transact(original, action, data = {}, key) {
  if (!key) throw Error('缺少操作编号');
  if (original.processed.includes(key)) return original;
  const s = structuredClone(original);
  s.catalog = mergeCatalog(s.catalog);
  const time = s.clock, operator = effectiveUser(s).name;
  let person = operator;
  const room = s.rooms.find(r => r.id === data.room);
  const order = s.orders.find(o => o.id === data.order);
  const active = () => { if (!order || order.status !== '营业中') throw Error('账单已变化，请返回房间重新查看'); };
  const roomIssueEvidence = () => {
    const evidenceText = String(data.evidenceText ?? data.issueNote ?? '').trim().slice(0, 500);
    const evidencePhoto = String(data.evidencePhoto || '').trim();
    const evidencePhotoName = String(data.evidencePhotoName || '').trim().slice(0, 120);
    if (!evidenceText && !evidencePhoto) throw Error('请提交照片或文字说明供审核');
    if (evidencePhoto && (!evidencePhoto.startsWith('data:image/') || evidencePhoto.length > 700000)) throw Error('审核照片格式无效或超过500KB');
    return { evidenceText, evidencePhoto, evidencePhotoName };
  };
  const pendingRoomIssueReview = roomId => (s.roomIssueReviews ||= []).find(request => request.room === roomId && request.status === '待审核');
  // pendingInventoryReview 已迁至 inventory.js（Phase 3），模块函数直接使用。
  const authorizeReviewer = submittedById => {
    if (!submittedById) throw Error('申请缺少提交人，不能审核');
    const selfReview = submittedById === s.user;
    if (selfReview && !hasPermission(effectiveUser(s), 'review.self')) throw Error('审核本人申请需要“允许审核本人申请”权限');
    return selfReview;
  };
  if (action === 'setPermissions') {
    need(s, ['管理员']);
    const target = String(data.user || '');
    if (!USERS[target] || USERS[target].legacy || target === 'administrator') throw Error('只能调整其他演示身份的权限');
    if (data.permissions !== undefined) {
      if (!Array.isArray(data.permissions) || data.permissions.some(permission => !PERMISSION_IDS.includes(permission))) throw Error('具体权限选项无效');
      s.capabilities ??= defaultCapabilities();
      s.capabilities[target] = [...new Set(data.permissions)];
    } else {
      if (!Array.isArray(data.roles) || data.roles.some(role => !PERMISSION_ROLES.includes(role))) throw Error('岗位权限选项无效');
      s.permissions ??= defaultPermissions();
      s.capabilities ??= defaultCapabilities();
      s.permissions[target] = [...new Set(data.roles)];
      s.capabilities[target] = permissionsForRoles(s.permissions[target]);
    }
  } else if (action === 'createCatalogProduct') {
    need(s, [], 'catalog.manage');
    const id = String(data.id || '').trim(), name = String(data.name || '').trim(), category = String(data.category || '').trim(), baseUnit = String(data.baseUnit || '').trim();
    if (!/^[a-z][a-z0-9._-]{0,39}$/.test(id) || s.catalog.products.some(item => item.id === id)) throw Error('商品 ID 无效或已存在');
    if (!name || name.length > 80 || !category || category.length > 40 || !baseUnit || baseUnit.length > 20) throw Error('请填写有效的商品名称、分类和基础单位');
    if (!Number.isSafeInteger(data.sortOrder)) throw Error('排序必须是整数');
    const sellable = Boolean(data.sellable), inventoryManaged = Boolean(data.inventoryManaged);
    const options = normalizeSaleOptions(data.saleOptions || [], sellable);
    s.catalog.products.push({ id, name, category, categoryLabel: category, baseUnit, saleOptions: options, inventoryManaged, inventoryThreshold: 10, sellable, manualPriceAllowed: false, exchangeLevel: null, openingGiftEligible: false, active: data.active !== false, sortOrder: data.sortOrder });
    if (inventoryManaged) s.inventory[id] = { count: null, threshold: 10, unit: baseUnit };
  } else if (action === 'updateCatalogProduct') {
    need(s, [], 'catalog.manage');
    const id = String(data.id || '').trim();
    const current = product(id, s.catalog);
    const name = String(data.name ?? current.name).trim().slice(0, 80);
    if (!name) throw Error('商品名称不能为空');
    const next = { ...current, name };
    for (const field of ['active', 'sellable', 'manualPriceAllowed']) if (data[field] !== undefined) next[field] = Boolean(data[field]);
    if (data.sortOrder !== undefined) {
      if (!Number.isSafeInteger(data.sortOrder)) throw Error('排序必须是整数');
      next.sortOrder = data.sortOrder;
    }
    if (data.saleOptions !== undefined) next.saleOptions = normalizeSaleOptions(data.saleOptions, next.sellable);
    else if (next.sellable) normalizeSaleOptions(next.saleOptions, true);
    s.catalog.products = s.catalog.products.map(item => item.id === id ? next : item);
  } else if (action === 'updateCatalogPackage') {
    need(s, [], 'catalog.manage');
    const id = String(data.id || '').trim();
    const current = s.catalog.packages.find(item => item.id === id);
    if (!current) throw Error('套餐不存在');
    const next = { ...current, name: String(data.name ?? current.name).trim().slice(0, 80) };
    if (!next.name) throw Error('套餐名称不能为空');
    for (const field of ['priceCents', 'basePriceCents', 'includedValueCents', 'sortOrder']) if (data[field] !== undefined) {
      if (!Number.isSafeInteger(data[field]) || data[field] < 0) throw Error('套餐金额或排序无效');
      next[field] = data[field];
    }
    if (data.active !== undefined) next.active = Boolean(data.active);
    s.catalog.packages = s.catalog.packages.map(item => item.id === id ? next : item);
  } else if (action === 'markRoomIssue') {
    need(s, [], 'room.issue');
    if (!room) throw Error('请选择有效房间');
    if (!['空闲', '待清洁'].includes(room.status)) throw Error('营业中的房间不能直接标记为故障或维护中');
    if (pendingRoomIssueReview(room.id)) throw Error('该房间已有恢复申请待审核');
    const issueType = String(data.issueType || '').trim();
    if (!ROOM_ISSUE_TYPES.includes(issueType)) throw Error('请选择故障或维护中状态');
    const evidence = roomIssueEvidence();
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
  } else if (action === 'clearRoomIssue') {
    need(s, [], 'room.issue');
    if (!room || room.status !== '故障/维护中') throw Error('房间异常状态已经变化');
    if (pendingRoomIssueReview(room.id)) throw Error('该房间已有恢复申请待审核');
    const evidence = roomIssueEvidence();
    s.roomIssueReviews.push({ id: ++s.serial, room: room.id, change: '恢复空房', fromStatus: room.status, requestedStatus: '空闲', issueType: room.issueType || '故障', ...evidence, status: '待审核', submittedBy: person, submittedById: s.user, submittedAt: time, decidedBy: '', decidedAt: '', decisionNote: '' });
  } else if (action === 'approveRoomIssue') {
    need(s, [], 'room.issue.approve');
    const request = (s.roomIssueReviews || []).find(item => item.id === Number(data.request));
    if (!request || request.status !== '待审核') throw Error('该房间恢复申请已经处理');
    if (request.requestedStatus !== '空闲') throw Error('只有恢复为空房的申请需要审核');
    const selfReview = authorizeReviewer(request.submittedById);
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
  } else if (action === 'rejectRoomIssue') {
    need(s, [], 'room.issue.approve');
    const request = (s.roomIssueReviews || []).find(item => item.id === Number(data.request));
    if (!request || request.status !== '待审核') throw Error('该房间恢复申请已经处理');
    if (request.requestedStatus !== '空闲') throw Error('只有恢复为空房的申请需要审核');
    const selfReview = authorizeReviewer(request.submittedById);
    const decisionNote = String(data.decisionNote || '').trim().slice(0, 300);
    if (!decisionNote) throw Error('请填写驳回原因');
    request.status = '已驳回';
    request.decidedBy = person;
    request.decidedAt = time;
    request.decisionNote = decisionNote;
    request.selfReviewAuthorized = selfReview;
  } else if (action === 'open') {
    const delegated = delegatedEmployee(s, data);
    if (delegated) person = delegated.name; else need(s, ['开单员','老板'], 'room.open');
    if (!room || !['空闲','待清洁','已预订'].includes(room.status)) throw Error('房间已在使用');
    if (pendingRoomIssueReview(room.id)) throw Error('房间恢复申请正在审核，暂不能开房');
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
  } else if (action === 'reserve') {
    const delegated = delegatedEmployee(s, data);
    if (delegated) person = delegated.name; else need(s, ['开单员','老板'], 'room.reserve');
    if (!room || !['空闲','营业中','待清洁','已预订'].includes(room.status)) throw Error('当前房间状态不能预订');
    if (pendingRoomIssueReview(room.id)) throw Error('房间恢复申请正在审核，暂不能预订');
    if (!RESERVATION_SOURCES.includes(data.source)) throw Error('请选择预订方式');
    const at = reservationTarget(time, data.dayOffset, data.session);
    if (s.reservations.some(r => r.room === room.id && r.status === '已预订' && Date.parse(r.at) === Date.parse(at))) throw Error('该房间该场次已经有预订');
    const sessionLabel = data.session === 'afternoon' ? '下午场（14:00—18:00）' : '夜间场（20:00—次日02:00）';
    s.reservations.push({ id: ++s.serial, room: room.id, at, dayOffset: Number(data.dayOffset), session: data.session, sessionLabel, source: data.source, note: String(data.note || '').slice(0,100), status: '已预订', person, employeeId: delegated?.id || '', recordedBy: operator });
  } else if (action === 'cancelReservation') {
    need(s, ['开单员','老板'], 'room.reserve'); if (!room) throw Error('房间状态已变化');
    const pending = s.reservations.filter(r => r.room === room.id && r.status === '已预订');
    const reservationId = data.id === undefined || data.id === '' ? null : Number(data.id);
    const booking = reservationId === null ? (pending.length === 1 ? pending[0] : null) : pending.find(r => r.id === reservationId);
    if (!booking) throw Error('预订状态已变化，请重新查看房间');
    booking.status = '已取消';
    if (room.status === '已预订' && !pending.some(r => r.id !== booking.id && reservationActiveAt(r, time))) room.status = '空闲';
  } else if (action === 'sale') {
    active();
    submitSale(s, order, data, person, operator, time);
  } else if (action === 'retailSale') {
    submitRetailSale(s, data, person, operator, time);
  } else if (action === 'otherCharge') {
    need(s, ['开单员','服务员','老板'], 'order.sale'); active();
    const category = String(data.category || '').trim();
    if (!OTHER_CHARGE_CATEGORIES.includes(category)) throw Error('请选择有效的其他消费类别');
    if (!Number.isSafeInteger(data.amount) || data.amount <= 0) throw Error('金额应为大于零的金额');
    const customItem = String(data.item || '').trim().slice(0, 50);
    if (category === '其他' && !customItem) throw Error('请填写其他消费项目');
    const batch = ++s.serial;
    order.otherCharges ??= [];
    order.otherCharges.push({ id: ++s.serial, batch, category, item: category === '其他' ? customItem : category, amount: data.amount, person, time });
  } else if (action === 'gift') {
    need(s, ['开单员','服务员','店长','老板'], 'order.gift'); active(); quantity(data.halves);
    const p = product(data.productId || data.product, s.catalog);
    if (!p.openingGiftEligible || p.selectionOnly) throw Error('该商品不参与赠酒水规则');
    const halfOption = saleOption(p, 'half');
    const allowance = bonusAllowance(order, p.id);
    if (!allowance.purchased) throw Error('请先增购对应酒水');
    order.giftRequests ??= [];
    const directHalves = Math.min(data.halves, allowance.availableHalves);
    const excessHalves = data.halves - directHalves;
    if (directHalves) grantBonus(s, order, p.id, directHalves, '每增购2打赠半打', time);
    if (excessHalves) order.giftRequests.push({ id: ++s.serial, product: p.id, productId: p.id, productNameSnapshot: p.name, categorySnapshot: p.category, baseUnitSnapshot: p.baseUnit, saleOptionId: 'half', saleOptionNameSnapshot: halfOption.name, halves: excessHalves, saleQuantity: excessHalves, baseQuantityPerSaleUnit: halfOption.baseQuantity, bottles: excessHalves * halfOption.baseQuantity, totalBaseQuantity: excessHalves * halfOption.baseQuantity, referenceValueCents: excessHalves * halfOption.priceCents, allowanceAtRequest: directHalves, status: '待确认', requestedBy: person, requestedById: s.user, submittedAt: time, time, decidedBy: '', decidedAt: '', decisionNote: '', snapshotStatus: 'current' });
  } else if (action === 'approveGift' || action === 'rejectGift') {
    need(s, ['店长','老板'], 'gift.approve'); active();
    const request = (order.giftRequests || []).find(item => item.id === data.request);
    if (!request || request.status !== '待确认') throw Error('赠酒水申请已处理');
    const selfReview = authorizeReviewer(request.requestedById);
    const decisionNote = String(data.decisionNote || '').trim().slice(0, 300);
    if (action === 'rejectGift' && !decisionNote) throw Error('请填写驳回原因');
    request.status = action === 'approveGift' ? '已批准' : '已驳回'; request.decidedBy = person; request.decidedAt = time; request.decisionNote = decisionNote; request.selfReviewAuthorized = selfReview;
    if (action === 'approveGift') grantBonus(s, order, request.product, request.halves, '老板／店长确认赠送', time, request.requestedBy);
  } else if (action === 'exchange') {
    need(s, ['开单员','服务员','老板'], 'order.exchange'); active(); quantity(data.count);
    const source = String(data.line || '');
    let lines, line, scope;
    if (source.startsWith('sale:')) {
      const id = Number(source.slice(5));
      const sale = order.sales.find(item => (item.drinks || []).some(drink => drink.id === id));
      lines = sale?.drinks; line = lines?.find(drink => drink.id === id); scope = '增购';
    } else if (source.startsWith('bonus:')) {
      const id = Number(source.slice(6));
      const gift = (order.bonusGifts || []).find(item => (item.drinks || []).some(drink => drink.id === id));
      lines = gift?.drinks; line = lines?.find(drink => drink.id === id); scope = '赠送';
    } else {
      const id = Number(source.startsWith('gift:') ? source.slice(5) : source);
      lines = order.drinks; line = lines.find(drink => drink.id === id); scope = '套餐';
    }
    if (!line || line.count < data.count) throw Error('超过可换数量');
    if (!canExchange(productIdOf(line), data.product, s.catalog)) throw Error('只能换同级或更低级商品，瓶装水不能换出');
    recordInventoryChange(s, productIdOf(line), data.count, '换购退回', time); recordInventoryChange(s, data.product, -data.count, '换购领取', time);
    line.count -= data.count;
    const target = lines.find(drink => productIdOf(drink) === data.product);
    if (target) target.count += data.count; else lines.push({ id: ++s.serial, product: data.product, count: data.count });
    order.exchanges.push({ from: productIdOf(line), to: data.product, fromProductId: productIdOf(line), toProductId: data.product, count: data.count, scope, time, person });
  } else if (action === 'serveExtra') {
    need(s, ['开单员','服务员','老板'], 'order.serveExtra'); active();
    const extra = (order.extras || []).find(item => item.product === data.product);
    if (!extra) throw Error('该账单没有这项配品');
    if (extra.served) throw Error('这项配品已经标记已上');
    extra.served = true; extra.servedAt = time; extra.servedBy = person;
  } else if (action === 'collect') {
    active();
    collectPayment(s, order, data, person, time);
  } else if (action === 'settle' || action === 'pay') {
    active();
    if (action === 'settle') settleOrder(s, order, data, person, time); else payOrder(s, order, data, person, time);
    release(s, order);
  } else if (action === 'approveRounding' || action === 'rejectRounding') {
    decideRounding(s, order, action, data, person, time, authorizeReviewer);
  } else if (action === 'credit') {
    active();
    applyCredit(s, order, data, person, time);
    release(s, order);
  } else if (action === 'approve' || action === 'reject') {
    decideCredit(s, order, action, person, time);
  } else if (action === 'repay') {
    submitRepay(s, order, data, person, time);
  } else if (action === 'approveRepayment' || action === 'rejectRepayment') {
    decideRepayment(s, order, action, data, person, time, authorizeReviewer);
  } else if (action === 'clean') {
    need(s, ['服务员','老板'], 'room.clean'); if (!room || room.status !== '待清洁') throw Error('房间状态已变化'); room.status = '空闲';
  } else if (action === 'deposit') {
    need(s, ['服务员','老板'], 'deposit.manage');
    const phoneValue = String(data.phone || '').trim();
    const name = String(data.name || '').trim().slice(0,30);
    if (!phoneValue && !name) throw Error('手机号和姓名至少填写一个');
    if (phoneValue) phone(phoneValue);
    if (!s.rooms.some(r => r.id === data.room)) throw Error('请选择房间');
    const items = Array.isArray(data.items) ? data.items : [{ product: data.product, count: data.count }];
    if (!items.length) throw Error('请至少添加一种酒');
    const group = `CJ${++s.serial}`;
    for (const item of items) {
      quantity(item.count);
      const depositProduct = product(item.productId || item.product, s.catalog);
      if (!depositProduct.openingGiftEligible || depositProduct.selectionOnly || !saleOptions(depositProduct).length) throw Error('请选择可存放的酒水');
      s.deposits.push({ id: ++s.serial, group, phone: phoneValue, name, room: data.room, product: depositProduct.id, productId: depositProduct.id, productNameSnapshot: depositProduct.name, baseUnitSnapshot: depositProduct.baseUnit, count: item.count, initial: item.count, time, person });
    }
  } else if (action === 'withdraw') {
    need(s, ['服务员','老板'], 'deposit.manage'); quantity(data.count);
    const d = s.deposits.find(d => d.id === data.id);
    const identity = String(data.identity || '').trim();
    const phoneMatch = /^\d{4,11}$/.test(identity) && d?.phone && d.phone.endsWith(identity);
    const nameMatch = Boolean(d?.name && identity === d.name);
    if (!d || !identity || (!phoneMatch && !nameMatch)) throw Error('请输入登记手机号尾号（至少4位）或姓名核对'); if (data.count > d.count) throw Error('取酒不能超过剩余数量');
    d.count -= data.count; s.withdrawals.push({ id: ++s.serial, deposit: d.id, count: data.count, time, person });
  } else if (action === 'stock') {
    // 命令体已迁至 inventory.js：submitStock（Phase 3），逐字节保留。
    submitStock(s, data, person, time);
  } else if (action === 'consumableStock') {
    // 命令体已迁至 inventory.js：submitConsumableStock（Phase 3），逐字节保留。
    submitConsumableStock(s, data, person, time);
  } else if (action === 'approveInventory' || action === 'rejectInventory') {
    // 命令体已迁至 inventory.js：decideInventory（Phase 3），逐字节保留；authorizeReviewer 经参数注入保持原闭包语义。
    decideInventory(s, action, data, person, time, authorizeReviewer);
  } else if (action === 'handover') {
    need(s, ['收银员','财务','店长','老板'], 'handover');
    if (!Number.isSafeInteger(data.actual) || data.actual < 0) throw Error('请输入有效实点金额');
    if (!Number.isSafeInteger(data.drawerCash) || data.drawerCash < 0) throw Error('请输入有效的前台现金');
    const expected = collected(s); s.handovers.push({ id: ++s.serial, expected, actual: data.actual, drawerCash: data.drawerCash, difference: data.actual-expected, person, time });
  } else if (action === 'expense') {
    need(s, ['管理员','老板','店长','财务','采购','开单员','服务员','收银员','库管'], 'expense.create');
    const expenseDate = String(data.date || '').trim();
    const parsedDate = Date.parse(`${expenseDate}T00:00:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate) || !Number.isFinite(parsedDate)) throw Error('请选择有效支出日期');
    if (!Number.isSafeInteger(data.amount) || data.amount <= 0) throw Error('支出金额应为大于零的金额');
    if (!PAYMENT_METHODS.includes(data.method)) throw Error('请选择付款方式');
    const type = String(data.type || '支出').trim();
    if (!EXPENSE_TYPES.includes(type)) throw Error('请选择记录类型');
    if (!EXPENSE_NATURES.includes(data.nature)) throw Error('请选择支出性质');
    const description = String(data.description || '').trim().slice(0, 200);
    if (!description) throw Error('请填写支出说明');
    const proof = String(data.proof || '').trim();
    if (proof && (!proof.startsWith('data:image/') || proof.length > 800000)) throw Error('图片凭证格式或大小无效');
    s.expenses ??= [];
    const needsApproval = type === '报销' && data.amount > EXPENSE_APPROVAL_THRESHOLD;
    s.expenses.push({ id: ++s.serial, date: expenseDate, type, amount: data.amount, method: data.method, nature: data.nature, description, proof, proofName: String(data.proofName || '').trim().slice(0, 120), status: needsApproval ? '待老板审批' : '已记录', approver: '', approvedAt: '', person, time });
  } else if (action === 'procurement') {
    need(s, [], 'procurement.create');
    const procurementDate = String(data.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(procurementDate) || !Number.isFinite(Date.parse(`${procurementDate}T00:00:00`))) throw Error('请选择有效采购日期');
    const item = String(data.item || '').trim().slice(0, 80); if (!item) throw Error('请填写采购项目');
    if (!Number.isSafeInteger(data.quantity) || data.quantity <= 0) throw Error('采购数量应为大于零的整数');
    const unit = String(data.unit || '').trim().slice(0, 20); if (!unit) throw Error('请填写采购单位');
    if (!Number.isSafeInteger(data.amount) || data.amount <= 0) throw Error('采购金额应为大于零的金额');
    if (!PAYMENT_METHODS.includes(data.method)) throw Error('请选择付款方式');
    const type = String(data.type || '支出').trim(); if (!EXPENSE_TYPES.includes(type)) throw Error('请选择记录类型');
    if (!EXPENSE_NATURES.includes(data.nature)) throw Error('请选择支出性质');
    const description = String(data.description || '').trim().slice(0, 200) || `采购${item}`;
    s.expenses ??= [];
    const needsApproval = type === '报销' && data.amount > EXPENSE_APPROVAL_THRESHOLD;
    const expenseId = ++s.serial;
    s.expenses.push({ id: expenseId, date: procurementDate, type, amount: data.amount, method: data.method, nature: data.nature, description, proof: '', proofName: '', status: needsApproval ? '待老板审批' : '已记录', approver: '', approvedAt: '', person, time, source: '采购' });
    s.procurements ??= [];
    s.procurements.push({ id: ++s.serial, date: procurementDate, item, quantity: data.quantity, unit, amount: data.amount, method: data.method, type, nature: data.nature, description, expenseId, status: needsApproval ? '报销待老板审批' : '已关联支出', person, time });
  } else if (action === 'incident') {
    need(s, [], 'incident.create');
    const incidentDate = String(data.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(incidentDate) || !Number.isFinite(Date.parse(`${incidentDate}T00:00:00`))) throw Error('请选择有效异常日期');
    if (!s.rooms.some(item => item.id === data.room)) throw Error('请选择房号');
    const type = String(data.type || '').trim(); if (!INCIDENT_TYPES.includes(type)) throw Error('请选择问题类型');
    const description = String(data.description || '').trim().slice(0, 300); if (!description) throw Error('请填写问题描述');
    const assigneeId = String(data.assignee || '').trim(); const assignee = USERS[assigneeId];
    if (!assignee || assignee.legacy || assigneeId === 'administrator') throw Error('请选择处理负责人');
    s.incidents ??= [];
    s.incidents.push({ id: ++s.serial, date: incidentDate, room: data.room, type, description, assigneeId, assignee: assignee.name, result: '', note: '', status: '待处理', person, createdAt: time, lastReminderDate: '', resolutionReviews: [] });
  } else if (action === 'resolveIncident') {
    need(s, [], 'incident.resolve');
    const incident = (s.incidents || []).find(item => item.id === Number(data.id));
    if (!incident || incident.status === '已完成') throw Error('该客诉／异常已经处理');
    if (incident.assignee !== person && !hasPermission(effectiveUser(s), 'incident.viewAll')) throw Error('只有负责人或管理人员可以填写处理结果');
    incident.resolutionReviews ??= [];
    if (incident.resolutionReviews.some(request => request.status === '待审核')) throw Error('处理结果已经提交审核，请等待有权限的员工处理');
    const result = String(data.result || '').trim().slice(0, 300); if (!result) throw Error('请填写处理结果');
    const note = String(data.note || '').trim().slice(0, 300); if (!note) throw Error('请填写处理备注');
    incident.resolutionReviews.push({ id: ++s.serial, result, note, status: '待审核', submittedBy: person, submittedById: s.user, submittedAt: time, decidedBy: '', decidedAt: '', decisionNote: '' });
    incident.status = '待审核'; incident.lastReminderDate = '';
  } else if (action === 'approveIncidentResolution' || action === 'rejectIncidentResolution') {
    need(s, [], 'incident.resolve.approve');
    const incident = (s.incidents || []).find(item => item.id === Number(data.id));
    const request = (incident?.resolutionReviews || []).find(item => item.id === Number(data.request));
    if (!incident || !request || request.status !== '待审核') throw Error('这项客诉／异常恢复申请已经处理');
    const selfReview = authorizeReviewer(request.submittedById);
    const decisionNote = String(data.decisionNote || '').trim().slice(0, 300);
    if (action === 'rejectIncidentResolution' && !decisionNote) throw Error('请填写驳回原因');
    if (action === 'approveIncidentResolution') {
      incident.result = request.result; incident.note = request.note; incident.status = '已完成'; incident.resolvedBy = request.submittedBy; incident.resolvedAt = time; incident.reviewedBy = person; incident.lastReminderDate = '';
    } else incident.status = '待处理';
    request.status = action === 'approveIncidentResolution' ? '已批准' : '已驳回'; request.decidedBy = person; request.decidedAt = time; request.decisionNote = decisionNote; request.selfReviewAuthorized = selfReview;
  } else if (action === 'approveExpense' || action === 'rejectExpense') {
    need(s, ['老板'], 'expense.approve');
    const expense = (s.expenses || []).find(item => item.id === Number(data.id));
    if (!expense || expense.status !== '待老板审批') throw Error('这笔报销不在待审批状态');
    expense.status = action === 'approveExpense' ? '已审批' : '已驳回';
    expense.approver = person;
    expense.approvedAt = time;
  } else throw Error('未知操作');
  s.processed.push(key); return s;
}
function release(s, order) { const r = s.rooms.find(r => r.order === order.id); if (r) { r.status = '待清洁'; r.order = null; } }
// phone 与 delegatedEmployee 随 Phase 4 部分迁移：delegatedEmployee 仍服务 open/reserve（Phase 5 域）；
// sales.js 有自己的同名私有副本，行为一致。phone 仍服务 deposit 分支（Phase 5 域）。
function delegatedEmployee(state, data) {
  const id = String(data.employee || '').trim();
  if (!id) return null;
  need(state, [], 'staff.record');
  const employee = USERS[id];
  if (!employee || employee.legacy || id === 'administrator') throw Error('请选择有效的演示员工');
  return { id, name: employee.name, recordedBy: effectiveUser(state).name };
}
function phone(value) { if (!/^1\d{10}$/.test(value || '')) throw Error('请填写11位手机号'); }
