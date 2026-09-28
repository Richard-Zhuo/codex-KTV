// Phase 7 自 app.js 迁入；唯一机械转换：模块级可变状态（state/page/filter/searchTerm/
// reportPeriod/storageProblem/APP_ENTRY/DEFAULT_PAGE/modal 等）→ ctx.*，函数体逐字保留。

import { allowedPermission, btn, ctx, date, displayRoomStatus, esc, pendingReservations, pendingRoomIssueReview, product, reservationSessionName, roomMatchesFilter } from '../context.js';
import { collected, money, reservationReminder, total } from '../../rules.js';
import { reservationDate } from '../../reporting.js';

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
  const o = ctx.state.orders.find(o=>o.id===r.order), bookings=pendingReservations(r.id), review=pendingRoomIssueReview(r.id);
  const status=displayRoomStatus(r), cardStatus=review?'恢复审核中':status, css = review?'issue-review':{'空闲':'free','营业中':'active','待清洁':'dirty','已预订':'reserved'}[status];
  const bookingText=bookings.length?`<small class="room-booking">未来预订：${reservationDate(bookings[0].at)} · ${esc(reservationSessionName(bookings[0]))}${bookings.length>1?`（还有${bookings.length-1}场）`:''}</small>`:'';
  const issueText=`${r.status==='故障/维护中'?`<small class="room-issue">${esc(r.issueType || '故障/维护中')}${r.issueNote?` · ${esc(r.issueNote)}`:''}</small>`:''}${review?`<small class="room-review-pending">${esc(review.change)}申请待审核</small>`:''}`;
  const bottom=review?'<span>恢复申请待审核</span><span>→</span>':r.status==='故障/维护中'?'<span>查看异常</span><span>→</span>':o?`<b>${money(total(o))}</b><span>查看账单 →</span>`:r.status==='空闲'?'<span>点这里开房</span><span>＋</span>':r.status==='待清洁'?'<span>打扫后恢复空房</span><span>→</span>':'<span>查看预订</span><span>→</span>';
  return `<article class="room-card ${css || 'issue'}" data-action="room" data-id="${r.id}"><span class="room-top"><span>${r.type}</span><span class="status"><i></i>${cardStatus}</span></span><strong class="room-number">${r.id}</strong><span class="room-bottom">${bottom}</span>${o && r.status==='营业中'?roomExtraActions(o):''}${issueText}${bookingText}</article>`;
}

function reservationListMarkup(roomId) {
  const rows=pendingReservations(roomId);
  if (!rows.length) return '';
  return `<div class="panel reservation-list"><b>未来预订</b>${rows.map(reservation=>`<div class="bill-line"><span>${date(reservation.at)} · ${esc(reservation.sessionLabel || '')}<br><small>${esc(reservation.source || '未记录')} · ${esc(reservation.person || '未记录')}</small></span>${allowedPermission('room.reserve')?btn('取消这笔','cancelReservation',`data-room="${roomId}" data-reservation="${reservation.id}"`,'quiet'):'<span class="badge">无预订权限</span>'}</div>`).join('')}</div>`;
}

function roomsPage() {
  const active = ctx.state.rooms.filter(r=>r.status==='营业中').length;
  const reminders = ctx.state.reservations.map(r => reservationReminder(r, ctx.state.clock)).filter(Boolean);
  const issueButton = allowedPermission('room.issue') ? btn('标记故障/维护','markRoomIssueMenu','','secondary') : '';
  return `<section class="welcome"><div><p class="eyebrow">今晚，也从容一点</p><h1>房间一眼看清</h1><p>先选房间，再开房、加单或收钱。</p></div><div class="welcome-icon" aria-hidden="true">♫</div></section>${reminders.map(r=>`<div class="reservation-alert"><b>预订提醒 · ${r.room}</b><p>${esc(r.sessionLabel)}已到时，仍未开房；这是第 ${r.number} 次整点提醒，请通知预订人员 ${esc(r.person)}。</p></div>`).join('')}<section class="summary"><div><strong>${ctx.state.rooms.filter(r=>displayRoomStatus(r)==='空闲'&&!pendingRoomIssueReview(r.id)).length}<small> / 9</small></strong><span>空闲房间</span></div><div><strong>${active}</strong><span>正在营业</span></div><div><strong>${money(collected(ctx.state))}</strong><span>练习累计实收</span></div></section><div class="section-title"><h2>全部包间</h2><div class="room-section-actions"><span>点击卡片操作</span>${issueButton}</div></div><div class="tabs" role="group" aria-label="房态筛选">${['全部','空闲','营业中','待清洁','已预订','异常'].map(f=>btn(f,'filter',`data-value="${f}"`,ctx.filter===f?'chip chosen':'chip')).join('')}</div><div class="rooms-grid">${ctx.state.rooms.filter(roomMatchesFilter).map(roomCard).join('') || '<p class="empty">目前没有这类房间。</p>'}</div><div class="tip"><span>✦</span><div><b>价格自动算，不用记表格</b><p>夜间房价已含赠饮，换酒不会加收差价。</p></div></div>${ctx.state.orders.filter(o=>o.status==='营业中'&&!ctx.state.rooms.some(r=>r.order===o.id)).map(o=>`<div class="panel"><b>${o.room} · 挂账被驳回，待收款</b>${btn('处理账单','order',`data-id="${o.id}"`)}</div>`).join('')}`;
}

export {
  extraLabels,
  roomExtraActions,
  roomCard,
  reservationListMarkup,
  roomsPage
};
