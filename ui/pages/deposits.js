// Phase 7 自 app.js 迁入；唯一机械转换：模块级可变状态（state/page/filter/searchTerm/
// reportPeriod/storageProblem/APP_ENTRY/DEFAULT_PAGE/modal 等）→ ctx.*，函数体逐字保留。

import { allowedPermission, btn, ctx, date, esc, product } from '../context.js';
import { searchDeposits } from '../../rules.js';

function depositPage() {
  const rows = searchDeposits(ctx.state.deposits, ctx.searchTerm);
  const canHandle = allowedPermission('deposit.manage');
  const depositButton = canHandle ? btn('＋ 登记一笔存酒','deposit','','secondary full') : '<p class="notice">当前身份只能查询存酒；登记和取酒需要服务员或老板权限。</p>';
  return `<p class="eyebrow">客人的酒，记得清楚</p><h1>存酒 · 取酒</h1><p class="muted">手机号或姓名填写一个即可</p><div class="panel"><form id="search"><label>手机号或顾客姓名<input name="query" value="${esc(ctx.searchTerm)}" placeholder="例如：0318或王生" required></label><button class="primary full">查找存酒</button></form></div>${depositButton}<div class="section-title"><h2>${ctx.searchTerm?'查询结果':'如何操作'}</h2><span>${ctx.searchTerm?`${rows.length} 条记录`:''}</span></div>${!ctx.searchTerm?'<div class="empty">存酒：点“登记一笔存酒”，一次可添加多种酒<br>取酒：输入手机号任意部分或姓名，再选对应的酒<br><small>存酒不抵扣挂账，也不重复扣商品库存。</small></div>':!rows.length?'<div class="empty">没有找到对应的存酒记录。</div>':rows.map(d=>`<article class="panel"><div class="split"><h3>${product(d.product).name}</h3><b class="green">剩 ${d.count} 支</b></div><p>${esc(d.name)||'未留姓名'} · ${esc(d.phone)||'未留手机号'}</p><p class="muted">${d.room} 房 · ${date(d.time)} 存 ${d.initial} 支</p>${d.count?(canHandle?btn('核对并取酒','withdraw',`data-id="${d.id}"`):'<span class="badge">需要服务员或老板取酒</span>'):'<span class="badge">已取完</span>'}</article>`).join('')}`;
}

export {
  depositPage
};
