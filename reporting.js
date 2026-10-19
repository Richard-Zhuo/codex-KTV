// 报表领域：纯 state 输入的经营报表 selectors 与 view models（Phase 6）。
// 自 app.js 迁出：reportMoney／reportQuantity／reportDateKey／reservationDate、
// reportPeriodMatch／reportOrder／reportGiftAmount／reportGiftDetails／
// reportSaleDetails／reportOtherDetails／reportBreakdown／reportTotals／
// reportGiftPerson／reportPaymentMethods／reportNotes，以及 reportPage 头部的
// 视图模型聚合（现 reportViewModel，含房间行 sales／other 汇总）。
// 函数体自 HEAD app.js 逐字保留（含原空格风格）；仅做闭包→参数机械转换：
//   reportPeriodMatch(order) → reportPeriodMatch(order, clock, reportPeriod)
//     （`state.clock`→`clock` 两处；全局 `reportPeriod`→参数 `reportPeriod`）
//   reportOrder(roomId) → reportOrder(state, roomId, reportPeriod)
//     （`reportPeriodMatch(order)`→`reportPeriodMatch(order, state.clock, reportPeriod)` 一处）
//   reportNotes(order) → reportNotes(order, reportPeriod)
//     （全局 `reportPeriod`→参数 `reportPeriod`，标识符同名，函数体不变）
//   reportPage 头部聚合行 → reportViewModel(state, reportPeriod)
//     （`filter(reportPeriodMatch)`→`filter(order=>reportPeriodMatch(order, state.clock, reportPeriod))`；
//       `reportOrder(room.id)`→`reportOrder(state, room.id, reportPeriod)`；
//       roomBody 行内 sales／other 聚合并入 rows 的 .map，reduce 表达式逐字保留）
// 依赖只来自 shared/money.js、sales.js（total／outstanding）与 catalog.js
// （productIdOf 历史商品回退），不依赖 DOM；app.js 的报表页面仅做模板渲染。
// 冻结口径：日/周/月（自然周周一起始、自然月）、房间按同房多单聚合、
// 快照优先（改目录不影响历史行）、付款方式纯微信只列方式名、
// 备注在日报读聚合行 credit 布尔（Bug #7 口径保持原状）。
import { money } from './shared/money.js';
import { total, outstanding } from './sales.js';
import { productIdOf } from './catalog.js';
import { orderPaymentCredit, netReceipts, cashDrawerFacts, validateOriginalPayment } from './financial-adjustments.js';
import { readTrustedDrawer } from './handover.js';
import { BusinessRejection } from './shared/business-error.js';


const reportUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function cancellationState(order) {
  const c = order?.cancellation;
  if (!c && order?.status !== '\u5df2\u64a4\u5355') return 'active';
  return order?.status === '\u5df2\u64a4\u5355' && c?.status === 'CANCELLED' && c.orderId === order.id &&
    reportUuid(c.cancellationId) && typeof c.reason === 'string' && c.reason.trim() &&
    typeof c.actualActorPrincipalId === 'string' && c.actualActorPrincipalId && paymentInstant(c.occurredAt) !== null
    ? 'cancelled' : 'unknown';
}
function effectiveOrders(orders) {
  return orders.filter(order => {
    const status = cancellationState(order);
    if (status === 'unknown') throw TypeError('Unverifiable cancellation in revenue query');
    return status === 'active';
  });
}

