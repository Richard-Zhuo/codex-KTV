// 应用外壳：persist/toast/openDialog/commit/render（Phase 7 自 app.js 迁入）。
// 唯一机械转换：模块级可变状态 → ctx.*；函数体逐字保留。

import { allowedPermission, btn, ctx, currentUser, date, esc } from './context.js';
import { roomsPage } from './pages/rooms.js';
import { retailPage } from './pages/retail.js';
import { depositPage } from './pages/deposits.js';
import { taskCenterPage } from './pages/tasks.js';
import { systemManagementPage } from './pages/admin.js';
import { expensesPage } from './pages/expenses.js';
import { procurementPage } from './pages/procurement.js';
import { incidentPage } from './pages/incidents.js';
import { reportPage } from './pages/reports.js';
import { minePage } from './pages/mine.js';
import { transact } from '../rules.js';
import { slot } from '../shared/time.js';

function persist(next) { try { ctx.persistence.save(next); ctx.state = next; } catch { throw Error('本机保存失败，操作未完成。请检查浏览器存储空间后重试。'); } }

function toast(text) { const el = document.querySelector('#toast'); el.textContent = text; el.classList.add('show'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove('show'),4500); }

function openDialog(title, content, submitLabel, action, hidden={}) {
  if (ctx.modal.open) ctx.modal.close();
  ctx.modal.innerHTML = `<div class="dialog-demo">演示数据 · 不产生真实收款</div><header class="dialog-head"><h2 id="modal-title">${title}</h2>${btn('关闭','close','','quiet')}</header><form data-form="${action || ''}">${Object.entries(hidden).map(([k,v])=>`<input type="hidden" name="${k}" value="${esc(v)}">`).join('')}${content}<p class="form-error" role="alert"></p>${submitLabel?`<button class="primary full" type="submit">${submitLabel}</button>`:''}</form>`;
  ctx.modal.showModal();
}

function commit(action, data, key) { const next=transact(ctx.state,action,data,key); persist(next); ctx.modal.close(); render(); toast('已保存 · 仅为演示记录'); }

function render() {
  const canManage = allowedPermission('backend.view');
  const adminPages = ['manage'];
  if (ctx.APP_ENTRY === 'admin' && !adminPages.includes(ctx.page)) ctx.page = 'manage';
  if (ctx.APP_ENTRY === 'staff' && ctx.page === 'manage') ctx.page = 'rooms';
  const content = ctx.APP_ENTRY === 'admin' && !canManage
    ? `<section class="panel portal-denied"><p class="eyebrow">系统管理</p><h1>当前身份不能进入系统后台</h1><p>请切换为有“进入系统管理后台”权限的身份，或返回员工系统继续营业操作。</p><a class="entry-link primary" href="/">返回员工系统</a></section>`
    : ctx.page==='rooms'?roomsPage():ctx.page==='retail'?retailPage():ctx.page==='deposits'?depositPage():ctx.page==='tasks'?taskCenterPage():ctx.page==='manage'?systemManagementPage():ctx.page==='expenses'?expensesPage():ctx.page==='procurement'?procurementPage():ctx.page==='incidents'?incidentPage():ctx.page==='report'?reportPage():minePage();
  const navItems = ctx.APP_ENTRY === 'admin'
    ? (canManage ? [['manage','▧','系统']] : [])
    : [['rooms','▦','房间'],...(allowedPermission('retail.sale')?[['retail','▣','零售']]:[]),['deposits','▤','存取酒'],['tasks','✓','待办'],...(allowedPermission('report.view')?[['report','▤','报表']]:[]),['mine','○','我的']];
  const portalLink = ctx.APP_ENTRY === 'admin'
    ? '<a class="entry-link" href="/">员工系统</a>'
    : canManage ? '<a class="entry-link" href="/admin">系统管理</a>' : '';
  const portalName = ctx.APP_ENTRY === 'admin' ? '系统管理' : '门店助手';
  ctx.app.innerHTML = `<header class="topbar"><a class="brand" href="${ctx.APP_ENTRY==='admin'?'/admin':'/'}" data-action="home"><span class="brand-mark">金</span><span>金碧辉煌<small>KTV · ${portalName}</small></span></a><div class="header-actions">${portalLink}<button class="identity" data-action="identity"><span class="avatar">${esc(currentUser().name[0])}</span>${esc(currentUser().name)} <span>⌄</span></button></div></header><main id="main"><div class="connection"><span class="online-dot"></span>${ctx.APP_ENTRY==='admin'?'系统管理演示':'本机练习'}${navigator.onLine?'':' · 当前设备离线'}<span>${date(ctx.state.clock)} · ${slot(ctx.state.clock)==='day'?'白天场':slot(ctx.state.clock)==='night'?'夜间场':'非营业时段'}</span></div>${ctx.storageProblem?`<p class="notice">${ctx.storageProblem}</p>`:''}${content}</main>${navItems.length?`<nav class="bottom-nav" aria-label="${ctx.APP_ENTRY==='admin'?'系统管理导航':'主导航'}">${navItems.map(([id,icon,label])=>`<button data-action="nav" data-page="${id}" class="${ctx.page===id?'selected':''}" ${ctx.page===id?'aria-current="page"':''}><span aria-hidden="true">${icon}</span>${label}</button>`).join('')}</nav>`:''}`;
}

export {
  persist,
  toast,
  openDialog,
  commit,
  render
};
