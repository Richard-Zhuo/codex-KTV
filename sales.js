// 销售领域：房间增购与独立零售共用成交管道、收款、结账（抹零）、挂账与回款。
// Phase 4 自 rules.js 迁出：prepareSaleRows／appendSaleRows／validatePayments／
// validateSettlementPayments 基础函数，sale／retailSale／collect／settle+pay／
// approveRounding+rejectRounding／credit／approve+reject／repay／
// approveRepayment+rejectRepayment 命令，以及 total／outstanding／
// collectableCharges／nextCollectCharge 金额查询。
// 函数体逐字节保留：room/retail、无房零售、多笔付款、成交快照、销售人员、
// 收款/抹零口径不变；失败不提交由 transact 的克隆-校验-提交边界继续保证。
// 权限闸门与自审授权经参数注入（need／authorizeReviewer），避免对 rules.js 的循环依赖。
import { DEFAULT_CATALOG, product, saleOption, saleOptions, productIdOf, categoryLabel } from './catalog.js';
import { recordInventoryChange, need } from './inventory.js';
import { USERS, effectiveUser } from './shared/identity.js';

export const PAYMENT_METHODS = ['微信', '支付宝', '现金', '美团', '抖音'];

function productSnapshot(catalog, id, baseQuantity, extra = {}) {
  const p = product(id, catalog);
  return { productId: p.id, productNameSnapshot: p.name, categorySnapshot: p.category, categoryLabelSnapshot: categoryLabel(p), baseUnitSnapshot: p.baseUnit, baseQuantity, ...extra };
}
function quantity(n) { if (!Number.isSafeInteger(n) || n <= 0) throw Error('数量必须是大于零的整数'); }

