import { createEmployeeApiClient, HttpApiError, HttpTransportError } from './api-client.js';
import { createEmployeeServerState } from './server-state.js';
import { createEmployeeCommandFlow } from './command-flow.js';
import { createPendingCommandJournal } from './pending-command-journal.js';
import { stateFromServerSnapshot } from './formal-workspace.js';
import { ctx, esc } from './context.js';
import { render as renderWorkspace } from './shell.js';

ctx.formalEnabled = true;
const app = document.querySelector('#app');
const client = createEmployeeApiClient();
const state = createEmployeeServerState(client);
const flow = createEmployeeCommandFlow({ api: client, state,
  journal: createPendingCommandJournal() });
let mounted = false;
let mounting = null;
let principalId = null;

function errorText(error) {
  if (error instanceof HttpTransportError) return error.reason === 'timeout'
    ? '连接超时，请检查网络后重新读取。' : '无法连接门店服务器，请检查网络。';
  if (error instanceof HttpApiError) return ({
    unauthenticated: '账号或密码不正确，或者登录已失效。',
    authorization_denied: '当前账号没有访问此页面的权限。',
    csrf_denied: '会话校验失效，请重新读取登录状态。',
    invalid_input: '提交内容不符合要求，请核对后重试。'
  })[error.code] ?? '服务器暂时无法处理请求。';
  return '服务器暂时无法处理请求。';
}
function errorNotice(error) {
  return error ? `<p class="notice" role="alert">${esc(errorText(error))}${error.requestId
    ? `<br><small>查询编号：${esc(error.requestId)}</small>` : ''}</p>` : '';
}
function header(session) {
  return `<header class="topbar"><a class="brand" href="/" data-action="home"><span class="brand-mark">金</span><span>金碧辉煌<small>KTV · 门店运营</small></span></a>${session
    ? '<div class="header-actions"><button class="secondary" data-action="formalLogout">退出登录</button></div>'
    : ''}</header>`;
}
function loginPage(error) {
  return `${header(null)}<main><section class="panel staff-auth"><h1>员工登录</h1><p class="muted">使用门店正式账号及密码</p>${errorNotice(error)}<form id="staff-login"><label>账号<input name="loginIdentifier" autocomplete="username" required maxlength="191"></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><button class="primary full" type="submit">登录并读取门店状态</button></form></section></main>`;
}
function statusPage(model, title, detail) {
  return `${header(model.session)}<main><section class="panel staff-auth"><h1>${title}</h1><p class="muted">${detail}</p>${errorNotice(model.error)}<button class="secondary full" data-action="formalRefresh">重新连接</button></section></main>`;
}

async function display(model) {
  if (model.session && model.snapshot &&
      (model.phase === 'ready' || model.phase === 'loading' ||
       model.phase === 'unavailable')) {
    if (model.phase === 'ready' && principalId !== model.session.principalId) {
      if (principalId && ctx.modal?.open) ctx.modal.close();
      flow.suspend();
      flow.restore();
      principalId = model.session.principalId;
    }
    let projected;
    try { projected = stateFromServerSnapshot(model.snapshot, model.session); }
    catch (error) {
      if (ctx.formal) ctx.formal.renderFailed = true;
      ctx.state = null;
      app.innerHTML = statusPage(model, '无法安全读取营业状态',
        '服务器返回的数据不符合正式员工页面的要求，已停止业务写入。');
      return;
    }
    if (!projected) {
      if (ctx.modal?.open) ctx.modal.close();
      ctx.formal = null;
      ctx.state = null;
      app.innerHTML = statusPage(model, '当前账号没有营业视图权限',
        '请联系门店管理员配置正式权限。');
      return;
    }
    ctx.state = projected;
    ctx.formal ??= { mode: 'http', flow, state, lastError: null };
    ctx.formal.session = model.session;
    ctx.formal.workspace = model.snapshot.view.workspace;
    ctx.formal.reviewSections = model.snapshot.view.reviewSections ?? [];
    if (!mounted) {
      if (!mounting) mounting = import('../app.js').then(() => {
        mounted = true;
        mounting = null;
        display(state.getState());
      }).catch(error => {
        mounting = null;
        app.innerHTML = statusPage(state.getState(), '无法加载员工页面',
          '请重新连接。');
        ctx.formal.lastError = error;
      });
      return;
    }
    try { renderWorkspace(); }
    catch {
      ctx.formal.renderFailed = true;
      app.innerHTML = statusPage(model, '无法安全显示营业状态',
        '请重新读取服务器状态。当前停止业务写入。');
    }
    return;
  }
  if (model.phase === 'login') {
    if (ctx.modal?.open) ctx.modal.close();
    flow.suspend();
    principalId = null;
    ctx.formal = null;
    ctx.state = null;
    app.innerHTML = loginPage(model.error);
  } else if (model.phase === 'loading') {
    app.innerHTML = statusPage(model, '正在读取门店状态', '请稍候。');
  } else {
    app.innerHTML = statusPage(model, '暂时无法连接', '无法读取正式营业状态。');
  }
}

state.subscribe(model => { void display(model); });
void display(state.getState());

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
  const action = target.dataset.action;
  if (!['formalLogout', 'formalRefresh', 'formalRetryUnknown',
    'formalRefreshKnown'].includes(action)) return;
  event.preventDefault();
  target.disabled = true;
  try {
    if (action === 'formalLogout') {
      if (['sending', 'unknown', 'foreign', 'storage-unavailable']
        .includes(flow.getStatus().phase) &&
          !window.confirm('上一笔操作结果仍待确认。退出后本标签页会保留原操作记录；请由原操作人员重新登录并确认。确定退出吗？')) {
        target.disabled = false;
        return;
      }
      await state.logout();
    } else if (action === 'formalRefresh') {
      ctx.formal && (ctx.formal.lastError = null);
      await state.reconnect();
    } else if (action === 'formalRetryUnknown') {
      const outcome = await flow.retryUnknown();
      if (ctx.formal) {
        ctx.formal.lastError = outcome.error ?? null;
        renderWorkspace();
      }
    } else {
      await flow.refreshKnownResult();
      ctx.formal.lastError = null;
      renderWorkspace();
    }
  } catch (error) {
    if (ctx.formal) {
      ctx.formal.lastError = error;
      renderWorkspace();
    } else {
      app.innerHTML = statusPage(state.getState(), '暂时无法完成操作',
        '请检查连接后重试。');
    }
  }
});
window.addEventListener('offline', () =>
  state.markUnavailable(new HttpTransportError('network')));
window.addEventListener('online', () => { void state.reconnect(); });
void state.bootstrap();
