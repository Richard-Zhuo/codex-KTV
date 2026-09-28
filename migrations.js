// Phase 1：演示状态的逐版本迁移链（纯函数，Node 可测）。
// 自 app.js 迁出的代码：启动补值（原 try 块内 order/room 字段回填）、
// migrateLegacyCatalogFacts、migrateDemoState、用户身份归一化。
// 行为与迁移前逐字一致：未知历史价格保持 null（不用当前价格填补），
// 旧字段只做 ??= 补值，不做删改。
// Phase 3：migrateLegacyOrderPricing 自 catalog.js 迁入（目录不迁移订单），函数体逐字保留。
import { initialState } from './rules.js';
import { USERS, USER_ALIASES, PERMISSION_ROLES, PERMISSION_IDS, defaultPermissions, defaultCapabilities, permissionsForRoles } from './shared/identity.js';
import { reservationActiveAt } from './rooms.js';
import { mergeCatalog, inventoryProducts, consumableProducts, productIdOf } from './catalog.js';

// 旧订单只补充可从原记录确定的金额和数量；缺失的历史商品元数据与参考价值保持未知，绝不读取迁移当天的当前售价。
export function migrateLegacyOrderPricing(orders) {
  const migrated = structuredClone(Array.isArray(orders) ? orders : []);
  for (const order of migrated) {
    order.packageBaseCents ??= Number.isSafeInteger(order.base) ? order.base : null;
    order.packageGiftValueCents ??= Number.isSafeInteger(order.gift) ? order.gift : null;
    order.packageReferenceGiftValueCents ??= Number.isSafeInteger(order.gift) ? order.gift : null;
    order.packagePriceCents ??= Number.isSafeInteger(order.base) && Number.isSafeInteger(order.gift) ? order.base + order.gift : null;
    for (const sale of order.sales || []) {
      sale.productId ??= sale.product || '';
      sale.saleQuantity ??= sale.count ?? null;
      sale.saleOptionId ??= sale.spec || null;
      sale.saleOptionNameSnapshot ??= null;
      sale.baseQuantityPerSaleUnit ??= sale.spec === 'dozen' ? 12 : sale.spec === 'half' ? 6 : sale.spec === 'single' ? 1 : null;
      sale.totalBaseQuantity ??= sale.bottles ?? null;
      sale.pricePerSaleUnitCents ??= null;
      sale.amountCents ??= Number.isSafeInteger(sale.amount) ? sale.amount : null;
      sale.productNameSnapshot ??= null;
      sale.categorySnapshot ??= null;
      sale.baseUnitSnapshot ??= null;
      sale.snapshotStatus ??= 'legacy';
    }
    for (const gift of order.bonusGifts || []) {
      gift.productId ??= gift.product || '';
      gift.productNameSnapshot ??= null;
      gift.categorySnapshot ??= null;
      gift.baseUnitSnapshot ??= null;
      gift.referenceValueCents ??= null;
      gift.snapshotStatus ??= 'legacy';
    }
  }
  return migrated;
}

// 启动结构校验：版本不是 1 或核心结构缺失即视为不可读（与原 app.js try 块首行一致）。
export function validateDemoState(state) {
  if (state.version !== 1 || !Array.isArray(state.rooms) || !state.inventory) throw Error('演示记录结构无效');
}

