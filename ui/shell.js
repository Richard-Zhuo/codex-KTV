import { deviceOpeningRejectionText } from './device-progress.js';
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

function persist(next) { if (ctx.formalEnabled) throw new TypeError('Server snapshot is read-only'); ctx.persistence.save(next); ctx.state = next; }

function toast(text) { const el = document.querySelector('#toast'); el.textContent = text; el.classList.add('show'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove('show'),4500); }

function openDialog(title, content, submitLabel, action, hidden={}) {
  if (ctx.modal.open) ctx.modal.close();
  ctx.modal.innerHTML = `${ctx.formalEnabled ? '' : '<div class="dialog-demo">演示数据 · 不产生真实收款</div>'}<header class="dialog-head"><h2 id="modal-title">${title}</h2>${btn('关闭','close','','quiet')}</header><form data-form="${action || ''}">${Object.entries(hidden).map(([k,v])=>`<input type="hidden" name="${k}" value="${esc(v)}">`).join('')}${content}<p class="form-error" role="alert"></p>${submitLabel?`<button class="primary full" type="submit">${submitLabel}</button>`:''}</form>`;
  ctx.modal.showModal();
}

async function commit(action, data, key) {
  if (ctx.formalEnabled) {
    if (!ctx.formal) throw new TypeError('Formal session unavailable');
    try {
      const outcome = await ctx.formal.flow.submit(action, data);
      if (ctx.modal.open) ctx.modal.close();
      ctx.formal.lastError = outcome.error ?? null;
      render();
      toast(action==='open' && outcome.result?.result?.businessState==='OPENING' ? '开房申请已保存，正在确认设备；请勿重复开房' : outcome.refreshed ? '已由服务器确认并重新读取门店状态' :
        '写入结果已确认，正在重新读取门店状态');
      return outcome;
    } catch (error) {
      if (ctx.modal.open) ctx.modal.close();
      ctx.formal.lastError = error;
      render();
      throw error;
    }
  }
  const next = transact(ctx.state, action, data, key);
  persist(next);
  ctx.modal.close();
  render();
  toast('已保存 · 仅为演示记录');
}

function recoveryPage(record, state) {
  const orders = record?.readable && Array.isArray(state?.orders) ? state.orders : null;
  const payments = orders?.reduce((count, order) => count + (Array.isArray(order.payments) ? order.payments.length : 0), 0);
  const rawView = record?.raw == null
    ? '<p>当前无法读取原文。请检查此浏览器的站点数据权限，暂勿清除站点数据。</p>'
    : `<details class="panel"><summary>查看并复制原始记录</summary><p class="muted">以下内容只读，来自本机原始记录；复制时请完整保留。</p><textarea readonly rows="12" aria-label="原始记录">${esc(record.raw)}</textarea></details>`;
  return `<header class="topbar"><div class="brand"><span class="brand-mark">金</span><span>金碧辉煌<small>KTV · 记录核对</small></span></div></header><main id="main"><section class="panel"><p class="eyebrow">本机记录需要核对</p><h1>已暂停保存</h1><p class="notice">${esc(record?.problem || '记录异常，已停止写入。')}</p>${orders ? `<p>可读取的历史订单 ${orders.length} 笔，付款 ${payments} 笔；这些记录仍在本机，当前仅供核对。</p>` : '<p>当前无法安全解析业务明细；原始记录仍可在下方查看。</p>'}<p>请先复制原始记录，交由维护人员核对当前套餐配置。修正本机主记录后再点“重新检查”。历史成交金额和付款不得按现价重算。</p><p class="muted">主记录：${esc(record?.key || '')}；${record?.backupSaved ? `另有恢复副本：${esc(record.backupKey)}` : record?.raw == null ? '当前无法读取主记录，仍禁止写入' : '独立副本未确认保存，主记录保持原样'}。</p>${btn('重新检查本机记录','retryRecovery','','primary')}</section>${rawView}</main>`;
}

