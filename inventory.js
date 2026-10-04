// 库存领域：唯一读写 state.inventory／state.consumables／盘点审核与库存流水的模块。
// Phase 3 自 rules.js 迁出：inventory() 记账函数、stock／consumableStock／
// approveInventory／rejectInventory 命令、pendingInventoryReview 查询。
// 函数体逐字节保留，行为（未建账禁售、余额/流水/counted、赠饮语义）不变。
// 权限闸门与自审授权经 ctx 注入（need／authorizeReviewer），避免对 rules.js 的循环依赖。
import { BusinessRejection } from './shared/business-error.js';
import { product } from './catalog.js';
import { effectiveUser, hasPermission, hasRole, assertTrustedExecutionContext, requireTrustedPermission, AuthorizationDenied } from './shared/identity.js';

export function need(state, roles, permission = '') { const user = effectiveUser(state); if (permission ? !hasPermission(user, permission) : !hasRole(user, roles)) throw new BusinessRejection('当前身份没有操作权限，请切换到对应演示身份'); }

export function pendingInventoryReview(state, kind, productId) { return (state.inventoryReviews ||= []).find(request => request.kind === kind && request.product === productId && request.status === '待审核'); }

export function recordInventoryChange(state, id, delta, source, time, related = {}, execution = { mode: 'demo' }) {
  if (!execution || !['demo', 'trusted'].includes(execution.mode)) throw TypeError('库存流水执行模式无效');
  const context = execution.mode === 'trusted' ? assertTrustedExecutionContext(execution.context) : null;
  if (context) time = context.dbNow;
  const catalogProduct = product(id, state.catalog);
  if (!catalogProduct.inventoryManaged) return;
  const item = state.inventory[id];
  if (!item) throw new BusinessRejection(`${catalogProduct.name}没有建立库存账`);
  if (item.count !== null && item.count + delta < 0) throw new BusinessRejection(`${catalogProduct.name}库存不足，请减少数量或先核对库存`);
  state.ledger.push({ id: ++state.serial, product: id, productId: id, productNameSnapshot: catalogProduct.name, baseUnitSnapshot: catalogProduct.baseUnit, delta, baseQuantityDelta: delta, source, ...related, counted: item.count !== null, time, person: context ? context.principalId : effectiveUser(state).name,
    ...(context ? { actualActorPrincipalId: context.principalId } : {}) });
  if (item.count !== null) item.count += delta;
}

// Submission identity is separate from the unchanged inventory review rules.
function inventorySubmission(state, roles, permission, person, time, execution) {
  if (!execution || !['demo', 'trusted'].includes(execution.mode)) throw TypeError('库存申请执行模式无效');
  if (execution.mode === 'trusted') {
    const context = assertTrustedExecutionContext(execution.context);
    requireTrustedPermission(context, permission);
    return { submittedBy: context.actorSnapshot?.displayName ?? null, submittedById: '',
      submittedByPrincipalId: context.principalId, submittedAt: context.dbNow };
  }
  need(state, roles, permission);
  return { submittedBy: person, submittedById: state.user, submittedAt: time };
}

export function submitStock(s, data, person, time, execution = { mode: 'demo' }) {
  const item = s.inventory[data.product]; if (!item) throw new BusinessRejection('该商品不管理库存');
  const submission = inventorySubmission(s, item.count === null ? ['店长','老板','采购'] : ['店长','老板','库管','采购'], item.count === null ? 'inventory.opening' : 'inventory.adjust', person, time, execution);
  if (!Number.isSafeInteger(data.count) || data.count < 0) throw new BusinessRejection('实际库存应为非负整数');
  const reason = String(data.reason || '').trim().slice(0, 300); if (!reason) throw new BusinessRejection('请填写调整原因');
  if (pendingInventoryReview(s, 'drink', data.product)) throw new BusinessRejection('该商品已有库存盘点待审核');
  const before = item.count;
  s.inventoryReviews.push({ id: ++s.serial, kind: 'drink', product: data.product, before, after: data.count, reason, source: before === null ? '期初建账' : '盘点调整', status: '待审核', ...submission, decidedBy: '', decidedAt: '', decisionNote: '' });
}

