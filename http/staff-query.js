import { assertTrustedExecutionContext } from '../shared/identity.js';

const readRooms = ['room.open', 'room.reserve', 'room.clean', 'room.issue',
  'room.issue.approve', 'order.sale', 'order.exchange', 'order.gift',
  'order.serveExtra', 'payment.collect', 'payment.settle', 'credit.apply',
  'credit.approve', 'credit.repay', 'credit.repay.approve', 'gift.approve',
  'rounding.approve', 'report.view', 'handover'];
const readOrders = ['order.sale', 'order.exchange', 'order.gift', 'order.serveExtra',
  'payment.collect', 'payment.settle', 'credit.apply', 'credit.approve',
  'credit.repay', 'credit.repay.approve', 'gift.approve', 'rounding.approve',
  'report.view', 'handover', 'room.open', 'retail.sale'];
const readAllOrders = readOrders.slice(0, -2);
const readCatalog = ['room.open', 'order.sale', 'order.exchange', 'order.gift',
  'retail.sale', 'deposit.manage', 'inventory.opening', 'inventory.adjust',
  'inventory.approve', 'catalog.manage', 'report.view'];
const readStock = ['room.open', 'order.sale', 'retail.sale', 'order.exchange',
  'inventory.opening', 'inventory.adjust', 'inventory.approve', 'catalog.manage'];
const any = (grants, values) => values.some(value => grants.has(value));
const pick = (source, fields) => Object.fromEntries(fields
  .filter(field => source?.[field] !== undefined)
  .map(field => [field, source[field]]));
const rows = (value, project) => (Array.isArray(value) ? value : []).map(project);
const own = (record, principalId) => record?.submittedByPrincipalId === principalId;

const drink = value => pick(value, ['id', 'product', 'productId', 'productNameSnapshot',
  'categorySnapshot', 'categoryLabelSnapshot', 'baseUnitSnapshot',
  'baseQuantity', 'count', 'totalBaseQuantity']);
const sale = value => ({
  ...pick(value, ['id', 'product', 'productId', 'productNameSnapshot',
    'categorySnapshot', 'categoryLabelSnapshot', 'saleOptionId',
    'saleOptionNameSnapshot', 'spec', 'count', 'saleQuantity', 'bottles',
    'amount', 'amountCents', 'person', 'recordedBy', 'employeeId', 'time']),
  drinks: rows(value.drinks, drink)
});
const giftRequest = value => pick(value, ['id', 'product', 'productId',
  'productNameSnapshot', 'halves', 'bottles', 'status', 'requestedBy',
  'requestedById', 'submittedByPrincipalId', 'requestedAt', 'decidedBy',
  'decidedByPrincipalId', 'decidedAt', 'decisionNote', 'selfReviewAuthorized']);
const review = value => value ? pick(value, ['id', 'status', 'amount', 'note',
  'submittedBy', 'submittedById', 'submittedByPrincipalId', 'submittedAt',
  'decidedBy', 'decidedByPrincipalId', 'decidedAt', 'decisionNote',
  'selfReviewAuthorized', 'exceptionalSelfApprovalRequired',
    'result']) : null;
const repaymentRequest = value => pick(value, ['id', 'amount', 'method',
  'status', 'submittedBy', 'submittedById', 'submittedByPrincipalId',
  'submittedAt', 'decidedBy', 'decidedByPrincipalId', 'decidedAt',
  'decisionNote', 'selfReviewAuthorized']);
const payment = value => pick(value, ['paymentId', 'amount', 'method',
  'chargeId', 'occurredAt', 'source', 'kind', 'time', 'repaymentRequestId']);
