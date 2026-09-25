import { PRODUCTS, OTHER_CHARGE_CATEGORIES, USERS, USER_ALIASES, PERMISSION_ROLES, PERMISSION_DEFINITIONS, PERMISSION_IDS, defaultPermissions, defaultCapabilities, permissionsForRoles, effectiveUser, hasPermission, RESERVATION_SOURCES, OPENING_SOURCES, PAYMENT_METHODS, EXPENSE_NATURES, EXPENSE_TYPES, EXPENSE_APPROVAL_THRESHOLD, CONSUMABLES, INCIDENT_TYPES, visibleExpenses, visibleProcurements, visibleIncidents, pendingIncidentReminders, money, product, slot, cents, quote, initialState, total, outstanding, collected, collectableCharges, nextCollectCharge, transact, canExchange, bonusAllowance, reservationReminder, reservationActiveAt, searchDeposits, hasRole } from './rules.js';
const KEY = 'jbhh-demo-v1';
let state, storageProblem = '';
try {
  const raw = localStorage.getItem(KEY);
  state = raw ? JSON.parse(raw) : initialState();
  if (state.version !== 1 || !Array.isArray(state.rooms) || !state.inventory) throw Error();
  const fresh = initialState();
  for (const [id, item] of Object.entries(fresh.inventory)) state.inventory[id] ??= item;
  state.consumables ??= structuredClone(fresh.consumables);
  for (const [id, item] of Object.entries(fresh.consumables)) state.consumables[id] ??= item;
  for (const order of state.orders) {
    order.sales ??= [];
    order.otherCharges ??= [];
    order.payments ??= [];
    order.exchanges ??= [];
    order.bonusGifts ??= [];
    order.giftRequests ??= [];
    order.openedBy ??= order.person || '';
    order.recordedBy ??= order.person || '';
    order.employeeId ??= '';
    order.openSource ??= '线下';
    order.reservedBy ??= '';
    order.reservationSource ??= '';
    order.rounding ??= 0;
    order.roundingType ??= order.rounding ? '免零' : '';
    order.roundingNote ??= '';
    order.roundingReview ??= null;
    if (order.credit) order.credit.openSource ??= order.openSource;
    for (const gift of order.bonusGifts) {
      gift.id ??= ++state.serial;
      gift.drinks ??= gift.bottles ? [{ id: ++state.serial, product: gift.product, count: gift.bottles }] : [];
    }
    for (const sale of order.sales) {
      sale.id ??= ++state.serial;
      const multiplier = sale.spec === 'dozen' ? 12 : sale.spec === 'half' ? 6 : 1;
      sale.bottles ??= Number(sale.count || 0) * multiplier;
      sale.drinks ??= sale.bottles ? [{ id: ++state.serial, product: sale.product, count: sale.bottles }] : [];
    }
  }
  for (const room of state.rooms) {
    if (room.status === '已预订' && !room.order && !state.reservations.some(reservation => reservation.room === room.id && reservationActiveAt(reservation, state.clock))) room.status = '空闲';
  }
}
catch { state = initialState(); storageProblem = '本机练习记录无法读取，已进入新练习。'; }
function migrateDemoState(next) {
  const defaults = defaultPermissions();
  const raw = next.permissions && typeof next.permissions === 'object' ? next.permissions : {};
  next.permissions = Object.fromEntries(Object.entries(defaults).map(([id, roles]) => {
    const configured = raw[id];
    const normalized = Array.isArray(configured) ? [...new Set(configured.filter(role => PERMISSION_ROLES.includes(role)))] : [...roles];
    return [id, id === 'administrator' ? ['管理员'] : normalized];
  }));
  const capabilityDefaults = defaultCapabilities();
  const rawCapabilities = next.capabilities && typeof next.capabilities === 'object' ? next.capabilities : {};
  next.capabilities = Object.fromEntries(Object.entries(capabilityDefaults).map(([id, permissions]) => {
    const configured = rawCapabilities[id];
    const legacyRoles = next.permissions[id];
    const fallback = Array.isArray(legacyRoles) ? permissionsForRoles(legacyRoles) : permissions;
    if (id === 'administrator') return [id, [...PERMISSION_IDS]];
    const normalized = Array.isArray(configured) ? [...new Set(configured.filter(permission => PERMISSION_IDS.includes(permission)))] : [...fallback];
    const added = ['expense.view', 'expense.create', 'expense.viewAll', 'expense.approve', 'identity.manage', 'staff.record', 'procurement.create', 'procurement.viewAll', 'incident.create', 'incident.viewAll', 'incident.resolve'];
    const configuredBase = normalized.filter(permission => !added.includes(permission));
    const fallbackBase = fallback.filter(permission => !added.includes(permission));
    const matchesRoleDefaults = configuredBase.length === fallbackBase.length && fallbackBase.every(permission => configuredBase.includes(permission));
    return [id, matchesRoleDefaults ? [...new Set([...normalized, ...fallback.filter(permission => added.includes(permission))])] : normalized];
  }));
  for (const order of next.orders || []) {
    order.otherCharges ??= [];
    for (const extra of order.extras || []) extra.served ??= false;
  }
  next.handovers = Array.isArray(next.handovers) ? next.handovers : [];
  for (const handover of next.handovers) handover.drawerCash ??= null;
  next.expenses = Array.isArray(next.expenses) ? next.expenses : [];
  for (const expense of next.expenses) {
    expense.type ??= '支出';
    expense.status ??= '已记录';
    expense.approver ??= '';
    expense.approvedAt ??= '';
  }
  const fresh = initialState();
  next.consumables = next.consumables && typeof next.consumables === 'object' ? next.consumables : structuredClone(fresh.consumables);
  for (const [id, item] of Object.entries(fresh.consumables)) next.consumables[id] ??= item;
  next.procurements = Array.isArray(next.procurements) ? next.procurements : [];
  next.incidents = Array.isArray(next.incidents) ? next.incidents : [];
  for (const incident of next.incidents) {
    incident.status ??= incident.result ? '已完成' : '待处理';
    incident.result ??= '';
    incident.note ??= '';
    incident.lastReminderDate ??= '';
  }
  for (const room of next.rooms || []) if (['V05', 'V06'].includes(room.id)) room.type = '中房';
  return next;
}
state = migrateDemoState(state);
state.user = USER_ALIASES[state.user] || state.user;
if (!USERS[state.user] || USERS[state.user].legacy) state.user = 'shaoBoss';
let page = 'rooms', filter = '全部', searchTerm = '', category = '啤酒', reportPeriod = 'day', busy = false, controlSequence = 0;
const app = document.querySelector('#app'), modal = document.querySelector('#modal');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const btn = (text, action, data='', cls='secondary') => `<button type="button" class="${cls}" data-action="${action}" ${data}>${text}</button>`;
const date = t => new Date(t).toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false });
const localDate = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
const dayValue = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const currentUser = () => effectiveUser(state);
const allowed = roles => hasRole(currentUser(), roles);
const allowedPermission = permission => hasPermission(currentUser(), permission);
const options = (list, selected) => list.map(([v,n]) => `<option value="${esc(v)}" ${String(v)===String(selected)?'selected':''}>${esc(n)}</option>`).join('');
const beers = PRODUCTS.filter(p => p.giftEligible).map(p => [p.id,p.name]);
const initialMixChoices = PRODUCTS.filter(p => canExchange('drink', p.id)).map(p => [p.id,p.name]);
const creditRoles = ['开单员','收银员','服务员','库管','店长','老板'];
const managementRoles = ['管理员','老板','店长','财务','采购','库管'];
const reportRoles = ['管理员','老板','财务','店长','收银员'];
const roomOptions = () => options(state.rooms.map(r=>[r.id,`${r.id} · ${r.type}`]));
const employeeOptions = (selected = '') => options(Object.entries(USERS).filter(([id, user]) => !user.legacy && id !== 'administrator').map(([id, user]) => [id, user.name]), selected);
const consumableOptions = (selected = '') => options(CONSUMABLES.map(item => [item.id, `${item.name} · 按${item.unit}统计`]), selected);
const contactText = record => [record?.name, record?.phone].filter(Boolean).join(' · ') || '未留联系人';
const permissionDefinition = id => PERMISSION_DEFINITIONS.find(permission => permission.id === id);
const permissionSummary = user => (user.permissions || []).map(id => permissionDefinition(id)?.label).filter(Boolean);
function pendingReservations(roomId) { return state.reservations.filter(reservation => reservation.room === roomId && reservation.status === '已预订').sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)); }
function reservationDate(time) { return new Date(time).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'}); }
function reservationSessionName(reservation) { return reservation.session === 'afternoon' ? '下午场' : reservation.session === 'night' ? '夜间场' : String(reservation.sessionLabel || '').split('（')[0]; }
function displayRoomStatus(room) { return room.status === '空闲' && pendingReservations(room.id).length ? '已预订' : room.status; }
function roomMatchesFilter(room) { return filter === '全部' ? true : filter === '已预订' ? room.status === '已预订' || pendingReservations(room.id).length > 0 : displayRoomStatus(room) === filter; }
const reportMoney = centsValue => money(Number(centsValue || 0));
const reportQuantity = value => Number(value || 0).toFixed(2).replace(/\.00$/,'').replace(/(\.\d)0$/,'$1');
const reportDateKey = value => { const d = new Date(value); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; };
function reportPeriodMatch(order) {
  if (!order) return false;
  const current = new Date(state.clock), time = new Date(order.time);
  if (reportPeriod === 'month') return current.getFullYear()===time.getFullYear() && current.getMonth()===time.getMonth();
  if (reportPeriod === 'week') { const start = new Date(current); start.setHours(0,0,0,0); const day=(start.getDay()+6)%7; start.setDate(start.getDate()-day); const end=new Date(start); end.setDate(start.getDate()+7); return time>=start && time<end; }
  return reportDateKey(state.clock) === reportDateKey(order.time);
}
function reportOrder(roomId) {
  const orders = state.orders.filter(order=>order.room===roomId && reportPeriodMatch(order)).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
  if (!orders.length) return null;
  return { ...orders.at(-1), periodOrders:orders, base:orders.reduce((sum,order)=>sum+Number(order.base||0),0), gift:orders.reduce((sum,order)=>sum+Number(order.gift||0),0), drinks:orders.flatMap(order=>order.drinks||[]), extras:orders.flatMap(order=>order.extras||[]), sales:orders.flatMap(order=>order.sales||[]), otherCharges:orders.flatMap(order=>order.otherCharges||[]), bonusGifts:orders.flatMap(order=>order.bonusGifts||[]), payments:orders.flatMap(order=>order.payments||[]), rounding:orders.reduce((sum,order)=>sum+Number(order.rounding||0),0), status:orders.at(-1).status, credit:orders.some(order=>order.credit), voucher:orders.find(order=>order.voucher)?.voucher };
}
function reportLooseAlcoholSale(sale) {
  const p = PRODUCTS.find(item => item.id === sale?.product);
  return Boolean(p?.saleDozen && Number(sale.bottles || sale.count || 0) % 6 !== 0);
}
function reportProductCount(order, productId) {
  if (!order) return 0;
  const lines = [
    ...(order.drinks || []),
    ...(order.sales || []).filter(sale => !reportLooseAlcoholSale(sale)).flatMap(sale=>sale.drinks || []),
    ...(order.bonusGifts || []).flatMap(gift=>gift.drinks || [])
  ];
  return lines.filter(line=>line.product===productId).reduce((sum,line)=>sum + Number(line.count || 0),0) / 12;
}
function reportGiftAmount(order) { return (order?.bonusGifts || []).reduce((sum,gift)=>(gift.drinks || []).reduce((n,line)=>n + Number(line.count || 0) * (PRODUCTS.find(item=>item.id===line.product)?.price || 0),sum),0); }
function reportGiftDetails(order) {
  const totals = new Map();
  for (const gift of order?.bonusGifts || []) {
    for (const line of gift.drinks || []) totals.set(line.product, (totals.get(line.product) || 0) + Number(line.count || 0));
  }
  return [...totals.entries()].flatMap(([productId,count]) => {
    const p = PRODUCTS.find(item=>item.id===productId);
    return p && count ? [`${reportQuantity(count / 12)}打${p.name}`] : [];
  });
}
function reportLooseDetails(order) {
  if (!order) return [];
  const sales = (order.sales || []).flatMap(sale => {
    const p = PRODUCTS.find(item => item.id === sale.product);
    if (!p) return [];
    const isPaidFood = ['零食', '美食', '小吃', '套餐配品'].includes(p.category) && Number(sale.amount || 0) > 0;
    const isLooseAlcohol = reportLooseAlcoholSale(sale);
    return isPaidFood || isLooseAlcohol ? [`${sale.bottles || sale.count}${p.name} ${money(sale.amount)}`] : [];
  });
  const otherCharges = (order.otherCharges || []).map(line => `${line.category === '其他' ? line.item : line.category} ${money(line.amount)}`);
  return [...sales, ...otherCharges];
}
function reportTobaccoDetails(order) {
  if (!order) return [];
  return (order.sales || []).flatMap(sale => {
    const p = PRODUCTS.find(item => item.id === sale.product);
    return p?.category === '烟' ? [`${sale.bottles || sale.count}${p.name} ${money(sale.amount)}`] : [];
  });
}
function reportGiftPerson(order) {
  if (!order) return '';
  const people = (order.bonusGifts || []).map(gift=>gift.requestedBy).filter(Boolean);
  return [...new Set(people)].join('、');
}
function reportPaymentMethods(order) {
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
function reportNotes(order) {
  if (!order) return [];
  const repaymentSuffix = item => {
    const credit = item?.credit;
    const fullyRepaid = item?.status === '已回款' || (credit && typeof credit === 'object' && Number(credit.remaining || 0) === 0);
    return credit && fullyRepaid ? ' 已回款' : '';
  };
  if (reportPeriod !== 'day') {
    return [...(order.periodOrders || [])]
      .filter(item=>item.credit)
      .sort((a,b)=>Date.parse(b.credit.submittedAt || b.time)-Date.parse(a.credit.submittedAt || a.time))
      .map(item=>`${reservationDate(item.credit.submittedAt || item.time)} 挂账${reportMoney(item.credit.amount)}${repaymentSuffix(item)}`);
  }
  return [order.credit?`挂账${repaymentSuffix(order)}`:'', order.voucher?`${order.voucher.provider}待验券`:'', order.status==='已结账'?'已结账':''].filter(Boolean);
}
function reportPage() {
  if (!allowedPermission('report.view')) return '<p>当前身份没有报表权限，请切换管理员或由管理员分配“查看经营报表”权限。</p>';
  const rows = state.rooms.map(room=>({room, order:reportOrder(room.id)})).filter(row=>row.order);
  const productColumns = [['饮料','drink'],['百威','bw'],['喜力','xl'],['青岛','qd'],['红青岛','redqd'],['蓝妹','lm'],['蓝妹（罐装）','lm_can'],['黑金百威','jbw']];
  const reportRows = rows.map(({room,order})=>{
    const salesAmount = (order?.sales || []).reduce((sum,line)=>sum + Number(line.amount || 0),0), beverageAmount = salesAmount + Number(order?.gift || 0);
    const drinkCount = PRODUCTS.filter(item=>item.category==='饮料' || item.category==='汽水').reduce((sum,item)=>sum+reportProductCount(order,item.id),0);
    const productCounts = Object.fromEntries(productColumns.map(([,id])=>[id,id==='drink'?drinkCount:reportProductCount(order,id)]));
    const notes = reportNotes(order);
    return { room, order, beverageAmount, productCounts, notes, giftDetails:reportGiftDetails(order), looseDetails:reportLooseDetails(order), tobacco:reportTobaccoDetails(order) };
  });
  const columnCount = 11 + productColumns.length;
  const body = reportRows.length ? reportRows.map(({room,order,beverageAmount,productCounts,notes,giftDetails,looseDetails,tobacco})=>`<tr class="has-order"><th scope="row"><strong>${esc(room.id)}</strong><small>${esc(room.type)}</small></th><td class="money-cell">${reportMoney(order.base)}</td><td class="money-cell emphasis">${reportMoney(beverageAmount)}</td><td>${esc(reportPaymentMethods(order)||'—')}</td><td class="detail-cell">${giftDetails.length?giftDetails.map(esc).join('<br>'):'—'}</td><td>${esc(reportGiftPerson(order)||'—')}</td><td class="detail-cell">${looseDetails.length?looseDetails.map(esc).join('<br>'):'—'}</td><td class="detail-cell">${tobacco.length?tobacco.map(esc).join('<br>'):'—'}</td>${productColumns.map(([,id])=>`<td class="count-cell">${productCounts[id]||'—'}</td>`).join('')}<td class="money-cell">${reportMoney(order.rounding)}</td><td class="money-cell total-cell">${reportMoney(total(order))}</td><td class="note-cell">${notes.length?notes.map(esc).join('<br>'):'—'}</td></tr>`).join('') : `<tr class="empty-period"><td colspan="${columnCount}">本统计周期暂无开房记录</td></tr>`;
  const productTotals = Object.fromEntries(productColumns.map(([,id])=>[id,reportRows.reduce((sum,row)=>sum+Number(row.productCounts[id]||0),0)]));
  const totals = rows.reduce((sum,{order})=>{ if (!order) return sum; sum.base += Number(order.base||0); sum.sales += (order.sales || []).reduce((n,line)=>n+Number(line.amount||0),0) + Number(order.gift||0); sum.gift += reportGiftAmount(order); sum.total += total(order); sum.rounding += Number(order.rounding||0); return sum; },{base:0,sales:0,gift:0,total:0,rounding:0});
  const giftTotals = reportGiftDetails({ bonusGifts:rows.flatMap(({order})=>order.bonusGifts || []) });
  const periodLabel = reportPeriod==='day'?'日报':reportPeriod==='week'?'周报':'月报';
  return `<p class="eyebrow">经营数据</p><div class="report-heading"><div><h1>营业${periodLabel}</h1><p class="muted">${reportPeriod==='day'?'按当天':reportPeriod==='week'?'按本周':'按本月'}演示记录汇总 · ${date(state.clock)} · 金额单位：元，酒水数量按打统计</p></div><label class="report-period">统计范围<select id="report-period"><option value="day" ${reportPeriod==='day'?'selected':''}>日报</option><option value="week" ${reportPeriod==='week'?'selected':''}>周报</option><option value="month" ${reportPeriod==='month'?'selected':''}>月报</option></select></label></div><section class="summary report-summary"><div><strong>${rows.length}</strong><span>有消费房间</span></div><div><strong>${reportMoney(totals.sales)}</strong><span>酒水消费（含开房赠饮）</span></div><div><strong>${reportMoney(totals.total)}</strong><span>账单合计</span></div></section><div class="report-total-strip"><span>酒水赠送金额 <b>${reportMoney(totals.gift)}</b></span><span>免零金额 <b>${reportMoney(totals.rounding)}</b></span></div><div class="report-table-wrap"><table class="report-table"><caption><strong>房间消费明细</strong><span>左右滑动查看完整报表</span></caption><thead><tr><th scope="col">房号</th><th scope="col">房费</th><th scope="col">酒水消费<small>含开房赠饮</small></th><th scope="col">买单方式</th><th scope="col">酒水赠送<small>后续赠送</small></th><th scope="col">赠送人</th><th scope="col">美食／其他</th><th scope="col">烟</th>${productColumns.map(([label])=>`<th scope="col">${esc(label)}<small>/打</small></th>`).join('')}<th scope="col">免零金额</th><th scope="col">合计</th><th scope="col">备注</th></tr></thead><tbody>${body}</tbody><tfoot><tr><th scope="row">合计</th><td>${reportMoney(totals.base)}</td><td>${reportMoney(totals.sales)}</td><td>—</td><td class="detail-cell">${giftTotals.length?giftTotals.map(esc).join('<br>'):'—'}</td><td>—</td><td>—</td><td>—</td>${productColumns.map(([,id])=>`<td>${productTotals[id]||'—'}</td>`).join('')}<td>${reportMoney(totals.rounding)}</td><td>${reportMoney(totals.total)}</td><td>—</td></tr></tfoot></table></div><p class="muted report-note">报表依据本机演示账单生成；房费取开房基础房费，酒水消费包含开房套餐赠饮和增购酒水，其他消费列在“美食／其他”，酒水赠送只统计后续赠送。</p>`;
}
function reservationListMarkup(roomId) {
  const rows=pendingReservations(roomId);
  if (!rows.length) return '';
  return `<div class="panel reservation-list"><b>未来预订</b>${rows.map(reservation=>`<div class="bill-line"><span>${date(reservation.at)} · ${esc(reservation.sessionLabel || '')}<br><small>${esc(reservation.source || '未记录')} · ${esc(reservation.person || '未记录')}</small></span>${allowedPermission('room.reserve')?btn('取消这笔','cancelReservation',`data-room="${roomId}" data-reservation="${reservation.id}"`,'quiet'):'<span class="badge">无预订权限</span>'}</div>`).join('')}</div>`;
}
function persist(next) { try { localStorage.setItem(KEY, JSON.stringify(next)); state = next; } catch { throw Error('本机保存失败，操作未完成。请检查浏览器存储空间后重试。'); } }
function toast(text) { const el = document.querySelector('#toast'); el.textContent = text; el.classList.add('show'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove('show'),4500); }
function openDialog(title, content, submitLabel, action, hidden={}) {
  if (modal.open) modal.close();
  modal.innerHTML = `<div class="dialog-demo">演示数据 · 不产生真实收款</div><header class="dialog-head"><h2 id="modal-title">${title}</h2>${btn('关闭','close','','quiet')}</header><form data-form="${action || ''}">${Object.entries(hidden).map(([k,v])=>`<input type="hidden" name="${k}" value="${esc(v)}">`).join('')}${content}<p class="form-error" role="alert"></p>${submitLabel?`<button class="primary full" type="submit">${submitLabel}</button>`:''}</form>`;
  modal.showModal();
}
function commit(action, data, key) { const next=transact(state,action,data,key); persist(next); modal.close(); render(); toast('已保存 · 仅为演示记录'); }
const extraLabels = { nuts: '小吃', fruit: '果盘' };
function roomExtraActions(order) {
  if (!allowedPermission('order.serveExtra')) return '';
  const extras = (order?.extras || []).filter(extra => extraLabels[extra.product]);
  if (!extras.length || extras.every(extra => extra.served)) return '';
  return `<div class="room-extra-actions" aria-label="配品上桌状态">${extras.map(extra => {
    const label = extraLabels[extra.product];
    return `<button type="button" class="extra-button ${extra.served?'served':''}" data-action="serveExtra" data-id="${order.id}" data-product="${extra.product}" ${extra.served?'disabled':''}>${label}${extra.served?' · 已上':''}</button>`;
  }).join('')}</div>`;
}
function roomCard(r) {
  const o = state.orders.find(o=>o.id===r.order), bookings=pendingReservations(r.id);
  const status=displayRoomStatus(r), css = {'空闲':'free','营业中':'active','待清洁':'dirty','已预订':'reserved'}[status];
  const bookingText=bookings.length?`<small class="room-booking">未来预订：${reservationDate(bookings[0].at)} · ${esc(reservationSessionName(bookings[0]))}${bookings.length>1?`（还有${bookings.length-1}场）`:''}</small>`:'';
  return `<article class="room-card ${css}" data-action="room" data-id="${r.id}"><span class="room-top"><span>${r.type}</span><span class="status"><i></i>${status}</span></span><strong class="room-number">${r.id}</strong><span class="room-bottom">${o?`<b>${money(total(o))}</b><span>查看账单 →</span>`:r.status==='空闲'?'<span>点这里开房</span><span>＋</span>':r.status==='待清洁'?'<span>打扫后恢复空房</span><span>→</span>':'<span>查看预订</span><span>→</span>'}</span>${o && r.status==='营业中'?roomExtraActions(o):''}${bookingText}</article>`;
}
function appearanceSettings() {
  const preference = window.ktvAppearance.preference;
  return `<section class="panel appearance-panel"><div class="split"><div><h3>页面配色</h3><p class="muted">选择日间、夜间或按设备时间自动切换。</p></div><span class="badge">当前${preference==='auto'?'自动':preference==='dark'?'夜间':'日间'}</span></div><label>模式<select id="appearance-preference" aria-label="页面配色模式">${options([['light','日间'],['dark','夜间'],['auto','自动（日出至19:00日间）']],preference)}</select></label><p class="muted">自动模式按本机时间在日出（演示按 06:00）至19:00使用日间，其余时间使用夜间。</p></section>`;
}
function syncAppearanceControls() {
  const select = document.querySelector('#appearance-preference');
  if (select) select.value = window.ktvAppearance.preference;
  const badge = document.querySelector('.appearance-panel .badge');
  if (badge) badge.textContent = `当前${window.ktvAppearance.preference==='auto'?'自动':window.ktvAppearance.preference==='dark'?'夜间':'日间'}`;
}
window.addEventListener('appearancechange', syncAppearanceControls);
function render() {
  const canManage = allowedPermission('backend.view');
  const user = currentUser();
  app.innerHTML = `<header class="topbar"><a class="brand" href="#" data-action="home"><span class="brand-mark">金</span><span>金碧辉煌<small>KTV · 门店助手</small></span></a><div class="header-actions"><button class="identity" data-action="identity"><span class="avatar">${esc(currentUser().name[0])}</span>${esc(currentUser().name)} <span>⌄</span></button></div></header><main id="main"><div class="connection"><span class="online-dot"></span>本机练习${navigator.onLine?'':' · 当前设备离线'}<span>${date(state.clock)} · ${slot(state.clock)==='day'?'白天场':slot(state.clock)==='night'?'夜间场':'非营业时段'}</span></div>${storageProblem?`<p class="notice">${storageProblem}</p>`:''}${page==='rooms'?roomsPage():page==='deposits'?depositPage():page==='manage'?managePage():page==='expenses'?expensesPage():page==='procurement'?procurementPage():page==='incidents'?incidentPage():page==='report'?reportPage():minePage()}</main><nav class="bottom-nav" aria-label="主导航">${[['rooms','▦','房间'],['deposits','▤','存取酒'],...(allowedPermission('report.view')?[['report','▤','报表']]:[]),['mine','○','我的'],...(canManage?[['manage','▧','管理']]:[])].map(([id,icon,label])=>`<button data-action="nav" data-page="${id}" class="${page===id?'selected':''}" ${page===id?'aria-current="page"':''}><span aria-hidden="true">${icon}</span>${label}</button>`).join('')}</nav>`;
}
function roomsPage() {
  const active = state.rooms.filter(r=>r.status==='营业中').length;
  const reminders = state.reservations.map(r => reservationReminder(r, state.clock)).filter(Boolean);
  return `<section class="welcome"><div><p class="eyebrow">今晚，也从容一点</p><h1>房间一眼看清</h1><p>先选房间，再开房、加单或收钱。</p></div><div class="welcome-icon" aria-hidden="true">♫</div></section>${reminders.map(r=>`<div class="reservation-alert"><b>预订提醒 · ${r.room}</b><p>${esc(r.sessionLabel)}已到时，仍未开房；这是第 ${r.number} 次整点提醒，请通知预订人员 ${esc(r.person)}。</p></div>`).join('')}<section class="summary"><div><strong>${state.rooms.filter(r=>displayRoomStatus(r)==='空闲').length}<small> / 9</small></strong><span>空闲房间</span></div><div><strong>${active}</strong><span>正在营业</span></div><div><strong>${money(collected(state))}</strong><span>练习累计实收</span></div></section><div class="section-title"><h2>全部包间</h2><span>点击卡片操作</span></div><div class="tabs" role="group" aria-label="房态筛选">${['全部','空闲','营业中','待清洁','已预订'].map(f=>btn(f,'filter',`data-value="${f}"`,filter===f?'chip chosen':'chip')).join('')}</div><div class="rooms-grid">${state.rooms.filter(roomMatchesFilter).map(roomCard).join('') || '<p class="empty">目前没有这类房间。</p>'}</div><div class="tip"><span>✦</span><div><b>价格自动算，不用记表格</b><p>夜间房价已含赠饮，换酒不会加收差价。</p></div></div>${state.orders.filter(o=>o.status==='营业中'&&!state.rooms.some(r=>r.order===o.id)).map(o=>`<div class="panel"><b>${o.room} · 挂账被驳回，待收款</b>${btn('处理账单','order',`data-id="${o.id}"`)}</div>`).join('')}`;
}
function depositPage() {
  const rows = searchDeposits(state.deposits, searchTerm);
  const canHandle = allowedPermission('deposit.manage');
  const depositButton = canHandle ? btn('＋ 登记一笔存酒','deposit','','secondary full') : '<p class="notice">当前身份只能查询存酒；登记和取酒需要服务员或老板权限。</p>';
  return `<p class="eyebrow">客人的酒，记得清楚</p><h1>存酒 · 取酒</h1><p class="muted">手机号或姓名填写一个即可</p><div class="panel"><form id="search"><label>手机号或顾客姓名<input name="query" value="${esc(searchTerm)}" placeholder="例如：0318或王生" required></label><button class="primary full">查找存酒</button></form></div>${depositButton}<div class="section-title"><h2>${searchTerm?'查询结果':'如何操作'}</h2><span>${searchTerm?`${rows.length} 条记录`:''}</span></div>${!searchTerm?'<div class="empty">存酒：点“登记一笔存酒”，一次可添加多种酒<br>取酒：输入手机号任意部分或姓名，再选对应的酒<br><small>存酒不抵扣挂账，也不重复扣商品库存。</small></div>':!rows.length?'<div class="empty">没有找到对应的存酒记录。</div>':rows.map(d=>`<article class="panel"><div class="split"><h3>${product(d.product).name}</h3><b class="green">剩 ${d.count} 支</b></div><p>${esc(d.name)||'未留姓名'} · ${esc(d.phone)||'未留手机号'}</p><p class="muted">${d.room} 房 · ${date(d.time)} 存 ${d.initial} 支</p>${d.count?(canHandle?btn('核对并取酒','withdraw',`data-id="${d.id}"`):'<span class="badge">需要服务员或老板取酒</span>'):'<span class="badge">已取完</span>'}</article>`).join('')}`;
}
function creditDetailMarkup(o, includeActions=true) {
  const actions = !includeActions ? '' : o.status==='待审批挂账' ? (allowedPermission('credit.approve')?btn('查看签字并审批','review',`data-id="${o.id}"`):'<span class="badge">等待有审批权限的身份处理</span>') : o.status==='已挂账' ? (allowedPermission('credit.repay')?btn('登记回款','repay',`data-id="${o.id}"`):'<span class="badge">等待有回款权限的身份处理</span>') : '';
  const lastRepayment = o.credit.repayments?.at(-1);
  return `<p>${esc(contactText(o.credit))} · 挂账经办 ${esc(o.credit.person)}</p><p>开单：${esc(o.credit.openedBy || o.openedBy || o.person || '未记录')} · 开房渠道：${esc(o.credit.openSource || o.openSource || '线下')}</p><p>预订：${o.credit.reservedBy?`${esc(o.credit.reservedBy)}（${esc(o.credit.reservationSource || '方式未记录')}）`:'无预订'}</p><p>备注：${esc(o.credit.note || '未填写')}</p><p class="muted">${o.credit.approver}审批 · 到期 ${date(o.credit.due)}${lastRepayment?` · 最后回款 ${date(lastRepayment.time)}`:''}</p>${o.status==='已挂账' && new Date(state.clock)>new Date(o.credit.due)?'<p class="notice">已逾期 · 提醒店长，抄送财务（演示，无外发）</p>':''}${actions}`;
}
function creditCards() {
  const rows = state.orders.filter(o=>o.credit).map(o=>{
    if (o.status === '已回款') return `<details class="panel credit-repaid"><summary><span><b>${esc(o.room)} · ${esc(contactText(o.credit))}</b><small>原挂账 ${money(o.credit.amount)} · 点击查看详情</small></span><span class="badge">已回款</span></summary><div class="credit-details">${creditDetailMarkup(o,false)}</div></details>`;
    return `<article class="panel"><div class="split"><h3>${esc(o.room)} · ${money(o.credit.remaining)}</h3><span class="badge">${esc(o.status)}</span></div>${creditDetailMarkup(o)}</article>`;
  }).join('');
  return rows || '<div class="empty">暂无挂账。员工或老板可从营业账单的“结账”入口申请挂账。</div>';
}
function giftRequestCards() {
  const rows=state.orders.flatMap(o=>(o.giftRequests||[]).filter(request=>request.status==='待确认').map(request=>({o,request})));
  return rows.map(({o,request})=>`<article class="panel"><div class="split"><h3>${o.room} · ${product(request.product).name}</h3><span class="badge">待确认</span></div><p>${request.halves} 个半打，共 ${request.bottles} 支 · 申请人 ${esc(request.requestedBy)}</p>${btn('进入账单处理','order',`data-id="${o.id}"`)}</article>`).join('') || '<p class="muted">暂无超额赠酒水申请。</p>';
}
function roundingReviewCards() {
  const rows=state.orders.filter(order=>order.roundingReview?.status==='待审核');
  return rows.map(order=>`<article class="panel"><div class="split"><h3>${esc(order.room)} · 特殊情况 ${money(order.roundingReview.amount)}</h3><span class="badge">待店长审核</span></div><p>${esc(order.roundingReview.note)} · 提交人 ${esc(order.roundingReview.submittedBy)}</p><p class="muted">${date(order.roundingReview.submittedAt)}</p>${allowedPermission('rounding.approve')?btn('查看并审核','reviewRounding',`data-id="${order.id}"`):'<span class="badge">请店长处理</span>'}</article>`).join('') || '<p class="muted">暂无特殊差额待审核。</p>';
}
function permissionCards() {
  if (!allowedPermission('identity.manage')) return '';
  const users = Object.entries(USERS).filter(([id, user]) => !user.legacy && id !== 'administrator');
  const selected = users[0]?.[0] || '';
  const active = selected ? effectiveUser(state, selected) : null;
  const labels = active ? permissionSummary(active) : [];
  return `<article class="panel permission-single-card"><div class="split"><div><h3>身份权限</h3><p class="muted">每个身份单独调整具体操作权限，岗位名称只作说明。</p></div><span class="badge">管理员专用</span></div><label>选择身份<select id="permission-target" aria-label="选择要调整的身份">${options(users.map(([id, user]) => [id, user.name]), selected)}</select></label><p id="permission-target-summary" class="permission-summary muted">${labels.length ? esc(labels.join('、')) : '当前没有可用操作'}</p>${btn('调整具体权限','editPermissions',`data-id="${selected}"`,'secondary full')}</article>`;
}
function staffRecordingPanel() {
  if (!allowedPermission('staff.record')) return '';
  return `<div class="section-title"><h2>员工补录</h2><span>记录订房与增购归属</span></div><div class="menu-list staff-recording-panel">${btn('登记员工订房　→','staffBooking','','secondary')}${btn('登记员工增购酒水　→','staffSale','','secondary')}</div>`;
}
function managePage() {
  if (!allowedPermission('backend.view')) return '<p>当前身份没有管理后台权限，请切换管理员或由管理员分配“进入管理后台”权限。</p>';
  const pendingGifts=state.orders.reduce((sum,o)=>sum+(o.giftRequests||[]).filter(r=>r.status==='待确认').length,0);
  const pendingRounding=state.orders.filter(order=>order.roundingReview?.status==='待审核').length;
  const title = allowedPermission('identity.manage') ? '后台总管理' : '门店管理台';
  return `<p class="eyebrow">${title}</p><h1>今天，心里有数</h1><section class="summary"><div><strong>${money(collected(state))}</strong><span>练习累计实收</span></div><div><strong>${state.orders.filter(o=>o.status==='待审批挂账').length+pendingGifts+pendingRounding}</strong><span>待处理</span></div><div><strong>${money(state.orders.filter(o=>o.status==='已挂账').reduce((n,o)=>n+o.credit.remaining,0))}</strong><span>未回款</span></div></section>${staffRecordingPanel()}${allowedPermission('identity.manage')?`<div class="section-title"><h2>身份权限</h2><span>仅管理员可调整</span></div>${permissionCards()}`:''}<div class="section-title"><h2>特殊差额审核</h2></div>${roundingReviewCards()}<div class="section-title"><h2>赠酒水确认</h2></div>${giftRequestCards()}<div class="section-title"><h2>挂账与回款</h2></div>${creditCards()}${allowedPermission('inventory.adjust')||allowedPermission('inventory.opening')?`<div class="section-title"><h2>库存与提醒</h2>${btn('管理库存','inventory')}</div>${stockNotices()}`:''}${allowedPermission('handover')?`<div class="section-title"><h2>交班核对</h2>${btn('核对收款','handover')}</div>${handoverHistory()}`:''}`;
}
function stockNotices() {
  const low=Object.entries(state.inventory).filter(([,v])=>v.count!==null&&v.count<=v.threshold);
  const consumableLow=Object.entries(state.consumables || {}).filter(([,v])=>v.count!==null&&v.count<=v.threshold);
  return `${low.map(([id,v])=>`<p class="notice">${product(id).name}剩 ${v.count} 支，预警线 ${v.threshold} 支</p>`).join('')}${consumableLow.map(([id,v])=>`<p class="notice">${CONSUMABLES.find(item=>item.id===id)?.name || id}剩 ${v.count} ${v.unit || '份'}${v.opened?`，已开封 ${v.opened} 份`:''}，预警线 ${v.threshold}</p>`).join('')}${state.notices.slice().reverse().map(n=>n.kind==='consumable'?`<div class="panel"><b>${CONSUMABLES.find(item=>item.id===n.product)?.name || n.product}：${n.before ?? '未建账'} → ${n.after} ${n.unit || '份'}</b><p>${esc(n.person)} · ${date(n.time)}</p><p>${esc(n.reason)}</p><span class="badge">已生效 · 事后告知</span></div>`:`<div class="panel"><b>${product(n.product).name}：${n.before} → ${n.after} 支</b><p>${esc(n.person)} · ${date(n.time)}</p><p>${esc(n.reason)}</p><span class="badge">已生效 · 事后告知</span></div>`).join('')||'<p class="muted">暂无库管调整提醒。未建账商品不会预警。</p>'}`;
}
function handoverHistory() { return state.handovers.slice().reverse().map(h=>`<div class="panel"><b>${date(h.time)} · ${esc(h.person)}</b><p>系统实收 ${money(h.expected)} / 实点 ${money(h.actual)}</p><p>前台现金：${h.drawerCash===null||h.drawerCash===undefined?'旧记录未填写':money(h.drawerCash)}</p><strong class="${h.difference?'amber':'green'}">差异 ${money(h.difference)}</strong></div>`).join('') || '<p class="muted">尚未交班。挂账不计入实收，回款按实际登记计入。</p>'; }
function expensesPage() {
  const rows = [...visibleExpenses(state, currentUser())].sort((a,b) => String(b.date || '').localeCompare(String(a.date || '')) || Number(b.id || 0) - Number(a.id || 0));
  const totalAmount = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const fixedAmount = rows.filter(row => row.nature === '固定支出').reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const scopeText = allowedPermission('expense.viewAll') ? '当前显示所有人的记录。' : '当前只显示你登记的记录，其他人的支出由财务、店长、老板或管理员查看。';
  const body = rows.map(row => {
    const type = row.type || '支出', status = row.status || '已记录';
    const actions = status === '待老板审批' && allowedPermission('expense.approve') ? `<div class="expense-actions">${btn('批准','approveExpense',`data-id="${row.id}"`,'quiet')}${btn('驳回','rejectExpense',`data-id="${row.id}"`,'danger')}</div>` : '';
    return `<tr><td>${esc(row.date || '—')}</td><td>${esc(type)}</td><td class="expense-amount">${money(Number(row.amount || 0))}</td><td><span class="expense-method">${esc(row.method || '—')}</span></td><td><span class="expense-kind">${esc(row.nature || '—')}</span></td><td class="expense-description">${esc(row.description || '—')}</td><td class="expense-proof">${row.proof ? `<a href="${esc(row.proof)}" target="_blank" rel="noreferrer" title="${esc(row.proofName || '查看凭证')}"><img src="${esc(row.proof)}" alt="支出凭证"></a>` : '—'}</td><td><span class="badge">${esc(status)}</span>${actions}</td><td>${esc(row.person || '—')}</td></tr>`;
  }).join('');
  const emptyText = allowedPermission('expense.viewAll') ? '尚无支出或报销记录。' : '尚无你登记的支出或报销记录。';
  return `<p class="eyebrow">支出记录</p><div class="section-title expense-heading"><div><h1>支出 / 报销</h1><p class="muted">${scopeText} 图片凭证仅保存在本机演示数据中。</p></div><div class="expense-toolbar">${btn('返回我的','backMine','','quiet')}${allowedPermission('expense.create')?btn('＋ 添加记录','addExpense','','primary'):''}</div></div><section class="summary expense-summary"><div><strong>${rows.length}</strong><span>记录数</span></div><div><strong>${money(totalAmount)}</strong><span>支出合计</span></div><div><strong>${money(fixedAmount)}</strong><span>固定支出</span></div></section>${rows.length?`<div class="expense-table-wrap"><table class="expense-table"><caption><strong>支出与报销明细</strong><span>按日期倒序 · 共 ${rows.length} 条</span></caption><thead><tr><th>日期</th><th>类型</th><th>支出金额</th><th>付款方式</th><th>性质</th><th>说明</th><th>图片</th><th>状态</th><th>经办人</th></tr></thead><tbody>${body}</tbody><tfoot><tr><th>合计</th><td colspan="1">—</td><td class="expense-amount">${money(totalAmount)}</td><td colspan="6">—</td></tr></tfoot></table></div>`:`<div class="empty">${emptyText}<small>点击“添加记录”填写第一笔支出。</small></div>`}`;
}
function expenseDialog() {
  openDialog('添加支出 / 报销',`<p class="notice">报销金额超过 ${money(EXPENSE_APPROVAL_THRESHOLD)} 需要老板审批；图片凭证为选填，演示数据只保存在当前浏览器。</p><div class="field-pair"><label>日期<input type="date" name="date" value="${dayValue(state.clock)}" required></label><label>记录类型<select name="type">${options(EXPENSE_TYPES.map(type=>[type,type]),EXPENSE_TYPES[0])}</select></label></div><div class="field-pair"><label>支出金额（元）<input name="amount" inputmode="decimal" placeholder="例如：100.00" required></label><label>付款方式<select name="method">${options(PAYMENT_METHODS.map(method=>[method,method]),PAYMENT_METHODS[0])}</select></label></div><label>性质<select name="nature">${options(EXPENSE_NATURES.map(nature=>[nature,nature]),EXPENSE_NATURES[0])}</select></label><label>说明<textarea name="description" maxlength="200" rows="3" placeholder="例如：1月电费、采购水果、员工报销" required></textarea></label><label>图片凭证（选填）<input id="expense-proof" type="file" accept="image/*"><input id="expense-proof-data" type="hidden" name="proof"><input id="expense-proof-name" type="hidden" name="proofName"></label><p id="expense-proof-status" class="muted">支持图片凭证，单张不超过 500KB。</p>`,'保存记录','expense');
}
function procurementPage() {
  const rows=[...visibleProcurements(state,currentUser())].sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')) || Number(b.id||0)-Number(a.id||0));
  const totalAmount=rows.reduce((sum,row)=>sum+Number(row.amount||0),0);
  const scope=allowedPermission('procurement.viewAll')?'当前显示所有人的采购记录。':'当前只显示你登记的采购记录。';
  const body=rows.map(row=>`<article class="panel procurement-card"><div class="split"><div><h3>${esc(row.item)}</h3><p>${esc(row.date)} · ${row.quantity} ${esc(row.unit)} · ${money(row.amount)}</p></div><span class="badge">${esc(row.status||'已关联支出')}</span></div><p class="muted">${esc(row.type||'支出')} · ${esc(row.nature||'')} · ${esc(row.method||'')} · ${esc(row.person||'')}</p><p>${esc(row.description||'')}</p></article>`).join('');
  return `<p class="eyebrow">采购记录</p><div class="section-title expense-heading"><div><h1>采购</h1><p class="muted">${scope} 采购会自动关联一笔支出／报销记录。</p></div><div class="expense-toolbar">${btn('返回我的','backMine','','quiet')}${allowedPermission('procurement.create')?btn('＋ 登记采购','addProcurement','','primary'):''}</div></div><section class="summary expense-summary"><div><strong>${rows.length}</strong><span>采购笔数</span></div><div><strong>${money(totalAmount)}</strong><span>采购合计</span></div><div><strong>${rows.filter(row=>String(row.status||'').includes('待')).length}</strong><span>待审批</span></div></section>${rows.length?`<div class="procurement-list">${body}</div>`:`<div class="empty">${allowedPermission('procurement.viewAll')?'尚无采购记录。':'尚无你登记的采购记录。'}<small>点击“登记采购”填写第一笔采购。</small></div>`}`;
}
function procurementDialog() {
  openDialog('登记采购',`<p class="notice">采购会同步写入支出／报销记录；报销金额超过 ${money(EXPENSE_APPROVAL_THRESHOLD)} 会进入老板审批。</p><div class="field-pair"><label>日期<input type="date" name="date" value="${dayValue(state.clock)}" required></label><label>记录类型<select name="type">${options(EXPENSE_TYPES.map(type=>[type,type]),'支出')}</select></label></div><div class="field-pair"><label>采购项目<input name="item" maxlength="80" placeholder="例如：瓜子、纸巾" required></label><label>数量<input name="quantity" type="number" min="1" step="1" inputmode="numeric" required></label></div><div class="field-pair"><label>单位<input name="unit" maxlength="20" placeholder="包、箱、份" required></label><label>金额（元）<input name="amount" inputmode="decimal" placeholder="例如：120.00" required></label></div><div class="field-pair"><label>付款方式<select name="method">${options(PAYMENT_METHODS.map(method=>[method,method]),PAYMENT_METHODS[0])}</select></label><label>性质<select name="nature">${options(EXPENSE_NATURES.map(nature=>[nature,nature]),EXPENSE_NATURES[0])}</select></label></div><label>说明（选填）<textarea name="description" maxlength="200" rows="3" placeholder="例如：补充消耗品库存"></textarea></label>`,'保存采购并关联支出','procurement');
}
function incidentPage() {
  const rows=[...visibleIncidents(state,currentUser())].sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')) || Number(b.id||0)-Number(a.id||0));
  const reminders=pendingIncidentReminders(state,state.clock).filter(row=>rows.some(item=>item.id===row.id));
  const body=rows.map(row=>{const canResolve= row.status!=='已完成' && allowedPermission('incident.resolve') && (row.assignee===currentUser().name || allowedPermission('incident.viewAll')); return `<article class="panel incident-card ${row.status==='已完成'?'incident-complete':''}"><div class="split"><div><h3>${esc(row.type)} · ${esc(row.room)}</h3><p>${esc(row.date)} · 登记人 ${esc(row.person||'未记录')}</p></div><span class="badge">${esc(row.status)}</span></div><p>${esc(row.description)}</p><p class="muted">负责人：${esc(row.assignee||'未指定')}${row.status==='已完成'?` · ${esc(row.resolvedBy||'')} 于 ${date(row.resolvedAt)}`:''}</p>${row.status==='已完成'?`<div class="incident-result"><b>处理结果</b><p>${esc(row.result)}</p><b>备注</b><p>${esc(row.note)}</p></div>`:canResolve?btn('填写处理结果','resolveIncident',`data-id="${row.id}"`,'secondary full'):'<span class="badge">等待负责人处理</span>'}</article>`;}).join('');
  return `<p class="eyebrow">现场记录</p><div class="section-title expense-heading"><div><h1>客诉 / 异常</h1><p class="muted">${allowedPermission('incident.viewAll')?'当前显示全部记录。':'当前显示你登记或负责处理的记录。'} 未完成项目每天14:00提醒。</p></div><div class="expense-toolbar">${btn('返回我的','backMine','','quiet')}${allowedPermission('incident.create')?btn('＋ 登记客诉 / 异常','addIncident','','primary'):''}</div></div>${reminders.length?`<div class="notice incident-reminder">今天14:00提醒：还有 ${reminders.length} 项未完成，请及时填写处理结果。</div>`:''}<section class="summary expense-summary"><div><strong>${rows.length}</strong><span>记录数</span></div><div><strong>${rows.filter(row=>row.status!=='已完成').length}</strong><span>待处理</span></div><div><strong>${reminders.length}</strong><span>今日提醒</span></div></section>${rows.length?`<div class="incident-list">${body}</div>`:'<div class="empty">暂无客诉或异常记录。<small>登记后分配负责人填写处理结果和备注。</small></div>'}`;
}
function incidentDialog() {
  openDialog('登记客诉 / 异常',`<p class="notice">未完成项目会在每天14:00提醒；负责人可补充处理结果和备注。</p><div class="field-pair"><label>日期<input type="date" name="date" value="${dayValue(state.clock)}" required></label><label>房号<select name="room">${roomOptions()}</select></label></div><label>问题类型<select name="type">${options(INCIDENT_TYPES.map(type=>[type,type]),INCIDENT_TYPES[0])}</select></label><label>问题描述<textarea name="description" maxlength="300" rows="4" placeholder="请描述发生了什么" required></textarea></label><label>处理负责人<select name="assignee" required>${employeeOptions(state.user)}</select></label>`,'保存并指派负责人','incident');
}
function resolveIncidentDialog(id) {
  const row=state.incidents.find(item=>item.id===Number(id));
  if(!row) { toast('这条客诉／异常已经不存在'); return; }
  openDialog(`处理客诉 / 异常 · ${esc(row.room)}`,`<p>${esc(row.date)} · ${esc(row.type)}</p><div class="notice">${esc(row.description)}</div><label>处理结果<textarea name="result" maxlength="300" rows="4" placeholder="例如：已联系客人并完成补偿" required></textarea></label><label>备注<textarea name="note" maxlength="300" rows="3" placeholder="请记录后续跟进信息" required></textarea></label>`,'保存处理结果','resolveIncident',{id});
}
function myReservationSection() {
  const name=currentUser().name;
  const reservations=state.reservations.filter(reservation=>reservation.person===name).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
  const bookedOrders=state.orders.filter(order=>order.reservedBy===name);
  const beverageSales=bookedOrders.reduce((sum,order)=>sum+(order.sales||[]).reduce((amount,line)=>amount+Number(line.amount||0),0),0);
  const rows=reservations.map(reservation=>{
    const start=Date.parse(reservation.at), duration=reservation.session==='afternoon'?4:6;
    const linked=bookedOrders.find(order=>order.room===reservation.room&&Date.parse(order.time)>=start&&Date.parse(order.time)<start+duration*3600000);
    const added=linked?(linked.sales||[]).reduce((sum,line)=>sum+Number(line.amount||0),0):0;
    return `<article class="panel personal-booking"><div class="split"><h3>${esc(reservation.room)} · ${reservationDate(reservation.at)} ${esc(reservationSessionName(reservation))}</h3><span class="badge">${esc(reservation.status)}</span></div><p>预订方式：${esc(reservation.source || '未记录')}${reservation.note?` · ${esc(reservation.note)}`:''}</p><p class="muted">${linked?`已关联开房 · 酒水增购 ${money(added)}`:'尚未关联开房账单'}</p></article>`;
  }).join('');
  return `<div class="section-title"><h2>我的订房与酒水</h2><span>提成核对依据</span></div><section class="summary personal-commission-summary"><div><strong>${reservations.length}</strong><span>本人预订记录</span></div><div><strong>${bookedOrders.length}</strong><span>已关联开房</span></div><div><strong>${money(beverageSales)}</strong><span>关联酒水增购</span></div></section><p class="muted commission-note">这里只列本人名下的订房和酒水金额；提成比例及应发金额尚未配置。</p><div class="personal-booking-list">${rows||'<div class="empty">当前账户还没有预订房间记录。</div>'}</div>`;
}
function minePage() {
  const reminders=pendingIncidentReminders(visibleIncidents(state,currentUser()),state.clock);
  return `<p class="eyebrow">我的账户</p><h1>${esc(currentUser().name)}，辛苦了</h1><p class="muted">演示职责：${currentUser().roles.length?currentUser().roles.join('、'):'暂无岗位权限'}</p>${reminders.length?`<div class="notice incident-reminder">今天14:00提醒：还有 ${reminders.length} 项客诉／异常待处理。${btn('查看记录','incidents','', 'quiet')}</div>`:''}${myReservationSection()}${appearanceSettings()}<div class="section-title"><h2>练习设置</h2></div><div class="menu-list">${btn('切换演示身份　→','identity')}${btn('调整练习时间　→','clock')}${allowedPermission('expense.view')?btn('支出 / 报销记录　→','expenses'):''}${allowedPermission('procurement.create')||state.procurements?.length?btn('采购记录　→','procurement'):''}${allowedPermission('incident.create')||state.incidents?.length?btn('客诉 / 异常　→','incidents'):''}${allowedPermission('handover')?btn('交班 · 核对收款　→','handover'):''}${allowedPermission('inventory.adjust')||allowedPermission('inventory.opening')?btn('库存 · 建账与调整　→','inventory'):''}${btn('练习说明　→','guide')}${btn('恢复演示数据　→','reset','','danger')}</div><div class="tip"><span>i</span><div><b>这是一份操作演示</b><p>数据只保存在当前浏览器。不同手机不共享；身份切换不是真实登录。手工确认收款不代表银行到账。</p></div></div>${allowedPermission('credit.approve')||allowedPermission('credit.repay')?`<h2>挂账记录</h2>${creditCards()}`:''}`;
}
function staffBookingDialog() {
  openDialog('为员工登记订房',`<p class="notice">登记后订单归属所选员工，当前操作人会保留为登记人。</p><label>归属员工<select name="employee" required>${employeeOptions()}</select></label><label>房号<select name="room" required>${roomOptions()}</select></label>${bookingFields()}`,'确认登记订房','reserve');
  setupBookingFields();
}
function showRoom(id) {
  const r=state.rooms.find(r=>r.id===id);
  if (r.order) { showOrder(r.order); return; }
  if (r.status==='待清洁') { openDialog(`${id} · 待清洁`, `<p>完成打扫后，点下方按钮恢复空房。</p>${allowedPermission('room.open')?btn('客人已到，提示后继续开房','openDirty',`data-id="${id}"`):''}`, allowedPermission('room.clean')?'打扫好了，恢复空房':'','clean',{room:id}); return; }
  const currentBooking=pendingReservations(id).find(booking=>reservationActiveAt(booking,state.clock));
  if (r.status==='已预订' && currentBooking) { openDialog(`${id} · 当前场次预订`,`<p>预订日期 ${date(currentBooking.at)}</p><p>${esc(currentBooking.sessionLabel || '')}</p><p>预订方式：${esc(currentBooking.source || '未记录')}</p><p>预订人员：${esc(currentBooking.person || '未记录')}</p><p>${esc(currentBooking.note)||'无备注'}</p>${allowedPermission('room.open')?btn('客人到店，开房','open',`data-id="${id}"`):''}${allowedPermission('room.reserve')?btn('取消这笔预订','cancelReservation',`data-room="${id}" data-reservation="${currentBooking.id}"`,'danger'):''}${reservationListMarkup(id)}`); return; }
  openRoom(id);
}
function openRoom(id, dirty=false) {
  const r=state.rooms.find(r=>r.id===id), closed=slot(state.clock)==='closed';
   openDialog(`${id} · ${r.type}${closed?'预订':'开房'}`, closed?`<p class="notice">现在是非营业时段，只接受预订。</p>${bookingFields()}${reservationListMarkup(id)}`:`<p class="muted">${date(state.clock)} · ${slot(state.clock)==='day'?'白天纯唱':'夜间套餐'}</p>${dirty?'<p class="notice">房间尚未标记清洁。提交即确认可以接待客人。</p>':''}${reservationListMarkup(id)}<label>开房渠道<select name="openSource">${options(OPENING_SOURCES.map(source=>[source,source||'线下（默认）']),'')}</select></label>${slot(state.clock)==='night'?`<label>客人选哪种酒水<select name="beer">${options(beers,'bw')}</select></label><section id="initial-mix" class="initial-mix" hidden><div class="split"><b>首次配酒水</b><span id="mix-total" class="badge"></span></div><p class="muted">开房前直接选好种类和支数；开房后再调整请点“换酒水”。</p><div id="mix-items"></div>${btn('＋ 添加一种酒水','addInitialMix','','secondary full')}</section>`:'<p>白天不带赠饮，可开房后另行加购。</p>'}<div id="quote-box"></div>${!dirty&&r.status==='空闲'&&allowedPermission('room.reserve')?btn('预订其他未来场次','reserveFuture',`data-id="${id}"`,'quiet'):''}`,closed?'确认预订':'确认开房',closed?'reserve':'open',{room:id,acceptDirty:dirty?'yes':''});
  if (closed) setupBookingFields();
  else {
    const f=modal.querySelector('form');
    const update=()=> {
      const q=quote(r.type,state.clock,f.elements.beer?.value || 'bw',f.elements.openSource?.value || ''), mix=document.querySelector('#initial-mix');
      let mixText='';
      if (mix) {
        const show=f.elements.beer.value==='drink'; mix.hidden=!show; mix.dataset.max=q.bottles;
        if (show && !document.querySelector('.initial-mix-item')) document.querySelector('#mix-items').innerHTML=initialMixRow(q.bottles,q.bottles);
        const sum=show?[...f.querySelectorAll('[name="mixCount"]')].reduce((n,input)=>n+Number(input.value||0),0):0;
        document.querySelector('#mix-total').textContent=show?`${sum} / ${q.bottles} 支`:'';
        mix.classList.toggle('invalid',show&&sum!==q.bottles);
        mixText=show?`<br><b>首次配酒水 ${sum}/${q.bottles} 支</b>`:'';
      }
      const voucherText=q.voucher?`<div class="notice">${esc(q.voucher.provider)}平台券覆盖开房费用 ${money(q.voucher.covered)}，当前按${money(0)}开房；扫码验券接口待接入。</div>`:'';
      const details=q.bottles?`${product(f.elements.beer.value).name} ${q.bottles} 支 · ${q.dozen} 打赠饮${mixText}<br>${q.extras.map(e=>`${product(e.product).name} ${e.count} 份`).join(' · ')}<br><small>${q.voucher?'平台券已覆盖开房费用，赠饮随券记录':'基础房费 '+money(q.base)+' ＋ 赠饮 '+money(q.gift)+'，已含在总价内'}</small>`:'纯唱包间费，无赠饮';
      document.querySelector('#quote-box').innerHTML=`${voucherText}<div class="quote"><span>客人共需支付</span><strong>${money(q.total)}</strong><p>${details}</p></div>`;
      f.querySelector('[type=submit]').textContent=`确认开房 · ${money(q.total)}`;
    };
    f.addEventListener('change',update); f.addEventListener('input',update); update();
  }
}
function initialMixRow(max, value=1, selected='drink0') { return `<div class="initial-mix-item"><div class="deposit-item-head"><b>酒水种类</b>${btn('移除','removeInitialMix','','quiet')}</div><label>选择酒水<select name="mixProduct">${options(initialMixChoices,selected)}</select></label>${stepper(max,'数量（支）','mixCount',value)}</div>`; }
function bookingFields() { const hour=new Date(state.clock).getHours(), day=hour>=20?'1':'0', session=hour<14?'afternoon':'night'; return `<div class="field-pair"><label>哪一天<select name="dayChoice">${options([['0','今天'],['1','明天'],['2','后天'],['custom','第几天后']],day)}</select></label><label id="custom-day-field" hidden>第几天后<input type="number" name="customDays" inputmode="numeric" min="3" max="30" value="3"></label></div><label>预订时段<select name="session">${options([['afternoon','下午场（14:00—18:00）'],['night','夜间场（20:00—次日02:00）']],session)}</select></label><fieldset class="choice-field"><legend>预订方式</legend><div class="radio-grid">${RESERVATION_SOURCES.map(source=>`<label class="radio-option"><input type="radio" name="source" value="${source}" ${source==='手机'?'checked':''}><span>${source}</span></label>`).join('')}</div></fieldset><p class="muted">可提前预定；下午场为14:00到18:00，夜间场为20:00到次日2:00。</p><p class="muted">到预订场次仍未开房，系统每隔1小时提醒预订人员。</p><label>备注（选填）<input name="note" maxlength="100" placeholder="例如：王生/130****0000，晚上8点到"></label>`; }
function setupBookingFields() {
  const f = modal.querySelector('form');
  const select = f?.elements.dayChoice;
  if (!select) return;
  const update = () => { document.querySelector('#custom-day-field').hidden = select.value !== 'custom'; };
  select.addEventListener('change', update); update();
}
function openBookingDialog(id) {
  openDialog(`${id} · 预订未来场次`,bookingFields(),'确认预订','reserve',{room:id});
  setupBookingFields();
}
function showOrder(id) {
  const o=state.orders.find(o=>o.id===id);
  const bonus=(o.bonusGifts||[]).map(line=>{
    const drinks=(line.drinks||[]).filter(drink=>drink.count), unchanged=drinks.length===1&&drinks[0].product===line.product&&drinks[0].count===line.bottles;
    return `<div class="bill-line"><span>赠送 · ${product(line.product).name} ${line.bottles}支</span><b>¥0</b></div>${unchanged?'':`<div class="drink-list"><p><b>这份赠送实际领取</b></p>${drinks.map(drink=>`<p>${product(drink.product).name} <b>${drink.count} 支</b></p>`).join('')}</div>`}`;
  }).join('');
  const requests=(o.giftRequests||[]).filter(request=>request.status==='待确认').map(request=>`<div class="notice"><b>赠酒水待确认</b><p>${product(request.product).name} ${request.halves}个半打，共${request.bottles}支 · ${esc(request.requestedBy)}申请</p>${allowedPermission('gift.approve')?`<div class="inline-actions">${btn('批准赠送','approveGift',`data-id="${id}" data-request="${request.id}"`,'primary')}${btn('驳回','rejectGift',`data-id="${id}" data-request="${request.id}"`,'danger')}</div>`:'<small>请老板／店长确认后再结账</small>'}</div>`).join('');
  const futureReservations=pendingReservations(o.room);
  const futureText=futureReservations.length?`<br>未来预订：${futureReservations.map(booking=>`${date(booking.at)} · ${esc(booking.sessionLabel || '')}`).join('；')}`:'';
  const attribution=o.recordedBy && o.recordedBy!== (o.openedBy || o.person) ? ` · 归属员工：${esc(o.openedBy || o.person || '未记录')} · 代录：${esc(o.recordedBy)}`:'';
  const origin=`<p class="muted">开单：${esc(o.openedBy || o.person || '未记录')}${attribution} · 开房渠道：${esc(o.openSource || '线下')}${o.reservedBy?` · 预订：${esc(o.reservedBy)}（${esc(o.reservationSource || '方式未记录')}）`:''}${futureText}</p>`;
  const voucherNotice=o.voucher?`<div class="notice">${esc(o.voucher.provider)}平台券开房费用 ${money(o.voucher.covered)} · ${esc(o.voucher.status)} · 扫码验券接口待接入</div>`:'';
  const saleLines=o.sales.map(line=>{
    const drinks=(line.drinks||[]).filter(drink=>drink.count);
    const unchanged=drinks.length===1&&drinks[0].product===line.product&&drinks[0].count===line.bottles;
    return `<div class="bill-line"><span>${product(line.product).name} × ${line.count}${line.spec==='dozen'?'打':line.spec==='half'?'半打':'支'}<small> · 归属 ${esc(line.person || o.openedBy || o.person || '未记录')}${line.recordedBy && line.recordedBy!==line.person?` · 代录 ${esc(line.recordedBy)}`:''}</small></span><b>${money(line.amount)}</b></div>${unchanged?'':`<div class="drink-list"><p><b>这笔增购实际领取</b></p>${drinks.map(drink=>`<p>${product(drink.product).name} <b>${drink.count} 支</b></p>`).join('')}</div>`}`;
  }).join('');
  const otherLines=(o.otherCharges||[]).map(line=>`<div class="bill-line"><span>其他消费 · ${esc(line.category==='其他'?line.item:line.category)}</span><b>${money(line.amount)}</b></div>`).join('');
  const received=(o.payments||[]).reduce((sum,payment)=>sum+payment.amount,0), due=outstanding(o);
  const exchangeable=[...o.drinks,...o.sales.flatMap(line=>line.drinks||[]),...(o.bonusGifts||[]).flatMap(line=>line.drinks||[])].some(line=>line.count&&product(line.product).level!==4);
  const actions=o.status==='营业中'?`<div class="action-grid">${allowedPermission('order.sale')?`${btn('＋ 加酒水','sale',`data-id="${id}"`,'primary')}${btn('＋ 加其他','otherCharge',`data-id="${id}"`)}`:''}${exchangeable&&allowedPermission('order.exchange')?btn('⇄ 换酒水','exchange',`data-id="${id}"`):''}${allowedPermission('order.gift')?btn('＋ 赠酒水','gift',`data-id="${id}"`):''}${allowedPermission('room.reserve')?btn('预订未来场次','reserveFuture',`data-id="${id}"`):''}${allowedPermission('payment.collect')&&nextCollectCharge(o)?btn('收钱','collect',`data-id="${id}"`,'primary'):''}${allowedPermission('payment.settle')||allowedPermission('credit.apply')?btn('结账','checkout',`data-id="${id}"`,'primary'):''}</div>`:'';
  const openingDetails=o.gift||o.drinks.length?`<div class="bill-line"><span>${o.voucher?'平台券赠饮（已含）':'套餐赠饮（已含）'}</span><b>${money(o.gift)}</b></div><div class="drink-list">${o.drinks.filter(d=>d.count).map(d=>`<p>${product(d.product).name} <b>${d.count} 支</b></p>`).join('')}${(o.extras||[]).map(d=>`<p>${extraLabels[d.product] || product(d.product).name} ${d.count} 份 · ${d.served?'已上':'待上'}</p>`).join('')}</div>`:'';
  openDialog(`${o.room} · 账单`, `<div class="quote"><span>本单总额</span><strong>${money(total(o))}</strong><p>${o.status} · ${date(o.time)} 开房<br>已收 ${money(received)} · 待收 ${money(due)}</p></div>${voucherNotice}${origin}${reservationListMarkup(o.room)}<div class="bill-line"><span>基础包间费</span><b>${money(o.base)}</b></div>${openingDetails}${saleLines}${otherLines}${bonus}${requests}${received?`<div class="bill-line"><span>已登记收款</span><b>${money(received)}</b></div>`:''}<p class="muted">加时费 ¥0 · 按开房时段计价</p>${actions}`);
}
function giftDialog(id) {
  const o=state.orders.find(o=>o.id===id);
  const productIds=[...new Set(o.sales.filter(line=>product(line.product).saleDozen).map(line=>line.product))];
  if (!productIds.length) { toast('请先增购酒水，再登记赠送'); return; }
  const labels=productIds.map(productId=>{const a=bonusAllowance(o,productId);return [productId,`${product(productId).name} · 已增购${a.purchased}支`];});
  openDialog('赠酒水',`<p class="notice">同一种酒水每增购24支，可由开单员／服务员赠送对应酒水半打；超出数量交老板／店长确认。</p><label>对应酒水<select name="product">${options(labels)}</select></label>${stepper(99,'赠送几个半打','halves')}<div id="gift-hint" class="quote compact"></div>`,'确认赠酒水','gift',{order:id});
  const f=modal.querySelector('form'), update=()=>{const a=bonusAllowance(o,f.elements.product.value), halves=Number(f.elements.halves.value), manager=allowedPermission('gift.approve'), direct=Math.min(halves,a.availableHalves), excess=Math.max(0,halves-direct);let hint='本次确认后立即赠送',label='确认赠酒水';if(!manager&&excess){hint=direct?`先直接赠${direct}个半打，另${excess}个提交老板／店长确认`:'本次超出规则，提交老板／店长确认';label=direct?'确认赠送并提交额外部分':'提交确认';}document.querySelector('#gift-hint').innerHTML=`已增购 ${a.purchased} 支<br>规则内还可赠 ${a.availableHalves} 个半打<br><small>${hint}</small>`;f.querySelector('[type=submit]').textContent=label;};
  f.addEventListener('input',update);f.addEventListener('change',update);update();
}
const saleCategories=[['啤酒','啤酒'],['饮料','饮料'],['汽水','汽水'],['瓶装水','瓶装水']];
const saleProductCategories=value=>value==='啤酒'?['普通啤酒','高端啤酒']:[value];
function saleItemRow(selectedCategory=category, selectedProduct='', selectedSpec='single', value=1) {
  const uiCategory=['普通啤酒','高端啤酒'].includes(selectedCategory)?'啤酒':selectedCategory;
  const products=PRODUCTS.filter(p=>saleProductCategories(uiCategory).includes(p.category)&&p.price>0);
  const productId=products.some(p=>p.id===selectedProduct)?selectedProduct:products[0]?.id;
  const p=productId?product(productId):PRODUCTS.find(item=>item.price>0);
  const specs=[['single',`单支 · ${money(p.price)}`],...(p.saleDozen?[['half',`半打6支 · ${money(p.dozen/2)}`],['dozen',`整打12支 · ${money(p.dozen)}`]]:[])];
  const spec=specs.some(([id])=>id===selectedSpec)?selectedSpec:'single';
  return `<div class="sale-item"><div class="deposit-item-head"><b>酒水品项</b>${btn('移除','removeSaleItem','','quiet')}</div><label>类别<select name="saleCategory">${options(saleCategories,uiCategory)}</select></label><label>商品<select name="saleProduct">${options(products.map(item=>[item.id,item.name]),productId)}</select></label><label>销售规格<select name="saleSpec">${options(specs,spec)}</select></label>${stepper(999,'数量（按所选规格）','saleCount',value)}<p class="sale-line-total muted"></p></div>`;
}
function saleDialog(id, staffMode=false) {
  const activeOrders=state.orders.filter(order=>order.status==='营业中');
  const orderField=staffMode?`<label>归属账单<select name="order" required>${options(activeOrders.map(order=>[order.id,`${order.room} · ${money(total(order))} · ${order.openedBy || order.person || '未记录'}`]),id)}</select></label><label>归属员工<select name="employee" required>${employeeOptions()}</select></label>`:'';
  openDialog(staffMode?'为员工登记增购酒水':'加酒水',`${orderField}<p class="notice">一单可以添加多种酒水，按“添加一种酒水”继续录入。</p><div id="sale-items">${saleItemRow()}</div>${btn('＋ 添加一种酒水','addSaleItem','','secondary full')}<div id="sale-total" class="quote compact"></div>`, '确认加单','sale',staffMode?{}:{order:id});
  const f=modal.querySelector('form');
  const updateAll=()=> {
    let amount=0;
    f.querySelectorAll('.sale-item').forEach(row=>{
      const categorySelect=row.querySelector('[name="saleCategory"]'), productSelect=row.querySelector('[name="saleProduct"]'), specSelect=row.querySelector('[name="saleSpec"]');
      const currentProduct=productSelect.value, products=PRODUCTS.filter(p=>saleProductCategories(categorySelect.value).includes(p.category)&&p.price>0);
      productSelect.innerHTML=options(products.map(item=>[item.id,item.name]),currentProduct);
      const p=product(productSelect.value), currentSpec=specSelect.value, specs=[['single',`单支 · ${money(p.price)}`],...(p.saleDozen?[['half',`半打6支 · ${money(p.dozen/2)}`],['dozen',`整打12支 · ${money(p.dozen)}`]]:[])];
      specSelect.innerHTML=options(specs,currentSpec);
      const spec=specSelect.value, count=Math.max(1,Number(row.querySelector('[name="saleCount"]').value)||1), price=spec==='dozen'?p.dozen:spec==='half'?p.dozen/2:p.price;
      amount+=price*count;
      row.querySelector('.sale-line-total').textContent=`本行 ${money(price*count)} · ${p.name} ${spec==='dozen'?'整打':spec==='half'?'半打':'单支'}`;
    });
    document.querySelector('#sale-total').textContent=`本次加单合计 ${money(amount)}`;
  };
  f.addEventListener('change',updateAll); f.addEventListener('input',updateAll); f._updateSale=updateAll; updateAll();
}
function otherChargeDialog(id) {
  openDialog('加其他',`<p class="notice">其他消费会加入本房账单，可单独收钱，也会计入最终结账。</p><label>类别<select name="category">${options(OTHER_CHARGE_CATEGORIES.map(item=>[item,item]),OTHER_CHARGE_CATEGORIES[0])}</select></label><label id="other-charge-item" hidden>项目<input name="item" maxlength="50" placeholder="例如：生日布置"></label><label>金额（元）<input name="amount" inputmode="decimal" placeholder="例如：88.00" required></label><p id="other-charge-hint" class="muted"></p>`, '确认加到本单','otherCharge',{order:id});
  const f=modal.querySelector('form'), categorySelect=f.elements.category, itemField=f.querySelector('#other-charge-item'), itemInput=f.elements.item, hint=f.querySelector('#other-charge-hint');
  const update=()=>{const custom=categorySelect.value==='其他';itemField.hidden=!custom;itemInput.disabled=!custom;itemInput.required=custom;hint.textContent=custom?'请填写具体项目和金额。':categorySelect.value==='代驾'?'请填写本次代驾金额。':`请填写本次${categorySelect.value}消费金额。`;};
  categorySelect.addEventListener('change',update);update();
}
function stepper(max=999, label='数量（支）', name='count', value=1) { const id=`quantity-${++controlSequence}`; return `<div class="quantity-field"><label for="${id}">${label}</label><div class="stepper">${btn('−','step','data-delta="-1" aria-label="减少数量"')}<input id="${id}" name="${name}" type="number" inputmode="numeric" min="1" max="${max}" value="${value}" required aria-label="${label}">${btn('＋','step','data-delta="1" aria-label="增加数量"')}</div></div>`; }
function depositItemRow() { return `<div class="deposit-item"><div class="deposit-item-head"><b>存酒品项</b>${btn('移除','removeDepositItem','','quiet')}</div><label>酒名<select name="depositProduct">${options(beers)}</select></label>${stepper(999,'数量（支）','depositCount')}</div>`; }
function openDepositDialog() {
  const prefilledPhone = /^1\d{10}$/.test(searchTerm) ? searchTerm : '';
  const prefilledName = searchTerm && !/^\d+$/.test(searchTerm) ? searchTerm : '';
  openDialog('登记存酒',`<p class="muted">手机号、姓名至少填写一个；一次可以添加多种酒。</p><label>手机号（选填）<input type="tel" name="phone" inputmode="tel" pattern="1[0-9]{10}" maxlength="11" value="${esc(prefilledPhone)}"></label><label>姓名（选填）<input name="name" maxlength="30" value="${esc(prefilledName)}"></label><label>房间<select name="room">${roomOptions()}</select></label><div id="deposit-items">${depositItemRow()}</div>${btn('＋ 添加一种酒','addDepositItem','','secondary full')}<p class="muted">存酒日期：${date(state.clock)}。已售出的酒单独保管，不再扣商品库存。</p>`,'确认存酒','deposit');
}
function exchangeDialog(id) {
  const o=state.orders.find(o=>o.id===id);
  const lines=[...o.drinks.map(line=>({key:`gift:${line.id}`,line,label:`套餐 · ${product(line.product).name}`})),...o.sales.flatMap(sale=>(sale.drinks||[]).map(line=>({key:`sale:${line.id}`,line,label:`增购 · ${product(line.product).name}`}))),...(o.bonusGifts||[]).flatMap(gift=>(gift.drinks||[]).map(line=>({key:`bonus:${line.id}`,line,label:`赠送 · ${product(line.product).name}`})))].filter(item=>item.line.count&&product(item.line.product).level!==4);
  if (!lines.length) { toast('没有可换出的酒水，瓶装水不能继续换出'); return; }
  openDialog('换酒水 · 不加钱',`<p class="notice">套餐、增购和已赠酒水都可按 1 支换 1 支，可只换几支。原账单金额不变。</p><label>从哪份酒水换出<select name="line">${options(lines.map(item=>[item.key,`${item.label} · 可换${item.line.count}支`]))}</select></label><label>换成<select name="product"></select></label>${stepper()}<p class="muted">换酒后，本单总额仍为 ${money(total(o))}</p>`,'确认换酒水','exchange',{order:id});
  const f=modal.querySelector('form'); const update=()=> { const item=lines.find(row=>row.key===f.elements.line.value); f.elements.product.innerHTML=options(PRODUCTS.filter(p=>canExchange(item.line.product,p.id)).map(p=>[p.id,p.name])); f.elements.count.max=item.line.count; f.elements.count.value=1; }; f.elements.line.addEventListener('change',update); update();
}
function paymentRow(amount=0, selected=PAYMENT_METHODS[0]) {
  return `<div class="payment-row"><label>付款方式<select name="paymentMethod">${options(PAYMENT_METHODS.map(method=>[method,method]),selected)}</select></label><label>已收到（元）<input name="paymentAmount" inputmode="decimal" value="${amount?(amount/100).toFixed(2):'0'}" required></label>${btn('移除','removePayment','','quiet')}</div>`;
}
function paymentFields(amount, allowRounding=false) {
  const differenceFields=allowRounding?`<label>差额处理<select name="differenceType"><option value="免零" selected>免零（默认）</option><option value="特殊情况">特殊情况（需店长审核）</option></select></label><div id="difference-note" hidden><label>特殊情况说明<textarea name="differenceNote" maxlength="200" placeholder="请填写少收原因，结账后提醒店长审核"></textarea></label></div>`:'';
  return `<p class="notice">请先核实收款码已到账或现金已收到，再登记。此处不会自动扣款。${allowRounding?'结账少收时请选择差额处理方式；特殊情况需填写说明并提醒店长审核。':''}</p><div id="payment-lines">${paymentRow(amount)}</div>${btn('＋ 添加一笔付款','addPayment','','secondary full')}<p id="pay-sum"></p>${differenceFields}<label class="check"><input type="checkbox" required>我已核实以上款项（演示确认）</label>`;
}
function bindPaymentSummary(amount, allowRounding=false) {
  const form=modal.querySelector('form'), output=document.querySelector('#pay-sum');
  if (!output) return;
  const type=form.elements.differenceType, noteBox=document.querySelector('#difference-note'), note=form.elements.differenceNote;
  const syncDifference=()=>{if(!type||!noteBox||!note)return;const special=type.value==='特殊情况';noteBox.hidden=!special;note.disabled=!special;note.required=special;};
  const update=()=> { syncDifference(); try { const entered=[...form.querySelectorAll('[name="paymentAmount"]')].reduce((sum,input)=>sum+cents(input.value||'0'),0), differenceLabel=type?.value||'免零'; output.textContent=`已填写 ${money(entered)} · ${entered===amount?'金额一致':entered<amount&&allowRounding?`${differenceLabel} ${money(amount-entered)}`:entered<amount?`还差 ${money(amount-entered)}`:`多填 ${money(entered-amount)}`}`; } catch { output.textContent='请填写有效金额'; } };
  form.addEventListener('input',update);form.addEventListener('change',update);update();
}
function collectDialog(id) {
  const o=state.orders.find(o=>o.id===id), charge=nextCollectCharge(o);
  if (!charge) { toast('本单没有待收费用'); return; }
  openDialog(`${o.room} · 收钱`,`<div class="quote"><span>本次只收</span><strong>${money(charge.remaining)}</strong><p>${esc(charge.label)}</p></div><p class="muted">收钱后房间继续营业。若刚增购酒水，本次只收最近一笔未收的增购；否则收开房费用。</p>${paymentFields(charge.remaining)}`,`确认收到 ${money(charge.remaining)}`,'collect',{order:id,charge:charge.id});
  bindPaymentSummary(charge.remaining);
}
function checkout(id) {
  const o=state.orders.find(o=>o.id===id), due=outstanding(o), received=total(o)-due;
  const pending=collectableCharges(o).map(charge=>`<div class="bill-line"><span>${esc(charge.label)}</span><b>${money(charge.remaining)}</b></div>`).join('');
  const canReceive=allowedPermission('payment.settle');
  const payment=due?(canReceive?paymentFields(due,true):'<p class="notice">当前身份可申请挂账；实际收款结账请切换有收银员或老板权限的身份。</p>'):'<p class="notice">费用已经通过“收钱”登记完毕。确认结账后，房间转为待清洁。</p>';
  const creditButton=due&&allowedPermission('credit.apply')?btn('客人暂未付款，申请挂账','credit',`data-id="${id}"`,'quiet full'):'';
  openDialog(`${o.room} · 结账`,`<div class="quote"><span>结账待收</span><strong>${money(due)}</strong><p>本单总额 ${money(total(o))} · 已收 ${money(received)}</p></div>${pending||'<p class="muted">没有未收费用。</p>'}<p class="muted">结账汇总“收钱”尚未登记的费用；完成结账后房间才转为待清洁。</p>${payment}${creditButton}`,canReceive?(due?`确认结账并收到 ${money(due)}`:'确认结账，转待清洁'):'',canReceive?'settle':'',{order:id});
  if (canReceive&&due) bindPaymentSummary(due,true);
}
function creditDialog(id) {
  const o=state.orders.find(o=>o.id===id), amount=outstanding(o);
  if (!amount) { toast('本单已经收清，无需挂账'); return; }
  openDialog('申请挂账',`<p>挂账 ${money(amount)} · 交给${amount>100000?'老板':'店长'}审批</p><div class="notice">开单：${esc(o.openedBy || o.person || '未记录')}<br>开房渠道：${esc(o.openSource || '线下')}<br>${o.reservedBy?`预订：${esc(o.reservedBy)}（${esc(o.reservationSource || '方式未记录')}）`:'本单没有预订记录'}</div><p class="muted">手机号或顾客姓名至少填写一个。</p><label>客人手机号（选填）<input name="phone" type="tel" inputmode="tel" pattern="1[0-9]{10}" maxlength="11"></label><label>顾客姓名（选填）<input name="name" maxlength="30"></label><label>挂账备注<textarea name="note" maxlength="200" required placeholder="例如：王生宴请，承诺明晚结清"></textarea></label><p>挂账经办：<b>${currentUser().name}</b>（不可改选）</p><label>经办员工本人手写签字<canvas id="signature" width="600" height="220" aria-label="手写签名区域"></canvas></label>${btn('重新签字','clearSignature','','quiet')}<p class="muted">签字提交起算24小时。申请后锁定结账，房间释放为待清洁；审批通过前不计实收。</p>`,'签字完成，提交审批','credit',{order:id});
  const canvas=document.querySelector('#signature'), ctx=canvas.getContext('2d'); ctx.lineWidth=4; ctx.lineCap='round'; ctx.strokeStyle='#183c32'; let down=false;
  const pos=e=> { const r=canvas.getBoundingClientRect(); return [(e.clientX-r.left)*canvas.width/r.width,(e.clientY-r.top)*canvas.height/r.height]; };
  canvas.addEventListener('pointerdown',e=>{ down=true; canvas.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); });
  canvas.addEventListener('pointermove',e=>{ if(down){ctx.lineTo(...pos(e));ctx.stroke();canvas.dataset.signed='yes';} });
  canvas.addEventListener('pointerup',()=>down=false); canvas.addEventListener('pointercancel',()=>down=false);
}
function inventoryDialog() {
  const drinkRows=Object.entries(state.inventory).map(([id,v])=>{const canStock=v.count===null?allowedPermission('inventory.opening'):allowedPermission('inventory.adjust');return `<div class="stock-row"><div><b>${product(id).name}</b><p>${v.count===null?'未建账':`${v.count} 支 · 预警线 ${v.threshold}`}</p></div>${canStock?btn(v.count===null?'建账':'调整','stock',`data-id="${id}"`):'<span class="badge">无库存调整权限</span>'}</div>`;}).join('');
  const consumableRows=Object.entries(state.consumables || {}).map(([id,v])=>{const item=CONSUMABLES.find(entry=>entry.id===id), canStock=v.count===null?allowedPermission('inventory.opening'):allowedPermission('inventory.adjust');return `<div class="stock-row"><div><b>${esc(item?.name || id)}</b><p>${v.count===null?'未建账':`${v.count} ${esc(v.unit || item?.unit || '份')} · 已开封 ${v.opened || 0} · 预警线 ${v.threshold}`}</p></div>${canStock?btn(v.count===null?'建账':'调整','consumableStock',`data-id="${id}"`):'<span class="badge">无库存调整权限</span>'}</div>`;}).join('');
  const logs=state.ledger.slice(-30).reverse().map(l=>{const isConsumable=l.kind==='consumable', label=isConsumable?(CONSUMABLES.find(item=>item.id===l.product)?.name || l.product):product(l.product).name;return `<div class="log"><b>${esc(label)} ${isConsumable?`${l.before ?? '未建账'} → ${l.after} ${l.unit || '份'}`:`${l.delta>0?'+':''}${l.delta} 支`}</b><p>${esc(l.source)} · ${esc(l.person)} · ${date(l.time)}</p><small>${l.counted?'计入账面':'建账前 · 不计账面'}${l.reason?' · '+esc(l.reason):''}</small></div>`;}).join('');
  openDialog('库存 · 酒水与消耗品',`<p class="notice">酒水按支数统计；消耗品按包数／份数统计，并记录已开封数量。未盘点商品显示“未建账”，照记流水但不拦营业。</p><h3>酒水库存</h3>${drinkRows}<h3>消耗品库存</h3>${consumableRows}<h3>最近库存流水</h3>${logs||'<p class="muted">暂无流水</p>'}`);
}
function permissionsDialog(id) {
  if (!allowed(['管理员'])) { toast('仅管理员可以调整身份权限'); return; }
  const base = USERS[id];
  if (!base || base.legacy || id === 'administrator') { toast('该身份不能调整'); return; }
  const active = effectiveUser(state, id);
  const groups = [...new Set(PERMISSION_DEFINITIONS.map(permission => permission.group))];
  const checks = groups.map(group => `<fieldset class="choice-field"><legend>${esc(group)}</legend>${PERMISSION_DEFINITIONS.filter(permission => permission.group === group).map(permission => `<label class="check"><input type="checkbox" name="permission" value="${esc(permission.id)}" ${active.permissions.includes(permission.id)?'checked':''}>${esc(permission.label)}</label>`).join('')}</fieldset>`).join('');
  openDialog(`调整具体权限 · ${esc(base.name)}`,`<p class="notice">按具体操作开关权限，可全部取消以暂时停用此身份。岗位名称只用于说明，不会代替这里的具体权限。</p>${checks}`,'保存具体权限','setPermissions',{user:id});
}
document.addEventListener('change',e=>{
  if(e.target.id==='report-period'){ reportPeriod=e.target.value; render(); window.scrollTo(0,0); return; }
  if(e.target.id==='appearance-preference'){
    const saved=window.ktvAppearance.setPreference(e.target.value);
    syncAppearanceControls();
    toast(`${e.target.value==='auto'?'已设为自动：日出至19:00日间，其余时间夜间':e.target.value==='dark'?'已设为夜间模式':'已设为日间模式'}${saved?'':' · 本次切换仅在当前页面有效'}`);
    return;
  }
  if(e.target.id==='permission-target'){
    const button=document.querySelector('[data-action="editPermissions"]');
    if(button) button.dataset.id=e.target.value;
    const user=effectiveUser(state,e.target.value), summary=document.querySelector('#permission-target-summary');
    if(summary) summary.textContent=permissionSummary(user).join('、') || '当前没有可用操作';
    return;
  }
  if(e.target.id==='expense-proof'){
    const input=e.target, file=input.files?.[0], dataInput=document.querySelector('#expense-proof-data'), nameInput=document.querySelector('#expense-proof-name'), status=document.querySelector('#expense-proof-status');
    if(!file){ if(dataInput)dataInput.value=''; if(nameInput)nameInput.value=''; if(status)status.textContent='支持图片凭证，单张不超过 500KB。'; return; }
    if(!file.type.startsWith('image/') || file.size>500*1024){ input.value=''; if(dataInput)dataInput.value=''; if(nameInput)nameInput.value=''; if(status)status.textContent=''; toast('图片需为有效图片且不超过 500KB'); return; }
    const reader=new FileReader();
    reader.onload=()=>{ if(dataInput)dataInput.value=String(reader.result || ''); if(nameInput)nameInput.value=file.name; if(status)status.textContent=`已选择图片：${file.name}`; };
    reader.onerror=()=>{ input.value=''; if(dataInput)dataInput.value=''; if(nameInput)nameInput.value=''; if(status)status.textContent=''; toast('图片读取失败，请重新选择'); };
    reader.readAsDataURL(file);
  }
});
document.addEventListener('click',e=>{
  const target=e.target.closest('[data-action]'); if(!target)return;
  e.preventDefault(); const a=target.dataset.action, id=target.dataset.id;
  try {
    if(a==='close'){modal.close();return;}
    if(a==='toggleTheme'||a==='autoTheme'){
      const preference = a==='autoTheme' ? 'auto' : window.ktvAppearance.theme==='dark' ? 'light' : 'dark';
      const saved = window.ktvAppearance.setPreference(preference);
      toast((preference==='auto'?'已恢复自动：日出至19:00日间，其余时间夜间':`已手动切换${preference==='dark'?'夜间':'日间'}模式`)+(saved?'':' · 本次切换仅在当前页面有效'));
      return;
    }
    if(a==='nav'||a==='home'){page=a==='home'?'rooms':target.dataset.page;render();window.scrollTo(0,0);return;}
    if(a==='expenses'){if(!allowedPermission('expense.view'))throw Error('当前身份没有查看支出与报销的权限');page='expenses';render();window.scrollTo(0,0);return;}
    if(a==='procurement'){if(!allowedPermission('procurement.create')&&!state.procurements?.length)throw Error('当前身份没有查看采购记录的权限');page='procurement';render();window.scrollTo(0,0);return;}
    if(a==='incidents'){if(!allowedPermission('incident.create')&&!state.incidents?.length)throw Error('当前身份没有查看客诉与异常的权限');page='incidents';render();window.scrollTo(0,0);return;}
    if(a==='backMine'){page='mine';render();window.scrollTo(0,0);return;}
    if(a==='addExpense'){if(!allowedPermission('expense.create'))throw Error('当前身份没有新增支出与报销的权限');expenseDialog();return;}
    if(a==='addProcurement'){if(!allowedPermission('procurement.create'))throw Error('当前身份没有新增采购的权限');procurementDialog();return;}
    if(a==='addIncident'){if(!allowedPermission('incident.create'))throw Error('当前身份没有登记客诉与异常的权限');incidentDialog();return;}
    if(a==='approveExpense'||a==='rejectExpense'){
      const expense=state.expenses.find(item=>item.id===Number(id));
      if(!expense||expense.status!=='待老板审批')throw Error('这笔报销不在待审批状态');
      const actionLabel=a==='approveExpense'?'批准':'驳回';
      openDialog(`${actionLabel}大额报销`,`<p>${esc(expense.date||'')} · ${money(Number(expense.amount||0))} · ${esc(expense.person||'未记录')}</p><p>${esc(expense.description||'无说明')}</p><p class="notice">${a==='approveExpense'?'批准后将记录老板审批结果。':'驳回后经办人需要重新提交报销。'}</p>`,`${actionLabel}报销`,a,{id:expense.id});
      return;
    }
    if(a==='filter'){filter=target.dataset.value;render();return;}
    if(a==='room')showRoom(id);
    else if(a==='open'||a==='openDirty')openRoom(id,a==='openDirty');
    else if(a==='reserve'||a==='reserveFuture')openBookingDialog(id);
    else if(a==='cancelReservation'){
      const roomId=target.dataset.room||id, reservationId=target.dataset.reservation;
      const booking=state.reservations.find(item=>item.room===roomId&&item.status==='已预订'&&(!reservationId||String(item.id)===String(reservationId)));
      const hidden={room:roomId}; if(booking) hidden.id=booking.id;
      openDialog('取消预订',`<p>确认取消 ${booking?`${roomId} 的 ${date(booking.at)} ${esc(booking.sessionLabel || '')}`:`${roomId} 的预订`}？</p>`,'确认取消','cancelReservation',hidden);
    }
    else if(a==='order')showOrder(id);
    else if(a==='sale')saleDialog(id);
    else if(a==='staffBooking'){if(!allowedPermission('staff.record'))throw Error('当前身份没有代员工登记的权限');staffBookingDialog();}
    else if(a==='staffSale'){if(!allowedPermission('staff.record'))throw Error('当前身份没有代员工登记的权限');const first=state.orders.find(order=>order.status==='营业中');if(!first){toast('当前没有营业中的账单');return;}saleDialog(first.id,true);}
    else if(a==='otherCharge')otherChargeDialog(id);
    else if(a==='gift')giftDialog(id);
    else if(a==='exchange')exchangeDialog(id);
    else if(a==='serveExtra')commit('serveExtra',{order:id,product:target.dataset.product},globalThis.crypto?.randomUUID?.() || `serve-${id}-${target.dataset.product}-${Date.now()}`);
    else if(a==='collect')collectDialog(id);
    else if(a==='checkout')checkout(id);
    else if(a==='credit')creditDialog(id);
    else if(a==='clearSignature'){const c=document.querySelector('#signature');c.getContext('2d').clearRect(0,0,c.width,c.height);delete c.dataset.signed;}
    else if(a==='step'){const input=target.closest('.stepper').querySelector('input');input.value=Math.max(1,Math.min(Number(input.max),Number(input.value)+Number(target.dataset.delta)));input.dispatchEvent(new Event('input',{bubbles:true}));}
    else if(a==='addInitialMix'){
      const box=document.querySelector('#initial-mix'), list=document.querySelector('#mix-items'), max=Number(box.dataset.max), inputs=[...list.querySelectorAll('[name="mixCount"]')];
      const sum=inputs.reduce((n,input)=>n+Number(input.value),0); let value=Math.max(1,max-sum);
      if(sum>=max){const donor=inputs.find(input=>Number(input.value)>1);if(!donor){toast('请先减少一种酒水的支数');return;}donor.value=Number(donor.value)-1;value=1;}
      const used=new Set([...list.querySelectorAll('[name="mixProduct"]')].map(select=>select.value)), selected=initialMixChoices.find(([productId])=>!used.has(productId))?.[0]||initialMixChoices[0][0];
      list.insertAdjacentHTML('beforeend',initialMixRow(max,value,selected));box.closest('form').dispatchEvent(new Event('input',{bubbles:true}));
    }
    else if(a==='removeInitialMix'){
      const list=document.querySelector('#mix-items'), rows=[...list.querySelectorAll('.initial-mix-item')];if(rows.length===1){toast('至少保留一种酒水');return;}
      const row=target.closest('.initial-mix-item'), removed=Number(row.querySelector('[name="mixCount"]').value);row.remove();const first=list.querySelector('[name="mixCount"]');first.value=Number(first.value)+removed;list.closest('form').dispatchEvent(new Event('input',{bubbles:true}));
    }
    else if(a==='addSaleItem'){
      const list=document.querySelector('#sale-items');
      if(!list)return;
      list.insertAdjacentHTML('beforeend',saleItemRow());
      modal.querySelector('form')?._updateSale?.();
    }
    else if(a==='removeSaleItem'){
      const rows=modal.querySelectorAll('.sale-item');
      if(rows.length===1){toast('至少保留一种酒水');return;}
      target.closest('.sale-item').remove();
      modal.querySelector('form')?._updateSale?.();
    }
    else if(a==='addPayment'){
      const list=document.querySelector('#payment-lines');
      if(!list)return;
      list.insertAdjacentHTML('beforeend',paymentRow());
      list.closest('form')?.dispatchEvent(new Event('input',{bubbles:true}));
    }
    else if(a==='removePayment'){
      const rows=modal.querySelectorAll('.payment-row');
      if(rows.length===1){toast('至少保留一笔付款');return;}
      target.closest('.payment-row').remove();
      modal.querySelector('form')?.dispatchEvent(new Event('input',{bubbles:true}));
    }
    else if(a==='addDepositItem')document.querySelector('#deposit-items').insertAdjacentHTML('beforeend',depositItemRow());
    else if(a==='removeDepositItem'){const rows=modal.querySelectorAll('.deposit-item');if(rows.length===1)toast('至少保留一种酒');else target.closest('.deposit-item').remove();}
    else if(a==='identity')openDialog('切换演示身份',`<p class="muted">仅用于体验权限，不是真实登录。</p><label>选择身份<select name="user">${options(Object.entries(USERS).filter(([,u])=>!u.legacy).map(([id,u])=>{const active=effectiveUser(state,id);return [id,`${u.name} · ${active.roles.length?active.roles.join('／'):'无权限'}`];}),state.user)}</select></label>`,'使用这个身份','identity');
    else if(a==='clock')openDialog('调整练习时间',`<p>默认从当天20:00开始练习。改成18:00或02:00可以测试价格边界，不会改写已有订单。</p><label>演示时间<input type="datetime-local" name="clock" value="${localDate(state.clock)}" required></label>`,'设置练习时间','clock');
    else if(a==='deposit')openDepositDialog();
    else if(a==='withdraw'){const d=state.deposits.find(d=>d.id===Number(id));openDialog('核对并取酒',`<p>${product(d.product).name} · 余 ${d.count} 支</p><label>手机尾号或顾客姓名<input name="identity" required placeholder="至少4位手机尾号，或完整姓名"></label><p class="muted">手机号可输入登记号码的最后4至11位；姓名需与登记姓名一致。</p>${stepper(d.count,'数量（支）')}`,'确认取酒','withdraw',{id});}
    else if(a==='editPermissions')permissionsDialog(id);
    else if(a==='resolveIncident')resolveIncidentDialog(id);
    else if(a==='approveGift'||a==='rejectGift'){const request=Number(target.dataset.request), gift=(state.orders.find(o=>o.id===id)?.giftRequests||[]).find(item=>item.id===request);openDialog(a==='approveGift'?'批准赠酒水':'驳回赠酒水',`<p>${product(gift.product).name} ${gift.halves}个半打，共${gift.bottles}支。</p><p>申请人：${esc(gift.requestedBy)}</p>`,a==='approveGift'?'确认批准':'确认驳回',a,{order:id,request});}
    else if(a==='reviewRounding'){const o=state.orders.find(o=>o.id===id), review=o?.roundingReview;if(!review||review.status!=='待审核')throw Error('这笔特殊差额已经处理');openDialog('审核特殊差额',`<div class="quote"><span>${esc(o.room)} · 结账差额</span><strong>${money(review.amount)}</strong></div><p>提交人：${esc(review.submittedBy)} · ${date(review.submittedAt)}</p><p class="notice">特殊情况说明：${esc(review.note)}</p><p class="muted">本次审核只确认差额原因已核实，不会追加扣款或改变已完成的结账。</p>`,'确认已审核','approveRounding',{order:id});}
    else if(a==='review'){const o=state.orders.find(o=>o.id===id);openDialog('核对挂账申请',`<p>${o.room} · ${money(o.credit.amount)}</p><p>顾客：${esc(contactText(o.credit))}</p><p>挂账经办 ${esc(o.credit.person)} · ${o.credit.approver}审批</p><p>开单：${esc(o.credit.openedBy || o.openedBy || o.person || '未记录')} · 开房渠道：${esc(o.credit.openSource || o.openSource || '线下')} · 预订：${o.credit.reservedBy?`${esc(o.credit.reservedBy)}（${esc(o.credit.reservationSource || '方式未记录')}）`:'无预订'}</p><p class="notice">备注：${esc(o.credit.note || '未填写')}</p><img class="signature-image" alt="经办员工签字" src="${esc(o.credit.signature)}">${btn('驳回，退回收款','reject',`data-id="${id}"`,'danger')}`,'批准挂账','approve',{order:id});}
    else if(a==='reject')openDialog('驳回挂账',`<p>账单将退回待收款；不会重新占用已释放的房间。</p>`,'确认驳回','reject',{order:id});
    else if(a==='repay'){const o=state.orders.find(o=>o.id===id);openDialog('登记实际回款',`<p>还欠 ${money(o.credit.remaining)} · ${esc(contactText(o.credit))}</p><label>本次已收到（元）<input name="amount" inputmode="decimal" required></label><label>收款方式<select name="method">${options(PAYMENT_METHODS.map(m=>[m,m]))}</select></label><label class="check"><input type="checkbox" required>已核实本次回款（演示）</label>`,'确认回款','repay',{order:id});}
    else if(a==='inventory')inventoryDialog();
    else if(a==='consumableStock'){const v=state.consumables?.[id], item=CONSUMABLES.find(entry=>entry.id===id);if(!v||!item)throw Error('该消耗品不存在');openDialog(`${item.name} · ${v.count===null?'期初建账':'库存调整'}`,`<p>当前：${v.count===null?'未建账':`${v.count} ${v.unit || item.unit} · 已开封 ${v.opened || 0}`}</p><label>盘点后的未开封数量（${item.unit}）<input name="count" type="number" min="0" inputmode="numeric" required></label><label>其中已开封数量（${item.unit}）<input name="opened" type="number" min="0" inputmode="numeric" value="${v.opened || 0}" required></label><label>原因<input name="reason" maxlength="100" required placeholder="例如：首次盘点／补充采购"></label><p class="muted">已开封数量单独记录，不再重复计入未开封库存。</p>`,'确认保存消耗品库存','consumableStock',{product:id});}
    else if(a==='handover')openDialog('交班 · 核对收款',`<div class="quote"><span>本轮练习累计实收</span><strong>${money(collected(state))}</strong></div><p>请将微信、支付宝、现金、美团与抖音的实收合计填入。挂账不算已收款。</p><label>实点收款合计（元）<input name="actual" inputmode="decimal" required></label><label>前台现金（元）<input name="drawerCash" inputmode="decimal" required></label><p class="muted">前台现金单独留档，不重复计入实点收款合计。演示按本轮练习累计核对，不自动切换真实班次。</p>`,'记录交班差异','handover');
    else if(a==='guide')openDialog('跟着练一遍',`<ol class="guide"><li>用邵老板身份点空房，选饮料并直接配好种类和支数，确认开房。</li><li>营业中房间卡片底部可点“小吃”和“果盘”标记已上，两个配品都完成后按钮自动隐藏。</li><li>点“收钱”只登记开房费用，房间会继续营业。</li><li>点“加酒水”增购2打百威，再点“赠酒水”赠半打；套餐和增购酒水都能点“换酒水”调整。</li><li>增购后点“收钱”只收最近一笔未收增购；最后点“结账”汇总余款，房间才转待清洁。</li><li>到“存取酒”存6支酒，用手机号任意部分或姓名查找；取酒时用手机尾号或姓名核对。</li><li>另开一房，从“结账”申请挂账，填写手机号或姓名、备注并手写签名；按金额切换店长或老板审批，管理员可处理全部审批。</li><li>卓老板为百威建账，再切换老板娘调整库存，回管理页看提醒。</li></ol><p class="notice">第一次练习可使用虚构手机号13800000000，不填写真实客人信息。</p>`);
    else if(a==='reset')openDialog('恢复演示数据',`<p>将清空当前浏览器中的练习账单、签名、存酒、支出／报销、采购、客诉／异常、库存和交班记录，9个房间恢复空闲。</p>`,'确认清空，重新练习','reset');
  } catch(error){toast(error.message);}
});
document.addEventListener('submit',e=>{
  e.preventDefault();const f=e.target;
  if(f.id==='search'){searchTerm=String(new FormData(f).get('query')||'').trim();render();return;}
  if(!f.dataset.form||busy)return;
  busy=true;const submit=f.querySelector('[type=submit]');if(submit)submit.disabled=true;
  try{
    const a=f.dataset.form,d=Object.fromEntries(new FormData(f));
    if(a==='identity'){persist({...state,user:d.user});page='rooms';modal.close();render();}
    else if(a==='clock'){if(!Number.isFinite(Date.parse(d.clock)))throw Error('请选择有效时间');persist({...state,clock:new Date(d.clock).toISOString()});modal.close();render();}
    else if(a==='reset'){persist({...initialState(),user:'shaoBoss'});page='rooms';filter='全部';searchTerm='';storageProblem='';modal.close();render();toast('已恢复，开始新一轮练习');}
    else{
      if('count'in d)d.count=Number(d.count);if('opened'in d)d.opened=Number(d.opened);if('quantity'in d)d.quantity=Number(d.quantity);if('line'in d&&/^\d+$/.test(d.line))d.line=Number(d.line);if('id'in d)d.id=Number(d.id);if('halves'in d)d.halves=Number(d.halves);if('request'in d)d.request=Number(d.request);
      if(a==='open'){
        d.beer=d.beer||'bw';d.acceptDirty=d.acceptDirty==='yes';
        if(d.beer==='drink'){const data=new FormData(f), products=data.getAll('mixProduct'), counts=data.getAll('mixCount');d.initialMix=products.map((product,index)=>({product,count:Number(counts[index])}));}
      }
      if(a==='reserve')d.dayOffset=Number(d.dayChoice==='custom'?d.customDays:d.dayChoice);
      if(a==='sale'){
        const data=new FormData(f), products=data.getAll('saleProduct'), specs=data.getAll('saleSpec'), counts=data.getAll('saleCount');
        d.items=products.map((product,index)=>({product,spec:specs[index],count:Number(counts[index])}));
      }
      if(a==='otherCharge')d.amount=cents(d.amount);
      if(a==='procurement')d.amount=cents(d.amount);
      if(['collect','settle','pay'].includes(a)){
        const data=new FormData(f), methods=data.getAll('paymentMethod'), amounts=data.getAll('paymentAmount');
        d.payments=methods.map((method,index)=>({method,amount:cents(amounts[index]||'0')})).filter(p=>p.amount>0);
      }
      if(a==='credit'){const canvas=document.querySelector('#signature');if(!canvas.dataset.signed)throw Error('请由经办员工本人在框内手写签字');d.signature=canvas.toDataURL('image/png');}
      if(a==='repay')d.amount=cents(d.amount);if(a==='handover'){d.actual=cents(d.actual);d.drawerCash=cents(d.drawerCash);}
      if(a==='expense'){const proofFile=f.querySelector('#expense-proof')?.files?.[0], proofInput=f.querySelector('#expense-proof-data');if(proofFile&&!proofInput?.value)throw Error('图片正在读取，请稍后再保存');d.amount=cents(d.amount);}
      if(a==='deposit'){
        const data = new FormData(f), products=data.getAll('depositProduct'), counts=data.getAll('depositCount');
        d.items=products.map((product,index)=>({product,count:Number(counts[index])}));
        searchTerm=String(d.phone||d.name||'').trim();
      }
      if(a==='setPermissions') d.permissions=new FormData(f).getAll('permission');
      f.dataset.key ||= globalThis.crypto?.randomUUID?.() || `op-${Date.now()}-${Math.random()}`;
      commit(a,d,f.dataset.key);
    }
  }catch(error){f.querySelector('.form-error').textContent=error.message;}
  finally{busy=false;if(submit)submit.disabled=false;}
});
window.addEventListener('online',render);window.addEventListener('offline',render);
window.addEventListener('storage',e=>{if(e.key===KEY){try{state=migrateDemoState(e.newValue?JSON.parse(e.newValue):initialState());state.user=USER_ALIASES[state.user]||state.user;if(!USERS[state.user]||USERS[state.user].legacy)state.user='shaoBoss';modal.close();render();toast('另一标签页更新了演示，请重新操作');}catch{toast('读取其他标签页记录失败，请刷新');}}});
render();
