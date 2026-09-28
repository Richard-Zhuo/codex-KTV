// Phase 7 自 app.js 迁入；唯一机械转换：模块级可变状态（state/page/filter/searchTerm/
// reportPeriod/storageProblem/APP_ENTRY/DEFAULT_PAGE/modal 等）→ ctx.*，函数体逐字保留。

import { allowedPermission, btn, canReviewSubmission, ctx, currentUser, date, esc, portalBackButton, reviewPermissionHint } from '../context.js';
import { pendingIncidentReminders, visibleIncidents } from '../../incidents.js';

function incidentPage() {
  const rows=[...visibleIncidents(ctx.state,currentUser())].sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')) || Number(b.id||0)-Number(a.id||0));
  const reminders=pendingIncidentReminders(ctx.state,ctx.state.clock).filter(row=>rows.some(item=>item.id===row.id));
  const body=rows.map(row=>{
    const pending=(row.resolutionReviews||[]).find(request=>request.status==='待审核');
    const canResolve=!pending&&row.status!=='已完成'&&allowedPermission('incident.resolve')&&(row.assignee===currentUser().name||allowedPermission('incident.viewAll'));
    const canReview=pending&&allowedPermission('incident.resolve.approve')&&canReviewSubmission(pending.submittedById);
    const result=row.status==='已完成'?`<div class="incident-result"><b>处理结果</b><p>${esc(row.result)}</p><b>备注</b><p>${esc(row.note)}</p><p class="muted">处理 ${esc(row.resolvedBy||'')} · 审核 ${esc(row.reviewedBy||'未记录')} · ${date(row.resolvedAt)}</p></div>`:'';
    const review=pending?`<div class="notice"><b>处理结果待审核</b><p>${esc(pending.result)}</p><p>${esc(pending.note)}</p><p class="muted">提交 ${esc(pending.submittedBy)} · ${date(pending.submittedAt)}</p>${canReview?btn('审核处理结果','reviewIncidentResolution',`data-id="${row.id}" data-request="${pending.id}"`,'primary full'):reviewPermissionHint(pending.submittedById)||'<span class="badge">需要客诉／异常恢复审核权限</span>'}</div>`:'';
    const action=result||review||(canResolve?btn('填写处理结果','resolveIncident',`data-id="${row.id}"`,'secondary full'):'<span class="badge">等待负责人处理</span>');
    return `<article class="panel incident-card ${row.status==='已完成'?'incident-complete':''}"><div class="split"><div><h3>${esc(row.type)} · ${esc(row.room)}</h3><p>${esc(row.date)} · 登记人 ${esc(row.person||'未记录')}</p></div><span class="badge">${esc(row.status)}</span></div><p>${esc(row.description)}</p><p class="muted">负责人：${esc(row.assignee||'未指定')}</p>${action}</article>`;
  }).join('');
  return `<p class="eyebrow">现场记录</p><div class="section-title expense-heading"><div><h1>客诉 / 异常</h1><p class="muted">${allowedPermission('incident.viewAll')?'当前显示全部记录。':'当前显示你登记或负责处理的记录。'} 未完成项目每天14:00提醒。</p></div><div class="expense-toolbar">${portalBackButton()}${allowedPermission('incident.create')?btn('＋ 登记客诉 / 异常','addIncident','','primary'):''}</div></div>${reminders.length?`<div class="notice incident-reminder">今天14:00提醒：还有 ${reminders.length} 项未完成，请及时填写处理结果。</div>`:''}<section class="summary expense-summary"><div><strong>${rows.length}</strong><span>记录数</span></div><div><strong>${rows.filter(row=>row.status!=='已完成').length}</strong><span>待处理</span></div><div><strong>${reminders.length}</strong><span>今日提醒</span></div></section>${rows.length?`<div class="incident-list">${body}</div>`:'<div class="empty">暂无客诉或异常记录。<small>登记后分配负责人填写处理结果和备注。</small></div>'}`;
}

export {
  incidentPage
};