export const reportMoney = centsValue => money(Number(centsValue || 0));
export const reportQuantity = value => Number(value || 0).toFixed(2).replace(/\.00$/,'').replace(/(\.\d)0$/,'$1');
export const reportDateKey = value => { const d = new Date(value); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; };
export function reservationDate(time) { return new Date(time).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'}); }
export function reportPeriodMatch(order, clock, reportPeriod, businessDateRange) {
  if (!order) return false;
  if (businessDateRange) return selectRevenueOrders({ orders: [order] }, businessDateRange).orders.length === 1;
  // The legacy natural-calendar path is demo-only; frozen ledger dates require an explicit query range.
  if (Object.hasOwn(order, 'businessDate')) throw TypeError('frozen revenue requires an explicit business date range');
  const current = new Date(clock), time = new Date(order.time);
  if (reportPeriod === 'month') return current.getFullYear()===time.getFullYear() && current.getMonth()===time.getMonth();
  if (reportPeriod === 'week') { const start = new Date(current); start.setHours(0,0,0,0); const day=(start.getDay()+6)%7; start.setDate(start.getDate()-day); const end=new Date(start); end.setDate(start.getDate()+7); return time>=start && time<end; }
  return reportDateKey(clock) === reportDateKey(order.time);
}
export function reportOrder(state, roomId, reportPeriod, businessDateRange) {
  const orders = state.orders.filter(order=>order.kind!=='retail' && order.room===roomId && reportPeriodMatch(order, businessDateRange ? undefined : state.clock, reportPeriod, businessDateRange)).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
  if (!orders.length) return null;
  const base=orders.reduce((sum,order)=>sum+Number(order.packageBaseCents ?? order.base ?? 0),0), gift=orders.reduce((sum,order)=>sum+Number(order.packageGiftValueCents ?? order.gift ?? 0),0);
  return { ...orders.at(-1), periodOrders:orders, packageBaseCents:base, packageGiftValueCents:gift, base, gift, drinks:orders.flatMap(order=>order.drinks||[]), extras:orders.flatMap(order=>order.extras||[]), sales:orders.flatMap(order=>order.sales||[]), otherCharges:orders.flatMap(order=>order.otherCharges||[]), bonusGifts:orders.flatMap(order=>order.bonusGifts||[]), payments:orders.flatMap(order=>order.payments||[]), rounding:orders.reduce((sum,order)=>sum+Number(order.rounding||0),0), status:orders.at(-1).status, voucher:orders.find(order=>order.voucher)?.voucher };
}
export function reportGiftAmount(order) { return (order?.bonusGifts || []).reduce((sum,gift)=>sum + (Number.isSafeInteger(gift.referenceValueCents) ? gift.referenceValueCents : 0),0); }
export function reportGiftDetails(order) {
  return (order?.bonusGifts || []).flatMap(gift=>(gift.drinks||[]).filter(line=>line.count).map(line=>`${reportQuantity(line.totalBaseQuantity ?? line.count)}${line.baseUnitSnapshot || gift.baseUnitSnapshot || '基础单位'}${line.productNameSnapshot || gift.productNameSnapshot || `历史商品（${productIdOf(line)}）`}`));
}
export function reportSaleDetails(order) {
  return (order?.sales || []).map(line=>`${line.categoryLabelSnapshot || line.categorySnapshot || '历史未分类'} · ${line.productNameSnapshot || `历史商品（${productIdOf(line)}）`} × ${line.saleQuantity ?? line.count}（${line.saleOptionNameSnapshot || line.baseUnitSnapshot || '规格未记录'}） ${money(line.amountCents ?? line.amount ?? 0)}`);
}
export function reportOtherDetails(order) {
  return (order?.otherCharges || []).map(line=>`${line.category === '其他' ? line.item : line.category} ${money(line.amountCents ?? line.amount ?? 0)}`);
}
export function reportBreakdown(orders, key) {
  const totals=new Map();
  for (const line of effectiveOrders(orders).flatMap(order=>order.sales||[])) {
    const label=key==='category' ? (line.categoryLabelSnapshot || line.categorySnapshot || '历史未分类') : (line.person || '归属未记录');
    totals.set(label,(totals.get(label)||0)+Number(line.amountCents ?? line.amount ?? 0));
  }
  return [...totals.entries()];
}
export function reportTotals(orders) {
  return effectiveOrders(orders).reduce((sum,order)=>{sum.base+=Number(order.packageBaseCents ?? order.base ?? 0);sum.sales+=(order.sales||[]).reduce((n,line)=>n+Number(line.amountCents ?? line.amount ?? 0),0)+Number(order.packageGiftValueCents ?? order.gift ?? 0);sum.gift+=reportGiftAmount(order);sum.total+=total(order);sum.rounding+=Number(order.rounding||0);return sum;},{base:0,sales:0,gift:0,total:0,rounding:0});
}
export function reportGiftPerson(order) {
  if (!order) return '';
  const people = (order.bonusGifts || []).map(gift=>gift.requestedBy).filter(Boolean);
  return [...new Set(people)].join('、');
}
export function reportPaymentMethods(order) {
  if (!order) return '';
  const totals = new Map();
  for (const payment of order.payments || []) {
    if (!payment.method) continue;
    totals.set(payment.method, (totals.get(payment.method) || 0) + Number(payment.amount || 0));
  }
  const methods = [...totals.entries()];
  if (!methods.length) return outstanding(order) ? '未收' : '';
  const hasNonWechat = methods.some(([method]) => method !== '微信');
  return methods.map(([method, amount]) => hasNonWechat ? `${method}${money(amount)}` : method).join('+');
}
export function reportNotes(order, reportPeriod) {
  if (!order) return [];
  const repaymentSuffix = item => {
    const credit = item?.credit;
    const fullyRepaid = item?.status === '已回款' || (credit && typeof credit === 'object' && Number(credit.remaining || 0) === 0);
    return credit && fullyRepaid ? ' 已回款' : '';
  };
  // Bug #7 修复：日报备注不再按聚合行 credit 布尔压缩，改为逐笔列出周期内每笔挂账，
  // 同房多单时保留每笔金额与回款状态。
  if (reportPeriod === 'day') {
    const creditNotes = [...(order.periodOrders || [order])]
      .filter(item => item.credit)
      .sort((a, b) => Date.parse(b.credit.submittedAt || b.time) - Date.parse(a.credit.submittedAt || a.time))
      .map(item => `挂账${reportMoney(item.credit.amount)}${repaymentSuffix(item)}`);
    return [...creditNotes, order.voucher ? `${order.voucher.provider}待验券` : '', order.status === '已结账' ? '已结账' : ''].filter(Boolean);
  }
  return [...(order.periodOrders || [])]
    .filter(item=>item.credit)
    .sort((a,b)=>Date.parse(b.credit.submittedAt || b.time)-Date.parse(a.credit.submittedAt || a.time))
    .map(item=>`${reservationDate(item.credit.submittedAt || item.time)} 挂账${reportMoney(item.credit.amount)}${repaymentSuffix(item)}`);
}
// 视图模型：reportPage 头部的聚合常量（自 HEAD app.js reportPage 逐行迁出），
// 另将房间行的 sales／other 汇总并入 rows，报表 UI 不再自行聚合。
export function reportViewModel(state, reportPeriod, query) {
  // Explicit date and timestamp intervals are separate server inputs, never derived from demo clock.
  const revenue = query ? selectRevenueOrders(state, query) : null;
  const cashFlow = query ? selectPaymentFlows(state, query.paymentInterval) : null;
  const periodOrders=revenue ? revenue.orders : state.orders.filter(order=>reportPeriodMatch(order, state.clock, reportPeriod)), roomOrders=periodOrders.filter(order=>order.kind!=='retail'), retailOrders=periodOrders.filter(order=>order.kind==='retail');
  const rows=state.rooms.map(room=>({room,order:reportOrder(state, room.id, reportPeriod, query)})).filter(row=>row.order).map(row=>({...row,sales:(row.order.sales||[]).reduce((sum,line)=>sum+Number(line.amountCents ?? line.amount ?? 0),0), other:(row.order.otherCharges||[]).reduce((sum,line)=>sum+Number(line.amountCents ?? line.amount ?? 0),0)}));
  const totals=reportTotals(periodOrders), roomTotals=reportTotals(roomOrders);
  const roomSales=roomOrders.flatMap(order=>order.sales||[]).reduce((sum,line)=>sum+Number(line.amountCents ?? line.amount ?? 0),0);
  const roomOther=roomOrders.flatMap(order=>order.otherCharges||[]).reduce((sum,line)=>sum+Number(line.amountCents ?? line.amount ?? 0),0);
  const categoryRows=reportBreakdown(periodOrders,'category'), sellerRows=reportBreakdown(periodOrders,'seller');
  return { periodOrders, roomOrders, retailOrders, rows, totals, roomTotals, roomSales, roomOther, categoryRows, sellerRows,
    ...(query ? { revenueAmbiguities: revenue.ambiguities, revenueComplete: revenue.complete, cashFlow,
      cancelledOrders: revenue.cancelledOrders, financialFlows: selectFinancialFlows(state, query.paymentInterval),
      currentBalances: selectCurrentOrderBalances(state, revenue.orders), cashCounts: selectCashCountHistory(state) } : {}) };
}

// Formal revenue queries use only frozen dates. Missing historical facts are exposed, never recalculated.
function validBusinessDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
export function selectRevenueOrders(state, { fromBusinessDate, toBusinessDate }) {
  if (!validBusinessDate(fromBusinessDate) || !validBusinessDate(toBusinessDate) || fromBusinessDate >= toBusinessDate) {
    throw TypeError('营业额查询需要明确的起止营业日（左闭右开）');
  }
  const orders = [], cancelledOrders = [], ambiguities = [];
  for (const order of state.orders) {
    if (!validBusinessDate(order?.businessDate)) {
      ambiguities.push({ code: 'ORDER_BUSINESS_DATE_UNKNOWN', orderId: order?.id ?? null });
    } else {
      const status = cancellationState(order);
      if (status === 'unknown') ambiguities.push({ code: 'ORDER_CANCELLATION_UNVERIFIABLE', orderId: order.id });
      else if (order.businessDate >= fromBusinessDate && order.businessDate < toBusinessDate)
        (status === 'cancelled' ? cancelledOrders : orders).push(order);
    }
  }
  return { orders, cancelledOrders, ambiguities, complete: ambiguities.length === 0 };
}

// Preserve MySQL's microsecond precision; query boundaries never depend on a device time zone.
function paymentInstant(value) {
  if (typeof value !== 'string') return null;
  const match = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.(\d{1,6}))?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) return null;
  const millis = Date.parse(value), day = Date.parse(value.slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(millis) || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  return BigInt(millis) * 1000n + BigInt((match[1] || '').padEnd(6, '0').slice(3));
}
export function selectPaymentFlows(state, { from, to }) {
  const start = paymentInstant(from), end = paymentInstant(to);
  if (start === null || end === null || start >= end) throw TypeError('资金查询需要带时区的起止真实时间（左闭右开）');
  const payments = [], ambiguities = [], channels = new Map();
  let totalCents = 0;
  // order.payments is the canonical money fact; credit.repayments is only a link/projection.
  for (const order of state.orders) {
    if (!Array.isArray(order?.payments)) {
      ambiguities.push({ code: 'ORDER_PAYMENTS_UNKNOWN', orderId: order?.id ?? null });
      continue;
    }
    for (const [paymentIndex, payment] of order.payments.entries()) {
      const reference = { orderId: order.id, paymentIndex };
      const occurred = paymentInstant(payment?.occurredAt);
      if (occurred === null) {
        // No existing field independently attests an old demo time; even a principal/name is insufficient.
        ambiguities.push({ ...reference, code: payment?.occurredAt == null ? 'PAYMENT_TIME_AMBIGUOUS' : 'PAYMENT_OCCURRED_AT_INVALID' });
        continue;
      }
      if (!Number.isSafeInteger(payment.amount) || payment.amount <= 0) {
        ambiguities.push({ ...reference, code: 'PAYMENT_AMOUNT_INVALID' });
        continue;
      }
      if (occurred < start || occurred >= end) continue;
      if (!Number.isSafeInteger(totalCents + payment.amount)) throw RangeError('资金合计超出安全整数范围');
      payments.push({ ...payment, ...reference });
      totalCents += payment.amount;
      channels.set(payment.method, (channels.get(payment.method) || 0) + payment.amount);
    }
  }
  return { payments, totalCents, byChannel: [...channels].map(([method, amountCents]) => ({ method, amountCents })),
    ambiguities, complete: ambiguities.length === 0 };
}


