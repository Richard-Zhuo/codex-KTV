// Phase 7 自 app.js 迁入；唯一机械转换：模块级可变状态（state/page/filter/searchTerm/
// reportPeriod/storageProblem/APP_ENTRY/DEFAULT_PAGE/modal 等）→ ctx.*，函数体逐字保留。

import { allowedPermission, btn, ctx, date, esc } from '../context.js';
import { total } from '../../sales.js';
import { money } from '../../shared/money.js';
import { productIdOf } from '../../catalog.js';

function retailPage() {
  if (!allowedPermission('retail.sale')) return '<p>当前身份没有独立零售权限。</p>';
  const orders=ctx.state.orders.filter(order=>order.kind==='retail').slice().reverse();
  const cards=orders.slice(0,30).map(order=>`<article class="panel"><div class="split"><b>${esc(order.id)} · ${date(order.createdAt || order.time)}</b><strong>${money(total(order))}</strong></div><p>${(order.sales||[]).map(line=>`${esc(line.productNameSnapshot || `历史商品（${productIdOf(line)}）`)} × ${line.saleQuantity ?? line.count}（${esc(line.saleOptionNameSnapshot || line.baseUnitSnapshot || '规格未记录')}）`).join('、')}</p><p class="muted">${esc(order.status)} · ${esc((order.payments||[]).map(payment=>payment.method).join('＋'))} · 销售归属 ${esc((order.sales||[]).map(line=>line.person).filter(Boolean).join('、')||order.person||'未记录')}</p></article>`).join('');
  return `<p class="eyebrow">前台零售</p><div class="split"><h1>独立零售</h1>${btn('＋ 新建零售成交','startRetail','','primary')}</div><p class="muted">无需开房。确认商品、库存和实际收款后，一次完成订单与扣库；库存商品须先完成期初建账。</p><div class="section-title"><h2>最近零售交易</h2><span>${orders.length} 笔</span></div>${cards||'<p class="empty">尚无独立零售交易。</p>'}`;
}

export {
  retailPage
};
