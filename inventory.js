// 库存领域：唯一读写 state.inventory／state.consumables／盘点审核与库存流水的模块。
// Phase 3 自 rules.js 迁出：inventory() 记账函数、stock／consumableStock／
// approveInventory／rejectInventory 命令、pendingInventoryReview 查询。
// 函数体逐字节保留，行为（未建账禁售、余额/流水/counted、赠饮语义）不变。
// 权限闸门与自审授权经 ctx 注入（need／authorizeReviewer），避免对 rules.js 的循环依赖。
import { BusinessRejection } from './shared/business-error.js';
import { product } from './catalog.js';
import { effectiveUser, hasPermission, hasRole } from './shared/identity.js';

export function need(state, roles, permission = '') { const user = effectiveUser(state); if (permission ? !hasPermission(user, permission) : !hasRole(user, roles)) throw new BusinessRejection('当前身份没有操作权限，请切换到对应演示身份'); }

export function pendingInventoryReview(state, kind, productId) { return (state.inventoryReviews ||= []).find(request => request.kind === kind && request.product === productId && request.status === '待审核'); }

export function recordInventoryChange(state, id, delta, source, time, related = {}) {
  const catalogProduct = product(id, state.catalog);
  if (!catalogProduct.inventoryManaged) return;
  const item = state.inventory[id];
  if (!item) throw new BusinessRejection(`${catalogProduct.name}没有建立库存账`);
  if (item.count !== null && item.count + delta < 0) throw new BusinessRejection(`${catalogProduct.name}库存不足，请减少数量或先核对库存`);
  state.ledger.push({ id: ++state.serial, product: id, productId: id, productNameSnapshot: catalogProduct.name, baseUnitSnapshot: catalogProduct.baseUnit, delta, baseQuantityDelta: delta, source, ...related, counted: item.count !== null, time, person: effectiveUser(state).name });
  if (item.count !== null) item.count += delta;
}

export function submitStock(s, data, person, time) {
  const item = s.inventory[data.product]; if (!item) throw new BusinessRejection('该商品不管理库存');
  need(s, item.count === null ? ['店长','老板','采购'] : ['店长','老板','库管','采购'], item.count === null ? 'inventory.opening' : 'inventory.adjust');
  if (!Number.isSafeInteger(data.count) || data.count < 0) throw new BusinessRejection('实际库存应为非负整数');
  const reason = String(data.reason || '').trim().slice(0, 300); if (!reason) throw new BusinessRejection('请填写调整原因');
  if (pendingInventoryReview(s, 'drink', data.product)) throw new BusinessRejection('该商品已有库存盘点待审核');
  const before = item.count;
  s.inventoryReviews.push({ id: ++s.serial, kind: 'drink', product: data.product, before, after: data.count, reason, source: before === null ? '期初建账' : '盘点调整', status: '待审核', submittedBy: person, submittedById: s.user, submittedAt: time, decidedBy: '', decidedAt: '', decisionNote: '' });
}

export function submitConsumableStock(s, data, person, time) {
  const item = s.consumables?.[data.product]; if (!item) throw new BusinessRejection('该消耗品不在库存管理中');
  const permission = item.count === null ? 'inventory.opening' : 'inventory.adjust';
  need(s, [], permission);
  if (!Number.isSafeInteger(data.count) || data.count < 0 || !Number.isSafeInteger(data.opened) || data.opened < 0) throw new BusinessRejection('消耗品数量应为非负整数');
  const reason = String(data.reason || '').trim().slice(0, 300); if (!reason) throw new BusinessRejection('请填写调整原因');
  if (pendingInventoryReview(s, 'consumable', data.product)) throw new BusinessRejection('该消耗品已有库存盘点待审核');
  const before = item.count, beforeOpened = item.opened || 0;
  s.inventoryReviews.push({ id: ++s.serial, kind: 'consumable', product: data.product, before, after: data.count, openedBefore: beforeOpened, openedAfter: data.opened, reason, source: before === null ? '消耗品期初建账' : '消耗品盘点调整', status: '待审核', submittedBy: person, submittedById: s.user, submittedAt: time, decidedBy: '', decidedAt: '', decisionNote: '' });
}

export function decideInventory(s, action, data, person, time, authorizeReviewer) {
  need(s, [], 'inventory.approve');
  const request = (s.inventoryReviews || []).find(item => item.id === Number(data.request));
  if (!request || request.status !== '待审核') throw new BusinessRejection('这笔库存盘点已经处理');
  const selfReview = authorizeReviewer(request.submittedById);
  const decisionNote = String(data.decisionNote || '').trim().slice(0, 300);
  if (action === 'rejectInventory' && !decisionNote) throw new BusinessRejection('请填写驳回原因');
  if (action === 'approveInventory') {
    if (request.kind === 'consumable') {
      const item = s.consumables?.[request.product];
      if (!item || item.count !== request.before || (item.opened || 0) !== request.openedBefore) throw new BusinessRejection('消耗品库存已经变化，请驳回后重新盘点');
      s.ledger.push({ id: ++s.serial, kind: 'consumable', product: request.product, delta: request.after-(request.before ?? 0), before: request.before, after: request.after, openedBefore: request.openedBefore, openedAfter: request.openedAfter, reason: request.reason, source: request.source, counted: true, person: request.submittedBy, reviewedBy: person, time });
      item.count = request.after; item.opened = request.openedAfter; if (request.before === null) item.openedAt = time;
    } else {
      const item = s.inventory[request.product];
      if (!item || item.count !== request.before) throw new BusinessRejection('商品库存已经变化，请驳回后重新盘点');
      s.ledger.push({ id: ++s.serial, product: request.product, delta: request.after-(request.before ?? 0), before: request.before, after: request.after, reason: request.reason, source: request.source, counted: true, person: request.submittedBy, reviewedBy: person, time });
      item.count = request.after; if (request.before === null) item.openedAt = time;
    }
    s.notices.push({ id: ++s.serial, kind: request.kind, product: request.product, unit: request.kind === 'consumable' ? (s.consumables?.[request.product]?.unit || '份') : (s.inventory[request.product]?.unit || product(request.product, s.catalog).baseUnit), before: request.before, after: request.after, openedBefore: request.openedBefore, openedAfter: request.openedAfter, reason: request.reason, person: request.submittedBy, reviewedBy: person, time });
  }
  request.status = action === 'approveInventory' ? '已批准' : '已驳回'; request.decidedBy = person; request.decidedAt = time; request.decisionNote = decisionNote; request.selfReviewAuthorized = selfReview;
}
