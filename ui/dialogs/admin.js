// Phase 7 自 app.js 迁入；唯一机械转换：模块级可变状态（state/page/filter/searchTerm/
// reportPeriod/storageProblem/APP_ENTRY/DEFAULT_PAGE/modal 等）→ ctx.*，函数体逐字保留。

import { allowed, allowedPermission, btn, ctx, date, esc, options, product } from '../context.js';
import { openDialog, toast } from '../shell.js';
import { catalogSaleOptionRow } from '../forms.js';
import { inventoryReviewCards } from '../pages/tasks.js';
import { PERMISSION_DEFINITIONS, USERS, effectiveUser } from '../../shared/identity.js';
import { consumableProducts, inventoryProducts, saleOptions } from '../../catalog.js';

function catalogCreateDialog() {
  openDialog('新增普通商品',`<p class="notice">商品 ID 创建后保持稳定。库存管理商品新增后显示“未建账”，需完成库存期初建账审核才能销售；不会自动设为 0。</p><label>稳定商品 ID<input name="id" maxlength="40" pattern="[a-z][a-z0-9._-]*" placeholder="例如 nanjing12" required></label><label>商品名称<input name="name" maxlength="80" required></label><label>分类<input name="category" maxlength="40" placeholder="例如 烟、小吃" required></label><label>库存基础单位<input name="baseUnit" maxlength="20" placeholder="例如 包、盒、瓶、支、份" required></label><label class="check"><input name="inventoryManaged" type="checkbox" checked>管理库存</label><label class="check"><input name="sellable" type="checkbox" checked>允许直接销售</label><label class="check"><input name="active" type="checkbox" checked>启用此商品</label><label>排序<input name="sortOrder" type="number" step="1" value="500" required></label><h3>销售规格与当前价格</h3><div id="catalog-sale-options">${catalogSaleOptionRow()}</div>${btn('＋ 添加销售规格','addCatalogSaleOption','','secondary full')}`,'创建商品','createCatalogProduct');
}

function catalogProductDialog(id) {
  const item = product(id);
  const priceFields = saleOptions(item).map(option => `<label>${esc(option.name)}价格（元）<input name="price_${esc(option.id)}" inputmode="decimal" value="${(option.priceCents/100).toFixed(2)}" required></label>`).join('');
  openDialog(`维护商品 · ${esc(item.name)}`,`<p class="notice">稳定 ID：<b>${esc(item.id)}</b>（本阶段不修改）。库存按${esc(item.baseUnit)}计量；价格只影响新订单。</p><label>商品名称<input name="name" maxlength="80" value="${esc(item.name)}" required></label>${priceFields}<label class="check"><input name="active" type="checkbox" ${item.active===false?'':'checked'}>启用此商品</label><label class="check"><input name="sellable" type="checkbox" ${item.sellable?'checked':''}>允许直接销售</label><label>排序<input name="sortOrder" type="number" step="1" value="${item.sortOrder ?? 0}" required></label>`,'保存商品与当前价格','updateCatalogProduct',{id:item.id});
}

function catalogPackageDialog(id) {
  const item = ctx.state.catalog.packages.find(packageItem => packageItem.id === id);
  if (!item) throw Error('套餐不存在');
  // Bug #2 修复：总价不再是独立输入，由基础房费＋赠饮参考值实时计算，单一口径。
  openDialog(`维护套餐 · ${esc(item.name)}`,`<p class="notice">稳定 ID：<b>${esc(item.id)}</b>（本阶段不修改）。赠饮允许选择范围和历史实际组成不会被当前配置重新解析。套餐总价自动等于基础房费＋赠饮参考值。</p><label>套餐名称<input name="name" maxlength="80" value="${esc(item.name)}" required></label><label>基础房费（元）<input name="basePriceCents" inputmode="decimal" value="${(item.basePriceCents/100).toFixed(2)}" required></label><label>赠饮参考值（元）<input name="includedValueCents" inputmode="decimal" value="${((item.includedValueCents || 0)/100).toFixed(2)}" required></label><label>套餐总价（元）<input name="priceCents" inputmode="decimal" value="${(item.priceCents/100).toFixed(2)}" readonly></label><label class="check"><input name="active" type="checkbox" ${item.active===false?'':'checked'}>启用此套餐</label><label>排序<input name="sortOrder" type="number" step="1" value="${item.sortOrder ?? 0}" required></label>`,'保存套餐与当前价格','updateCatalogPackage',{id:item.id});
}

