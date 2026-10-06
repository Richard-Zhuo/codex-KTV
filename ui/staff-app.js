import { createEmployeeApiClient, HttpApiError, HttpTransportError } from './api-client.js';
import { createEmployeeServerState } from './server-state.js';

const app = document.querySelector('#app');
const client = createEmployeeApiClient();
const state = createEmployeeServerState(client);
let page = 'rooms';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function errorText(error) {
  if (error instanceof HttpTransportError) {
    return error.reason === 'timeout' ? '连接超时，请检查网络后重试。' : '无法连接门店服务器，请检查网络。';
  }
  if (error instanceof HttpApiError) {
    const labels = {
      unauthenticated: '账号或密码不正确，或登录已失效。',
      authorization_denied: '当前账号没有执行此操作的权限。',
      csrf_denied: '会话校验已失效，请重新获取登录状态。',
      invalid_input: '提交内容不符合要求，请检查后重试。'
    };
    return labels[error.code] ?? '服务器暂时无法处理请求。';
  }
  return '服务器暂时无法处理请求。';
}
function errorNotice(error) {
  if (!error) return '';
  return `<p class="notice" role="alert">${esc(errorText(error))}${error.requestId
    ? `<br><small>查询编号：${esc(error.requestId)}</small>` : ''}</p>`;
}
function header(session) {
  return `<header class="topbar"><a class="brand" href="/" data-action="home"><span class="brand-mark">金</span><span>金碧辉煌<small>KTV · 门店助手</small></span></a>${session
    ? `<div class="header-actions"><span class="identity">已登录 · ${esc(session.principalId.slice(0, 8))}</span><button class="secondary" data-action="logout">退出登录</button></div>`
    : ''}</header>`;
}
function loginPage(error) {
  return `${header(null)}<main><section class="panel staff-auth"><h1>员工登录</h1><p class="muted">使用门店正式账号继续。</p>${errorNotice(error)}<form id="staff-login"><label>账号<input name="loginIdentifier" autocomplete="username" required maxlength="191"></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><button class="primary full" type="submit">登录并读取门店状态</button></form></section></main>`;
}
function roomsMarkup(view) {
  if (!Array.isArray(view.rooms)) {
    return '<div class="empty">当前账号没有房间查看权限，或服务器未提供房态。</div>';
  }
  return `<div class="rooms-grid">${view.rooms.map(room => `<article class="room-card"><span class="room-top"><span>${esc(room.type)}</span><span class="status">${esc(room.status)}</span></span><strong class="room-number">${esc(room.id)}</strong><span class="room-bottom">以服务器房态为准</span></article>`).join('') || '<div class="empty">暂无可查看的房间。</div>'}</div>`;
}
function readyPage(model) {
  const { snapshot, session, stale, error } = model;
  const view = snapshot.view;
  const pages = {
    rooms: `<section class="welcome"><div><p class="eyebrow">门店房态</p><h1>房间一眼看清</h1><p>以下为服务器确认的状态。</p></div></section><div class="section-title"><h2>全部包间</h2><span>版本 ${snapshot.revision}</span></div>${roomsMarkup(view)}`,
    retail: '<section class="panel"><h1>独立零售</h1><p class="muted">业务操作将在本阶段下一提交接入正式命令。</p></section>',
    tasks: '<section class="panel"><h1>待办</h1><p class="muted">当前只显示服务器已确认的查看结果。</p></section>',
    mine: `<section class="panel"><h1>我的账户</h1><p class="muted">当前正式账号：${esc(session.principalId)}</p></section>`
  };
  const nav = [['rooms', '包间'], ['retail', '零售'], ['tasks', '待办'], ['mine', '我的']]
    .map(([id, label]) => `<button data-action="nav" data-page="${id}" class="${page === id ? 'selected' : ''}" ${page === id ? 'aria-current="page"' : ''}>${label}</button>`).join('');
  return `${header(session)}<main><div class="connection"><span class="online-dot"></span>${stale ? '网络中断 · 旧快照只读' : '已连接门店服务器'}<span>账本版本 ${snapshot.revision}</span></div>${errorNotice(error)}<button class="quiet" data-action="refresh">重新读取服务器状态</button>${pages[page] ?? pages.rooms}</main><nav class="bottom-nav" aria-label="主导航">${nav}</nav>`;
}
function render(model) {
  if (model.phase === 'login') {
    app.innerHTML = loginPage(model.error);
  } else if (model.snapshot && model.session &&
             (model.phase === 'ready' || model.phase === 'unavailable')) {
    app.innerHTML = readyPage(model);
  } else if (model.phase === 'loading') {
    app.innerHTML = `${header(null)}<main><section class="panel staff-auth"><h1>正在读取门店状态</h1><p class="muted">请稍候。</p></section></main>`;
  } else {
    app.innerHTML = `${header(null)}<main><section class="panel staff-auth"><h1>暂时无法连接</h1>${errorNotice(model.error)}<button class="secondary full" data-action="refresh">重新连接</button></section></main>`;
  }
}
state.subscribe(render);
render(state.getState());
app.addEventListener('submit', async event => {
  if (event.target.id !== 'staff-login') return;
  event.preventDefault();
  const form = event.target;
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  const data = new FormData(form);
  await state.login(String(data.get('loginIdentifier') ?? ''),
    String(data.get('password') ?? ''));
});
app.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  event.preventDefault();
  const action = target.dataset.action;
  if (action === 'nav') {
    page = target.dataset.page;
    render(state.getState());
  } else if (action === 'home') {
    page = 'rooms';
    render(state.getState());
  } else if (action === 'logout') {
    await state.logout();
  } else if (action === 'refresh') {
    await state.reconnect();
  }
});
void state.bootstrap();