// 启动补值（原 app.js try 块）：目录合并、库存/消耗品补位、旧订单字段回填、失效预订房复位。
export function migrateStartupState(state) {
  state.catalog = mergeCatalog(state.catalog);
  const fresh = initialState();
  for (const item of inventoryProducts(state.catalog)) state.inventory[item.id] ??= { count: null, threshold: item.inventoryThreshold ?? 10, unit: item.baseUnit };
  state.consumables ??= structuredClone(fresh.consumables);
  for (const [id, item] of Object.entries(fresh.consumables)) state.consumables[id] ??= item;
  for (const order of state.orders) {
    order.sales ??= [];
    order.otherCharges ??= [];
    order.payments ??= [];
    order.exchanges ??= [];
    order.bonusGifts ??= [];
    order.giftRequests ??= [];
    order.openedBy ??= order.person || '';
    order.recordedBy ??= order.person || '';
    order.employeeId ??= '';
    order.openSource ??= '线下';
    order.reservedBy ??= '';
    order.reservationSource ??= '';
    order.rounding ??= 0;
    order.roundingType ??= order.rounding ? '免零' : '';
    order.roundingNote ??= '';
    order.roundingReview ??= null;
    if (order.credit) order.credit.openSource ??= order.openSource;
    for (const gift of order.bonusGifts) {
      gift.id ??= ++state.serial;
      gift.drinks ??= gift.bottles ? [{ id: ++state.serial, product: gift.product, count: gift.bottles }] : [];
      // Bug #3 配套：旧数据里换入/缺名称的饮品行补齐快照字段骨架（历史名保持未知，不读当前目录）。
      for (const drink of gift.drinks) { drink.productId ??= drink.product || gift.productId || gift.product || ''; drink.productNameSnapshot ??= null; drink.baseUnitSnapshot ??= null; drink.totalBaseQuantity ??= drink.count ?? null; drink.snapshotStatus ??= 'legacy'; }
    }
    for (const sale of order.sales) {
      sale.id ??= ++state.serial;
      const multiplier = sale.spec === 'dozen' ? 12 : sale.spec === 'half' ? 6 : 1;
      sale.bottles ??= Number(sale.count || 0) * multiplier;
      sale.drinks ??= sale.bottles ? [{ id: ++state.serial, product: sale.product, count: sale.bottles }] : [];
      // Bug #3 配套：同上，销售行内嵌饮品行补齐快照字段骨架。
      for (const drink of sale.drinks) { drink.productId ??= drink.product || sale.productId || sale.product || ''; drink.productNameSnapshot ??= null; drink.baseUnitSnapshot ??= null; drink.totalBaseQuantity ??= drink.count ?? null; drink.snapshotStatus ??= 'legacy'; }
    }
  }
  for (const room of state.rooms) {
    if (room.status === '已预订' && !room.order && !state.reservations.some(reservation => reservation.room === room.id && reservationActiveAt(reservation, state.clock))) room.status = '空闲';
  }
  return state;
}

