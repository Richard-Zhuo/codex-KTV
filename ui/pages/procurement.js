// Phase 7 自 app.js 迁入；唯一机械转换：模块级可变状态（state/page/filter/searchTerm/
// reportPeriod/storageProblem/APP_ENTRY/DEFAULT_PAGE/modal 等）→ ctx.*，函数体逐字保留。

import { allowedPermission, btn, ctx, currentUser, date, esc, portalBackButton } from '../context.js';
import { visibleProcurements } from '../../procurement.js';
import { money } from '../../shared/money.js';

function procurementPage() {
  const rows=[...visibleProcurements(ctx.state,currentUser())].sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')) || Number(b.id||0)-Number(a.id||0));
  const totalAmount=rows.reduce((sum,row)=>sum+Number(row.amount||0),0);
  const scope=allowedPermission('procurement.viewAll')?'当前显示所有人的采购记录。':'当前只显示你登记的采购记录。';
  const body=rows.map(row=>`<article class="panel procurement-card"><div class="split"><div><h3>${esc(row.item)}</h3><p>${esc(row.date)} · ${row.quantity} ${esc(row.unit)} · ${money(row.amount)}</p></div><span class="badge">${esc(row.status||'已关联支出')}</span></div><p class="muted">${esc(row.type||'支出')} · ${esc(row.nature||'')} · ${esc(row.method||'')} · ${esc(row.person||'')}</p><p>${esc(row.description||'')}</p></article>`).join('');
  return `<p class="eyebrow">采购记录</p><div class="section-title expense-heading"><div><h1>采购</h1><p class="muted">${scope} 采购会自动关联一笔支出／报销记录。</p></div><div class="expense-toolbar">${portalBackButton()}${allowedPermission('procurement.create')?btn('＋ 登记采购','addProcurement','','primary'):''}</div></div><section class="summary expense-summary"><div><strong>${rows.length}</strong><span>采购笔数</span></div><div><strong>${money(totalAmount)}</strong><span>采购合计</span></div><div><strong>${rows.filter(row=>String(row.status||'').includes('待')).length}</strong><span>待审批</span></div></section>${rows.length?`<div class="procurement-list">${body}</div>`:`<div class="empty">${allowedPermission('procurement.viewAll')?'尚无采购记录。':'尚无你登记的采购记录。'}<small>点击“登记采购”填写第一笔采购。</small></div>`}`;
}

export {
  procurementPage
};
