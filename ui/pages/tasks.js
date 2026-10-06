// Phase 7 自 app.js 迁入；唯一机械转换：模块级可变状态（state/page/filter/searchTerm/
// reportPeriod/storageProblem/APP_ENTRY/DEFAULT_PAGE/modal 等）→ ctx.*，函数体逐字保留。

import { allowedPermission, btn, canReviewSubmission, contactText, ctx, currentUser, date, esc, product, reviewPermissionHint } from '../context.js';
import { roomIssueEvidenceMarkup } from '../forms.js';
import { BUSINESS_REVIEW_SECTIONS, businessReviewSections } from '../../shared/identity.js';
import { visibleIncidents } from '../../incidents.js';
import { money } from '../../shared/money.js';
import { pendingBusinessReviewCount as inboxPendingCount, reviewHistoryRows as inboxHistoryRows } from '../../reviewInbox.js';

function repaymentReviewMarkup(o) {
  const rows=(o.credit?.repaymentRequests||[]).filter(request=>request.status==='待审核');
  return rows.map(request=>{const canReview=allowedPermission('credit.repay.approve')&&canReviewSubmission(request);return `<div class="notice"><div class="split"><b>回款 ${money(request.amount)} · ${esc(request.method)}</b><span class="badge">待审核</span></div><p>登记人 ${esc(request.submittedBy)} · ${date(request.submittedAt)}</p>${canReview?btn('审核回款','reviewRepayment',`data-id="${o.id}" data-request="${request.id}"`,'primary full'):reviewPermissionHint(request)||'<span class="badge">需要回款审核权限</span>'}</div>`;}).join('');
}

function creditDetailMarkup(o, includeActions=true) {
  const actions = !includeActions ? '' : o.status==='待审批挂账' ? (allowedPermission('credit.approve')?btn('查看签字并审批','review',`data-id="${o.id}"`):'<span class="badge">等待有审批权限的身份处理</span>') : o.status==='已挂账' ? (allowedPermission('credit.repay')?btn('登记回款','repay',`data-id="${o.id}"`):'<span class="badge">等待有回款权限的身份处理</span>') : '';
  const lastRepayment = o.credit.repayments?.at(-1);
  return `<p>${esc(contactText(o.credit))} · 挂账经办 ${esc(o.credit.person)}</p><p>开单：${esc(o.credit.openedBy || o.openedBy || o.person || '未记录')} · 开房渠道：${esc(o.credit.openSource || o.openSource || '线下')}</p><p>预订：${o.credit.reservedBy?`${esc(o.credit.reservedBy)}（${esc(o.credit.reservationSource || '方式未记录')}）`:'无预订'}</p><p>备注：${esc(o.credit.note || '未填写')}</p><p class="muted">${o.credit.approver}审批 · 到期 ${date(o.credit.due)}${lastRepayment?` · 最后回款 ${date(lastRepayment.time)}`:''}</p>${o.status==='已挂账' && new Date(ctx.state.clock)>new Date(o.credit.due)?'<p class="notice">已逾期 · 提醒店长，抄送财务（演示，无外发）</p>':''}${repaymentReviewMarkup(o)}${actions}`;
}

function creditCards() {
  const rows = ctx.state.orders.filter(o=>o.credit).map(o=>{
    if (o.status === '已回款') return `<details class="panel credit-repaid"><summary><span><b>${esc(o.room)} · ${esc(contactText(o.credit))}</b><small>原挂账 ${money(o.credit.amount)} · 点击查看详情</small></span><span class="badge">已回款</span></summary><div class="credit-details">${creditDetailMarkup(o,false)}</div></details>`;
    return `<article class="panel"><div class="split"><h3>${esc(o.room)} · ${money(o.credit.remaining)}</h3><span class="badge">${esc(o.status)}</span></div>${creditDetailMarkup(o)}</article>`;
  }).join('');
  return rows || '<div class="empty">暂无挂账。员工或老板可从营业账单的“结账”入口申请挂账。</div>';
}

function creditApprovalCards() {
  const rows=ctx.state.orders.filter(order=>order.status==='待审批挂账'&&order.credit);
  return rows.map(order=>`<article class="panel"><div class="split"><h3>${esc(order.room)} · ${money(order.credit.amount)}</h3><span class="badge">待审批挂账</span></div>${creditDetailMarkup(order)}</article>`).join('')||'<p class="muted">暂无挂账申请待审批。</p>';
}

