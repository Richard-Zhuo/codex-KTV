// Phase 7 自 app.js 迁入；唯一机械转换：模块级可变状态（state/page/filter/searchTerm/
// reportPeriod/storageProblem/APP_ENTRY/DEFAULT_PAGE/modal 等）→ ctx.*，函数体逐字保留。

import { allowedPermission, appearanceSettings, btn, ctx, currentUser, esc, reservationSessionName } from '../context.js';
import { creditCards } from './tasks.js';
import { staffRecordingPanel } from './admin.js';
import { pendingIncidentReminders, visibleIncidents } from '../../incidents.js';
import { money } from '../../shared/money.js';
import { reservationDate } from '../../reporting.js';

function myReservationSection() {
  const name=currentUser().name;
  const employeeId=ctx.state.actorEmployee?.employeeId;
  const reservations=ctx.state.reservations.filter(reservation=>ctx.formal ?
    Boolean(employeeId) && reservation.employeeId===employeeId : reservation.person===name)
    .sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
  const bookedOrders=ctx.state.orders.filter(order=>ctx.formal ?
    Boolean(employeeId) && order.employeeId===employeeId : order.reservedBy===name);
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
  const reminders=pendingIncidentReminders((ctx.formal ? ctx.state.incidents : visibleIncidents(ctx.state,currentUser())),ctx.state.clock);
  const businessTools=`${allowedPermission('expense.view')?btn('支出 / 报销记录　→','expenses'):''}${allowedPermission('procurement.create')||ctx.state.procurements?.length?btn('采购记录　→','procurement'):''}${allowedPermission('incident.create')||allowedPermission('incident.resolve')||ctx.state.incidents?.length?btn('客诉 / 异常　→','incidents'):''}${allowedPermission('handover')?btn('交班 · 核对收款　→','handover'):''}${allowedPermission('inventory.adjust')||allowedPermission('inventory.opening')||allowedPermission('inventory.approve')?btn('库存 · 建账与调整　→','inventory'):''}`;
  const creditRecords=allowedPermission('credit.approve')||allowedPermission('credit.repay')||allowedPermission('credit.repay.approve')?`<div class="section-title"><h2>挂账与回款记录</h2><span>主动登记回款仍在本业务模块</span></div>${creditCards()}`:'';
  return `<p class="eyebrow">我的账户</p><h1>${esc(currentUser().name)}，辛苦了</h1><p class="muted">岗位说明：${esc(currentUser().title || '未设置')} · 岗位名称只作说明，具体权限由管理员调整</p>${reminders.length?`<div class="notice incident-reminder">今天14:00提醒：还有 ${reminders.length} 项客诉／异常待处理。${btn('查看记录','incidents','', 'quiet')}</div>`:''}${myReservationSection()}${staffRecordingPanel()}${businessTools?`<div class="section-title"><h2>日常营业</h2><span>按具体权限显示</span></div><div class="menu-list">${businessTools}</div>`:''}${creditRecords}${appearanceSettings()}`;
}

export {
  myReservationSection,
  minePage
};