export const total = order => (order.packageBaseCents ?? order.base ?? 0) + (order.packageGiftValueCents ?? order.gift ?? 0) + (order.sales || []).reduce((sum, line) => sum + (line.amountCents ?? line.amount ?? 0), 0) + (order.otherCharges || []).reduce((sum, line) => sum + (line.amountCents ?? line.amount ?? 0), 0);
export const outstanding = order => Math.max(0, total(order) - (order.payments || []).reduce((sum, payment) => sum + payment.amount, 0));
// collected（实收汇总）自 rules.js 迁入（Phase 5）：payments 口径的跨订单汇总选择器，供交班与报表使用。
export const collected = state => state.orders.reduce((sum, o) => sum + (o.payments || []).reduce((n,p) => n+p.amount, 0), 0);
export function collectableCharges(order, catalog = DEFAULT_CATALOG) {
  const paidFor = chargeId => (order.payments || []).filter(payment => payment.chargeId === chargeId).reduce((sum, payment) => sum + payment.amount, 0);
  const opening = { id: 'open', kind: 'open', label: '开房费用（含套餐赠饮）', amount: (order.packageBaseCents ?? order.base ?? 0) + (order.packageGiftValueCents ?? order.gift ?? 0) };
  const groups = new Map();
  for (const line of (order.sales || [])) {
    const batch = line.batch ?? line.id;
    const id = `sale:${batch}`;
    const productId = productIdOf(line);
    const saleQuantity = line.saleQuantity ?? line.count ?? 0;
    const optionName = line.saleOptionNameSnapshot || (line.spec === 'dozen' ? '整打' : line.spec === 'half' ? '半打' : '单支');
    // Bug #4 修复：无名称快照的历史行显示「历史商品（id）」，不回退当前目录；
    // catalog 参数仅为兼容保留，不再用于回退查询（商品移除也不会抛错）。
    const productLabel = line.productNameSnapshot || `历史商品（${productId}）`;
    const label = `${productLabel} ${saleQuantity}${optionName}`;
    const amount = line.amountCents ?? line.amount ?? 0;
    const current = groups.get(id);
    if (current) { current.amount += amount; current.labels.push(label); }
    else groups.set(id, { id, batch, kind: 'sale', labels: [label], amount });
  }
  for (const line of (order.otherCharges || [])) {
    const batch = line.batch ?? line.id;
    const id = `other:${batch}`;
    const label = line.category === '其他' ? line.item : line.category;
    const current = groups.get(id);
    const amount = line.amountCents ?? line.amount ?? 0;
    if (current) { current.amount += amount; current.labels.push(label); }
    else groups.set(id, { id, batch, kind: 'other', labels: [label], amount });
  }
  const additions = [...groups.values()].sort((a, b) => Number(a.batch) - Number(b.batch)).map(group => ({ id: group.id, kind: group.kind, label: `${group.kind === 'sale' ? '上一笔增购' : '上一笔其他消费'} · ${group.labels.join('、')}`, amount: group.amount }));
  return [opening, ...additions].map(charge => ({ ...charge, remaining: charge.amount - paidFor(charge.id) })).filter(charge => charge.remaining > 0);
}
export function nextCollectCharge(order, catalog = DEFAULT_CATALOG) {
  const charges = collectableCharges(order, catalog), additions = charges.filter(charge => charge.kind !== 'open');
  return additions.at(-1) || charges.find(charge => charge.kind === 'open') || null;
}
function phone(value) { if (!/^1\d{10}$/.test(value || '')) throw Error('请填写11位手机号'); }
function delegatedEmployee(state, data) {
  const id = String(data.employee || '').trim();
  if (!id) return null;
  need(state, [], 'staff.record');
  const employee = USERS[id];
  if (!employee || employee.legacy || id === 'administrator') throw Error('请选择有效的演示员工');
  return { id, name: employee.name, recordedBy: effectiveUser(state).name };
}
function prepareSaleRows(state, data) {
  const items = Array.isArray(data.items) ? data.items : [{ product: data.product, spec: data.spec, count: data.count }];
  if (!items.length) throw Error('请至少添加一种商品');
  const required = new Map();
  const rows = items.map(item => {
    const saleQuantity = item.saleQuantity ?? item.count;
    quantity(saleQuantity);
    const p = product(item.productId || item.product, state.catalog);
    if (!p.sellable || p.active === false) throw Error('该商品当前不可销售');
    const option = saleOption(p, item.saleOptionId || item.spec || 'single');
    const pricePerSaleUnitCents = item.manualPriceCents !== undefined && p.manualPriceAllowed ? item.manualPriceCents : option.priceCents;
    const totalBaseQuantity = saleQuantity * option.baseQuantity, amountCents = saleQuantity * pricePerSaleUnitCents;
    if (!Number.isSafeInteger(pricePerSaleUnitCents) || pricePerSaleUnitCents <= 0 || !Number.isSafeInteger(amountCents) || amountCents <= 0) throw Error('销售价格无效');
    if (!Number.isSafeInteger(totalBaseQuantity) || totalBaseQuantity <= 0) throw Error('销售基础数量无效');
    if (p.inventoryManaged) required.set(p.id, (required.get(p.id) || 0) + totalBaseQuantity);
    return { p, option, saleQuantity, totalBaseQuantity, pricePerSaleUnitCents, amountCents };
  });
  for (const [id, count] of required) {
    if (!Number.isSafeInteger(count)) throw Error('销售基础数量无效');
    const balance = state.inventory[id];
    if (!balance || balance.count === null || !Number.isSafeInteger(balance.count)) throw Error(`${product(id, state.catalog).name}未建账，完成库存期初建账后才能销售`);
    if (balance.count < count) throw Error(`${product(id, state.catalog).name}库存不足，请减少数量或先核对库存`);
  }
  return rows;
}
function appendSaleRows(state, order, rows, person, operator, employeeId, time, source) {
  const batch = ++state.serial;
  for (const row of rows) {
    const saleId = ++state.serial;
    recordInventoryChange(state, row.p.id, -row.totalBaseQuantity, source, time, { orderId: order.id, saleLineId: saleId });
    const snapshot = productSnapshot(state.catalog, row.p.id, row.totalBaseQuantity, { saleOptionId: row.option.id, saleOptionNameSnapshot: row.option.name, saleQuantity: row.saleQuantity, baseQuantityPerSaleUnit: row.option.baseQuantity, totalBaseQuantity: row.totalBaseQuantity, pricePerSaleUnitCents: row.pricePerSaleUnitCents, amountCents: row.amountCents, snapshotStatus: 'current' });
    order.sales.push({ id: saleId, batch, product: row.p.id, productId: row.p.id, count: row.saleQuantity, spec: row.option.id, bottles: row.totalBaseQuantity, amount: row.amountCents, ...snapshot, drinks: [{ id: ++state.serial, product: row.p.id, productId: row.p.id, productNameSnapshot: row.p.name, baseUnitSnapshot: row.p.baseUnit, count: row.totalBaseQuantity, totalBaseQuantity: row.totalBaseQuantity }], person, recordedBy: operator, employeeId, time });
  }
}
function validatePayments(payments, amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw Error('待收金额无效');
  if (amount === 0) { if (Array.isArray(payments) && payments.length) throw Error('本次无需再收款'); return []; }
  if (!Array.isArray(payments) || !payments.length || payments.some(payment => !PAYMENT_METHODS.includes(payment.method) || !Number.isSafeInteger(payment.amount) || payment.amount <= 0)) throw Error('请填写有效的收款方式和金额');
  if (payments.reduce((sum, payment) => sum + payment.amount, 0) !== amount) throw Error('各项收款之和必须等于本次待收金额');
  return payments;
}
function validateSettlementPayments(payments, amount, differenceType = '免零', differenceNote = '') {
  if (!Number.isSafeInteger(amount) || amount < 0) throw Error('待收金额无效');
  if (amount === 0) return { payments: [], rounding: 0, differenceType: '', differenceNote: '', needsReview: false };
  if (!Array.isArray(payments) || !payments.length || payments.some(payment => !PAYMENT_METHODS.includes(payment.method) || !Number.isSafeInteger(payment.amount) || payment.amount <= 0)) throw Error('请填写有效的收款方式和金额');
  const received = payments.reduce((sum, payment) => sum + payment.amount, 0);
  if (received > amount) throw Error('各项收款之和不能超过本次待收金额');
  const rounding = amount - received;
  if (!rounding) return { payments, rounding: 0, differenceType: '', differenceNote: '', needsReview: false };
  const type = String(differenceType || '免零').trim();
  if (!['免零', '特殊情况'].includes(type)) throw Error('请选择有效的差额处理方式');
  const note = String(differenceNote || '').trim().slice(0, 200);
  if (type === '特殊情况' && !note) throw Error('请填写特殊情况说明，提交后由店长审核');
  return { payments, rounding, differenceType: type, differenceNote: type === '特殊情况' ? note : '', needsReview: type === '特殊情况' };
}