function repaymentReviewCards() {
  const rows=ctx.state.orders.filter(order=>(order.credit?.repaymentRequests||[]).some(request=>request.status==='待审核'));
  return rows.map(order=>`<article class="panel"><div class="split"><h3>${esc(order.room)} · ${esc(contactText(order.credit))}</h3><span class="badge">回款待审核</span></div>${repaymentReviewMarkup(order)}</article>`).join('')||'<p class="muted">暂无挂账回款待审核。</p>';
}

function expenseReviewCards() {
  const rows=(ctx.state.expenses||[]).filter(expense=>expense.status==='待老板审批');
  return rows.map(expense=>`<article class="panel"><div class="split"><h3>${esc(expense.description)} · ${money(expense.amount)}</h3><span class="badge">待老板审批</span></div><p>${esc(expense.date)} · ${esc(expense.person)} · ${esc(expense.method)}</p><div class="inline-actions">${btn('批准报销','approveExpense',`data-id="${expense.id}"`,'primary')}${btn('驳回','rejectExpense',`data-id="${expense.id}"`,'danger')}</div></article>`).join('')||'<p class="muted">暂无大额报销待审批。</p>';
}

function giftRequestCards() {
  const rows=ctx.state.orders.flatMap(o=>(o.giftRequests||[]).filter(request=>request.status==='待确认').map(request=>({o,request})));
  return rows.map(({o,request})=>`<article class="panel"><div class="split"><h3>${o.room} · ${esc(request.productNameSnapshot || product(request.productId || request.product).name)}</h3><span class="badge">待确认</span></div><p>${request.halves} 个半打，共 ${request.bottles} 支 · 申请人 ${esc(request.requestedBy)}</p>${allowedPermission('gift.approve')&&canReviewSubmission(request)?btn('进入账单处理','order',`data-id="${o.id}"`):reviewPermissionHint(request)||'<span class="badge">需要赠酒水审核权限</span>'}</article>`).join('') || '<p class="muted">暂无超额赠酒水申请。</p>';
}

function roundingReviewCards() {
  const rows=ctx.state.orders.filter(order=>order.roundingReview?.status==='待审核');
  return rows.map(order=>{const canReview=allowedPermission('rounding.approve')&&canReviewSubmission(order.roundingReview);return `<article class="panel"><div class="split"><h3>${esc(order.room)} · 特殊情况 ${money(order.roundingReview.amount)}</h3><span class="badge">待审核</span></div><p>${esc(order.roundingReview.note)} · 提交人 ${esc(order.roundingReview.submittedBy)}</p><p class="muted">${date(order.roundingReview.submittedAt)}</p>${canReview?btn('查看并审核','reviewRounding',`data-id="${order.id}"`):reviewPermissionHint(order.roundingReview)||'<span class="badge">需要特殊差额审核权限</span>'}</article>`;}).join('') || '<p class="muted">暂无特殊差额待审核。</p>';
}

function inventoryReviewCards() {
  const rows=(ctx.state.inventoryReviews||[]).filter(request=>request.status==='待审核');
  return rows.map(request=>{const catalogItem=ctx.state.catalog.products.find(item=>item.id===request.product), label=request.kind==='consumable'?(catalogItem?.name||request.product):catalogItem?.name||request.product;const unit=request.kind==='consumable'?(ctx.state.consumables?.[request.product]?.unit||catalogItem?.baseUnit||'份'):(catalogItem?.baseUnit||'支');const opened=request.kind==='consumable'?` · 已开封 ${request.openedBefore||0} → ${request.openedAfter||0}`:'';const canReview=allowedPermission('inventory.approve')&&canReviewSubmission(request);return `<article class="panel"><div class="split"><h3>${esc(label)} · ${esc(request.source)}</h3><span class="badge">待审核</span></div><p>${request.before??'未建账'} → ${request.after} ${esc(unit)}${opened}</p><p>${esc(request.reason)} · 提交人 ${esc(request.submittedBy)}</p>${canReview?btn('审核库存盘点','reviewInventory',`data-id="${request.id}"`,'primary full'):reviewPermissionHint(request)||'<span class="badge">需要库存审核权限</span>'}</article>`;}).join('')||'<p class="muted">暂无库存盘点待审核。</p>';
}

