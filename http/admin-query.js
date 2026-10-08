import { AuthorizationDenied, PERMISSION_IDS, assertTrustedExecutionContext } from '../shared/identity.js';
import { POLICY_ATTRIBUTE_IDS, authorizeReviewCommand, createTrustedPrincipal, createTrustedReviewFacts } from '../ledger/command-policy.js';

const rows = value => Array.isArray(value) ? value : [];
const pick = (value, fields) => Object.fromEntries(fields
  .filter(field => value?.[field] !== undefined)
  .map(field => [field, value[field]]));

export function projectAdminSnapshot(head, context) {
  assertTrustedExecutionContext(context);
  const grants = new Set(context.permissionIds);
  if (!grants.has('backend.view')) throw new AuthorizationDenied('missing-backend-view');
  if (!head || !Number.isSafeInteger(head.revision) || head.revision < 0 ||
      !head.state || !Array.isArray(head.state.rooms) ||
      !Array.isArray(head.state.orders)) {
    throw new Error('Invalid server ledger snapshot');
  }

  const attributes = new Set(context.policyAttributeIds ?? []);
  const principal = createTrustedPrincipal({ id: context.principalId,
    permissionIds: context.permissionIds.filter(id => PERMISSION_IDS.includes(id)),
    policyAttributeIds: (context.policyAttributeIds ?? []).filter(id =>
      POLICY_ATTRIBUTE_IDS.includes(id)) });
  const actionByType = { roomRecovery: 'approveRoomIssue', inventory: 'approveInventory',
    gift: 'approveGift', rounding: 'approveRounding', credit: 'approve',
    repayment: 'approveRepayment', incidentResolution: 'approveIncidentResolution',
    expense: 'approveExpense' };
  const rejectActionByType = { roomRecovery: 'rejectRoomIssue', inventory: 'rejectInventory',
    gift: 'rejectGift', rounding: 'rejectRounding', credit: 'reject',
    repayment: 'rejectRepayment', incidentResolution: 'rejectIncidentResolution',
    expense: 'rejectExpense' };
  const state = head.state;
  const principalId = context.principalId;
  const view = {
    serverNow: context.dbNow,
    rooms: state.rooms.map(room => pick(room, ['id', 'type', 'status', 'issueType', 'businessState', 'deviceControl', 'deviceWorkflowId'])),
    reviewQueue: []
  };
  view.dashboard = {
    roomCount: view.rooms.length,
    occupiedRooms: view.rooms.filter(room => room.status === '营业中').length,
    issueRooms: view.rooms.filter(room => room.status === '故障/维护中').length
  };

  if (grants.has('report.view')) {
    view.orders = state.orders.map(order => pick(order,
      ['id', 'kind', 'room', 'status', 'businessDate', 'businessState', 'deviceControl', 'deviceWorkflowId']));
    view.dashboard.orderCount = view.orders.length;
  }
  if (grants.has('catalog.manage')) {
    view.catalog = {
      products: rows(state.catalog?.products).map(item => pick(item,
        ['id', 'name', 'category', 'active', 'sellable', 'baseUnit'])),
      packages: rows(state.catalog?.packages).map(item => pick(item,
        ['id', 'name', 'roomType', 'period', 'priceCents', 'active']))
    };
  }

  if (grants.has('expense.viewAll') || grants.has('expense.view')) {
    view.expenses = rows(state.expenses)
      .filter(item => grants.has('expense.viewAll') ||
        item.submittedByPrincipalId === principalId)
      .map(item => pick(item, ['id', 'date', 'type', 'amount', 'method',
        'nature', 'description', 'status', 'submittedByPrincipalId']));
  }
  if (grants.has('procurement.viewAll') || grants.has('procurement.create')) {
    view.procurements = rows(state.procurements)
      .filter(item => grants.has('procurement.viewAll') ||
        item.submittedByPrincipalId === principalId)
      .map(item => pick(item, ['id', 'date', 'item', 'quantity', 'unit',
        'amount', 'status', 'expenseId', 'submittedByPrincipalId']));
  }
  if (grants.has('incident.viewAll') || grants.has('incident.create')) {
    view.incidents = rows(state.incidents)
      .filter(item => grants.has('incident.viewAll') ||
        item.submittedByPrincipalId === principalId)
      .map(item => pick(item, ['id', 'room', 'date', 'type', 'description',
        'status', 'submittedByPrincipalId']));
  }

  const add = (grant, type, source, project) => {
    if (!grants.has(grant)) return;
    for (const item of source) {
      const summary = { type, ...project(item) };
      const submitter = summary.submittedByPrincipalId;
      const validSubmitter = typeof submitter === 'string' && !!submitter &&
        submitter.trim() === submitter;
      const reviewFacts = validSubmitter ? createTrustedReviewFacts({
        submittedByPrincipalId: submitter,
        exceptionalSelfApprovalRequired: type === 'rounding' &&
          summary.exceptionalSelfApprovalRequired === true
      }) : null;
      summary.canApprove = !!reviewFacts && authorizeReviewCommand({
        principal, action: actionByType[type], reviewFacts }).allowed;
      summary.canReject = !!reviewFacts && authorizeReviewCommand({
        principal, action: rejectActionByType[type], reviewFacts }).allowed;
      summary.canDecide = summary.canApprove || summary.canReject;
      view.reviewQueue.push(summary);
    }
  };
  add('room.issue.approve', 'roomRecovery',
    rows(state.roomIssueReviews).filter(item => item.status === '待审核'),
    item => pick(item, ['id', 'room', 'fromStatus', 'requestedStatus',
      'issueType', 'evidenceText', 'evidencePhoto', 'evidencePhotoName',
      'submittedByPrincipalId', 'submittedAt']));
  add('inventory.approve', 'inventory',
    rows(state.inventoryReviews).filter(item => item.status === '待审核'),
    item => ({ ...pick(item, ['id', 'kind', 'product', 'source', 'before',
      'after', 'openedBefore', 'openedAfter', 'reason',
      'submittedByPrincipalId', 'submittedAt']) }));
  add('gift.approve', 'gift',
    state.orders.flatMap(order => rows(order.giftRequests)
      .filter(item => item.status === '待确认')
      .map(item => ({ order, item }))),
    ({ order, item }) => ({ orderId: order.id, room: order.room,
      ...pick(item, ['id', 'product', 'productNameSnapshot', 'halves',
        'bottles', 'submittedByPrincipalId', 'requestedAt']) }));
  add('rounding.approve', 'rounding',
    state.orders.filter(order => order.roundingReview?.status === '待审核'),
    order => ({ orderId: order.id, room: order.room,
      ...pick(order.roundingReview, ['amount', 'note',
        'submittedByPrincipalId', 'submittedAt',
        'exceptionalSelfApprovalRequired']) }));
  const creditRoute = credit => {
    if (!context.policyAttributesConfigured ||
        !Number.isSafeInteger(credit?.amount) || credit.amount <= 0) return false;
    if (credit.approver === '老板') return attributes.has('credit.approval.boss');
    if (credit.approver === '店长' && credit.amount <= 100000) {
      return attributes.has('credit.approval.manager') ||
        attributes.has('credit.approval.boss');
    }
    return false;
  };
  add('credit.approve', 'credit',
    state.orders.filter(order => order.status === '待审批挂账' &&
      creditRoute(order.credit)),
    order => ({ orderId: order.id, room: order.room,
      ...pick(order.credit, ['amount', 'approver', 'name', 'phone', 'note',
        'signature', 'submittedByPrincipalId', 'submittedAt']) }));
  add('credit.repay.approve', 'repayment',
    state.orders.flatMap(order => rows(order.credit?.repaymentRequests)
      .filter(item => item.status === '待审核')
      .map(item => ({ order, item }))),
    ({ order, item }) => ({ orderId: order.id, room: order.room,
      ...pick(item, ['id', 'amount', 'method', 'submittedByPrincipalId',
        'submittedAt']) }));
  add('incident.resolve.approve', 'incidentResolution',
    rows(state.incidents).flatMap(incident => rows(incident.resolutionReviews)
      .filter(item => item.status === '待审核')
      .map(item => ({ incident, item }))),
    ({ incident, item }) => ({ incidentId: incident.id, room: incident.room,
      incidentType: incident.type,
      ...pick(item, ['id', 'result', 'note',
        'submittedByPrincipalId', 'submittedAt']) }));
  add('expense.approve', 'expense',
    rows(state.expenses).filter(item => item.status === '待老板审批' &&
      (item.amount <= 50000 || attributes.has('expense.approval.boss'))),
    item => pick(item, ['id', 'date', 'amount', 'description', 'method',
      'proof', 'proofName', 'submittedByPrincipalId', 'time']));

  view.dashboard.pendingReviews = view.reviewQueue.length;
  return { revision: head.revision, view };
}