// —— 命令层：由 rules.js 的 transact 分支委托调用，参数与原分支一致 ——

export function submitSale(s, order, data, person, operator, time) {
  const delegated = delegatedEmployee(s, data);
  if (delegated) person = delegated.name; else need(s, ['开单员','服务员','老板'], 'order.sale');
  appendSaleRows(s, order, prepareSaleRows(s, data), person, operator, delegated?.id || s.user, time, '加购销售');
}
export function submitRetailSale(s, data, person, operator, time) {
  need(s, [], 'retail.sale');
  const delegated = delegatedEmployee(s, data);
  if (delegated) person = delegated.name;
  const rows = prepareSaleRows(s, data);
  const amount = rows.reduce((sum, row) => sum + row.amountCents, 0);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw Error('成交金额无效');
  const payments = validatePayments(data.payments, amount);
  const id = `D${++s.serial}`;
  const retailOrder = { id, kind: 'retail', room: null, time, createdAt: time, paidAt: time, closedAt: time, person, recordedBy: operator, employeeId: delegated?.id || s.user, status: '已结账', packageId: null, packageNameSnapshot: null, packagePriceCents: 0, packageBaseCents: 0, packageGiftValueCents: 0, base: 0, gift: 0, drinks: [], resolvedComponents: [], extras: [], sales: [], otherCharges: [], bonusGifts: [], giftRequests: [], payments: [], rounding: 0, roundingType: '', roundingNote: '', roundingReview: null, credit: null, exchanges: [] };
  s.orders.push(retailOrder);
  appendSaleRows(s, retailOrder, rows, person, operator, delegated?.id || s.user, time, '零售销售');
  retailOrder.payments.push(...payments.map(payment => ({ ...payment, chargeId: 'retail', time, person: operator })));
}
export function collectPayment(s, order, data, person, time) {
  need(s, ['收银员','老板'], 'payment.collect');
  const charge = nextCollectCharge(order, s.catalog);
  if (!charge) throw Error('本单没有待收费用');
  if (data.charge !== charge.id) throw Error('账单已变化，请重新打开收钱页面');
  const payments = validatePayments(data.payments, charge.remaining);
  order.payments.push(...payments.map(payment => ({ ...payment, chargeId: charge.id, time, person })));
}
export function settleOrder(s, order, data, person, time) {
  need(s, ['收银员','老板'], 'payment.settle');
  if ((order.giftRequests || []).some(item => item.status === '待确认')) throw Error('还有待确认的赠酒水申请，请先处理');
  const due = outstanding(order), settlement = validateSettlementPayments(data.payments, due, data.differenceType, data.differenceNote);
  order.payments.push(...settlement.payments.map(payment => ({ ...payment, chargeId: 'settlement', time, person })));
  order.rounding = settlement.rounding;
  order.roundingType = settlement.differenceType;
  order.roundingNote = settlement.differenceNote;
  order.roundingReview = settlement.needsReview ? { status: '待审核', amount: settlement.rounding, note: settlement.differenceNote, submittedBy: person, submittedById: s.user, submittedAt: time, approver: '店长', decidedBy: '', decidedAt: '', decisionNote: '' } : null;
  order.status = '已结账'; order.closedAt = time;
  return { release: true };
}
export function payOrder(s, order, data, person, time) {
  need(s, ['收银员','老板'], 'payment.settle');
  if ((order.giftRequests || []).some(item => item.status === '待确认')) throw Error('还有待确认的赠酒水申请，请先处理');
  const due = outstanding(order), settlement = { payments: validatePayments(data.payments, due), rounding: 0, differenceType: '', differenceNote: '', needsReview: false };
  order.payments.push(...settlement.payments.map(payment => ({ ...payment, chargeId: 'settlement', time, person })));
  order.rounding = settlement.rounding;
  order.roundingType = settlement.differenceType;
  order.roundingNote = settlement.differenceNote;
  order.roundingReview = settlement.needsReview ? { status: '待审核', amount: settlement.rounding, note: settlement.differenceNote, submittedBy: person, submittedById: s.user, submittedAt: time, approver: '店长', decidedBy: '', decidedAt: '', decisionNote: '' } : null;
  order.status = '已结账'; order.closedAt = time;
  return { release: true };
}

