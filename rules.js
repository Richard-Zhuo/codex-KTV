// 整数分计价、事务式状态变更，不依赖 DOM；演示与可信执行显式隔离。
// 商品与套餐的运行时唯一来源是 state.catalog。DEFAULT_CATALOG 只由目录模块负责初始化、迁移和恢复演示数据。
// 领域模块已分阶段迁出：catalog／inventory（Phase 3）、sales（Phase 4）、
// rooms／deposits／expenses／procurement／incidents／handover（Phase 5）、UI（Phase 7）。
// Phase 8 起移除全部 facade re-export：调用方直接从 owner 模块导入；
// rules.js 仅导出 OTHER_CHARGE_CATEGORIES／bonusAllowance／initialState／transact，
// 并保留订单内联分支（otherCharge／gift／exchange／serveExtra）与身份/目录命令。
import { BusinessRejection } from './shared/business-error.js';
import { DEFAULT_CATALOG, cloneCatalog, mergeCatalog, assertCatalogPackagePrices, product, saleOption, inventoryProducts, consumableProducts, categoryLabel, productIdOf } from './catalog.js';
import { need, recordInventoryChange, submitStock, submitConsumableStock, decideInventory } from './inventory.js';
import { submitSale, submitRetailSale, collectPayment, settleOrder, payOrder, decideRounding, applyCredit, decideCredit, submitRepay, decideRepayment } from './sales.js';
import { canExchange, release, openRoom, reserveRoom, cancelReservation, cleanRoom, markRoomIssue, clearRoomIssue, decideRoomIssue } from './rooms.js';
import { submitDeposit, withdrawDeposit } from './deposits.js';
import { submitExpense, decideExpense } from './expenses.js';
import { submitProcurement } from './procurement.js';
import { submitIncident, submitIncidentResolution, decideIncidentResolution } from './incidents.js';
import { submitHandover } from './handover.js';
import { USERS, PERMISSION_ROLES, PERMISSION_IDS, defaultPermissions, defaultCapabilities, permissionsForRoles, effectiveUser, hasPermission, assertTrustedExecutionContext, requireTrustedPermission, AuthorizationDenied } from './shared/identity.js';

export const OTHER_CHARGE_CATEGORIES = ['小吃', '热食', '烧鸡烤肉', '代驾', '其他'];

