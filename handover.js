// Demo handovers retain the legacy reconciliation; trusted handovers start a separate drawer chain.
import { BusinessRejection } from './shared/business-error.js';
import { need } from './inventory.js';
import { collected, PAYMENT_METHODS } from './sales.js';
import { assertTrustedExecutionContext, requireTrustedPermission } from './shared/identity.js';
import { cashDrawerFacts } from './financial-adjustments.js';

const HANDOVER_VERSION = 'drawer-v2';
const BOUNDARY_VERSION = 'cash-fact-set-v2';
const boundaryVersions = { 'drawer-v1': 'payment-set-v1', 'drawer-v2': BOUNDARY_VERSION };
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
    if (!Object.hasOwn(boundaryVersions, handover.trustedHandoverVersion) || !UUID.test(handover.handoverId) ||
        ids.has(handover.handoverId) || !validTime(handover.occurredAt) ||
        typeof handover.submittedByPrincipalId !== 'string' || !handover.submittedByPrincipalId ||
        !Number.isSafeInteger(handover.actualCash) || handover.actualCash < 0 ||
        handover.bootstrap !== !previous || handover.previousHandoverId !== (previous?.handoverId ?? null) ||
        handover.cashBoundary?.version !== boundaryVersions[handover.trustedHandoverVersion] ||
        !Array.isArray(handover.cashBoundary.payments) || !Array.isArray(handover.cashBoundary.legacyPayments) ||
        handover.trustedHandoverVersion === HANDOVER_VERSION && !Array.isArray(handover.cashBoundary.facts) ||
        handover.trustedHandoverVersion === 'drawer-v1' && Object.hasOwn(handover.cashBoundary, 'facts')) fail();
    ids.add(handover.handoverId); previous = handover;
  }
  return previous;
}

function safeAdd(a, b) {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0 || !Number.isSafeInteger(a + b)) fail();
  return a + b;
}
function intervalCash(state, previous, current, records, financial) {
  if (!previous) return { cashIn: 0, cashOut: 0, refundCashOut: 0, independentCashOut: 0, byChannel: {} };
  const before = previous.cashBoundary, ids = new Set(), currentById = new Map(current.payments.map(p => [p.paymentId, p]));
  if (JSON.stringify(before.legacyPayments) !== JSON.stringify(current.legacyPayments)) fail();
  for (const payment of before.payments) {
    if (!payment || !UUID.test(payment.paymentId) || ids.has(payment.paymentId) ||
        typeof payment.signature !== 'string' || currentById.get(payment.paymentId)?.signature !== payment.signature) fail();
    ids.add(payment.paymentId);
  }
  const seenFacts = new Set(), currentFacts = new Map(financial.facts.map(f => [f.factId, f]));
  for (const fact of before.facts ?? []) {
    const actual = currentFacts.get(fact?.factId);
    if (!fact || !UUID.test(fact.factId) || seenFacts.has(fact.factId) ||
        !actual || actual.kind !== fact.kind || actual.signature !== fact.signature) fail();
    seenFacts.add(fact.factId);
  }
  let cashIn = 0, refundCashOut = 0, independentCashOut = 0;
  const byChannel = {};
  for (const { paymentId } of current.payments) {
    if (ids.has(paymentId)) continue;
    const payment = records.get(paymentId), amount = payment.amount - (financial.paymentReversals.get(paymentId) ?? 0);
    if (!Number.isSafeInteger(amount) || amount < 0) fail();
    byChannel[payment.method] = safeAdd(byChannel[payment.method] || 0, amount);
    if (payment.method === '\u73b0\u91d1') cashIn = safeAdd(cashIn, amount);
  }
  const chain = state.handovers.filter(h => Object.hasOwn(h, 'trustedHandoverVersion'));
  const previousIndex = chain.findIndex(h => h.handoverId === previous.handoverId);
  for (const fact of financial.facts) {
    if (fact.kind === 'PAYMENT_REVERSAL' || seenFacts.has(fact.factId)) continue;
    if (previous.trustedHandoverVersion === 'drawer-v1') {
      const index = chain.findIndex(h => h.handoverId === fact.drawerHandoverId);
      if (index < 0 || index > previousIndex) fail();
      if (index < previousIndex) continue;
    } else if (fact.drawerHandoverId !== previous.handoverId) fail();
    if (fact.kind === 'REFUND') refundCashOut = safeAdd(refundCashOut, fact.amount);
    else independentCashOut = safeAdd(independentCashOut, fact.amount);
  }
  return { cashIn, cashOut: safeAdd(refundCashOut, independentCashOut), refundCashOut, independentCashOut, byChannel };
}
// One read-only calculation shared by execution and the handover writer.
// Capturing correction IDs preserves the interpretation of every historical interval.
function drawerInterval(state) {
  const { boundary, records } = paymentBoundary(state), previous = previousTrustedHandover(state);
  const financial = cashDrawerFacts(state);
  boundary.facts = financial.facts.map(({ factId, kind, signature }) => ({ factId, kind, signature }));
  return { boundary, previous, ...intervalCash(state, previous, boundary, records, financial) };
}
export function readTrustedDrawer(state) {
  const { previous, cashIn, cashOut } = drawerInterval(state);
  if (!previous) fail();
  const expectedCash = safeAdd(previous.actualCash, cashIn) - cashOut;
  if (!Number.isSafeInteger(expectedCash) || expectedCash < 0) fail();
  return { handoverId: previous.handoverId, actualCash: previous.actualCash, cashIn, cashOut, expectedCash,
    boundaryPaymentIds: previous.cashBoundary.payments.map(p => p.paymentId) };
}

function submitTrustedHandover(state, data, context) {
  assertTrustedExecutionContext(context); requireTrustedPermission(context, 'handover');
  if (!Number.isSafeInteger(data.actualCash) || data.actualCash < 0) throw new BusinessRejection('请输入有效实点现金金额');
  const { boundary, previous, cashIn, cashOut, refundCashOut, independentCashOut, byChannel } = drawerInterval(state);
  const expectedCash = previous ? safeAdd(previous.actualCash, cashIn) - cashOut : data.actualCash;
  // A physical count records book anomalies; it does not authorize spending or settle the variance.
  const difference = data.actualCash - expectedCash;
  if (!Number.isSafeInteger(expectedCash) || !Number.isSafeInteger(difference)) fail();
  const handoverId = globalThis.crypto.randomUUID();
  if (state.handovers.some(h => h.handoverId === handoverId)) throw Error('交班 ID 冲突');
  state.handovers.push({ id: ++state.serial, trustedHandoverVersion: HANDOVER_VERSION, handoverId,
    occurredAt: context.dbNow, submittedByPrincipalId: context.principalId,
    actualCash: data.actualCash, expectedCash, difference,
    ...(expectedCash < 0 ? { cashAnomaly: 'NEGATIVE_EXPECTED_CASH' } : {}),
    previousHandoverId: previous?.handoverId ?? null, bootstrap: !previous, cashBoundary: boundary,
    intervalCashIn: cashIn, intervalCashOut: cashOut, intervalRefundCashOut: refundCashOut,
    intervalIndependentCashOut: independentCashOut, intervalByChannel: byChannel,
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