function inventoryDialog() {
  const pending=(kind,id)=>(ctx.state.inventoryReviews||[]).find(request=>request.kind===kind&&request.product===id&&request.status==='待审核');
  const drinkRows=inventoryProducts(ctx.state.catalog).map(item=>{const id=item.id,v=ctx.state.inventory[id] || { count:null, threshold:item.inventoryThreshold || 10, unit:item.baseUnit }, review=pending('drink',id), canStock=v.count===null?allowedPermission('inventory.opening'):allowedPermission('inventory.adjust');return `<div class="stock-row"><div><b>${esc(item.name)}</b><p>${v.count===null?'未建账':`${v.count} ${esc(v.unit || item.baseUnit)} · 预警线 ${v.threshold}`}${review?` · 待审核盘点 ${review.after} ${esc(v.unit || item.baseUnit)}`:''}</p></div>${review?'<span class="badge">盘点待审核</span>':canStock?btn(v.count===null?'提交建账':'提交盘点','stock',`data-id="${id}"`):'<span class="badge">无库存调整权限</span>'}</div>`;}).join('');
  const consumableRows=consumableProducts(ctx.state.catalog).map(item=>{const id=item.id,v=ctx.state.consumables?.[id] || { count:null, opened:0, unit:item.baseUnit, threshold:item.inventoryThreshold || 10 }, review=pending('consumable',id), canStock=v.count===null?allowedPermission('inventory.opening'):allowedPermission('inventory.adjust');return `<div class="stock-row"><div><b>${esc(item.name)}</b><p>${v.count===null?'未建账':`${v.count} ${esc(v.unit || item.baseUnit)} · 已开封 ${v.opened || 0} · 预警线 ${v.threshold}`}${review?` · 待审核盘点 ${review.after} / 已开封 ${review.openedAfter||0}`:''}</p></div>${review?'<span class="badge">盘点待审核</span>':canStock?btn(v.count===null?'提交建账':'提交盘点','consumableStock',`data-id="${id}"`):'<span class="badge">无库存调整权限</span>'}</div>`;}).join('');
  const logs=ctx.state.ledger.slice(-30).reverse().map(l=>{const isConsumable=l.kind==='consumable', item=ctx.state.catalog.products.find(productItem=>productItem.id===l.product), label=item?.name || l.product, unit=l.unit || item?.baseUnit || '份';return `<div class="log"><b>${esc(label)} ${isConsumable?`${l.before ?? '未建账'} → ${l.after} ${unit}`:`${l.delta>0?'+':''}${l.delta} ${unit}`}</b><p>${esc(l.source)} · ${esc(l.person)} · ${date(l.time)}</p><small>${l.counted?'计入账面':'建账前 · 不计账面'}${l.reason?' · '+esc(l.reason):''}</small></div>`;}).join('');
  openDialog('库存 · 商品与内部消耗品',`<p class="notice">商品按各自基础单位统计。新增库存商品先显示未建账，期初数量审核通过后才能销售；内部消耗品继续另记已开封数量。审核前不改变账面库存。</p><h3>待审核盘点</h3>${inventoryReviewCards()}<h3>商品库存</h3>${drinkRows}<h3>内部消耗品库存</h3>${consumableRows}<h3>最近库存流水</h3>${logs||'<p class="muted">暂无流水</p>'}`);
}

function permissionsDialog(id) {
  if (!allowed(['管理员'])) { toast('仅管理员可以调整身份权限'); return; }
  const base = USERS[id];
  if (!base || base.legacy || id === 'administrator') { toast('该身份不能调整'); return; }
  const active = effectiveUser(ctx.state, id);
  const groups = [...new Set(PERMISSION_DEFINITIONS.map(permission => permission.group))];
  const checks = groups.map(group => `<fieldset class="choice-field"><legend>${esc(group)}</legend>${PERMISSION_DEFINITIONS.filter(permission => permission.group === group).map(permission => `<label class="check"><input type="checkbox" name="permission" value="${esc(permission.id)}" ${active.permissions.includes(permission.id)?'checked':''}>${esc(permission.label)}</label>`).join('')}</fieldset>`).join('');
  openDialog(`调整具体权限 · ${esc(base.name)}（${esc(base.title || '岗位说明未设置')}）`,`<p class="notice">按具体操作开关权限，可全部取消以暂时停用此身份。岗位名称只用于说明，不会代替这里的具体权限。</p>${checks}`,'保存具体权限','setPermissions',{user:id});
}

export {
  catalogCreateDialog,
  catalogProductDialog,
  catalogPackageDialog,
  inventoryDialog,
  permissionsDialog
};
