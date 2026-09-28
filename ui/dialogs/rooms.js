// Phase 7 自 app.js 迁入；唯一机械转换：模块级可变状态（state/page/filter/searchTerm/
// reportPeriod/storageProblem/APP_ENTRY/DEFAULT_PAGE/modal 等）→ ctx.*，函数体逐字保留。

import { allowedPermission, btn, ctx, date, esc, openingGiftChoices, options, pendingReservations, pendingRoomIssueReview, product } from '../context.js';
import { openDialog } from '../shell.js';
import { bookingFields, initialMixRow, roomIssueEvidenceMarkup, setupBookingFields } from '../forms.js';
import { reservationListMarkup } from '../pages/rooms.js';
import { showOrder } from './orders.js';
import { OPENING_SOURCES, money, quote, reservationActiveAt, slot, total } from '../../rules.js';

function showRoom(id) {
  const r=ctx.state.rooms.find(r=>r.id===id);
  const review=pendingRoomIssueReview(id);
  if (review) {
    openDialog(`${id} · 恢复申请待审核`, `<p><b>恢复为空房</b>：${esc(review.fromStatus)} → 空闲</p><p class="muted">提交：${esc(review.submittedBy)} · ${date(review.submittedAt)}</p>${roomIssueEvidenceMarkup(review)}${allowedPermission('room.issue.approve')?btn('到待办中心审核','goReviewTasks','','secondary full'):'<p class="muted">请等待有房间恢复审核权限的人员处理。</p>'}`);
    return;
  }
  if (r.status==='故障/维护中') {
    openDialog(`${id} · 故障/维护中`, `<p>${esc(r.issueType || '故障/维护中')}：${esc(r.issueNote || '已提交照片凭证')}</p><p class="muted">提交：${esc(r.issueBy || '未记录')} · ${r.issueApprovedBy?`历史审核：${esc(r.issueApprovedBy)}`:'标记无需审批'} · ${r.issueAt?date(r.issueAt):'时间未记录'}</p>${r.issueEvidencePhoto?`<a class="issue-proof" href="${esc(r.issueEvidencePhoto)}" target="_blank" rel="noreferrer"><img src="${esc(r.issueEvidencePhoto)}" alt="异常状态现场照片"><span>${esc(r.issueEvidencePhotoName || '查看现场照片')}</span></a>`:''}${allowedPermission('room.issue')?btn('申请恢复为空房','requestRoomRecovery',`data-id="${id}"`,'primary full'):'<p class="muted">当前身份没有提交恢复申请的权限。</p>'}`);
    return;
  }
  if (r.order) { showOrder(r.order); return; }
  if (r.status==='待清洁') { openDialog(`${id} · 待清洁`, `<p>完成打扫后，点下方按钮恢复空房。</p>${allowedPermission('room.open')?btn('客人已到，提示后继续开房','openDirty',`data-id="${id}"`):''}`, allowedPermission('room.clean')?'打扫好了，恢复空房':'','clean',{room:id}); return; }
  const currentBooking=pendingReservations(id).find(booking=>reservationActiveAt(booking,ctx.state.clock));
  if (r.status==='已预订' && currentBooking) { openDialog(`${id} · 当前场次预订`,`<p>预订日期 ${date(currentBooking.at)}</p><p>${esc(currentBooking.sessionLabel || '')}</p><p>预订方式：${esc(currentBooking.source || '未记录')}</p><p>预订人员：${esc(currentBooking.person || '未记录')}</p><p>${esc(currentBooking.note)||'无备注'}</p>${allowedPermission('room.open')?btn('客人到店，开房','open',`data-id="${id}"`):''}${allowedPermission('room.reserve')?btn('取消这笔预订','cancelReservation',`data-room="${id}" data-reservation="${currentBooking.id}"`,'danger'):''}${reservationListMarkup(id)}`); return; }
  openRoom(id);
}

function openRoom(id, dirty=false) {
  const r=ctx.state.rooms.find(r=>r.id===id), closed=slot(ctx.state.clock)==='closed';
  openDialog(`${id} · ${r.type}${closed?'预订':'开房'}`, closed?`<p class="notice">现在是非营业时段，只接受预订。</p>${bookingFields()}${reservationListMarkup(id)}`:`<p class="muted">${date(ctx.state.clock)} · ${slot(ctx.state.clock)==='day'?'白天纯唱':'夜间套餐'}</p>${dirty?'<p class="notice">房间尚未标记清洁。提交即确认可以接待客人。</p>':''}${reservationListMarkup(id)}<label>开房渠道<select name="openSource">${options(OPENING_SOURCES.map(source=>[source,source||'线下（默认）']),'')}</select></label>${slot(ctx.state.clock)==='night'?`<label>客人选哪种酒水<select name="beer">${options(openingGiftChoices(),'bw')}</select></label><section id="initial-mix" class="initial-mix" hidden><div class="split"><b>首次配酒水</b><span id="mix-total" class="badge"></span></div><p class="muted">开房前直接选好种类和支数；开房后再调整请点“换酒水”。</p><div id="mix-items"></div>${btn('＋ 添加一种酒水','addInitialMix','','secondary full')}</section>`:'<p>白天不带赠饮，可开房后另行加购。</p>'}<div id="quote-box"></div>${!dirty&&r.status==='空闲'&&allowedPermission('room.reserve')?btn('预订其他未来场次','reserveFuture',`data-id="${id}"`,'quiet'):''}`,closed?'确认预订':'确认开房',closed?'reserve':'open',{room:id,acceptDirty:dirty?'yes':''});
  if (closed) setupBookingFields();
  else {
    const f=ctx.modal.querySelector('form');
    const update=()=> {
      const q=quote(r.type,ctx.state.clock,f.elements.beer?.value || 'bw',f.elements.openSource?.value || '',ctx.state.catalog), mix=document.querySelector('#initial-mix');
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

function openBookingDialog(id) {
  openDialog(`${id} · 预订未来场次`,bookingFields(),'确认预订','reserve',{room:id});
  setupBookingFields();
}

export {
  showRoom,
  openRoom,
  openBookingDialog
};
