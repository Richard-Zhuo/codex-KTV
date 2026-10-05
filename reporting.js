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
  for (const line of orders.flatMap(order=>order.sales||[])) {
    const label=key==='category' ? (line.categoryLabelSnapshot || line.categorySnapshot || '历史未分类') : (line.person || '归属未记录');
    totals.set(label,(totals.get(label)||0)+Number(line.amountCents ?? line.amount ?? 0));
  }
  return [...totals.entries()];
}
export function reportTotals(orders) {
  return orders.reduce((sum,order)=>{sum.base+=Number(order.packageBaseCents ?? order.base ?? 0);sum.sales+=(order.sales||[]).reduce((n,line)=>n+Number(line.amountCents ?? line.amount ?? 0),0)+Number(order.packageGiftValueCents ?? order.gift ?? 0);sum.gift+=reportGiftAmount(order);sum.total+=total(order);sum.rounding+=Number(order.rounding||0);return sum;},{base:0,sales:0,gift:0,total:0,rounding:0});
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
    ...(query ? { revenueAmbiguities: revenue.ambiguities, revenueComplete: revenue.complete, cashFlow } : {}) };
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
  const orders = [], ambiguities = [];
  for (const order of state.orders) {
    if (!validBusinessDate(order?.businessDate)) {
      ambiguities.push({ code: 'ORDER_BUSINESS_DATE_UNKNOWN', orderId: order?.id ?? null });
    } else if (order.businessDate >= fromBusinessDate && order.businessDate < toBusinessDate) orders.push(order);
  }
  return { orders, ambiguities, complete: ambiguities.length === 0 };
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