function incidentResolutionReviewCards() {
  const rows=(ctx.state.incidents||[]).flatMap(incident=>(incident.resolutionReviews||[]).filter(request=>request.status==='待审核').map(request=>({incident,request})));
  return rows.map(({incident,request})=>{const canReview=allowedPermission('incident.resolve.approve')&&canReviewSubmission(request);return `<article class="panel"><div class="split"><h3>${esc(incident.room)} · ${esc(incident.type)}</h3><span class="badge">恢复待审核</span></div><p>${esc(request.result)}</p><p class="muted">提交 ${esc(request.submittedBy)} · ${date(request.submittedAt)}</p>${canReview?btn('审核处理结果','reviewIncidentResolution',`data-id="${incident.id}" data-request="${request.id}"`,'primary full'):reviewPermissionHint(request)||'<span class="badge">需要客诉／异常恢复审核权限</span>'}</article>`;}).join('')||'<p class="muted">暂无客诉／异常恢复待审核。</p>';
}

function roomIssueReviewCards() {
  const all=[...(ctx.state.roomIssueReviews || [])].sort((a,b)=>Date.parse(b.submittedAt)-Date.parse(a.submittedAt)||Number(b.id||0)-Number(a.id||0));
  const rows=all.filter(request=>request.status==='待审核');
  const pending=rows.map(request=>{
    const canReview=allowedPermission('room.issue.approve') && canReviewSubmission(request);
    return `<article class="panel room-issue-review"><div class="split"><h3>${esc(request.room)} · 恢复为空房</h3><span class="badge">待审核</span></div><p>${esc(request.fromStatus)} → 空闲${request.issueType?` · ${esc(request.issueType)}`:''}</p><p class="muted">提交：${esc(request.submittedBy)} · ${date(request.submittedAt)}</p>${roomIssueEvidenceMarkup(request)}${canReview?btn('查看并审核','reviewRoomIssue',`data-id="${request.id}"`,'primary full'):reviewPermissionHint(request)||'<span class="badge">需要房间恢复审核权限</span>'}</article>`;
  }).join('');
  const history=all.filter(request=>request.status!=='待审核').slice(0,6);
  const historyMarkup=history.length?`<details class="panel room-issue-history"><summary>最近房态记录（${history.length}）</summary>${history.map(request=>`<div class="room-issue-history-row"><div class="split"><b>${esc(request.room)} · ${esc(request.change)}</b><span class="badge">${esc(request.status)}</span></div><p>${esc(request.fromStatus)} → ${esc(request.requestedStatus)} · 提交 ${esc(request.submittedBy)}${request.decidedBy?` · 审核 ${esc(request.decidedBy)}`:' · 无需审核'}</p>${roomIssueEvidenceMarkup(request)}${request.decisionNote?`<p class="muted">记录备注：${esc(request.decisionNote)}</p>`:''}</div>`).join('')}</details>`:'';
  return `${pending || '<p class="muted">暂无房间恢复申请待审核。</p>'}${historyMarkup}`;
}

function myPendingIncidentTasks() {
  const name=currentUser().name;
  return (ctx.formal ? ctx.state.incidents : visibleIncidents(ctx.state,currentUser())).filter(incident=>
    (ctx.formal ? incident.assigneeEmployeeId===ctx.state.actorEmployee?.employeeId : incident.assignee===name)&&incident.status==='待处理'&&!(incident.resolutionReviews||[]).some(request=>request.status==='待审核'));
}

function myTaskCards(rows=myPendingIncidentTasks()) {
  return rows.map(incident=>`<article class="panel"><div class="split"><h3>${esc(incident.room)} · ${esc(incident.type)}</h3><span class="badge">等待处理</span></div><p>${esc(incident.description)}</p><p class="muted">${esc(incident.date)} · 负责人 ${esc(incident.assignee)}</p>${allowedPermission('incident.resolve')?btn('填写处理结果','resolveIncident',`data-id="${incident.id}"`,'primary full'):'<span class="badge">需要客诉／异常处理权限</span>'}</article>`).join('')||'<p class="muted">当前没有分配给你的业务待办。</p>';
}