export function decideRounding(s, order, action, data, person, time, authorizeReviewer) {
  need(s, ['店长'], 'rounding.approve');
  if (!order?.roundingReview || order.roundingReview.status !== '待审核') throw Error('特殊差额审核状态已变化');
  const selfReview = authorizeReviewer(order.roundingReview.submittedById);
  const decisionNote = String(data.decisionNote || '').trim().slice(0, 300);
  if (action === 'rejectRounding' && !decisionNote) throw Error('请填写驳回原因');
  order.roundingReview.status = action === 'approveRounding' ? '已批准' : '已驳回'; order.roundingReview.decidedBy = person; order.roundingReview.decidedAt = time; order.roundingReview.decisionNote = decisionNote; order.roundingReview.selfReviewAuthorized = selfReview;
}
export function applyCredit(s, order, data, person, time) {
  need(s, ['开单员','收银员','服务员','库管','店长','老板'], 'credit.apply');
  if ((order.giftRequests || []).some(item => item.status === '待确认')) throw Error('还有待确认的赠酒水申请，请先处理');
  const phoneValue = String(data.phone || '').trim(), name = String(data.name || '').trim().slice(0,30);
  if (!phoneValue && !name) throw Error('手机号和顾客姓名至少填写一个');
  if (phoneValue) phone(phoneValue);
  const note = String(data.note || '').trim().slice(0,200); if (!note) throw Error('请填写挂账备注');
  if (typeof data.signature !== 'string' || !data.signature.startsWith('data:image/png;base64,') || data.signature.length < 100) throw Error('请由经办员工本人手写签字');
  const amount = outstanding(order); if (!amount) throw Error('本单已经收清，无需挂账');
  order.credit = { id: ++s.serial, amount, remaining: amount, phone: phoneValue, name, note, person, submittedById: s.user, openedBy: order.openedBy || order.person || '未记录', openSource: order.openSource || '线下', reservedBy: order.reservedBy || '', reservationSource: order.reservationSource || '', signature: data.signature, submittedAt: time, due: new Date(Date.parse(time)+86400000).toISOString(), approver: amount>100000 ? '老板' : '店长', repayments: [], repaymentRequests: [] };
  order.status = '待审批挂账';
  return { release: true };
}
export function decideCredit(s, order, action, person, time, authorizeReviewer) {
  if (!order || order.status !== '待审批挂账') throw Error('审批已处理'); need(s, [order.credit.approver], 'credit.approve');
  // Bug #1 修复：指定审批人是硬性岗位限制，need 的管理员岗位穿透不再适用于此分支。
  // 层级语义：店长级挂账可由店长或老板批准，老板级挂账只能由老板批准；
  // 无对应营业岗位的身份（如仅持 credit.approve 具体权限的管理员）不能跨级批准。
  const roles = effectiveUser(s).roles || [];
  const allowedRoles = order.credit.approver === '店长' ? ['店长', '老板'] : [order.credit.approver];
  if (!roles.some(role => allowedRoles.includes(role))) throw Error(`这笔挂账需要${order.credit.approver}岗位审批`);
  const selfReview = authorizeReviewer(order.credit.submittedById);
  order.credit.decisionAt = time;
  order.credit.decisionBy = person;
  order.credit.selfReviewAuthorized = selfReview;
  order.credit.decisionStatus = action === 'approve' ? '已批准' : '已驳回';
  order.status = action === 'approve' ? '已挂账' : '营业中';
  // 驳回保留原申请和决定；原房间可能已有新客，不重新占房。
  if (action === 'reject') {
    order.creditHistory ??= [];
    order.creditHistory.push(structuredClone(order.credit));
    order.credit = null;
  }
  return { release: false };
}
export function submitRepay(s, order, data, person, time) {
  need(s, ['收银员','财务','老板'], 'credit.repay');
  if (!order || order.status !== '已挂账') throw Error('请选择已审批的挂账');
  order.credit.repaymentRequests ??= [];
  const pendingAmount = order.credit.repaymentRequests.filter(request => request.status === '待审核').reduce((sum, request) => sum + request.amount, 0);
  if (!Number.isSafeInteger(data.amount) || data.amount <= 0 || data.amount > order.credit.remaining - pendingAmount) throw Error('回款金额应大于零且不超过扣除待审核回款后的欠款');
  if (!PAYMENT_METHODS.includes(data.method)) throw Error('请选择收款方式');
  order.credit.repaymentRequests.push({ id: ++s.serial, amount: data.amount, method: data.method, status: '待审核', submittedBy: person, submittedById: s.user, submittedAt: time, decidedBy: '', decidedAt: '', decisionNote: '' });
}
export function decideRepayment(s, order, action, data, person, time, authorizeReviewer) {
  need(s, [], 'credit.repay.approve');
  if (!order?.credit) throw Error('挂账记录不存在');
  const request = (order.credit.repaymentRequests || []).find(item => item.id === Number(data.request));
  if (!request || request.status !== '待审核') throw Error('这笔回款申请已经处理');
  const selfReview = authorizeReviewer(request.submittedById);
  const decisionNote = String(data.decisionNote || '').trim().slice(0, 300);
  if (action === 'rejectRepayment' && !decisionNote) throw Error('请填写驳回原因');
  if (action === 'approveRepayment') {
    if (order.status !== '已挂账' || request.amount > order.credit.remaining) throw Error('挂账余额已经变化，请驳回后重新登记');
    const payment = { amount: request.amount, method: request.method, chargeId: 'credit-repayment', time, person: request.submittedBy, approvedBy: person, repaymentRequestId: request.id };
    order.credit.repayments.push(payment); order.payments.push(payment); order.credit.remaining -= request.amount;
    if (!order.credit.remaining) order.status = '已回款';
  }
  request.status = action === 'approveRepayment' ? '已批准' : '已驳回'; request.decidedBy = person; request.decidedAt = time; request.decisionNote = decisionNote; request.selfReviewAuthorized = selfReview;
}
