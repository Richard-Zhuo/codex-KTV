// Phase 7 自 app.js 迁入；唯一机械转换：模块级可变状态（state/page/filter/searchTerm/
// reportPeriod/storageProblem/APP_ENTRY/DEFAULT_PAGE/modal 等）→ ctx.*，函数体逐字保留。

import { allowed, allowedPermission, btn, ctx, date, esc, options, permissionSummary, product } from '../context.js';
import { USERS, effectiveUser } from '../../shared/identity.js';
import { money } from '../../shared/money.js';
import { categoryLabel, saleOptions } from '../../catalog.js';

function permissionCards() {
  if (!allowedPermission('identity.manage')) return '';
  const users = Object.entries(USERS).filter(([id, user]) => !user.legacy && id !== 'administrator');
  const selected = users[0]?.[0] || '';
  const active = selected ? effectiveUser(ctx.state, selected) : null;
  const labels = active ? permissionSummary(active) : [];
  return `<article class="panel permission-single-card"><div class="split"><div><h3>身份权限</h3><p class="muted">每个身份单独调整具体操作权限，岗位名称只作说明。</p></div><span class="badge">管理员专用</span></div><label>选择身份<select id="permission-target" aria-label="选择要调整的身份">${options(users.map(([id, user]) => [id, `${user.name} · ${user.title || '岗位说明未设置'}`]), selected)}</select></label><p id="permission-target-summary" class="permission-summary muted">${labels.length ? esc(labels.join('、')) : '当前没有可用操作'}</p>${btn('调整具体权限','editPermissions',`data-id="${selected}"`,'secondary full')}</article>`;
}

function staffRecordingPanel() {
  if (!allowedPermission('staff.record')) return '';
  return `<div class="section-title"><h2>员工补录</h2><span>记录订房与增购归属</span></div><div class="menu-list staff-recording-panel">${btn('登记员工订房　→','staffBooking','','secondary')}${btn('登记员工增购酒水　→','staffSale','','secondary')}</div>`;
}

function catalogPriceSummary(item) {
  return saleOptions(item).map(option => `${option.name} ${money(option.priceCents)}`).join(' · ') || '无直接销售规格';
}

function catalogManagementPanel() {
  if (!allowedPermission('catalog.manage')) return '';
  const products = ctx.state.catalog.products.filter(item => item.kind !== 'consumable' && item.kind !== 'package-component' && item.id !== 'drink').sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0));
  const productRows = products.map(item => `<div class="panel"><div class="split"><div><h3>${esc(item.name)} <small>${esc(item.id)}</small></h3><p>${esc(categoryLabel(item))} · 基础单位：${esc(item.baseUnit)} · ${catalogPriceSummary(item)}</p></div><span class="badge">${item.active===false?'已停用':!item.sellable?'仅选择':item.inventoryManaged&&(ctx.state.inventory[item.id]?.count===null||ctx.state.inventory[item.id]?.count===undefined)?'未建账 · 不可成交':'可销售'}</span></div><p class="muted">库存：${item.inventoryManaged?(ctx.state.inventory[item.id]?.count===null||ctx.state.inventory[item.id]?.count===undefined?'未建账':`${ctx.state.inventory[item.id].count} ${esc(item.baseUnit)}`):'不管理'} · 开房赠饮：${item.openingGiftEligible?'允许':'不参与'} · 排序 ${item.sortOrder ?? 0}</p>${btn('维护商品与价格','editCatalogProduct',`data-id="${item.id}"`,'secondary full')}</div>`).join('');
  const packageRows = ctx.state.catalog.packages.slice().sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)).map(item => `<div class="panel"><div class="split"><div><h3>${esc(item.name)} <small>${esc(item.id)}</small></h3><p>${esc(item.roomType)} · ${item.period==='night'?'夜间':'白天'} · 当前总价 ${money(item.priceCents)}</p></div><span class="badge">${item.active===false?'已停用':'启用中'}</span></div><p class="muted">基础房费 ${money(item.basePriceCents)} · 套餐赠饮参考值 ${money(item.includedValueCents || 0)} · 套餐包含选择规则，不直接保存库存。</p>${btn('维护套餐价格','editCatalogPackage',`data-id="${item.id}"`,'secondary full')}</div>`).join('');
  return `<div class="section-title"><h2>商品、套餐与当前价格</h2><span>管理员专用</span></div><p class="muted">运行时报价、增购、库存和报表都读取当前目录；订单形成时另存成交快照，改价不会回写历史账单。新增库存商品显示未建账，完成期初盘点审核后才能销售。</p><div class="split"><h3>商品目录</h3>${btn('＋ 新增商品','createCatalogProduct','','primary')}</div>${productRows || '<p class="empty">暂无可维护商品。</p>'}<h3>房间套餐</h3>${packageRows || '<p class="empty">暂无可维护套餐。</p>'}`;
}

function systemManagementPage() {
  if (!allowedPermission('backend.view')) return '<p>当前身份没有系统管理后台权限，请切换管理员或由管理员分配“进入系统管理后台”权限。</p>';
  const identityManagement=allowed(['管理员'])?`<div class="section-title"><h2>员工身份与具体权限</h2><span>管理员专用</span></div>${permissionCards()}`:'<div class="empty">当前身份可以进入系统管理后台，但没有可调整的系统配置。业务审核请返回员工系统的“待办”。</div>';
  return `<p class="eyebrow">系统管理后台</p><h1>系统管理</h1><p class="muted">这里只提供身份权限和商品目录等系统管理能力，不承载挂账、赠酒、房间恢复、库存、客诉、交班或营业报表等日常营业工作。</p>${catalogManagementPanel()}${identityManagement}<div class="tip"><span>i</span><div><b>当前仍是单机演示</b><p>目录、套餐和价格保存在本机 localStorage；尚未接入 PostgreSQL，也不代表生产数据管理或独立审计已经完成。</p></div></div>`;
}

// Phase 8 清理：本模块原有两个从未被调用的死渲染函数（库存通知、交班历史），
// 已随死代码清理删除；state.notices 与 state.handovers 的字段和写入路径保持不变。

export {
  permissionCards,
  staffRecordingPanel,
  catalogPriceSummary,
  catalogManagementPanel,
  systemManagementPage
};
