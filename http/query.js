import { SessionAuthenticationRequired } from '../ledger/trusted-execution.js';
import { assertTrustedExecutionContext, requireTrustedPermission } from '../shared/identity.js';
import { reportViewModel } from '../reporting.js';

export function createCurrentSessionReader({ pool, authStore }) {
  if (typeof pool?.getConnection !== 'function' ||
      typeof authStore?.bindSessionRevalidation !== 'function') {
    throw new TypeError('Invalid current-session reader');
  }
  return Object.freeze({
    async withContext(credential, work) {
      const connection = await pool.getConnection();
      let begun = false;
      try {
        await connection.beginTransaction();
        begun = true;
        const context = await authStore.bindSessionRevalidation(connection)
          .revalidateSessionInTransaction(credential);
        if (!context) throw new SessionAuthenticationRequired();
        const result = await work(assertTrustedExecutionContext(context), connection);
        await connection.commit();
        begun = false;
        return result;
      } catch (error) {
        if (begun) await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    }
  });
}

const roomGrants = ['room.open', 'room.reserve', 'room.clean', 'room.issue',
  'room.issue.approve', 'order.sale', 'order.exchange', 'payment.collect',
  'payment.settle', 'report.view'];
const catalogGrants = ['catalog.manage', 'room.open', 'order.sale', 'retail.sale',
  'order.exchange', 'order.serveExtra'];
const orderGrants = ['report.view', 'payment.collect', 'payment.settle'];
const reviewGrants = [
  ['room.issue.approve', null], ['inventory.approve', null],
  ['gift.approve', null], ['rounding.approve', null],
  ['credit.approve', ['credit.approval.manager', 'credit.approval.boss']],
  ['credit.repay.approve', null], ['incident.resolve.approve', null],
  ['expense.approve', 'expense.approval.boss']
];
const any = (grants, candidates) => candidates.some(value => grants.has(value));

export function projectStoreSnapshot(head, context) {
  assertTrustedExecutionContext(context);
  if (!head || !Number.isSafeInteger(head.revision) || head.revision < 0 ||
      !head.state || !Array.isArray(head.state.rooms) || !Array.isArray(head.state.orders)) {
    throw new Error('Invalid server ledger snapshot');
  }
  const grants = new Set(context.permissionIds);
  const attributes = new Set(context.policyAttributeIds ?? []);
  const state = head.state;
  const view = {};
  if (any(grants, roomGrants)) {
    view.rooms = state.rooms.map(room => ({ id: room.id, type: room.type,
      status: room.status, ...(room.businessState?{businessState:room.businessState,deviceControl:room.deviceControl}:{}) }));
  }
  if (any(grants, catalogGrants)) {
    view.catalog = { products: (state.catalog?.products ?? []).filter(item => item.active !== false)
      .map(item => ({ id: item.id, name: item.name, category: item.category,
        baseUnit: item.baseUnit, sellable: item.sellable,
        saleOptions: (item.saleOptions ?? []).map(option => ({
          id: option.id, name: option.name, baseQuantity: option.baseQuantity,
          priceCents: option.priceCents
        })) })) };
  }
  if (any(grants, orderGrants)) {
    view.orders = state.orders.map(order => ({ id: order.id, kind: order.kind,
      room: order.room, status: order.status, businessDate: order.businessDate ?? null }));
  }
  if (grants.has('expense.viewAll') || grants.has('expense.view')) {
    view.expenses = (state.expenses ?? [])
      .filter(item => grants.has('expense.viewAll') ||
        item.submittedByPrincipalId === context.principalId)
      .map(item => ({ id: item.id, date: item.date, type: item.type,
        amount: item.amount, status: item.status, description: item.description,
        submittedByPrincipalId: item.submittedByPrincipalId ?? null }));
  }
  if (grants.has('procurement.viewAll')) {
    view.procurements = (state.procurements ?? []).map(item => ({
      id: item.id, date: item.date, item: item.item, quantity: item.quantity,
      amount: item.amount, status: item.status
    }));
  }
  if (grants.has('incident.viewAll')) {
    view.incidents = (state.incidents ?? []).map(item => ({
      id: item.id, type: item.type, status: item.status,
      submittedByPrincipalId: item.submittedByPrincipalId ?? null
    }));
  }
  view.reviewSections = reviewGrants.filter(([grant, attribute]) =>
    grants.has(grant) && (!attribute || (Array.isArray(attribute) ? attribute.some(value => attributes.has(value)) : attributes.has(attribute)))).map(([grant]) => grant);
  return { revision: head.revision, view };
}


// Opt-in report projection on the existing snapshot query; never return raw ledger orders.
export function projectFinancialReport(head, context, query) {
  assertTrustedExecutionContext(context); requireTrustedPermission(context, 'report.view');
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  if (!exact(query, ['fromBusinessDate', 'toBusinessDate', 'paymentInterval']) ||
      !exact(query.paymentInterval, ['from', 'to'])) throw TypeError('Explicit financial report ranges required');
  if (!head || !Number.isSafeInteger(head.revision) || head.revision < 0 ||
      !Array.isArray(head.state?.orders) || !Array.isArray(head.state?.rooms)) throw Error('Invalid server ledger snapshot');
  const model = reportViewModel(head.state, 'day', query);
  return { revision: head.revision, report: {
    query: { fromBusinessDate: query.fromBusinessDate, toBusinessDate: query.toBusinessDate,
      paymentInterval: { from: query.paymentInterval.from, to: query.paymentInterval.to } },
    totals: model.totals, categoryRows: model.categoryRows, sellerRows: model.sellerRows,
    revenue: { orderIds: model.periodOrders.map(o => o.id), cancelledOrderIds: model.cancelledOrders.map(o => o.id),
      ambiguities: model.revenueAmbiguities, complete: model.revenueComplete },
    currentBalances: model.currentBalances, financialFlows: model.financialFlows, cashCounts: model.cashCounts,
    complete: model.revenueComplete && model.currentBalances.complete && model.financialFlows.complete && model.cashCounts.complete
  } };
}