const credit = (value, context, grants) => {
  if (!value) return null;
  const creditReviewer = grants.has('credit.approve') &&
    (context.policyAttributeIds ?? []).some(id =>
      ['credit.approval.manager', 'credit.approval.boss'].includes(id));
  const allowedDetail = own(value, context.principalId) ||
    creditReviewer || any(grants, ['credit.repay', 'credit.repay.approve']);
  const projected = {
    ...pick(value, ['id', 'amount', 'remaining', 'person', 'openedBy',
      'openSource', 'reservedBy', 'reservationSource', 'submittedBy',
      'submittedById', 'submittedByPrincipalId', 'submittedAt', 'due',
      'approver', 'decisionBy', 'decidedByPrincipalId', 'decisionAt',
      'decisionStatus', 'selfReviewAuthorized']),
    repayments: rows(value.repayments, payment),
    repaymentRequests: rows(value.repaymentRequests, repaymentRequest)
  };
  if (allowedDetail) Object.assign(projected, pick(value, ['phone', 'name', 'note']));
  if (creditReviewer) Object.assign(projected, pick(value, ['signature']));
  return projected;
};
const order = (value, context, grants) => ({
  ...pick(value, ['id', 'kind', 'room', 'time', 'createdAt', 'businessDate',
    'businessDayRuleVersion', 'person', 'recordedBy', 'employeeId', 'openedBy',
    'openSource', 'reservedBy', 'reservationSource', 'status', 'packageId',
    'packageNameSnapshot', 'packagePriceCents', 'packageBaseCents',
    'packageGiftValueCents', 'base', 'gift', 'period', 'rounding',
    'roundingType', 'roundingNote']),
  voucher: value.voucher ? pick(value.voucher, ['provider', 'covered', 'status']) : null,
  drinks: rows(value.drinks, drink),
  extras: rows(value.extras, item => pick(item, ['product', 'productId',
    'productNameSnapshot', 'count', 'served'])),
  sales: rows(value.sales, sale),
  otherCharges: rows(value.otherCharges, item => pick(item, ['id', 'category',
    'item', 'amount', 'amountCents', 'person', 'time'])),
  bonusGifts: rows(value.bonusGifts, item => ({
    ...pick(item, ['id', 'product', 'productId', 'productNameSnapshot',
      'bottles', 'halves', 'person', 'time']),
    drinks: rows(item.drinks, drink)
  })),
  giftRequests: rows(value.giftRequests, giftRequest),
  payments: rows(value.payments, payment),
  roundingReview: review(value.roundingReview),
  credit: credit(value.credit, context, grants),
  creditHistory: rows(value.creditHistory, item => pick(item, [
    'decisionBy', 'decidedByPrincipalId', 'decisionAt', 'decisionStatus',
    'selfReviewAuthorized'
  ])),
  exchanges: rows(value.exchanges, item => pick(item, ['id', 'line', 'product',
    'count', 'time']))
});

function catalog(value) {
  return {
    schemaVersion: value?.schemaVersion,
    products: rows(value?.products, item => ({
      ...pick(item, ['id', 'name', 'category', 'categoryLabel', 'baseUnit',
        'inventoryManaged', 'inventoryThreshold', 'sellable',
        'manualPriceAllowed', 'exchangeLevel', 'openingGiftEligible',
        'selectionOnly', 'active', 'sortOrder']),
      saleOptions: rows(item.saleOptions, option => pick(option,
        ['id', 'name', 'baseQuantity', 'priceCents']))
    })),
    packages: rows(value?.packages, item => ({
      ...pick(item, ['id', 'name', 'kind', 'roomType', 'period',
        'priceCents', 'basePriceCents', 'includedValueCents',
        'giftSaleQuantity', 'active', 'sortOrder']),
      components: rows(item.components, component => ({
        ...pick(component, ['id', 'kind', 'name', 'productId', 'baseQuantity',
          'baseUnit', 'mixedSelectionProductId']),
        allowedProductIds: component.allowedProductIds ?
          [...component.allowedProductIds] : undefined,
        mixedAllowedProductIds: component.mixedAllowedProductIds ?
          [...component.mixedAllowedProductIds] : undefined,
        baseQuantityByProduct: component.baseQuantityByProduct ?
          { ...component.baseQuantityByProduct } : undefined
      })),
      openingGift: item.openingGift ? {
        ...pick(item.openingGift, ['mixedSelectionProductId']),
        allowedProductIds: [...(item.openingGift.allowedProductIds ?? [])],
        mixedAllowedProductIds: [...(item.openingGift.mixedAllowedProductIds ?? [])],
        baseQuantityByProduct: { ...(item.openingGift.baseQuantityByProduct ?? {}) }
      } : null
    }))
  };
}

function stock(value) {
  return Object.fromEntries(Object.entries(value ?? {}).map(([id, item]) =>
    [id, pick(item, ['count', 'opened', 'unit', 'threshold'])]));
}

