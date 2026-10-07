import { adminDecisionNeedsNote } from './admin-approval.js';

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

function reviewCard(item, index, writable) {
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
  const actions = writable && item.canDecide === true ?
    `<div class="inline-actions"><button class="primary" type="button" data-action="adminDecide" data-index="${index}" data-decision="approve"${item.canApprove === true ? '' : ' disabled'}>批准</button><button class="danger" type="button" data-action="adminDecide" data-index="${index}" data-decision="reject"${item.canReject === true ? '' : ' disabled'}>驳回</button></div>` :
    writable && item.canDecide === false ?
      '<p class="muted">当前账号不能审核此申请；本人申请还需独立的自审资格。</p>' : '';
  return `<article class="panel admin-review" data-review-type="${escapeAdminText(item.type)}" data-review-id="${escapeAdminText(item.id ?? item.orderId)}"><div class="split"><h3>${escapeAdminText(title)}</h3><span class="badge">待处理</span></div><p>${escapeAdminText(detail)}</p>${line('说明', note)}${item.evidencePhoto || item.proof ? '<p class="muted">含图片证据</p>' : ''}${line('提交人标识', item.submittedByPrincipalId)}${actions}</article>`;
}

function simpleRows(title, items, render) {
  if (!Array.isArray(items)) return '';
  return `<section class="admin-section"><div class="section-title"><h2>${escapeAdminText(title)}</h2><span>${items.length} 项</span></div>${items.length ?
    items.map(render).join('') : '<p class="muted">当前没有记录。</p>'}</section>`;
}

const errorMessages = Object.freeze({
  unauthenticated: '登录已失效，请重新登录。',
  authorization_denied: '当前账号没有权限执行该操作；权限以服务器判定为准。',
  csrf_denied: '会话校验失败，请重新读取服务器状态。',
  business_rejection: '该事项不再满足处理条件，请核对最新状态。',
  revision_conflict: '事项已被他人修改，已重新读取状态；本次审批不会自动重试。',
  idempotency_conflict: '操作标识与原请求不一致，请停止重试并核对记录。',
  invalid_input: '提交内容无效，请核对后重新填写。',
  internal_error: '服务器暂时无法完成操作，请凭查询编号联系管理员。'
});

function commandNotice(flowStatus, error) {
  const phase = flowStatus?.phase ?? 'idle';
  const details = error ? `<p>${escapeAdminText(errorMessages[error.code] ??
    (error.reason ? '无法连接门店服务器，请核对上一笔操作结果。' :
      '暂时无法完成操作，请核对服务器状态。'))}</p>${error.requestId ?
      `<small>查询编号：${escapeAdminText(error.requestId)}</small>` : ''}` : '';
  const warning = phase === 'unknown' ?
    '<p>上一笔操作结果待确认。请恢复连接后使用原操作标识重试；不要重新发起审批。</p><button class="secondary" type="button" data-action="adminRetryUnknown">使用原操作标识确认结果</button>' :
    phase === 'foreign' ?
      '<p>本标签页有另一账号留下的待确认操作。当前账号不能重试，请换回原账号核对。</p>' :
    phase === 'storage-unavailable' ?
      '<p>无法安全保存待确认操作，已暂停新的审批。请检查浏览器会话存储。</p>' :
    phase === 'refresh-needed' ?
      '<p>服务器已确认操作，但最新状态尚未读取。请重新读取后再继续。</p><button class="secondary" type="button" data-action="adminRefreshKnown">重新读取确认状态</button>' :
    phase === 'sending' ? '<p>正在等待服务器确认审批结果。</p>' : '';
  return details || warning ? `<section class="notice" role="alert">${details}${warning}</section>` : '';
}

