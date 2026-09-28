// 金碧辉煌 KTV · 演示应用入口（Phase 7 重构后）
// app.js 仅负责：装配 ctx（启动/注入）、入口路由与事件分发（document/window 监听）。
// 页面渲染在 ui/pages/*，对话框在 ui/dialogs/*，外壳与 persist/commit 在 ui/shell.js，
// 表单件在 ui/forms.js，通用助手与 ctx 单例在 ui/context.js；业务命令经 rules.js facade。
// 唯一机械转换：模块级可变状态 → ctx.*（见 ui/context.js 头注释），分支与文案逐字保留。
import { initialState } from './rules.js';
import { USERS, PERMISSION_DEFINITIONS, effectiveUser } from './shared/identity.js';
import { PAYMENT_METHODS, collected } from './sales.js';
import { ROOM_ISSUE_TYPES } from './rooms.js';
import { cents, money } from './shared/money.js';
import { saleOptions } from './catalog.js';
import { createDemoPersistence, DEMO_STATE_KEY } from './persistence.js';
import { ctx, product, esc, btn, date, localDate, options, contactText, allowedPermission, canReviewSubmission, permissionSummary, initialMixChoices, pendingRoomIssueReview, syncAppearanceControls } from './ui/context.js';
import { render, persist, toast, openDialog, commit } from './ui/shell.js';
import { roomIssueEvidenceFields, roomIssueEvidenceMarkup, initialMixRow, saleItemRow, catalogSaleOptionRow, paymentRow, depositItemRow, stepper } from './ui/forms.js';
import { showRoom, openRoom, openBookingDialog } from './ui/dialogs/rooms.js';
import { showOrder, giftDialog, saleDialog, otherChargeDialog, exchangeDialog, collectDialog, checkout, creditDialog } from './ui/dialogs/orders.js';
import { retailDialog, staffBookingDialog } from './ui/dialogs/retail.js';
import { openDepositDialog } from './ui/dialogs/deposits.js';
import { expenseDialog, procurementDialog, incidentDialog, resolveIncidentDialog } from './ui/dialogs/operations.js';
import { catalogCreateDialog, catalogProductDialog, catalogPackageDialog, inventoryDialog, permissionsDialog } from './ui/dialogs/admin.js';

const APP_ENTRY = document.body.dataset.appEntry === 'admin' ? 'admin' : 'staff';
const REQUESTED_STAFF_PAGE = new URLSearchParams(window.location.search).get('page');
const DEFAULT_PAGE = APP_ENTRY === 'admin' ? 'manage' : REQUESTED_STAFF_PAGE === 'tasks' ? 'tasks' : 'rooms';
const persistence = createDemoPersistence({ storage: localStorage });
const loaded = persistence.load();
ctx.state = loaded.state;
ctx.storageProblem = loaded.problem;
const app = document.querySelector('#app'), modal = document.querySelector('#modal');
ctx.APP_ENTRY = APP_ENTRY; ctx.DEFAULT_PAGE = DEFAULT_PAGE; ctx.page = DEFAULT_PAGE;
ctx.persistence = persistence; ctx.modal = modal; ctx.app = app;