function pendingBusinessReviewCount(section) {
  // 命令体已迁至 reviewInbox.js（Phase 5），逐字节保留；此处仅绑定当前状态。
  return inboxPendingCount(ctx.state, section);
}

function reviewHistoryRows() {
  // 命令体已迁至 reviewInbox.js（Phase 5），逐字节保留；此处仅绑定当前状态与当前身份。
  return inboxHistoryRows(ctx.state, currentUser(), ctx.formal ?
    BUSINESS_REVIEW_SECTIONS.filter(section =>
      ctx.formal.reviewSections?.includes(section.permission)).map(section => section.id) : undefined,
    ctx.formal?.session.principalId ?? null);
}

function reviewHistoryCards(rows=reviewHistoryRows()) {
  return rows.map(row=>`<article class="panel"><div class="split"><h3>${esc(row.title)}</h3><span class="badge">${esc(row.status)}</span></div><p class="muted">${date(row.time)}${row.selfReviewAuthorized?' · 已授权自审':''}</p>${row.note?`<p>${esc(row.note)}</p>`:''}</article>`).join('')||'<p class="muted">当前身份暂无已处理审核记录。</p>';
}

function taskCenterPage() {
  const sections=ctx.formal ? BUSINESS_REVIEW_SECTIONS.filter(section =>
    ctx.formal.reviewSections?.includes(section.permission)).map(section => section.id) :
    businessReviewSections(currentUser()), myTasks=myPendingIncidentTasks(), history=reviewHistoryRows();
  const reviewViews={
    creditApproval:['挂账审批','按金额对应的店长或老板权限处理。',creditApprovalCards],
    creditRepayment:['挂账回款审核','批准后才扣减欠款并计入实收。',repaymentReviewCards],
    rounding:['特殊差额审核','核实特殊少收原因，不改写已完成账单。',roundingReviewCards],
    gift:['超额赠酒水审核','待确认赠送会阻止结账或挂账。',giftRequestCards],
    roomRecovery:['房间恢复审核','故障标记立即生效，恢复为空房才需审核。',roomIssueReviewCards],
    inventory:['库存盘点审核','批准后才改变酒水或消耗品账面数量。',inventoryReviewCards],
    incident:['客诉／异常恢复审核','处理结果批准后才转为完成。',incidentResolutionReviewCards],
    expense:['大额报销审批','超过500元的报销由有权限人员处理。',expenseReviewCards]
  };
  const pendingCount=sections.reduce((sum,section)=>sum+pendingBusinessReviewCount(section),0);
  const reviews=sections.map(section=>{const [title,hint,renderCards]=reviewViews[section];return `<section class="task-review-section" data-review-section="${section}"><div class="section-title"><div><h2>${title}</h2><p class="muted">${hint}</p></div><span>${pendingBusinessReviewCount(section)} 项</span></div>${renderCards()}</section>`;}).join('');
  return `<p class="eyebrow">员工系统 · 营业待办</p><h1>待办 / 审核中心</h1><p class="muted">这里只汇总当前需要你处理的事项；主动发起型营业操作仍在房间、库存、采购、客诉、交班或“我的”中。</p><section class="summary"><div><strong>${myTasks.length}</strong><span>我的待办</span></div><div><strong>${pendingCount}</strong><span>待审核事项</span></div><div><strong>${history.length}</strong><span>最近已处理</span></div></section><div class="section-title"><h2>我的待办</h2><span>按负责人显示</span></div>${myTaskCards(myTasks)}<div class="section-title"><h2>待我审核</h2><span>按具体审核权限显示</span></div>${reviews||'<div class="empty">当前身份没有业务审核权限，不显示其他审核事项。</div>'}<div class="section-title"><h2>审核记录 / 已处理事项</h2><span>仅显示当前身份处理的对应业务</span></div>${reviewHistoryCards(history)}`;
}

export {
  repaymentReviewMarkup,
  creditDetailMarkup,
  creditCards,
  creditApprovalCards,
  repaymentReviewCards,
  expenseReviewCards,
  giftRequestCards,
  roundingReviewCards,
  inventoryReviewCards,
  incidentResolutionReviewCards,
  roomIssueReviewCards,
  myPendingIncidentTasks,
  myTaskCards,
  pendingBusinessReviewCount,
  reviewHistoryRows,
  reviewHistoryCards,
  taskCenterPage
};