function renderFormal() {
  const sections = ctx.formal.workspace.sections;
  const grants = new Set(ctx.formal.session.permissionIds);
  const available = {
    rooms: sections.rooms, retail: grants.has('retail.sale'),
    deposits: sections.deposits,
    tasks: sections.roomIssueReviews || sections.inventoryReviews ||
      sections.incidents || sections.expenses || sections.orders,
    report: grants.has('report.view'), mine: true,
    expenses: sections.expenses, procurement: sections.procurements,
    incidents: sections.incidents
  };
  if (!available[ctx.page]) ctx.page = available.rooms ? 'rooms' :
    available.retail ? 'retail' : 'mine';
  const pages = { rooms: roomsPage, retail: retailPage, deposits: depositPage,
    tasks: taskCenterPage, report: reportPage, mine: minePage,
    expenses: expensesPage, procurement: procurementPage,
    incidents: incidentPage };
  let content;
  try { content = pages[ctx.page](); ctx.formal.renderFailed = false; }
  catch {
    ctx.formal.renderFailed = true;
    content = '<section class="panel"><h1>暂时无法安全显示营业数据</h1><p>请重新读取服务器状态。当前停止业务写入。</p></section>';
  }
  const flow = ctx.formal.flow.getStatus();
  const model = ctx.formal.state.getState();
  const writable = ctx.formal.state.isWritable() && flow.phase === 'idle' &&
    !ctx.formal.renderFailed;
  const navigation = [['rooms','房态'],['retail','零售'],['deposits','寄取酒'],
    ['tasks','待办'],['report','报表'],['mine','我的']]
    .filter(([id]) => available[id]);
  const label = error => deviceOpeningRejectionText(error) ?? ({
    unauthenticated: '登录已失效，请重新登录。',
    authorization_denied: '当前账号没有执行此操作的权限，请查看最新状态。',
    csrf_denied: '会话校验失效，请确认最新状态后重新操作。',
    revision_conflict: '营业状态已被其他人更新，请查看新状态后重新确认操作。',
    idempotency_conflict: '该操作编号与原请求不一致，已停止操作。',
    business_rejection: '服务器拒绝了这项业务操作，请核对当前状态。',
    invalid_input: '提交内容不符合要求，请核对后重新操作。'
  })[error?.code] ?? '暂时无法确认操作结果。';
  const error = ctx.formal.lastError ?? model.error;
  const notice = flow.phase === 'unknown'
    ? '<p class="notice" role="alert">上一笔操作结果待确认。请勿重做；由原操作人员使用同一操作编号和完全相同的请求确认。</p>' +
      btn('确认上一笔结果', 'formalRetryUnknown')
    : flow.phase === 'foreign'
      ? '<p class="notice" role="alert">上一笔操作由另一账号发起，结果待确认。当前账号不能重试；请由原操作人员登录并确认。</p>'
    : flow.phase === 'storage-unavailable'
      ? '<p class="notice" role="alert">无法安全读取或保存待确认操作记录。已停止新的业务写入，请先恢复本标签页的会话存储。</p>'
    : flow.phase === 'refresh-needed'
      ? '<p class="notice" role="alert">服务器已接收操作，但最新状态尚未读取。请先重新读取。</p>' +
        btn('重新读取服务器状态', 'formalRefreshKnown')
      : error ? `<p class="notice" role="alert">${label(error)}${error.requestId ? ` 查询编号：${esc(error.requestId)}` : ''}</p>` : '';
  const connection = writable ? '已连接正式营业状态' :
    model.stale || !navigator.onLine ? '连接中断 · 历史快照只读' : '正在确认服务器状态 · 暂停写入';
  ctx.app.innerHTML = `<header class="topbar"><a class="brand" href="/" data-action="home"><span class="brand-mark">金</span><span>金碧辉煌<small>KTV · 门店运营</small></span></a><div class="header-actions"><span class="identity"><span class="avatar">${esc(currentUser().name.slice(0,1))}</span>${esc(currentUser().name)}</span><button class="secondary" data-action="formalLogout">退出登录</button></div></header><main id="main"><div class="connection"><span class="online-dot"></span>${connection}<span>服务器版本 ${esc(model.snapshot.revision)} · ${date(ctx.state.clock)} ${slot(ctx.state.clock)==='day'?'下午场':slot(ctx.state.clock)==='night'?'夜间场':'非营业时间'}</span></div>${notice}<button class="quiet" data-action="formalRefresh">重新读取服务器状态</button>${content}</main><nav class="bottom-nav" aria-label="营业导航">${navigation.map(([id,name]) => `<button data-action="nav" data-page="${id}" class="${ctx.page===id?'selected':''}" ${ctx.page===id?'aria-current="page"':''}>${name}</button>`).join('')}</nav>`;
}

function render() {
  if (ctx.formalEnabled) {
    if (!ctx.formal) throw new TypeError('Formal session unavailable');
    renderFormal();
    return;
  }
  if (ctx.persistence?.isWriteBlocked()) {
    ctx.app.innerHTML = recoveryPage(ctx.persistence.recoveryRecord(), ctx.state);
    return;
  }
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
  recoveryPage,
  render
};