document.addEventListener('change',e=>{
  if(e.target.id==='report-period'){ ctx.reportPeriod=e.target.value; render(); window.scrollTo(0,0); return; }
  // Bug #2 修复：套餐维护对话框中基础房费或赠饮参考值变化时，只读总价同步重算。
  if(e.target.name==='basePriceCents'||e.target.name==='includedValueCents'){
    const form=e.target.closest('form');
    if(form?.dataset?.form==='updateCatalogPackage'){
      const total=form.elements.priceCents, base=Number(form.elements.basePriceCents.value)||0, included=Number(form.elements.includedValueCents.value)||0;
      if(total){ total.value=(base+included).toFixed(2); }
    }
    return;
  }
  if(e.target.id==='appearance-preference'){
    const saved=window.ktvAppearance.setPreference(e.target.value);
    syncAppearanceControls();
    toast(`${e.target.value==='auto'?'已设为自动：日出至19:00日间，其余时间夜间':e.target.value==='dark'?'已设为夜间模式':'已设为日间模式'}${saved?'':' · 本次切换仅在当前页面有效'}`);
    return;
  }
  if(e.target.id==='permission-target'){
    const button=document.querySelector('[data-action="editPermissions"]');
    if(button) button.dataset.id=e.target.value;
    const user=effectiveUser(ctx.state,e.target.value), summary=document.querySelector('#permission-target-summary');
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
    return;
  }
  if(e.target.id==='room-issue-photo'){
    const input=e.target, file=input.files?.[0], dataInput=document.querySelector('#room-issue-photo-data'), nameInput=document.querySelector('#room-issue-photo-name'), status=document.querySelector('#room-issue-photo-status');
    if(!file){ if(dataInput)dataInput.value=''; if(nameInput)nameInput.value=''; if(status)status.textContent='支持单张图片，不超过 500KB；照片仅保存在本机演示数据中。'; return; }
    if(!file.type.startsWith('image/') || file.size>500*1024){ input.value=''; if(dataInput)dataInput.value=''; if(nameInput)nameInput.value=''; if(status)status.textContent=''; toast('图片需为有效图片且不超过 500KB'); return; }
    const reader=new FileReader();
    reader.onload=()=>{ if(dataInput)dataInput.value=String(reader.result || ''); if(nameInput)nameInput.value=file.name; if(status)status.textContent=`已选择现场照片：${file.name}`; };
    reader.onerror=()=>{ input.value=''; if(dataInput)dataInput.value=''; if(nameInput)nameInput.value=''; if(status)status.textContent=''; toast('图片读取失败，请重新选择'); };
    reader.readAsDataURL(file);
  }
});
document.addEventListener('click',e=>{
  const target=e.target.closest('[data-action]'); if(!target)return;
  e.preventDefault(); const a=target.dataset.action, id=target.dataset.id;
  try {
    if(a==='close'){ctx.modal.close();return;}
    if(a==='retryRecovery'){const loaded=ctx.persistence.load();ctx.state=loaded.state;ctx.storageProblem=loaded.problem;render();return;}
    if(a==='toggleTheme'||a==='autoTheme'){
      const preference = a==='autoTheme' ? 'auto' : window.ktvAppearance.theme==='dark' ? 'light' : 'dark';
      const saved = window.ktvAppearance.setPreference(preference);
      toast((preference==='auto'?'已恢复自动：日出至19:00日间，其余时间夜间':`已手动切换${preference==='dark'?'夜间':'日间'}模式`)+(saved?'':' · 本次切换仅在当前页面有效'));
      return;
    }
    if(a==='nav'||a==='home'){ctx.page=a==='home'?ctx.DEFAULT_PAGE:target.dataset.page;render();window.scrollTo(0,0);return;}
    if(a==='goReviewTasks'){ctx.modal.close();if(ctx.APP_ENTRY==='staff'){ctx.page='tasks';render();window.scrollTo(0,0);}else window.location.assign('/?page=tasks');return;}
    if(a==='expenses'){if(!allowedPermission('expense.view'))throw Error('当前身份没有查看支出与报销的权限');ctx.page='expenses';render();window.scrollTo(0,0);return;}
    if(a==='procurement'){if(!allowedPermission('procurement.create')&&!ctx.state.procurements?.length)throw Error('当前身份没有查看采购记录的权限');ctx.page='procurement';render();window.scrollTo(0,0);return;}
    if(a==='incidents'){if(!allowedPermission('incident.create')&&!allowedPermission('incident.resolve.approve')&&!ctx.state.incidents?.length)throw Error('当前身份没有查看客诉与异常的权限');ctx.page='incidents';render();window.scrollTo(0,0);return;}
    if(a==='backMine'){ctx.page=ctx.APP_ENTRY==='admin'?'manage':'mine';render();window.scrollTo(0,0);return;}
    if(a==='addExpense'){if(!allowedPermission('expense.create'))throw Error('当前身份没有新增支出与报销的权限');expenseDialog();return;}
    if(a==='addProcurement'){if(!allowedPermission('procurement.create'))throw Error('当前身份没有新增采购的权限');procurementDialog();return;}
    if(a==='addIncident'){if(!allowedPermission('incident.create'))throw Error('当前身份没有登记客诉与异常的权限');incidentDialog();return;}
    if(a==='approveExpense'||a==='rejectExpense'){
      const expense=ctx.state.expenses.find(item=>item.id===Number(id));
      if(!expense||expense.status!=='待老板审批')throw Error('这笔报销不在待审批状态');
      const actionLabel=a==='approveExpense'?'批准':'驳回';
      openDialog(`${actionLabel}大额报销`,`<p>${esc(expense.date||'')} · ${money(Number(expense.amount||0))} · ${esc(expense.person||'未记录')}</p><p>${esc(expense.description||'无说明')}</p><p class="notice">${a==='approveExpense'?'批准后将记录老板审批结果。':'驳回后经办人需要重新提交报销。'}</p>`,`${actionLabel}报销`,a,{id:expense.id});
      return;
    }
    if(a==='reviewRoomIssue'){
      const request=(ctx.state.roomIssueReviews || []).find(item=>item.id===Number(id));
      if(!request||request.status!=='待审核')throw Error('该房间恢复申请已经处理');
      if(request.requestedStatus!=='空闲')throw Error('故障标记无需审核，只有恢复为空房需要审核');
      if(!allowedPermission('room.issue.approve'))throw Error('当前身份没有房间恢复审核权限');
      if(!canReviewSubmission(request.submittedById))throw Error('审核本人申请需要“允许审核本人申请”权限');
      openDialog(`审核恢复申请 · ${esc(request.room)}`,`<div class="quote"><span>恢复为空房</span><strong>空闲</strong></div><p>${esc(request.fromStatus)} → 空闲${request.issueType?` · ${esc(request.issueType)}`:''}</p><p class="muted">提交：${esc(request.submittedBy)} · ${date(request.submittedAt)}</p>${roomIssueEvidenceMarkup(request)}<label>审核备注（选填）<textarea name="decisionNote" maxlength="300" rows="2" placeholder="记录现场核对情况"></textarea></label>${btn('驳回申请','rejectRoomIssueDialog',`data-id="${request.id}"`,'danger full')}`,'批准恢复为空房','approveRoomIssue',{request:request.id});
      return;
    }
    if(a==='rejectRoomIssueDialog'){
      const request=(ctx.state.roomIssueReviews || []).find(item=>item.id===Number(id));
      if(!request||request.status!=='待审核')throw Error('该房间恢复申请已经处理');
      if(request.requestedStatus!=='空闲')throw Error('故障标记无需审核，只有恢复为空房需要审核');
      openDialog(`驳回恢复申请 · ${esc(request.room)}`,`<p>${esc(request.fromStatus)} → 空闲</p><label>驳回原因<textarea name="decisionNote" maxlength="300" rows="3" required placeholder="请说明需要补充或更正的内容"></textarea></label>`,'确认驳回','rejectRoomIssue',{request:request.id});
      return;
    }
    if(a==='filter'){ctx.filter=target.dataset.value;render();return;}
    if(a==='room')showRoom(id);
    else if(a==='markRoomIssueMenu'){
      if(!allowedPermission('room.issue'))throw Error('当前身份没有标记房间异常的权限');
      const availableRooms=ctx.state.rooms.filter(room=>['空闲','待清洁'].includes(room.status)&&!pendingRoomIssueReview(room.id));
      if(!availableRooms.length){toast('当前没有可标记异常的房间');return;}
      openDialog('标记房间故障/维护',`<p class="notice">提交照片或文字后立即生效，无需审核；房间会暂停开房和预订并保留操作记录。</p><label>房号<select name="room">${options(availableRooms.map(room=>[room.id,`${room.id} · ${room.type}${room.status==='待清洁'?' · 待清洁':''}`]),availableRooms[0].id)}</select></label><label>异常状态<select name="issueType">${options(ROOM_ISSUE_TYPES.map(type=>[type,type]),ROOM_ISSUE_TYPES[0])}</select></label>${roomIssueEvidenceFields()}`,'确认标记并立即生效','markRoomIssue');
    }
    else if(a==='requestRoomRecovery'){
      const room=ctx.state.rooms.find(item=>item.id===id);
      if(!room||room.status!=='故障/维护中')throw Error('房间异常状态已经变化');
      if(!allowedPermission('room.issue'))throw Error('当前身份没有提交恢复申请的权限');
      openDialog(`${id} · 申请恢复为空房`,`<p class="notice">恢复不会立即生效；请提交维修完成的照片或文字说明。审核本人申请需要额外的自审权限。</p>${roomIssueEvidenceFields()}`,'提交恢复审核','clearRoomIssue',{room:id});
    }
    else if(a==='open'||a==='openDirty')openRoom(id,a==='openDirty');
    else if(a==='reserve'||a==='reserveFuture')openBookingDialog(id);
    else if(a==='cancelReservation'){
      const roomId=target.dataset.room||id, reservationId=target.dataset.reservation;
      const booking=ctx.state.reservations.find(item=>item.room===roomId&&item.status==='已预订'&&(!reservationId||String(item.id)===String(reservationId)));
      const hidden={room:roomId}; if(booking) hidden.id=booking.id;
      openDialog('取消预订',`<p>确认取消 ${booking?`${roomId} 的 ${date(booking.at)} ${esc(booking.sessionLabel || '')}`:`${roomId} 的预订`}？</p>`,'确认取消','cancelReservation',hidden);
    }
    else if(a==='order')showOrder(id);
    else if(a==='sale')saleDialog(id);
    else if(a==='startRetail')retailDialog();
    else if(a==='staffBooking'){if(!allowedPermission('staff.record'))throw Error('当前身份没有代员工登记的权限');staffBookingDialog();}
    else if(a==='staffSale'){if(!allowedPermission('staff.record'))throw Error('当前身份没有代员工登记的权限');const first=ctx.state.orders.find(order=>order.status==='营业中');if(!first){toast('当前没有营业中的账单');return;}saleDialog(first.id,true);}
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
      const mixChoices=initialMixChoices(), used=new Set([...list.querySelectorAll('[name="mixProduct"]')].map(select=>select.value)), selected=mixChoices.find(([productId])=>!used.has(productId))?.[0]||mixChoices[0]?.[0]||'drink0';
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
      ctx.modal.querySelector('form')?._updateSale?.();
    }
    else if(a==='removeSaleItem'){
      const rows=ctx.modal.querySelectorAll('.sale-item');
      if(rows.length===1){toast('至少保留一种商品');return;}
      target.closest('.sale-item').remove();
      ctx.modal.querySelector('form')?._updateSale?.();
    }
    else if(a==='addCatalogSaleOption')document.querySelector('#catalog-sale-options')?.insertAdjacentHTML('beforeend',catalogSaleOptionRow());
    else if(a==='removeCatalogSaleOption'){
      const rows=ctx.modal.querySelectorAll('.catalog-sale-option');
      if(rows.length===1){toast('至少保留一种销售规格');return;}
      target.closest('.catalog-sale-option').remove();
    }
    else if(a==='addPayment'){
      const list=document.querySelector('#payment-lines');
      if(!list)return;
      list.insertAdjacentHTML('beforeend',paymentRow());
      list.closest('form')?.dispatchEvent(new Event('input',{bubbles:true}));
    }
    else if(a==='removePayment'){
      const rows=ctx.modal.querySelectorAll('.payment-row');
      if(rows.length===1){toast('至少保留一笔付款');return;}
      target.closest('.payment-row').remove();
      ctx.modal.querySelector('form')?.dispatchEvent(new Event('input',{bubbles:true}));
    }
    else if(a==='addDepositItem')document.querySelector('#deposit-items').insertAdjacentHTML('beforeend',depositItemRow());
    else if(a==='removeDepositItem'){const rows=ctx.modal.querySelectorAll('.deposit-item');if(rows.length===1)toast('至少保留一种酒');else target.closest('.deposit-item').remove();}
    else if(a==='identity')openDialog('切换演示身份',`<p class="muted">仅用于体验权限，不是真实登录；岗位名称只作说明。</p><label>选择身份<select name="user">${options(Object.entries(USERS).filter(([,u])=>!u.legacy).map(([id,u])=>[id,`${u.name} · ${u.title || '岗位说明未设置'}`]),ctx.state.user)}</select></label>`,'使用这个身份','identity');
    else if(a==='clock')openDialog('调整练习时间',`<p>默认从当天20:00开始练习。改成18:00或02:00可以测试价格边界，不会改写已有订单。</p><label>演示时间<input type="datetime-local" name="clock" value="${localDate(ctx.state.clock)}" required></label>`,'设置练习时间','clock');
    else if(a==='deposit')openDepositDialog();
    else if(a==='withdraw'){const d=ctx.state.deposits.find(d=>d.id===Number(id));openDialog('核对并取酒',`<p>${d.productNameSnapshot || product(d.product).name} · 余 ${d.count} 支</p><label>手机尾号或顾客姓名<input name="identity" required placeholder="至少4位手机尾号，或完整姓名"></label><p class="muted">手机号可输入登记号码的最后4至11位；姓名需与登记姓名一致。</p>${stepper(d.count,'数量（支）')}`,'确认取酒','withdraw',{id});}
    else if(a==='editPermissions')permissionsDialog(id);
    else if(a==='editCatalogProduct'){if(!allowedPermission('catalog.manage'))throw Error('当前身份没有目录维护权限');catalogProductDialog(id);}
    else if(a==='createCatalogProduct'){if(!allowedPermission('catalog.manage'))throw Error('当前身份没有目录维护权限');catalogCreateDialog();}
    else if(a==='editCatalogPackage'){if(!allowedPermission('catalog.manage'))throw Error('当前身份没有目录维护权限');catalogPackageDialog(id);}
    else if(a==='resolveIncident')resolveIncidentDialog(id);
    else if(a==='reviewIncidentResolution'){
      const incident=ctx.state.incidents.find(item=>item.id===Number(id)), request=(incident?.resolutionReviews||[]).find(item=>item.id===Number(target.dataset.request));
      if(!request||request.status!=='待审核')throw Error('这项客诉／异常恢复申请已经处理');
      if(!canReviewSubmission(request.submittedById))throw Error('审核本人申请需要“允许审核本人申请”权限');
      openDialog(`审核客诉 / 异常恢复 · ${esc(incident.room)}`,`<p>${esc(incident.type)} · 负责人 ${esc(incident.assignee)}</p><div class="notice"><b>处理结果</b><p>${esc(request.result)}</p><b>备注</b><p>${esc(request.note)}</p></div><p class="muted">提交 ${esc(request.submittedBy)} · ${date(request.submittedAt)}</p><label>审核备注（选填）<textarea name="decisionNote" maxlength="300" rows="2"></textarea></label>${btn('驳回恢复','rejectIncidentResolutionDialog',`data-id="${incident.id}" data-request="${request.id}"`,'danger full')}`,'批准并完成','approveIncidentResolution',{id:incident.id,request:request.id});
    }
    else if(a==='rejectIncidentResolutionDialog'){const incident=ctx.state.incidents.find(item=>item.id===Number(id)), request=(incident?.resolutionReviews||[]).find(item=>item.id===Number(target.dataset.request));if(!request||request.status!=='待审核')throw Error('这项客诉／异常恢复申请已经处理');openDialog(`驳回客诉 / 异常恢复 · ${esc(incident.room)}`,`<label>驳回原因<textarea name="decisionNote" maxlength="300" rows="3" required placeholder="请说明需要继续处理的内容"></textarea></label>`,'确认驳回','rejectIncidentResolution',{id:incident.id,request:request.id});}
    else if(a==='approveGift'||a==='rejectGift'){const request=Number(target.dataset.request), gift=(ctx.state.orders.find(o=>o.id===id)?.giftRequests||[]).find(item=>item.id===request);if(!gift||gift.status!=='待确认')throw Error('赠酒水申请已处理');if(!canReviewSubmission(gift.requestedById))throw Error('审核本人申请需要“允许审核本人申请”权限');openDialog(a==='approveGift'?'批准超额赠酒水':'驳回超额赠酒水',`<p>${product(gift.product).name} ${gift.halves}个半打，共${gift.bottles}支。</p><p>申请人：${esc(gift.requestedBy)}</p>${a==='rejectGift'?'<label>驳回原因<textarea name="decisionNote" maxlength="300" rows="3" required></textarea></label>':'<label>审核备注（选填）<textarea name="decisionNote" maxlength="300" rows="2"></textarea></label>'}`,a==='approveGift'?'确认批准':'确认驳回',a,{order:id,request});}
    else if(a==='reviewRounding'){const o=ctx.state.orders.find(o=>o.id===id), review=o?.roundingReview;if(!review||review.status!=='待审核')throw Error('这笔特殊差额已经处理');if(!canReviewSubmission(review.submittedById))throw Error('审核本人申请需要“允许审核本人申请”权限');openDialog('审核特殊差额',`<div class="quote"><span>${esc(o.room)} · 结账差额</span><strong>${money(review.amount)}</strong></div><p>提交人：${esc(review.submittedBy)} · ${date(review.submittedAt)}</p><p class="notice">特殊情况说明：${esc(review.note)}</p><p class="muted">本次审核只确认差额原因已核实，不会追加扣款或改变已完成的结账。</p><label>审核备注（选填）<textarea name="decisionNote" maxlength="300" rows="2"></textarea></label>${btn('驳回差额说明','rejectRoundingDialog',`data-id="${o.id}"`,'danger full')}`,'批准特殊差额','approveRounding',{order:id});}
    else if(a==='rejectRoundingDialog'){const o=ctx.state.orders.find(o=>o.id===id);if(!o?.roundingReview||o.roundingReview.status!=='待审核')throw Error('这笔特殊差额已经处理');openDialog('驳回特殊差额',`<p>${esc(o.room)} · ${money(o.roundingReview.amount)}</p><label>驳回原因<textarea name="decisionNote" maxlength="300" rows="3" required></textarea></label><p class="muted">驳回会保留异常审核记录，不会自动改写已完成账单。</p>`,'确认驳回','rejectRounding',{order:id});}
    else if(a==='review'){const o=ctx.state.orders.find(o=>o.id===id);openDialog('核对挂账申请',`<p>${o.room} · ${money(o.credit.amount)}</p><p>顾客：${esc(contactText(o.credit))}</p><p>挂账经办 ${esc(o.credit.person)} · ${o.credit.approver}审批</p><p>开单：${esc(o.credit.openedBy || o.openedBy || o.person || '未记录')} · 开房渠道：${esc(o.credit.openSource || o.openSource || '线下')} · 预订：${o.credit.reservedBy?`${esc(o.credit.reservedBy)}（${esc(o.credit.reservationSource || '方式未记录')}）`:'无预订'}</p><p class="notice">备注：${esc(o.credit.note || '未填写')}</p><img class="signature-image" alt="经办员工签字" src="${esc(o.credit.signature)}">${btn('驳回，退回收款','reject',`data-id="${id}"`,'danger')}`,'批准挂账','approve',{order:id});}
    else if(a==='reject')openDialog('驳回挂账',`<p>账单将退回待收款；不会重新占用已释放的房间。</p>`,'确认驳回','reject',{order:id});
    else if(a==='repay'){const o=ctx.state.orders.find(o=>o.id===id), pending=(o.credit.repaymentRequests||[]).filter(request=>request.status==='待审核').reduce((sum,request)=>sum+request.amount,0), available=o.credit.remaining-pending;if(available<=0)throw Error('全部欠款已有回款申请待审核');openDialog('登记实际回款',`<p>还欠 ${money(o.credit.remaining)} · 待审核 ${money(pending)} · 本次最多 ${money(available)}</p><p>${esc(contactText(o.credit))}</p><label>本次已收到（元）<input name="amount" inputmode="decimal" required></label><label>收款方式<select name="method">${options(PAYMENT_METHODS.map(m=>[m,m]))}</select></label><label class="check"><input type="checkbox" required>已核实本次回款（演示）</label><p class="muted">登记后需具备回款审核权限的员工批准；本人审核还需额外拥有自审权限。批准前不计入实收。</p>`,'提交回款审核','repay',{order:id});}
    else if(a==='reviewRepayment'){
      const o=ctx.state.orders.find(o=>o.id===id), request=(o?.credit?.repaymentRequests||[]).find(item=>item.id===Number(target.dataset.request));if(!request||request.status!=='待审核')throw Error('这笔回款申请已经处理');if(!canReviewSubmission(request.submittedById))throw Error('审核本人申请需要“允许审核本人申请”权限');openDialog('审核挂账回款',`<div class="quote"><span>${esc(o.room)} · ${esc(request.method)}</span><strong>${money(request.amount)}</strong></div><p>登记人：${esc(request.submittedBy)} · ${date(request.submittedAt)}</p><label>审核备注（选填）<textarea name="decisionNote" maxlength="300" rows="2"></textarea></label>${btn('驳回回款','rejectRepaymentDialog',`data-id="${o.id}" data-request="${request.id}"`,'danger full')}`,'批准并计入实收','approveRepayment',{order:o.id,request:request.id});
    }
    else if(a==='rejectRepaymentDialog'){const o=ctx.state.orders.find(o=>o.id===id), request=(o?.credit?.repaymentRequests||[]).find(item=>item.id===Number(target.dataset.request));if(!request||request.status!=='待审核')throw Error('这笔回款申请已经处理');openDialog('驳回挂账回款',`<p>${money(request.amount)} · ${esc(request.method)}</p><label>驳回原因<textarea name="decisionNote" maxlength="300" rows="3" required></textarea></label>`,'确认驳回','rejectRepayment',{order:o.id,request:request.id});}
    else if(a==='inventory')inventoryDialog();
    else if(a==='stock'){const v=ctx.state.inventory[id],item=product(id),unit=v?.unit||item.baseUnit;if(!v)throw Error('该商品不存在');openDialog(`${item.name} · ${v.count===null?'期初建账':'库存盘点'}`,`<p>当前：${v.count===null?'未建账':`${v.count} ${unit}`}</p><label>盘点后的实际库存（${unit}）<input name="count" type="number" min="0" inputmode="numeric" required></label><label>原因<input name="reason" maxlength="100" required placeholder="例如：首次盘点／破损一件"></label><p class="muted">提交后需库存审核权限；本人审核还需额外拥有自审权限。批准前不改变账面库存。</p>`,'提交库存审核','stock',{product:id});}
    else if(a==='consumableStock'){const v=ctx.state.consumables?.[id], item=ctx.state.catalog.products.find(entry=>entry.id===id);if(!v||!item)throw Error('该消耗品不存在');openDialog(`${item.name} · ${v.count===null?'期初建账':'库存盘点'}`,`<p>当前：${v.count===null?'未建账':`${v.count} ${v.unit || item.baseUnit} · 已开封 ${v.opened || 0}`}</p><label>盘点后的未开封数量（${item.baseUnit}）<input name="count" type="number" min="0" inputmode="numeric" required></label><label>其中已开封数量（${item.baseUnit}）<input name="opened" type="number" min="0" inputmode="numeric" value="${v.opened || 0}" required></label><label>原因<input name="reason" maxlength="100" required placeholder="例如：首次盘点／补充采购"></label><p class="muted">已开封数量单独记录。提交后需库存审核权限；本人审核还需额外拥有自审权限。</p>`,'提交库存审核','consumableStock',{product:id});}
    else if(a==='reviewInventory'){
      const request=(ctx.state.inventoryReviews||[]).find(item=>item.id===Number(id));if(!request||request.status!=='待审核')throw Error('这笔库存盘点已经处理');if(!canReviewSubmission(request.submittedById))throw Error('审核本人申请需要“允许审核本人申请”权限');const catalogItem=ctx.state.catalog.products.find(item=>item.id===request.product), label=catalogItem?.name||request.product, unit=request.kind==='consumable'?(ctx.state.consumables?.[request.product]?.unit||catalogItem?.baseUnit||'份'):(catalogItem?.baseUnit||'支');openDialog(`审核库存盘点 · ${esc(label)}`,`<div class="quote"><span>${request.before??'未建账'} → ${request.after}</span><strong>${esc(unit)}</strong></div>${request.kind==='consumable'?`<p>已开封：${request.openedBefore||0} → ${request.openedAfter||0}</p>`:''}<p>${esc(request.reason)}</p><p class="muted">提交 ${esc(request.submittedBy)} · ${date(request.submittedAt)}</p><label>审核备注（选填）<textarea name="decisionNote" maxlength="300" rows="2"></textarea></label>${btn('驳回盘点','rejectInventoryDialog',`data-id="${request.id}"`,'danger full')}`,'批准并更新库存','approveInventory',{request:request.id});
    }
    else if(a==='rejectInventoryDialog'){const request=(ctx.state.inventoryReviews||[]).find(item=>item.id===Number(id));if(!request||request.status!=='待审核')throw Error('这笔库存盘点已经处理');openDialog('驳回库存盘点',`<label>驳回原因<textarea name="decisionNote" maxlength="300" rows="3" required></textarea></label>`,'确认驳回','rejectInventory',{request:request.id});}
    else if(a==='handover')openDialog('交班 · 核对收款',`<div class="quote"><span>本轮练习累计实收</span><strong>${money(collected(ctx.state))}</strong></div><p>请将微信、支付宝、现金、美团与抖音的实收合计填入。挂账不算已收款。</p><label>实点收款合计（元）<input name="actual" inputmode="decimal" required></label><label>前台现金（元）<input name="drawerCash" inputmode="decimal" required></label><p class="muted">前台现金单独留档，不重复计入实点收款合计。演示按本轮练习累计核对，不自动切换真实班次。</p>`,'记录交班差异','handover');
    else if(a==='guide')openDialog('跟着练一遍',`<ol class="guide"><li>用邵老板身份点空房，选饮料并直接配好种类和支数，确认开房。</li><li>营业中房间卡片底部可点“小吃”和“果盘”标记已上，两个配品都完成后按钮自动隐藏。</li><li>点“收钱”只登记开房费用，房间会继续营业。</li><li>点“加酒水”增购2打百威，再点“赠酒水”赠半打；套餐和增购酒水都能点“换酒水”调整。</li><li>增购后点“收钱”只收最近一笔未收增购；最后点“结账”汇总余款，房间才转待清洁。</li><li>到“存取酒”存6支酒，用手机号任意部分或姓名查找；取酒时用手机尾号或姓名核对。</li><li>另开一房，从“结账”申请挂账，填写手机号或姓名、备注并手写签名；切换到有对应具体审核权限的人员，在“待办”处理。</li><li>卓老板为百威建账，再切换有库存审核权限的人员，到“待办”处理盘点申请。</li></ol><p class="notice">第一次练习可使用虚构手机号13800000000，不填写真实客人信息。</p>`);
    else if(a==='reset')openDialog('恢复演示数据',`<p>将清空当前浏览器中的练习账单、签名、存酒、支出／报销、采购、客诉／异常、库存和交班记录，9个房间恢复空闲。</p>`,'确认清空，重新练习','reset');
  } catch(error){toast(error.message);}
});
document.addEventListener('submit',e=>{
  e.preventDefault();const f=e.target;
  if(f.id==='search'){ctx.searchTerm=String(new FormData(f).get('query')||'').trim();render();return;}
  if(!f.dataset.form||ctx.busy)return;
  ctx.busy=true;const submit=f.querySelector('[type=submit]');if(submit)submit.disabled=true;
  try{
    const a=f.dataset.form,d=Object.fromEntries(new FormData(f));
    if(a==='identity'){persist({...ctx.state,user:d.user});ctx.page=ctx.DEFAULT_PAGE;ctx.modal.close();render();}
    else if(a==='clock'){if(!Number.isFinite(Date.parse(d.clock)))throw Error('请选择有效时间');persist({...ctx.state,clock:new Date(d.clock).toISOString()});ctx.modal.close();render();}
    else if(a==='reset'){persist({...initialState(),user:'shaoBoss'});ctx.page=ctx.DEFAULT_PAGE;ctx.filter='全部';ctx.searchTerm='';ctx.storageProblem='';ctx.modal.close();render();toast('已恢复，开始新一轮练习');}
    else{
      if('count'in d)d.count=Number(d.count);if('opened'in d)d.opened=Number(d.opened);if('quantity'in d)d.quantity=Number(d.quantity);if('line'in d&&/^\d+$/.test(d.line))d.line=Number(d.line);if('id'in d&&/^\d+$/.test(String(d.id)))d.id=Number(d.id);if('halves'in d)d.halves=Number(d.halves);if('request'in d)d.request=Number(d.request);
      if(a==='open'){
        d.beer=d.beer||'bw';d.acceptDirty=d.acceptDirty==='yes';
        if(d.beer==='drink'){const data=new FormData(f), products=data.getAll('mixProduct'), counts=data.getAll('mixCount');d.initialMix=products.map((product,index)=>({product,count:Number(counts[index])}));}
      }
      if(a==='reserve')d.dayOffset=Number(d.dayChoice==='custom'?d.customDays:d.dayChoice);
      if(a==='sale'||a==='retailSale'){
        const data=new FormData(f), products=data.getAll('saleProduct'), specs=data.getAll('saleSpec'), counts=data.getAll('saleCount');
        d.items=products.map((product,index)=>({product,spec:specs[index],count:Number(counts[index])}));
      }
      if(a==='otherCharge')d.amount=cents(d.amount);
      if(a==='procurement')d.amount=cents(d.amount);
      if(['collect','settle','pay','retailSale'].includes(a)){
        const data=new FormData(f), methods=data.getAll('paymentMethod'), amounts=data.getAll('paymentAmount');
        d.payments=methods.map((method,index)=>({method,amount:cents(amounts[index]||'0')})).filter(p=>p.amount>0);
      }
      if(a==='credit'){const canvas=document.querySelector('#signature');if(!canvas.dataset.signed)throw Error('请由经办员工本人在框内手写签字');d.signature=canvas.toDataURL('image/png');}
      if(a==='repay')d.amount=cents(d.amount);if(a==='handover'){d.actual=cents(d.actual);d.drawerCash=cents(d.drawerCash);}
      if(a==='expense'){const proofFile=f.querySelector('#expense-proof')?.files?.[0], proofInput=f.querySelector('#expense-proof-data');if(proofFile&&!proofInput?.value)throw Error('图片正在读取，请稍后再保存');d.amount=cents(d.amount);}
      if(['markRoomIssue','clearRoomIssue'].includes(a)){const proofFile=f.querySelector('#room-issue-photo')?.files?.[0], proofInput=f.querySelector('#room-issue-photo-data');if(proofFile&&!proofInput?.value)throw Error('现场照片正在读取，请稍后再提交');}
      if(a==='deposit'){
        const data = new FormData(f), products=data.getAll('depositProduct'), counts=data.getAll('depositCount');
        d.items=products.map((product,index)=>({product,count:Number(counts[index])}));
        ctx.searchTerm=String(d.phone||d.name||'').trim();
      }
      if(a==='setPermissions') d.permissions=new FormData(f).getAll('permission');
      if(a==='createCatalogProduct'){
        const data=new FormData(f), ids=data.getAll('saleOptionId'), names=data.getAll('saleOptionName'), quantities=data.getAll('saleOptionBaseQuantity'), prices=data.getAll('saleOptionPrice');
        d.inventoryManaged=Boolean(f.elements.inventoryManaged?.checked); d.sellable=Boolean(f.elements.sellable?.checked); d.active=Boolean(f.elements.active?.checked); d.sortOrder=Number(d.sortOrder);
        d.saleOptions=ids.map((id,index)=>({id,name:names[index],baseQuantity:Number(quantities[index]),priceCents:cents(prices[index])}));
      }
      if(a==='updateCatalogProduct'){
        const item=product(d.id);
        d.active=Boolean(f.elements.active?.checked); d.sellable=Boolean(f.elements.sellable?.checked); d.sortOrder=Number(d.sortOrder);
        d.saleOptions=saleOptions(item).map(option=>({...option,priceCents:cents(d[`price_${option.id}`])}));
      }
      if(a==='updateCatalogPackage'){
        // Bug #2 修复：priceCents 不再独立填写，提交前由基础房费＋赠饮参考值重新计算，
        // 对话框中为只读展示（rules.js 仍校验一致性，双保险）。
        d.active=Boolean(f.elements.active?.checked); d.basePriceCents=cents(d.basePriceCents); d.includedValueCents=cents(d.includedValueCents); d.priceCents=d.basePriceCents+d.includedValueCents; d.sortOrder=Number(d.sortOrder);
      }
      f.dataset.key ||= globalThis.crypto?.randomUUID?.() || `op-${Date.now()}-${Math.random()}`;
      commit(a,d,f.dataset.key);
    }
  }catch(error){f.querySelector('.form-error').textContent=error.message;}
  finally{ctx.busy=false;if(submit)submit.disabled=false;}
});
window.addEventListener('online',render);window.addEventListener('offline',render);
window.addEventListener('storage',e=>{if(e.key===DEMO_STATE_KEY){try{ctx.state=ctx.persistence.loadExternal(e.newValue);ctx.storageProblem=ctx.persistence.recoveryRecord()?.problem||'';ctx.modal.close();render();if(!ctx.persistence.isWriteBlocked())toast('另一标签页更新了演示，请重新操作');}catch{toast('当前记录已停写，请先核对原文');}}});
render();