function legacyOrderProductSnapshot(record, baseQuantity = null) {
  const id = productIdOf(record);
  return {
    productId: id,
    productNameSnapshot: record?.productNameSnapshot ?? null,
    categorySnapshot: record?.categorySnapshot ?? null,
    categoryLabelSnapshot: record?.categoryLabelSnapshot ?? null,
    baseUnitSnapshot: record?.baseUnitSnapshot ?? null,
    baseQuantity,
    snapshotStatus: record?.snapshotStatus || 'legacy'
  };
}
function migrateLegacyCatalogFacts(next) {
  next.catalog = mergeCatalog(next.catalog);
  next.orders = migrateLegacyOrderPricing(next.orders);
  const fresh = initialState();
  const oldConsumables = next.consumables && typeof next.consumables === 'object' ? next.consumables : {};
  const aliases = { nuts: 'cons_nuts', ice: 'cons_ice', tissue: 'cons_tissue', straw: 'cons_straw' };
  for (const [oldId, newId] of Object.entries(aliases)) if (!oldConsumables[newId] && oldConsumables[oldId]) oldConsumables[newId] = oldConsumables[oldId];
  next.inventory = Object.fromEntries(inventoryProducts(next.catalog).map(item => [item.id, { count: null, ...(next.inventory?.[item.id] || fresh.inventory[item.id] || {}), unit: item.baseUnit, threshold: next.inventory?.[item.id]?.threshold ?? item.inventoryThreshold ?? 10 }]));
  next.consumables = Object.fromEntries(consumableProducts(next.catalog).map(item => [item.id, { ...(oldConsumables[item.id] || fresh.consumables[item.id]), unit: item.baseUnit, threshold: oldConsumables[item.id]?.threshold ?? item.inventoryThreshold ?? 10 }]));
  for (const order of next.orders || []) {
    order.kind ??= 'room';
    order.createdAt ??= order.time;
    order.packageId ??= null;
    order.packageNameSnapshot ??= null;
    order.packageBaseCents ??= Number.isSafeInteger(order.base) ? order.base : null;
    order.packageGiftValueCents ??= Number.isSafeInteger(order.gift) ? order.gift : null;
    order.packageReferenceGiftValueCents ??= Number.isSafeInteger(order.gift) ? order.gift : null;
    order.packagePriceCents ??= Number.isSafeInteger(order.base) && Number.isSafeInteger(order.gift) ? order.base + order.gift : null;
    order.openingGiftReferenceValueCents ??= Number.isSafeInteger(order.gift) ? order.gift : null;
    order.resolvedComponents ??= [
      ...(order.drinks || []).map(line => ({ ...legacyOrderProductSnapshot(line, Number.isSafeInteger(line.count) ? line.count : null), kind: 'opening-drink', totalBaseQuantity: Number.isSafeInteger(line.count) ? line.count : null })),
      ...(order.extras || []).map(line => ({ ...legacyOrderProductSnapshot(line, Number.isSafeInteger(line.count) ? line.count : null), kind: 'package-component', totalBaseQuantity: Number.isSafeInteger(line.count) ? line.count : null }))
    ];
    for (const line of order.drinks || []) {
      line.productId ??= line.product || '';
      line.productNameSnapshot ??= null;
      line.baseUnitSnapshot ??= null;
      line.totalBaseQuantity ??= line.count ?? null;
      line.snapshotStatus ??= 'legacy';
    }
    for (const extra of order.extras || []) extra.productId ??= extra.product || '';
    for (const sale of order.sales || []) {
      sale.productId ??= sale.product || '';
      sale.saleQuantity ??= sale.count ?? null;
      sale.saleOptionId ??= sale.spec || null;
      sale.saleOptionNameSnapshot ??= null;
      sale.baseQuantityPerSaleUnit ??= sale.spec === 'dozen' ? 12 : sale.spec === 'half' ? 6 : sale.spec === 'single' ? 1 : null;
      sale.totalBaseQuantity ??= sale.bottles ?? null;
      sale.pricePerSaleUnitCents ??= null;
      sale.amountCents ??= Number.isSafeInteger(sale.amount) ? sale.amount : null;
      sale.productNameSnapshot ??= null;
      sale.categorySnapshot ??= null;
      sale.baseUnitSnapshot ??= null;
      sale.snapshotStatus ??= 'legacy';
      sale.drinks ??= sale.totalBaseQuantity ? [{ id: ++next.serial, product: sale.product, productId: sale.productId, count: sale.totalBaseQuantity, totalBaseQuantity: sale.totalBaseQuantity, productNameSnapshot: null, baseUnitSnapshot: null, snapshotStatus: 'legacy' }] : [];
      for (const drink of sale.drinks || []) { drink.productId ??= drink.product || sale.productId; drink.totalBaseQuantity ??= drink.count ?? null; drink.productNameSnapshot ??= null; drink.baseUnitSnapshot ??= null; drink.snapshotStatus ??= 'legacy'; }
    }
    for (const gift of order.bonusGifts || []) {
      gift.productId ??= gift.product || '';
      gift.productNameSnapshot ??= null;
      gift.categorySnapshot ??= null;
      gift.baseUnitSnapshot ??= null;
      gift.saleOptionId ??= 'half';
      gift.saleOptionNameSnapshot ??= null;
      gift.saleQuantity ??= gift.halves ?? null;
      gift.baseQuantityPerSaleUnit ??= 6;
      gift.totalBaseQuantity ??= gift.bottles ?? null;
      gift.referenceValueCents ??= null;
      gift.snapshotStatus ??= 'legacy';
      gift.drinks ??= gift.bottles ? [{ id: ++next.serial, product: gift.product, productId: gift.productId, count: gift.bottles, totalBaseQuantity: gift.bottles, productNameSnapshot: null, baseUnitSnapshot: null, snapshotStatus: 'legacy' }] : [];
      for (const drink of gift.drinks || []) { drink.productId ??= drink.product || gift.productId; drink.totalBaseQuantity ??= drink.count ?? null; drink.productNameSnapshot ??= null; drink.baseUnitSnapshot ??= null; drink.snapshotStatus ??= 'legacy'; }
    }
    for (const request of order.giftRequests || []) {
      request.productId ??= request.product || '';
      request.productNameSnapshot ??= null;
      request.categorySnapshot ??= null;
      request.baseUnitSnapshot ??= null;
      request.referenceValueCents ??= null;
      request.snapshotStatus ??= 'legacy';
    }
  }
  return next;
}
export function migrateDemoState(next) {
  next = migrateLegacyCatalogFacts(next);
  const userIdByName = name => Object.entries(USERS).find(([, user]) => user.name === name)?.[0] || '';
  const capabilitySchemaVersion = Number(next.capabilitySchemaVersion || 0);
  const defaults = defaultPermissions();
  const raw = next.permissions && typeof next.permissions === 'object' ? next.permissions : {};
  next.permissions = Object.fromEntries(Object.entries(defaults).map(([id, roles]) => {
    const configured = raw[id];
    const normalized = Array.isArray(configured) ? [...new Set(configured.filter(role => PERMISSION_ROLES.includes(role)))] : [...roles];
    return [id, id === 'administrator' ? ['管理员'] : normalized];
  }));
  const capabilityDefaults = defaultCapabilities();
  const rawCapabilities = next.capabilities && typeof next.capabilities === 'object' ? next.capabilities : {};
  next.capabilities = Object.fromEntries(Object.entries(capabilityDefaults).map(([id, permissions]) => {
    const configured = rawCapabilities[id];
    const legacyRoles = next.permissions[id];
    const fallback = Array.isArray(legacyRoles) ? permissionsForRoles(legacyRoles) : permissions;
    if (id === 'administrator') return [id, [...PERMISSION_IDS]];
    const normalized = Array.isArray(configured) ? [...new Set(configured.filter(permission => PERMISSION_IDS.includes(permission)))] : [...fallback];
    const added = ['expense.view', 'expense.create', 'expense.viewAll', 'expense.approve', 'identity.manage', 'staff.record', 'retail.sale', 'procurement.create', 'procurement.viewAll', 'incident.create', 'incident.viewAll', 'incident.resolve', 'incident.resolve.approve', 'room.issue', 'room.issue.approve', 'credit.repay.approve', 'inventory.approve'];
    const configuredBase = normalized.filter(permission => !added.includes(permission));
    const fallbackBase = fallback.filter(permission => !added.includes(permission));
    const matchesRoleDefaults = configuredBase.length === fallbackBase.length && fallbackBase.every(permission => configuredBase.includes(permission));
    const dualReviewPermissions = capabilitySchemaVersion < 2 ? fallback.filter(permission => ['credit.repay.approve', 'inventory.approve', 'incident.resolve.approve'].includes(permission)) : [];
    return [id, matchesRoleDefaults ? [...new Set([...normalized, ...fallback.filter(permission => added.includes(permission)), ...dualReviewPermissions])] : [...new Set([...normalized, ...dualReviewPermissions])]];
  }));
  next.capabilitySchemaVersion = 4;
  for (const order of next.orders || []) {
    order.otherCharges ??= [];
    for (const extra of order.extras || []) extra.served ??= false;
    for (const request of order.giftRequests || []) {
      request.requestedById ??= userIdByName(request.requestedBy);
      request.submittedAt ??= request.time || order.time || next.clock;
      request.decisionNote ??= '';
      request.selfReviewAuthorized ??= false;
    }
    if (order.roundingReview) {
      order.roundingReview.submittedById ??= userIdByName(order.roundingReview.submittedBy);
      order.roundingReview.decisionNote ??= '';
      order.roundingReview.selfReviewAuthorized ??= false;
      if (order.roundingReview.status === '已审核') order.roundingReview.status = '已批准';
    }
    if (order.credit) {
      order.credit.repayments ??= [];
      order.credit.repaymentRequests ??= [];
      for (const request of order.credit.repaymentRequests) {
        request.submittedById ??= userIdByName(request.submittedBy);
        request.decisionNote ??= '';
        request.selfReviewAuthorized ??= false;
      }
    }
  }
  next.handovers = Array.isArray(next.handovers) ? next.handovers : [];
  for (const handover of next.handovers) handover.drawerCash ??= null;
  next.expenses = Array.isArray(next.expenses) ? next.expenses : [];
  for (const expense of next.expenses) {
    expense.type ??= '支出';
    expense.status ??= '已记录';
    expense.approver ??= '';
    expense.approvedAt ??= '';
  }
  const fresh = initialState();
  next.consumables = next.consumables && typeof next.consumables === 'object' ? next.consumables : structuredClone(fresh.consumables);
  for (const [id, item] of Object.entries(fresh.consumables)) next.consumables[id] ??= item;
  next.procurements = Array.isArray(next.procurements) ? next.procurements : [];
  next.incidents = Array.isArray(next.incidents) ? next.incidents : [];
  next.roomIssueReviews = Array.isArray(next.roomIssueReviews) ? next.roomIssueReviews : [];
  next.inventoryReviews = Array.isArray(next.inventoryReviews) ? next.inventoryReviews : [];
  for (const incident of next.incidents) {
    incident.status ??= incident.result ? '已完成' : '待处理';
    incident.result ??= '';
    incident.note ??= '';
    incident.lastReminderDate ??= '';
    incident.resolutionReviews = Array.isArray(incident.resolutionReviews) ? incident.resolutionReviews : [];
    for (const request of incident.resolutionReviews) {
      request.submittedById ??= userIdByName(request.submittedBy);
      request.decisionNote ??= '';
      request.selfReviewAuthorized ??= false;
    }
  }
  for (const request of next.inventoryReviews) {
    request.submittedById ??= userIdByName(request.submittedBy);
    request.decisionNote ??= '';
    request.selfReviewAuthorized ??= false;
  }
  for (const room of next.rooms || []) {
    if (['V05', 'V06'].includes(room.id)) room.type = '中房';
    room.issueType ??= '';
    room.issueNote ??= '';
    room.issueAt ??= '';
    room.issueBy ??= '';
    room.issueApprovedBy ??= '';
    room.issueEvidencePhoto ??= '';
    room.issueEvidencePhotoName ??= '';
  }
  for (const request of next.roomIssueReviews) {
    request.selfReviewAuthorized ??= false;
    if (request.status !== '待审核' || request.requestedStatus !== '故障/维护中') continue;
    const room = (next.rooms || []).find(item => item.id === request.room);
    if (room && room.status === request.fromStatus) {
      room.status = '故障/维护中';
      room.issueType = request.issueType || '故障';
      room.issueNote = request.evidenceText || '已提交照片凭证';
      room.issueAt = request.submittedAt || next.clock;
      room.issueBy = request.submittedBy || '';
      room.issueApprovedBy = '';
      room.issueEvidencePhoto = request.evidencePhoto || '';
      room.issueEvidencePhotoName = request.evidencePhotoName || '';
      request.status = '无需审核';
      request.decidedAt = request.submittedAt || next.clock;
      request.decisionNote = '规则更新：故障／维护标记提交后立即生效';
    } else {
      request.status = '已失效';
      request.decidedAt = next.clock;
      request.decisionNote = '房间状态已变化，旧标记申请自动失效';
    }
  }
  return next;
}

// 用户身份归一化（原 app.js 启动与跨标签页两处共用）：别名映射 + 淘汰身份回落。
export function normalizeDemoUser(state) {
  state.user = USER_ALIASES[state.user] || state.user;
  if (!USERS[state.user] || USERS[state.user].legacy) state.user = 'shaoBoss';
  return state;
}