function productSnapshot(catalog, id, baseQuantity, extra = {}) {
  const p = product(id, catalog);
  return { productId: p.id, productNameSnapshot: p.name, categorySnapshot: p.category, categoryLabelSnapshot: categoryLabel(p), baseUnitSnapshot: p.baseUnit, baseQuantity, ...extra };
}
function quantity(n) { if (!Number.isSafeInteger(n) || n <= 0) throw new BusinessRejection('数量必须是大于零的整数'); }
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
// grantBonus 服务 gift/approveGift 分支（赠酒域，暂留 rules.js），函数体自 HEAD 逐字保留。
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
// 目录命令的私有业务校验；demo 与 trusted 共用原规则。
function normalizeSaleOptions(options, sellable) {
  if (!Array.isArray(options) || (sellable && !options.length)) throw new BusinessRejection('可售商品至少需要一种销售规格');
  const ids = new Set();
  return options.map(option => {
    const id = String(option?.id || '').trim(), name = String(option?.name || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,39}$/.test(id) || ids.has(id) || !name || name.length > 30 || !Number.isSafeInteger(option.baseQuantity) || option.baseQuantity <= 0 || !Number.isSafeInteger(option.priceCents) || option.priceCents < 0 || (sellable && option.priceCents === 0)) throw new BusinessRejection('销售规格 ID、基础数量或价格无效，且 ID 不得重复');
    ids.add(id);
    return { id, name, baseQuantity: option.baseQuantity, priceCents: option.priceCents };
  });
}
const CATALOG_COMMAND_ACTIONS = Object.freeze(['createCatalogProduct', 'updateCatalogProduct', 'updateCatalogPackage']);
function executeCatalogCommand(s, action, data, execution = { mode: 'demo' }) {
  if (execution?.mode === 'trusted') requireTrustedPermission(execution.context, 'catalog.manage');
  else if (execution?.mode === 'demo') need(s, [], 'catalog.manage');
  else throw TypeError('目录执行模式无效');
  if (action === 'createCatalogProduct') {
    const id = String(data.id || '').trim(), name = String(data.name || '').trim(), category = String(data.category || '').trim(), baseUnit = String(data.baseUnit || '').trim();
    if (!/^[a-z][a-z0-9._-]{0,39}$/.test(id) || s.catalog.products.some(item => item.id === id)) throw new BusinessRejection('商品 ID 无效或已存在');
    if (!name || name.length > 80 || !category || category.length > 40 || !baseUnit || baseUnit.length > 20) throw new BusinessRejection('请填写有效的商品名称、分类和基础单位');
    if (!Number.isSafeInteger(data.sortOrder)) throw new BusinessRejection('排序必须是整数');
    const sellable = Boolean(data.sellable), inventoryManaged = Boolean(data.inventoryManaged);
    const options = normalizeSaleOptions(data.saleOptions || [], sellable);
    s.catalog.products.push({ id, name, category, categoryLabel: category, baseUnit, saleOptions: options, inventoryManaged, inventoryThreshold: 10, sellable, manualPriceAllowed: false, exchangeLevel: null, openingGiftEligible: false, active: data.active !== false, sortOrder: data.sortOrder });
    if (inventoryManaged) s.inventory[id] = { count: null, threshold: 10, unit: baseUnit };
  } else if (action === 'updateCatalogProduct') {
    const id = String(data.id || '').trim();
    const current = product(id, s.catalog);
    const name = String(data.name ?? current.name).trim().slice(0, 80);
    if (!name) throw new BusinessRejection('商品名称不能为空');
    const next = { ...current, name };
    for (const field of ['active', 'sellable', 'manualPriceAllowed']) if (data[field] !== undefined) next[field] = Boolean(data[field]);
    if (data.sortOrder !== undefined) {
      if (!Number.isSafeInteger(data.sortOrder)) throw new BusinessRejection('排序必须是整数');
      next.sortOrder = data.sortOrder;
    }
    if (data.saleOptions !== undefined) next.saleOptions = normalizeSaleOptions(data.saleOptions, next.sellable);
    else if (next.sellable) normalizeSaleOptions(next.saleOptions, true);
    s.catalog.products = s.catalog.products.map(item => item.id === id ? next : item);
  } else if (action === 'updateCatalogPackage') {
    const id = String(data.id || '').trim();
    const current = s.catalog.packages.find(item => item.id === id);
    if (!current) throw new BusinessRejection('套餐不存在');
    const next = { ...current, name: String(data.name ?? current.name).trim().slice(0, 80) };
    if (!next.name) throw new BusinessRejection('套餐名称不能为空');
    for (const field of ['priceCents', 'basePriceCents', 'includedValueCents', 'sortOrder']) if (data[field] !== undefined) {
      if (!Number.isSafeInteger(data[field]) || data[field] < 0) throw new BusinessRejection('套餐金额或排序无效');
      next[field] = data[field];
    }
    // Bug #2 修复：总价只有一个来源——基础房费＋赠饮参考值；提交不一致直接拒绝，
    // 开房报价、订单快照与账单 total 不再出现两个总价口径。
    if (next.priceCents !== next.basePriceCents + (next.includedValueCents || 0)) throw new BusinessRejection('套餐总价必须等于基础房费加赠饮参考值');
    if (data.active !== undefined) next.active = Boolean(data.active);
    s.catalog.packages = s.catalog.packages.map(item => item.id === id ? next : item);
  } else throw TypeError('未知目录命令');
}
// 先修改克隆，全部校验成功才返回；失败不产生部分扣库或半张账单。
export function transact(original, action, data = {}, key, execution = { mode: 'demo' }) {
  if (!execution || !['demo', 'trusted'].includes(execution.mode)) throw TypeError('事务执行模式无效');
  const context = execution.mode === 'trusted' ? assertTrustedExecutionContext(execution.context) : null;
  if (context && !['clean', 'markRoomIssue', 'clearRoomIssue', ...CATALOG_COMMAND_ACTIONS, 'cancelReservation'].includes(action)) throw new AuthorizationDenied('trusted-action-not-enabled');
  if (!key) throw new BusinessRejection('缺少操作编号');
  if (original.processed.includes(key)) return original;
  const s = structuredClone(original);
  s.catalog = mergeCatalog(s.catalog);
  assertCatalogPackagePrices(s.catalog);
  if (context) {
    // Only migrated commands; never evaluate demo identity or clock.
    const execution = { mode: 'trusted', context };
    if (CATALOG_COMMAND_ACTIONS.includes(action)) executeCatalogCommand(s, action, data, execution);
    else {
      const room = s.rooms.find(room => room.id === data.room);
      if (action === 'clean') cleanRoom(s, room, execution);
      else if (action === 'markRoomIssue') markRoomIssue(s, room, data, undefined, undefined, execution);
      else if (action === 'clearRoomIssue') clearRoomIssue(s, room, data, undefined, undefined, execution);
      else cancelReservation(s, room, data, undefined, execution);
    }
    s.processed.push(key);
    return s;
  }
  const time = s.clock, operator = effectiveUser(s).name;
  let person = operator;
  const room = s.rooms.find(r => r.id === data.room);
  const order = s.orders.find(o => o.id === data.order);
  const active = () => { if (!order || order.status !== '营业中') throw new BusinessRejection('账单已变化，请返回房间重新查看'); };
  const authorizeReviewer = submittedById => {
    if (!submittedById) throw new BusinessRejection('申请缺少提交人，不能审核');
    const selfReview = submittedById === s.user;
    if (selfReview && !hasPermission(effectiveUser(s), 'review.self')) throw new BusinessRejection('审核本人申请需要“允许审核本人申请”权限');
    return selfReview;
  };
  if (action === 'setPermissions') {
    need(s, ['管理员']);
    const target = String(data.user || '');
    if (!USERS[target] || USERS[target].legacy || target === 'administrator') throw new BusinessRejection('只能调整其他演示身份的权限');
    if (data.permissions !== undefined) {
      if (!Array.isArray(data.permissions) || data.permissions.some(permission => !PERMISSION_IDS.includes(permission))) throw new BusinessRejection('具体权限选项无效');
      s.capabilities ??= defaultCapabilities();
      s.capabilities[target] = [...new Set(data.permissions)];
    } else {
      if (!Array.isArray(data.roles) || data.roles.some(role => !PERMISSION_ROLES.includes(role))) throw new BusinessRejection('岗位权限选项无效');
      s.permissions ??= defaultPermissions();
      s.capabilities ??= defaultCapabilities();
      s.permissions[target] = [...new Set(data.roles)];
      s.capabilities[target] = permissionsForRoles(s.permissions[target]);
    }
  } else if (CATALOG_COMMAND_ACTIONS.includes(action)) {
    executeCatalogCommand(s, action, data);
  } else if (action === 'markRoomIssue') {
    // 命令体已迁至 rooms.js：markRoomIssue（Phase 5），逐字节保留。
    markRoomIssue(s, room, data, person, time);
  } else if (action === 'clearRoomIssue') {
    // 命令体已迁至 rooms.js：clearRoomIssue（Phase 5），逐字节保留。
    clearRoomIssue(s, room, data, person, time);
  } else if (action === 'approveRoomIssue' || action === 'rejectRoomIssue') {
    // 命令体已迁至 rooms.js：decideRoomIssue（Phase 5），逐字节保留；authorizeReviewer 经参数注入保持原闭包语义。
    decideRoomIssue(s, action, data, person, time, authorizeReviewer);
  } else if (action === 'open') {
    // 命令体已迁至 rooms.js：openRoom（Phase 5），逐字节保留。
    openRoom(s, room, data, person, operator, time);
  } else if (action === 'reserve') {
    // 命令体已迁至 rooms.js：reserveRoom（Phase 5），逐字节保留。
    reserveRoom(s, room, data, person, operator, time);
  } else if (action === 'cancelReservation') {
    // 命令体已迁至 rooms.js：cancelReservation（Phase 5），逐字节保留。
    cancelReservation(s, room, data, time);
  } else if (action === 'sale') {
    active();
    submitSale(s, order, data, person, operator, time);
  } else if (action === 'retailSale') {
    submitRetailSale(s, data, person, operator, time);
  } else if (action === 'otherCharge') {
    need(s, ['开单员','服务员','老板'], 'order.sale'); active();
    const category = String(data.category || '').trim();
    if (!OTHER_CHARGE_CATEGORIES.includes(category)) throw new BusinessRejection('请选择有效的其他消费类别');
    if (!Number.isSafeInteger(data.amount) || data.amount <= 0) throw new BusinessRejection('金额应为大于零的金额');
    const customItem = String(data.item || '').trim().slice(0, 50);
    if (category === '其他' && !customItem) throw new BusinessRejection('请填写其他消费项目');
    const batch = ++s.serial;
    order.otherCharges ??= [];
    order.otherCharges.push({ id: ++s.serial, batch, category, item: category === '其他' ? customItem : category, amount: data.amount, person, time });
  } else if (action === 'gift') {
    need(s, ['开单员','服务员','店长','老板'], 'order.gift'); active(); quantity(data.halves);
    const p = product(data.productId || data.product, s.catalog);
    if (!p.openingGiftEligible || p.selectionOnly) throw new BusinessRejection('该商品不参与赠酒水规则');
    const halfOption = saleOption(p, 'half');
    const allowance = bonusAllowance(order, p.id);
    if (!allowance.purchased) throw new BusinessRejection('请先增购对应酒水');
    order.giftRequests ??= [];
    const directHalves = Math.min(data.halves, allowance.availableHalves);
    const excessHalves = data.halves - directHalves;
    if (directHalves) grantBonus(s, order, p.id, directHalves, '每增购2打赠半打', time);
    if (excessHalves) order.giftRequests.push({ id: ++s.serial, product: p.id, productId: p.id, productNameSnapshot: p.name, categorySnapshot: p.category, baseUnitSnapshot: p.baseUnit, saleOptionId: 'half', saleOptionNameSnapshot: halfOption.name, halves: excessHalves, saleQuantity: excessHalves, baseQuantityPerSaleUnit: halfOption.baseQuantity, bottles: excessHalves * halfOption.baseQuantity, totalBaseQuantity: excessHalves * halfOption.baseQuantity, referenceValueCents: excessHalves * halfOption.priceCents, allowanceAtRequest: directHalves, status: '待确认', requestedBy: person, requestedById: s.user, submittedAt: time, time, decidedBy: '', decidedAt: '', decisionNote: '', snapshotStatus: 'current' });
  } else if (action === 'approveGift' || action === 'rejectGift') {
    need(s, ['店长','老板'], 'gift.approve'); active();
    const request = (order.giftRequests || []).find(item => item.id === data.request);
    if (!request || request.status !== '待确认') throw new BusinessRejection('赠酒水申请已处理');
    const selfReview = authorizeReviewer(request.requestedById);
    const decisionNote = String(data.decisionNote || '').trim().slice(0, 300);
    if (action === 'rejectGift' && !decisionNote) throw new BusinessRejection('请填写驳回原因');
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
    if (!line || line.count < data.count) throw new BusinessRejection('超过可换数量');
    if (!canExchange(productIdOf(line), data.product, s.catalog)) throw new BusinessRejection('只能换同级或更低级商品，瓶装水不能换出');
    recordInventoryChange(s, productIdOf(line), data.count, '换购退回', time); recordInventoryChange(s, data.product, -data.count, '换购领取', time);
    line.count -= data.count;
    const target = lines.find(drink => productIdOf(drink) === data.product);
    if (target) target.count += data.count; else {
      // Bug #3 修复：换入行写入完整名称/单位快照，历史展示不再依赖当前目录。
      const exchanged = product(data.product, s.catalog);
      lines.push({ id: ++s.serial, product: data.product, productId: exchanged.id, productNameSnapshot: exchanged.name, baseUnitSnapshot: exchanged.baseUnit, count: data.count, totalBaseQuantity: data.count, snapshotStatus: 'current' });
    }
    order.exchanges.push({ from: productIdOf(line), to: data.product, fromProductId: productIdOf(line), toProductId: data.product, count: data.count, scope, time, person });
  } else if (action === 'serveExtra') {
    need(s, ['开单员','服务员','老板'], 'order.serveExtra'); active();
    const extra = (order.extras || []).find(item => item.product === data.product);
    if (!extra) throw new BusinessRejection('该账单没有这项配品');
    if (extra.served) throw new BusinessRejection('这项配品已经标记已上');
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
    decideCredit(s, order, action, person, time, authorizeReviewer);
  } else if (action === 'repay') {
    submitRepay(s, order, data, person, time);
  } else if (action === 'approveRepayment' || action === 'rejectRepayment') {
    decideRepayment(s, order, action, data, person, time, authorizeReviewer);
  } else if (action === 'clean') {
    // 命令体已迁至 rooms.js：cleanRoom（Phase 5），逐字节保留。
    cleanRoom(s, room);
  } else if (action === 'deposit') {
    // 命令体已迁至 deposits.js：submitDeposit（Phase 5），逐字节保留。
    submitDeposit(s, data, person, time);
  } else if (action === 'withdraw') {
    // 命令体已迁至 deposits.js：withdrawDeposit（Phase 5），逐字节保留。
    withdrawDeposit(s, data, person, time);
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
    // 命令体已迁至 handover.js：submitHandover（Phase 5），逐字节保留。
    submitHandover(s, data, person, time);
  } else if (action === 'expense') {
    // 命令体已迁至 expenses.js：submitExpense（Phase 5），逐字节保留。
    submitExpense(s, data, person, time);
  } else if (action === 'procurement') {
    // 命令体已迁至 procurement.js：submitProcurement（Phase 5），逐字节保留。
    submitProcurement(s, data, person, time);
  } else if (action === 'incident') {
    // 命令体已迁至 incidents.js：submitIncident（Phase 5），逐字节保留。
    submitIncident(s, data, person, time);
  } else if (action === 'resolveIncident') {
    // 命令体已迁至 incidents.js：submitIncidentResolution（Phase 5），逐字节保留。
    submitIncidentResolution(s, data, person, time);
  } else if (action === 'approveIncidentResolution' || action === 'rejectIncidentResolution') {
    // 命令体已迁至 incidents.js：decideIncidentResolution（Phase 5），逐字节保留；authorizeReviewer 经参数注入保持原闭包语义。
    decideIncidentResolution(s, action, data, person, time, authorizeReviewer);
  } else if (action === 'approveExpense' || action === 'rejectExpense') {
    // 命令体已迁至 expenses.js：decideExpense（Phase 5），逐字节保留。
    decideExpense(s, action, data, person, time, authorizeReviewer);
  } else throw new BusinessRejection('未知操作');
  s.processed.push(key); return s;
}