export function projectEmployeeWorkspace(state, context, {
  employees = [], serverNow = new Date().toISOString()
} = {}) {
  assertTrustedExecutionContext(context);
  const grants = new Set(context.permissionIds);
  const canApproveExpense = grants.has('expense.approve') &&
    (context.policyAttributeIds ?? []).includes('expense.approval.boss');
  const sections = {
    rooms: any(grants, readRooms),
    orders: any(grants, readOrders),
    catalog: any(grants, readCatalog),
    stock: any(grants, readStock),
    reservations: any(grants, ['room.open', 'room.reserve', 'report.view']),
    deposits: grants.has('deposit.manage'),
    expenses: any(grants, ['expense.view', 'expense.viewAll',
      'expense.create']) || canApproveExpense,
    procurements: any(grants, ['procurement.create', 'procurement.viewAll']),
    incidents: any(grants, ['incident.create', 'incident.resolve',
      'incident.resolve.approve', 'incident.viewAll']),
    roomIssueReviews: any(grants, ['room.issue', 'room.issue.approve']),
    inventoryReviews: any(grants, ['inventory.opening', 'inventory.adjust',
      'inventory.approve']),
    handovers: any(grants, ['handover', 'report.view'])
  };
  if (!Object.values(sections).some(Boolean)) return null;
  const workspace = { serverNow, sections };
  const actorEmployee = employees.find(item => item.principalId === context.principalId &&
    item.enabled !== false);
  if (actorEmployee) workspace.actorEmployee = pick(actorEmployee,
    ['employeeId', 'displayName']);
  if (any(grants, ['staff.record', 'incident.create'])) {
    workspace.employees = employees.filter(item => item.enabled !== false)
      .map(item => pick(item, ['employeeId', 'displayName']));
  }
  if (sections.rooms) workspace.rooms = rows(state.rooms, item => ({
    ...pick(item, ['id', 'type', 'status', 'issueType', 'issueNote',
      'issueAt', 'issueBy', 'issueApprovedBy']),
    order: sections.orders && state.orders.some(order =>
      order.id === item.order &&
      (any(grants, readAllOrders) ||
        grants.has('room.open') &&
          order.actualActorPrincipalId === context.principalId))
      ? item.order : null,
    ...(any(grants, ['room.issue', 'room.issue.approve']) ?
      pick(item, ['issueEvidencePhoto', 'issueEvidencePhotoName']) : {})
  }));
  if (sections.orders) workspace.orders = rows(state.orders.filter(item =>
    any(grants, readAllOrders) ||
    grants.has('retail.sale') && item.kind === 'retail' &&
      item.actualActorPrincipalId === context.principalId ||
    grants.has('room.open') &&
      item.actualActorPrincipalId === context.principalId),
    item => order(item, context, grants));
  if (sections.catalog) workspace.catalog = catalog(state.catalog);
  if (sections.stock) {
    workspace.inventory = stock(state.inventory);
    workspace.consumables = stock(state.consumables);
  }
  if (sections.reservations) workspace.reservations = rows(state.reservations,
    item => pick(item, ['id', 'room', 'at', 'session', 'sessionLabel', 'source',
      'person', 'recordedBy', 'employeeId', 'status', 'note', 'time']));
  if (sections.deposits) {
    workspace.deposits = rows(state.deposits, item => pick(item,
      ['id', 'group', 'name', 'phone', 'room', 'product', 'productId',
        'productNameSnapshot', 'baseUnitSnapshot', 'count', 'initial',
        'time', 'person']));
    workspace.withdrawals = rows(state.withdrawals, item => pick(item,
      ['id', 'deposit', 'count', 'time', 'person']));
  }
  if (sections.expenses) workspace.expenses = rows(state.expenses, item =>
    (grants.has('expense.viewAll') || canApproveExpense ||
      own(item, context.principalId)) ? pick(item,
        ['id', 'date', 'type', 'amount', 'method', 'nature', 'description',
          'proof', 'proofName', 'status', 'approver', 'approvedAt', 'person',
          'time', 'source', 'submittedByPrincipalId', 'decidedByPrincipalId',
          'selfReviewAuthorized']) : null).filter(Boolean);
  if (sections.procurements) workspace.procurements = rows(state.procurements,
    item => (grants.has('procurement.viewAll') || own(item, context.principalId)) ?
      pick(item, ['id', 'date', 'item', 'quantity', 'unit', 'amount',
        'method', 'type', 'nature', 'description', 'expenseId', 'status',
        'person', 'time', 'submittedByPrincipalId']) : null).filter(Boolean);
  if (sections.incidents) workspace.incidents = rows(state.incidents, item => {
    if (!grants.has('incident.viewAll') && !own(item, context.principalId) &&
        item.assigneeEmployeeId !== actorEmployee?.employeeId) return null;
    return {
      ...pick(item, ['id', 'room', 'date', 'type', 'description', 'assignee',
        'assigneeEmployeeId', 'status', 'person', 'time',
        'submittedByPrincipalId', 'result']),
      resolutionReviews: rows(item.resolutionReviews, review)
    };
  }).filter(Boolean);
  if (sections.roomIssueReviews) workspace.roomIssueReviews = rows(
    state.roomIssueReviews, item =>
      (grants.has('room.issue.approve') || own(item, context.principalId)) ?
        pick(item, ['id', 'room', 'change', 'status', 'fromStatus',
          'requestedStatus', 'issueType', 'issueNote', 'evidencePhoto',
          'evidencePhotoName', 'submittedBy', 'submittedById',
          'submittedByPrincipalId', 'submittedAt', 'decidedBy',
          'decidedByPrincipalId', 'decidedAt', 'decisionNote',
          'selfReviewAuthorized']) : null).filter(Boolean);
  if (sections.inventoryReviews) workspace.inventoryReviews = rows(
    state.inventoryReviews, item =>
      (grants.has('inventory.approve') || own(item, context.principalId)) ?
        pick(item, ['id', 'product', 'kind', 'source', 'before', 'after',
          'openedBefore', 'openedAfter', 'reason', 'status', 'submittedBy',
          'submittedById', 'submittedByPrincipalId', 'submittedAt',
          'decidedBy', 'decidedByPrincipalId', 'decidedAt', 'decisionNote',
          'selfReviewAuthorized']) : null).filter(Boolean);
  if (sections.handovers) workspace.handovers = rows(state.handovers,
    item => pick(item, ['id', 'time', 'person', 'actual', 'drawerCash',
      'expected', 'difference']));
  return workspace;
}