function dashboard(model, { flowStatus, lastError } = {}) {
  const { snapshot, session } = model;
  const view = snapshot.view;
  if (!view || !view.dashboard || !Array.isArray(view.rooms) ||
      !Array.isArray(view.reviewQueue)) {
    return '<main><section class="panel"><h1>无法安全显示后台数据</h1><p>请重新读取服务器状态。</p></section></main>';
  }
  const stale = model.phase !== 'ready' || model.stale;
  const writable = !stale && (flowStatus?.phase ?? 'idle') === 'idle';
  const counts = view.dashboard;
  const notice = stale ?
    '<p class="notice" role="alert">连接中断 · 以下是上次确认的只读状态。恢复连接并重新读取后才能继续操作。</p>' : '';
  const reviews = simpleRows('待审批事项', view.reviewQueue,
    (item, index) => reviewCard(item, index, writable));
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
    '后台状态待重新确认' : '已连接正式后台'}<span>服务器版本 ${escapeAdminText(snapshot.revision)}</span></div>${notice}${commandNotice(flowStatus, lastError)}<section class="panel"><p class="eyebrow">正式系统后台</p><h1>经营概览</h1><p class="muted">当前账号 ${escapeAdminText(session.principalId)}</p><div class="split"><p>房间 ${escapeAdminText(counts.roomCount)} · 营业中 ${escapeAdminText(counts.occupiedRooms)} · 异常 ${escapeAdminText(counts.issueRooms)}</p><p>待审批 ${escapeAdminText(counts.pendingReviews)}</p></div>${counts.orderCount === undefined ? '' : line('可见订单', counts.orderCount)}</section><button class="quiet" type="button" data-action="adminRefresh">重新读取服务器状态</button>${reviews}${rooms}${orders}${expenses}${procurements}${incidents}${catalog}</main>`;
}

function photoPreview(value, label) {
  if (typeof value !== 'string' ||
      !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return '';
  }
  return `<figure><img class="evidence-preview" alt="${escapeAdminText(label)}" src="${escapeAdminText(value)}"><figcaption>${escapeAdminText(label)}</figcaption></figure>`;
}

function decisionEvidence(item) {
  const details = item.type === 'roomRecovery' ?
    line('房间与状态', `${item.room} · ${item.fromStatus} → ${item.requestedStatus}`) +
      line('异常类型', item.issueType) + line('现场说明', item.evidenceText) +
      photoPreview(item.evidencePhoto, '房间现场照片') :
    item.type === 'inventory' ?
      line('商品与盘点', `${item.product} · ${item.before ?? '未建账'} → ${item.after}`) +
      line('盘点原因', item.reason) :
    item.type === 'gift' ?
      line('房间与商品', `${item.room} · ${item.productNameSnapshot ?? item.product}`) +
      line('赠送数量', item.bottles) :
    item.type === 'rounding' ?
      line('房间与差额', `${item.room} · ¥${numberText(item.amount)}`) +
      line('特殊情况', item.note) :
    item.type === 'credit' ?
      line('房间与金额', `${item.room} · ¥${numberText(item.amount)}`) +
      line('顾客姓名', item.name) + line('顾客电话', item.phone) +
      line('审批路径', item.approver) + line('挂账说明', item.note) +
      photoPreview(item.signature, '经办签名') :
    item.type === 'repayment' ?
      line('房间与金额', `${item.room} · ¥${numberText(item.amount)}`) +
      line('收款方式', item.method) :
    item.type === 'incidentResolution' ?
      line('房间与异常', `${item.room} · ${item.incidentType}`) +
      line('处理结果', item.result) + line('处理说明', item.note) :
      line('报销说明', item.description) +
      line('报销金额', `¥${numberText(item.amount)}`) +
      line('报销日期', item.date) + line('付款方式', item.method) +
      photoPreview(item.proof, '费用凭证');
  return details + line('提交人标识', item.submittedByPrincipalId);
}

export function renderAdminDecisionDialog(item, direction) {
  if (!labels[item?.type] || !['approve', 'reject'].includes(direction) ||
      item[direction === 'approve' ? 'canApprove' : 'canReject'] !== true) {
    throw new TypeError('Invalid review dialog');
  }
  const verb = direction === 'approve' ? '批准' : '驳回';
  const note = ['credit', 'expense'].includes(item.type) ? '' :
    `<label>${direction === 'reject' ? '驳回原因' : '审核备注（选填）'}<textarea name="decisionNote" maxlength="300" rows="3" ${adminDecisionNeedsNote(item, direction) ? 'required' : ''}></textarea></label>`;
  return `<form id="admin-decision"><h2 id="admin-modal-title">${verb}${escapeAdminText(labels[item.type])}</h2><p>请核对服务器上的待审事项与当前账号。提交后以服务器确认的结果为准。</p>${line('事项标识', item.id ?? item.orderId)}${decisionEvidence(item)}${note}<div class="inline-actions"><button class="secondary" type="button" data-action="adminCancelDecision">取消</button><button class="${direction === 'reject' ? 'danger' : 'primary'}" type="submit">确认${verb}</button></div></form>`;
}
export function renderAdminPage(model, options = {}) {
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
  if (session && model.snapshot) return header + dashboard(model, options);
  const title = model.phase === 'loading' ? '正在读取后台状态' : '暂时无法连接门店服务器';
  return `${header}<main><section class="panel staff-auth"><h1>${title}</h1><p>请检查连接并重试。</p><button class="secondary full" type="button" data-action="adminRefresh">重新连接</button></section></main>`;
}