// UI 共享上下文与通用展示助手（Phase 7 自 app.js 迁入）。
// 唯一机械转换：模块级可变状态（state/page/filter/searchTerm/category/reportPeriod/
// busy/controlSequence/storageProblem/APP_ENTRY/DEFAULT_PAGE/persistence/modal/app）改为 ctx.* 属性，
// 函数体逐字保留；ctx 由 app.js 启动时装配注入。

import { PERMISSION_DEFINITIONS, USERS, effectiveUser, hasPermission, hasRole } from '../shared/identity.js';
import { canExchange } from '../rooms.js';
import { findProduct, saleOptions } from '../catalog.js';

export const ctx = { state: null, storageProblem: '', page: 'rooms', filter: '全部',
  searchTerm: '', category: 'beer', reportPeriod: 'day', busy: false, controlSequence: 0,
  APP_ENTRY: 'staff', DEFAULT_PAGE: 'rooms', persistence: null, modal: null, app: null };

const product = id => findProduct(ctx.state.catalog, id);

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

const btn = (text, action, data='', cls='secondary') => `<button type="button" class="${cls}" data-action="${action}" ${data}>${text}</button>`;

const date = t => new Date(t).toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false });

const localDate = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };

const dayValue = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

const currentUser = () => effectiveUser(ctx.state);

const allowed = roles => hasRole(currentUser(), roles);

const allowedPermission = permission => hasPermission(currentUser(), permission);

const canReviewSubmission = submittedById => submittedById !== ctx.state.user || allowedPermission('review.self');

const selfReviewBlocked = submittedById => submittedById === ctx.state.user && !allowedPermission('review.self');

const reviewPermissionHint = submittedById => selfReviewBlocked(submittedById) ? '<span class="badge">审核本人申请需要“允许审核本人申请”权限</span>' : '';

const portalBackButton = () => btn('返回我的', 'backMine', '', 'quiet');

const options = (list, selected) => list.map(([v,n]) => `<option value="${esc(v)}" ${String(v)===String(selected)?'selected':''}>${esc(n)}</option>`).join('');

const openingGiftChoices = () => ctx.state.catalog.products.filter(p => p.openingGiftEligible && p.active !== false).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)).map(p => [p.id,p.name]);

const depositChoices = () => ctx.state.catalog.products.filter(p => p.openingGiftEligible && p.active !== false && !p.selectionOnly && p.sellable && saleOptions(p).length).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)).map(p => [p.id,p.name]);

const initialMixChoices = () => ctx.state.catalog.products.filter(p => p.active !== false && p.id !== 'drink' && canExchange('drink', p.id, ctx.state.catalog)).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)).map(p => [p.id,p.name]);

// Phase 8 清理：creditRoles／managementRoles／reportRoles／consumableOptions 为
// 导出后从未被任何模块导入的死代码（角色名单已被权限矩阵取代），随死代码清理删除。

const roomOptions = () => options(ctx.state.rooms.map(r=>[r.id,`${r.id} · ${r.type}`]));

const employeeOptions = (selected = '') => options(Object.entries(USERS).filter(([id, user]) => !user.legacy && id !== 'administrator').map(([id, user]) => [id, `${user.name} · ${user.title || '岗位说明未设置'}`]), selected);

const contactText = record => [record?.name, record?.phone].filter(Boolean).join(' · ') || '未留联系人';

const permissionDefinition = id => PERMISSION_DEFINITIONS.find(permission => permission.id === id);

const permissionSummary = user => (user.permissions || []).map(id => permissionDefinition(id)?.label).filter(Boolean);

function pendingReservations(roomId) { return ctx.state.reservations.filter(reservation => reservation.room === roomId && reservation.status === '已预订').sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)); }

function pendingRoomIssueReview(roomId) { return (ctx.state.roomIssueReviews || []).find(request => request.room === roomId && request.status === '待审核'); }

function reservationSessionName(reservation) { return reservation.session === 'afternoon' ? '下午场' : reservation.session === 'night' ? '夜间场' : String(reservation.sessionLabel || '').split('（')[0]; }

function displayRoomStatus(room) { return room.status === '空闲' && pendingReservations(room.id).length ? '已预订' : room.status; }

function roomMatchesFilter(room) { return ctx.filter === '全部' ? true : ctx.filter === '已预订' ? room.status === '已预订' || pendingReservations(room.id).length > 0 : ctx.filter === '异常' ? room.status === '故障/维护中' || Boolean(pendingRoomIssueReview(room.id)) : ctx.filter === '空闲' ? displayRoomStatus(room) === '空闲' && !pendingRoomIssueReview(room.id) : displayRoomStatus(room) === ctx.filter; }

function appearanceSettings() {
  const preference = window.ktvAppearance.preference;
  return `<section class="panel appearance-panel"><div class="split"><div><h3>页面配色</h3><p class="muted">选择日间、夜间或按设备时间自动切换。</p></div><span class="badge">当前${preference==='auto'?'自动':preference==='dark'?'夜间':'日间'}</span></div><label>模式<select id="appearance-preference" aria-label="页面配色模式">${options([['light','日间'],['dark','夜间'],['auto','自动（日出至19:00日间）']],preference)}</select></label><p class="muted">自动模式按本机时间在日出（演示按 06:00）至19:00使用日间，其余时间使用夜间。</p></section>`;
}

function syncAppearanceControls() {
  const select = document.querySelector('#appearance-preference');
  if (select) select.value = window.ktvAppearance.preference;
  const badge = document.querySelector('.appearance-panel .badge');
  if (badge) badge.textContent = `当前${window.ktvAppearance.preference==='auto'?'自动':window.ktvAppearance.preference==='dark'?'夜间':'日间'}`;
}

window.addEventListener('appearancechange', syncAppearanceControls);

export {
  product,
  esc,
  btn,
  date,
  localDate,
  dayValue,
  currentUser,
  allowed,
  allowedPermission,
  canReviewSubmission,
  selfReviewBlocked,
  reviewPermissionHint,
  portalBackButton,
  options,
  openingGiftChoices,
  depositChoices,
  initialMixChoices,
  roomOptions,
  employeeOptions,
  contactText,
  permissionDefinition,
  permissionSummary,
  pendingReservations,
  pendingRoomIssueReview,
  reservationSessionName,
  displayRoomStatus,
  roomMatchesFilter,
  appearanceSettings,
  syncAppearanceControls
};