export function submitConsumableStock(s, data, person, time, execution = { mode: 'demo' }) {
  const item = s.consumables?.[data.product]; if (!item) throw new BusinessRejection('该消耗品不在库存管理中');
  const permission = item.count === null ? 'inventory.opening' : 'inventory.adjust';
  const submission = inventorySubmission(s, [], permission, person, time, execution);
  if (!Number.isSafeInteger(data.count) || data.count < 0 || !Number.isSafeInteger(data.opened) || data.opened < 0) throw new BusinessRejection('消耗品数量应为非负整数');
  const reason = String(data.reason || '').trim().slice(0, 300); if (!reason) throw new BusinessRejection('请填写调整原因');
  if (pendingInventoryReview(s, 'consumable', data.product)) throw new BusinessRejection('该消耗品已有库存盘点待审核');
  const before = item.count, beforeOpened = item.opened || 0;
  s.inventoryReviews.push({ id: ++s.serial, kind: 'consumable', product: data.product, before, after: data.count, openedBefore: beforeOpened, openedAfter: data.opened, reason, source: before === null ? '消耗品期初建账' : '消耗品盘点调整', status: '待审核', ...submission, decidedBy: '', decidedAt: '', decisionNote: '' });
}

export function decideInventory(s, action, data, person, time, authorizeReviewer, execution = { mode: 'demo' }) {
  const context = execution?.mode === 'trusted' ? assertTrustedExecutionContext(execution.context) : null;
  if (context) requireTrustedPermission(context, 'inventory.approve');
  else if (execution?.mode === 'demo') need(s, [], 'inventory.approve');
  else throw TypeError('库存审核执行模式无效');
  const request = (s.inventoryReviews || []).find(item => item.id === Number(data.request));
  if (!request || request.status !== '待审核') throw new BusinessRejection('这笔库存盘点已经处理');
  let selfReview;
  if (context) {
    // Read only the applicant recorded in the locked ledger state, never payload identity.
    const applicant = request.submittedByPrincipalId;
    if (typeof applicant !== 'string' || !applicant || applicant.trim() !== applicant || applicant.length > 191) {
      throw new AuthorizationDenied('untrusted-inventory-applicant');
    }
    selfReview = applicant === context.principalId;
    if (selfReview) requireTrustedPermission(context, 'review.self');
    person = context.actorSnapshot?.displayName ?? null;
    time = context.dbNow;
  } else selfReview = authorizeReviewer(request.submittedById);
  const reviewerIdentity = context ? { submittedByPrincipalId: request.submittedByPrincipalId,
    reviewedByPrincipalId: context.principalId } : {};
  const decisionNote = String(data.decisionNote || '').trim().slice(0, 300);
  if (action === 'rejectInventory' && !decisionNote) throw new BusinessRejection('请填写驳回原因');
  if (action === 'approveInventory') {
    if (request.kind === 'consumable') {
      const item = s.consumables?.[request.product];
      if (!item || item.count !== request.before || (item.opened || 0) !== request.openedBefore) throw new BusinessRejection('消耗品库存已经变化，请驳回后重新盘点');
      s.ledger.push({ id: ++s.serial, kind: 'consumable', product: request.product, delta: request.after-(request.before ?? 0), before: request.before, after: request.after, openedBefore: request.openedBefore, openedAfter: request.openedAfter, reason: request.reason, source: request.source, counted: true, person: request.submittedBy, reviewedBy: person, time, ...reviewerIdentity });
      item.count = request.after; item.opened = request.openedAfter; if (request.before === null) item.openedAt = time;
    } else {
      const item = s.inventory[request.product];
      if (!item || item.count !== request.before) throw new BusinessRejection('商品库存已经变化，请驳回后重新盘点');
      s.ledger.push({ id: ++s.serial, product: request.product, delta: request.after-(request.before ?? 0), before: request.before, after: request.after, reason: request.reason, source: request.source, counted: true, person: request.submittedBy, reviewedBy: person, time, ...reviewerIdentity });
      item.count = request.after; if (request.before === null) item.openedAt = time;
    }
    const notice = { id: ++s.serial, kind: request.kind, product: request.product, unit: request.kind === 'consumable' ? (s.consumables?.[request.product]?.unit || '份') : (s.inventory[request.product]?.unit || product(request.product, s.catalog).baseUnit), before: request.before, after: request.after, openedBefore: request.openedBefore, openedAfter: request.openedAfter, reason: request.reason, person: request.submittedBy, reviewedBy: person, time, ...reviewerIdentity };
    // JSON persistence omits absent fields; do not invent opened quantities for drinks.
    if (context) for (const field of ['openedBefore', 'openedAfter']) if (notice[field] === undefined) delete notice[field];
    s.notices.push(notice);
  }
  request.status = action === 'approveInventory' ? '已批准' : '已驳回'; request.decidedBy = person; request.decidedAt = time; request.decisionNote = decisionNote; request.selfReviewAuthorized = selfReview;
  if (context) request.decidedByPrincipalId = context.principalId;
}
