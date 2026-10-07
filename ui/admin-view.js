const labels = Object.freeze({
  roomRecovery: '房间恢复',
  inventory: '库存审核',
  gift: '赠酒审核',
  rounding: '免零审核',
  credit: '挂账审批',
  repayment: '回款审核',
  incidentResolution: '异常恢复审核',
  expense: '费用审批'
});

export const escapeAdminText = value => String(value ?? '').replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    "'": '&#39;' })[char]);

const numberText = value => Number.isSafeInteger(value) ?
  (value / 100).toFixed(2) : '待核对';
const line = (label, value) => value === undefined || value === null ||
  value === '' ? '' : `<p><span class="muted">${escapeAdminText(label)}：</span>${escapeAdminText(value)}</p>`;

function reviewCard(item) {
  const title = labels[item.type] ?? '待审核';
  const detail = item.type === 'roomRecovery' ?
    `${item.room} · ${item.fromStatus ?? ''} → ${item.requestedStatus ?? ''}` :
    item.type === 'inventory' ?
      `${item.product} · ${item.before ?? '未建账'} → ${item.after ?? ''}` :
    item.type === 'gift' ?
      `${item.room} · ${item.productNameSnapshot ?? item.product ?? ''} · ${item.bottles ?? ''} 支` :
    item.type === 'incidentResolution' ?
      `${item.room} · ${item.incidentType ?? ''}` :
    item.type === 'expense' ?
      `${item.description ?? ''} · ¥${numberText(item.amount)}` :
      `${item.room ?? ''} · ¥${numberText(item.amount)}`;
  const note = item.reason ?? item.note ?? item.evidenceText ?? item.result ?? '';
  return `<article class="panel admin-review" data-review-type="${escapeAdminText(item.type)}" data-review-id="${escapeAdminText(item.id ?? item.orderId)}"><div class="split"><h3>${escapeAdminText(title)}</h3><span class="badge">待处理</span></div><p>${escapeAdminText(detail)}</p>${line('说明', note)}${item.evidencePhoto || item.proof ? '<p class="muted">含图片证据</p>' : ''}${line('提交人标识', item.submittedByPrincipalId)}</article>`;
}

function simpleRows(title, items, render) {
  if (!Array.isArray(items)) return '';
  return `<section class="admin-section"><div class="section-title"><h2>${escapeAdminText(title)}</h2><span>${items.length} 项</span></div>${items.length ?
    items.map(render).join('') : '<p class="muted">当前没有记录。</p>'}</section>`;
}

function dashboard(model) {
  const { snapshot, session } = model;
  const view = snapshot.view;
  if (!view || !view.dashboard || !Array.isArray(view.rooms) ||
      !Array.isArray(view.reviewQueue)) {
    return '<main><section class="panel"><h1>无法安全显示后台数据</h1><p>请重新读取服务器状态。</p></section></main>';
  }
  const stale = model.phase !== 'ready' || model.stale;
  const counts = view.dashboard;
  const notice = stale ?
    '<p class="notice" role="alert">连接中断 · 以下是上次确认的只读状态。恢复连接并重新读取后才能继续操作。</p>' : '';
  const reviews = simpleRows('待审批事项', view.reviewQueue, reviewCard);
  const rooms = simpleRows('房间状态', view.rooms, room =>
    `<article class="panel"><div class="split"><b>${escapeAdminText(room.id)} · ${escapeAdminText(room.type)}</b><span class="badge">${escapeAdminText(room.status)}</span></div></article>`);
  const orders = simpleRows('订单基本状态', view.orders, order =>
    `<article class="panel"><div class="split"><b>${escapeAdminText(order.id)} · ${escapeAdminText(order.room ?? '零售')}</b><span class="badge">${escapeAdminText(order.status)}</span></div></article>`);
  const expenses = simpleRows('费用记录', view.expenses, item =>
    `<article class="panel"><b>${escapeAdminText(item.description)}</b>${line('金额', '¥' + numberText(item.amount))}${line('状态', item.status)}</article>`);
  const procurements = simpleRows('采购记录', view.procurements, item =>
    `<article class="panel"><b>${escapeAdminText(item.item)}</b>${line('数量', item.quantity)}${line('状态', item.status)}</article>`);
  const incidents = simpleRows('异常与事件', view.incidents, item =>
    `<article class="panel"><b>${escapeAdminText(item.room)} · ${escapeAdminText(item.type)}</b>${line('状态', item.status)}</article>`);
  const catalog = view.catalog ?
    simpleRows('目录维护', view.catalog.products, item =>
      `<article class="panel"><b>${escapeAdminText(item.name)}</b>${line('商品标识', item.id)}${line('状态', item.active === false ? '已停用' : '启用')}</article>`) : '';
  return `<main id="main"><div class="connection"><span class="online-dot"></span>${stale ?
    '后台状态待重新确认' : '已连接正式后台'}<span>服务器版本 ${escapeAdminText(snapshot.revision)}</span></div>${notice}<section class="panel"><p class="eyebrow">正式系统后台</p><h1>经营概览</h1><p class="muted">当前账号 ${escapeAdminText(session.principalId)}</p><div class="split"><p>房间 ${escapeAdminText(counts.roomCount)} · 营业中 ${escapeAdminText(counts.occupiedRooms)} · 异常 ${escapeAdminText(counts.issueRooms)}</p><p>待审批 ${escapeAdminText(counts.pendingReviews)}</p></div>${counts.orderCount === undefined ? '' : line('可见订单', counts.orderCount)}</section><button class="quiet" type="button" data-action="adminRefresh">重新读取服务器状态</button>${reviews}${rooms}${orders}${expenses}${procurements}${incidents}${catalog}</main>`;
}

export function renderAdminPage(model) {
  const session = model.session;
  const header = `<header class="topbar"><a class="brand" href="/admin"><span class="brand-mark">金</span><span>金碧辉煌<small>KTV · 系统管理</small></span></a><div class="header-actions"><a class="entry-link" href="/">员工入口</a>${session || model.error?.code === 'authorization_denied' ?
    '<button class="secondary" type="button" data-action="adminLogout">退出登录</button>' : ''}</div></header>`;
  if (model.phase === 'login') {
    return `${header}<main><section class="panel staff-auth"><h1>后台登录</h1><p class="muted">使用正式账号和权限进入。</p>${model.error ?
      '<p class="notice" role="alert">账号或密码不正确，或登录已失效。</p>' : ''}<form id="admin-login"><label>账号<input name="loginIdentifier" autocomplete="username" required maxlength="191"></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><button class="primary full" type="submit">登录后台</button></form></section></main>`;
  }
  if (model.error?.code === 'authorization_denied') {
    return `${header}<main><section class="panel portal-denied"><h1>无权访问系统后台</h1><p>当前正式账号没有后台查看资格。请联系门店管理员配置权限。</p></section></main>`;
  }
  if (session && model.snapshot) return header + dashboard(model);
  const title = model.phase === 'loading' ? '正在读取后台状态' : '暂时无法连接门店服务器';
  return `${header}<main><section class="panel staff-auth"><h1>${title}</h1><p>请检查连接并重试。</p><button class="secondary full" type="button" data-action="adminRefresh">重新连接</button></section></main>`;
}