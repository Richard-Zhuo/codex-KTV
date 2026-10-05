// Demo handovers retain the legacy reconciliation; trusted handovers start a separate drawer chain.
import { BusinessRejection } from './shared/business-error.js';
import { need } from './inventory.js';
import { collected, PAYMENT_METHODS } from './sales.js';
import { assertTrustedExecutionContext, requireTrustedPermission } from './shared/identity.js';

const HANDOVER_VERSION = 'drawer-v1';
const BOUNDARY_VERSION = 'payment-set-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = () => { throw new BusinessRejection('交班现金边界或付款事实无法安全解释'); };
const validTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value));

// Canonical payments only. Repayment mirrors, wine custody and unproven expense funding are not drawer movements.
function paymentBoundary(state) {
  const payments = [], legacyPayments = [], records = new Map();
  for (const order of state.orders) {
    for (const [index, payment] of (order.payments || []).entries()) {
      if (!payment || typeof payment !== 'object') fail();
      const signature = JSON.stringify([order.id, payment.method, payment.amount, payment.occurredAt ?? null,
        payment.recordedByPrincipalId ?? null, payment.approvedByPrincipalId ?? null, payment.time ?? null]);
      const trusted = UUID.test(payment.paymentId) && validTime(payment.occurredAt) &&
        typeof payment.recordedByPrincipalId === 'string' && Boolean(payment.recordedByPrincipalId) &&
        PAYMENT_METHODS.includes(payment.method) && Number.isSafeInteger(payment.amount) && payment.amount > 0;
      if (trusted) {
        if (records.has(payment.paymentId)) fail();
        records.set(payment.paymentId, payment);
        payments.push({ paymentId: payment.paymentId, signature });
      } else legacyPayments.push({ reference: JSON.stringify([order.id, index]), signature });
    }
  }
  return { boundary: { version: BOUNDARY_VERSION, payments, legacyPayments }, records };
}

function previousTrustedHandover(state) {
  let previous = null;
  const ids = new Set();
  for (const handover of state.handovers) {
    if (!Object.hasOwn(handover, 'trustedHandoverVersion')) continue;
    if (handover.trustedHandoverVersion !== HANDOVER_VERSION || !UUID.test(handover.handoverId) ||
        ids.has(handover.handoverId) || !validTime(handover.occurredAt) ||
        typeof handover.submittedByPrincipalId !== 'string' || !handover.submittedByPrincipalId ||
        !Number.isSafeInteger(handover.actualCash) || handover.actualCash < 0 ||
        handover.bootstrap !== !previous || handover.previousHandoverId !== (previous?.handoverId ?? null) ||
        handover.cashBoundary?.version !== BOUNDARY_VERSION ||
        !Array.isArray(handover.cashBoundary.payments) || !Array.isArray(handover.cashBoundary.legacyPayments)) fail();
    ids.add(handover.handoverId); previous = handover;
  }
  return previous;
}

function intervalCash(previous, current, records) {
  if (!previous) return { cashIn: 0, cashOut: 0, byChannel: {} };
  const before = previous.cashBoundary, ids = new Set(), currentById = new Map(current.payments.map(p => [p.paymentId, p]));
  // Old ambiguous payments are absorbed at bootstrap, never dated or turned into new money.
  // A new ambiguous payment, mutation or removal cannot silently advance the drawer cursor.
  if (JSON.stringify(before.legacyPayments) !== JSON.stringify(current.legacyPayments)) fail();
  for (const payment of before.payments) {
    if (!payment || !UUID.test(payment.paymentId) || ids.has(payment.paymentId) ||
        typeof payment.signature !== 'string' || currentById.get(payment.paymentId)?.signature !== payment.signature) fail();
    ids.add(payment.paymentId);
  }
  let cashIn = 0;
  const byChannel = {};
  for (const { paymentId } of current.payments) {
    if (ids.has(paymentId)) continue;
    const payment = records.get(paymentId);
    byChannel[payment.method] = (byChannel[payment.method] || 0) + payment.amount;
    if (!Number.isSafeInteger(byChannel[payment.method])) fail();
    if (payment.method === '现金') cashIn += payment.amount;
  }
  if (!Number.isSafeInteger(cashIn)) fail();
  // No current command records a proven drawer cash outflow. Do not infer it from an expense's method.
  return { cashIn, cashOut: 0, byChannel };
}

function submitTrustedHandover(state, data, context) {
  assertTrustedExecutionContext(context); requireTrustedPermission(context, 'handover');
  if (!Number.isSafeInteger(data.actualCash) || data.actualCash < 0) throw new BusinessRejection('请输入有效实点现金金额');
  const { boundary, records } = paymentBoundary(state), previous = previousTrustedHandover(state);
  const { cashIn, cashOut, byChannel } = intervalCash(previous, boundary, records);
  const expectedCash = previous ? previous.actualCash + cashIn - cashOut : data.actualCash;
  if (!Number.isSafeInteger(expectedCash) || expectedCash < 0) fail();
  const handoverId = globalThis.crypto.randomUUID();
  if (state.handovers.some(h => h.handoverId === handoverId)) throw Error('交班 ID 冲突');
  state.handovers.push({ id: ++state.serial, trustedHandoverVersion: HANDOVER_VERSION, handoverId,
    occurredAt: context.dbNow, submittedByPrincipalId: context.principalId,
    actualCash: data.actualCash, expectedCash, difference: data.actualCash - expectedCash,
    previousHandoverId: previous?.handoverId ?? null, bootstrap: !previous, cashBoundary: boundary,
    intervalCashIn: cashIn, intervalCashOut: cashOut, intervalByChannel: byChannel,
    person: context.actorSnapshot?.displayName ?? null, time: context.dbNow,
    expected: expectedCash, actual: data.actualCash, drawerCash: data.actualCash });
}

export function submitHandover(s, data, person, time, execution = { mode: 'demo' }) {
  if (!execution || !['demo', 'trusted'].includes(execution.mode)) throw TypeError('交班执行模式无效');
  if (execution.mode === 'trusted') return submitTrustedHandover(s, data, execution.context);
  need(s, ['收银员','财务','店长','老板'], 'handover');
  if (!Number.isSafeInteger(data.actual) || data.actual < 0) throw new BusinessRejection('请输入有效实点金额');
  if (!Number.isSafeInteger(data.drawerCash) || data.drawerCash < 0) throw new BusinessRejection('请输入有效的前台现金');
  const expected = collected(s); s.handovers.push({ id: ++s.serial, expected, actual: data.actual, drawerCash: data.drawerCash, difference: data.actual-expected, person, time });
}