// Period events and current order balances intentionally have different semantics.
// Original K05 selectPaymentFlows remains the unchanged original-receipt query.
const reportPick = (value, fields) => Object.fromEntries(fields.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
const financialFields = ['adjustmentId', 'kind', 'originalPaymentId', 'amount', 'occurredAt',
  'businessDate', 'businessDayRuleVersion', 'businessTimeZone', 'refundChannel', 'refundFundingSource',
  'affectsCurrentDrawer', 'drawerHandoverId'];
const cashOutFields = ['cashOutId', 'amountCents', 'occurredAt', 'businessDate',
  'businessDayRuleVersion', 'businessTimeZone', 'drawerHandoverId'];
function reportSum(values) {
  return values.reduce((sum, value) => {
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(sum + value)) throw RangeError('Unsafe financial report amount');
    return sum + value;
  }, 0);
}
export function selectFinancialFlows(state, interval) {
  const original = selectPaymentFlows(state, interval), ambiguities = [...original.ambiguities];
  const start = paymentInstant(interval.from), end = paymentInstant(interval.to);
  const inPeriod = value => {
    const instant = paymentInstant(value);
    return instant !== null && instant >= start && instant < end;
  };
  const verifiedPayments = [];
  for (const p of original.payments) {
    try { validateOriginalPayment(state, p.orderId, p.paymentId); verifiedPayments.push(p); }
    catch (error) {
      if (!(error instanceof BusinessRejection)) throw error;
      ambiguities.push({ code: 'PAYMENT_IDENTITY_UNVERIFIABLE', orderId: p.orderId, paymentIndex: p.paymentIndex });
    }
  }
  const candidates = [], identities = new Map();
  for (const order of state.orders) {
    try {
      orderPaymentCredit(order); netReceipts(order);
      for (const a of order.financialAdjustments ?? []) {
        validateOriginalPayment(state, order.id, a.originalPaymentId);
        candidates.push({ ...reportPick(a, financialFields), orderId: order.id });
        identities.set(a.adjustmentId, (identities.get(a.adjustmentId) ?? 0) + 1);
      }
    } catch (error) {
      if (!(error instanceof BusinessRejection)) throw error;
      ambiguities.push({ code: 'ORDER_FINANCIAL_FACTS_UNVERIFIABLE', orderId: order.id });
    }
  }
  const adjustments = candidates.filter(a => {
    if (identities.get(a.adjustmentId) !== 1) {
      ambiguities.push({ code: 'FINANCIAL_FACT_ID_DUPLICATE', orderId: a.orderId }); return false;
    }
    return inPeriod(a.occurredAt);
  });
  const reversals = adjustments.filter(a => a.kind === 'PAYMENT_REVERSAL');
  const refunds = adjustments.filter(a => a.kind === 'REFUND');
  let drawerFacts = null;
  try {
    const facts = cashDrawerFacts(state).facts;
    if (!selectCashCountHistory(state).complete) throw new BusinessRejection('Unverifiable cash count chain');
    // Publish drawer facts only after both fact and chain validation succeed.
    drawerFacts = facts;
  }
  catch (error) {
    if (!(error instanceof BusinessRejection)) throw error;
    ambiguities.push({ code: 'DRAWER_FACTS_UNVERIFIABLE' });
  }
  const cashOutflows = drawerFacts === null ? [] : (state.cashOutflows ?? [])
    .filter(f => inPeriod(f.occurredAt)).map(f => reportPick(f, cashOutFields));
  const refundCents = reportSum(refunds.map(a => a.amount)), reversalCents = reportSum(reversals.map(a => a.amount));
  // Reuse the accepted drawer fact validator; reversal facts are corrections, never cash outflows.
  const refundIds = new Set(drawerFacts?.filter(f => f.kind === 'REFUND').map(f => f.factId));
  const drawerRefundCents = drawerFacts === null ? null : reportSum(refunds.filter(a => refundIds.has(a.adjustmentId)).map(a => a.amount));
  const independentCashOutCents = drawerFacts === null ? null : reportSum(cashOutflows.map(f => f.amountCents));
  return {
    payments: verifiedPayments.map(p => reportPick(p, ['paymentId', 'orderId', 'amount', 'method', 'occurredAt'])),
    reversals, refunds, cashOutflows, originalPaymentCents: reportSum(verifiedPayments.map(p => p.amount)),
    reversalCents, refundCents, netReceiptsChangeCents: reportSum([...verifiedPayments.map(p => p.amount), -reversalCents, -refundCents]),
    drawerRefundCents, independentCashOutCents,
    drawerCashOutCents: drawerFacts === null ? null : reportSum([drawerRefundCents, independentCashOutCents]),
    ambiguities, complete: ambiguities.length === 0
  };
}
export function selectCurrentOrderBalances(state, orders) {
  const balances = [], ambiguities = [];
  for (const order of orders) {
    try {
      if (!Array.isArray(order.payments)) throw new BusinessRejection('Unknown original payments');
      for (const payment of order.payments) validateOriginalPayment(state, order.id, payment?.paymentId);
      balances.push({ orderId: order.id, effectivePaymentCreditCents: orderPaymentCredit(order), netReceiptsCents: netReceipts(order) });
    } catch (error) {
      if (!(error instanceof BusinessRejection)) throw error;
      ambiguities.push({ code: 'ORDER_CURRENT_BALANCE_UNVERIFIABLE', orderId: order.id });
    }
  }
  return { orders: balances,
    effectivePaymentCreditCents: ambiguities.length ? null : reportSum(balances.map(o => o.effectivePaymentCreditCents)),
    netReceiptsCents: ambiguities.length ? null : reportSum(balances.map(o => o.netReceiptsCents)),
    ambiguities, complete: ambiguities.length === 0 };
}
export function selectCashCountHistory(state) {
  const counts = [], ambiguities = [];
  for (const h of state.handovers ?? []) {
    if (!['drawer-v1', 'drawer-v2'].includes(h?.trustedHandoverVersion)) {
      ambiguities.push({ code: 'LEGACY_CASH_COUNT_UNVERIFIABLE' }); continue;
    }
    counts.push(reportPick(h, ['trustedHandoverVersion', 'handoverId', 'previousHandoverId', 'occurredAt',
      'expectedCash', 'actualCash', 'difference', 'cashAnomaly']));
    if (!Number.isSafeInteger(h.expectedCash) || !Number.isSafeInteger(h.actualCash) || h.actualCash < 0 ||
        !Number.isSafeInteger(h.difference) || h.difference !== h.actualCash - h.expectedCash)
      ambiguities.push({ code: 'CASH_COUNT_AMOUNTS_UNVERIFIABLE', handoverId: h.handoverId });
  }
  if (counts.length) {
    try { readTrustedDrawer(state); }
    catch (error) {
      if (!(error instanceof BusinessRejection)) throw error;
      ambiguities.push({ code: 'CASH_COUNT_CHAIN_UNVERIFIABLE' });
    }
  }
  return { counts, unresolvedDifferences: counts.filter(h => h.difference !== 0 || h.cashAnomaly),
    ambiguities, complete: ambiguities.length === 0 };
}
