// Phase 7 自 app.js 迁入；唯一机械转换：模块级可变状态（state/page/filter/searchTerm/
// reportPeriod/storageProblem/APP_ENTRY/DEFAULT_PAGE/modal 等）→ ctx.*，函数体逐字保留。

import { allowedPermission, btn, ctx, currentUser, date, esc, portalBackButton } from '../context.js';
import { money, visibleExpenses } from '../../rules.js';

function expensesPage() {
  const rows = [...visibleExpenses(ctx.state, currentUser())].sort((a,b) => String(b.date || '').localeCompare(String(a.date || '')) || Number(b.id || 0) - Number(a.id || 0));
  const totalAmount = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const fixedAmount = rows.filter(row => row.nature === '固定支出').reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const scopeText = allowedPermission('expense.viewAll') ? '当前显示所有人的记录。' : '当前只显示你登记的记录，其他人的支出由财务、店长、老板或管理员查看。';
  const body = rows.map(row => {
    const type = row.type || '支出', status = row.status || '已记录';
    const actions = status === '待老板审批' && allowedPermission('expense.approve') ? `<div class="expense-actions">${btn('批准','approveExpense',`data-id="${row.id}"`,'quiet')}${btn('驳回','rejectExpense',`data-id="${row.id}"`,'danger')}</div>` : '';
    return `<tr><td>${esc(row.date || '—')}</td><td>${esc(type)}</td><td class="expense-amount">${money(Number(row.amount || 0))}</td><td><span class="expense-method">${esc(row.method || '—')}</span></td><td><span class="expense-kind">${esc(row.nature || '—')}</span></td><td class="expense-description">${esc(row.description || '—')}</td><td class="expense-proof">${row.proof ? `<a href="${esc(row.proof)}" target="_blank" rel="noreferrer" title="${esc(row.proofName || '查看凭证')}"><img src="${esc(row.proof)}" alt="支出凭证"></a>` : '—'}</td><td><span class="badge">${esc(status)}</span>${actions}</td><td>${esc(row.person || '—')}</td></tr>`;
  }).join('');
  const emptyText = allowedPermission('expense.viewAll') ? '尚无支出或报销记录。' : '尚无你登记的支出或报销记录。';
  return `<p class="eyebrow">支出记录</p><div class="section-title expense-heading"><div><h1>支出 / 报销</h1><p class="muted">${scopeText} 图片凭证仅保存在本机演示数据中。</p></div><div class="expense-toolbar">${portalBackButton()}${allowedPermission('expense.create')?btn('＋ 添加记录','addExpense','','primary'):''}</div></div><section class="summary expense-summary"><div><strong>${rows.length}</strong><span>记录数</span></div><div><strong>${money(totalAmount)}</strong><span>支出合计</span></div><div><strong>${money(fixedAmount)}</strong><span>固定支出</span></div></section>${rows.length?`<div class="expense-table-wrap"><table class="expense-table"><caption><strong>支出与报销明细</strong><span>按日期倒序 · 共 ${rows.length} 条</span></caption><thead><tr><th>日期</th><th>类型</th><th>支出金额</th><th>付款方式</th><th>性质</th><th>说明</th><th>图片</th><th>状态</th><th>经办人</th></tr></thead><tbody>${body}</tbody><tfoot><tr><th>合计</th><td colspan="1">—</td><td class="expense-amount">${money(totalAmount)}</td><td colspan="6">—</td></tr></tfoot></table></div>`:`<div class="empty">${emptyText}<small>点击“添加记录”填写第一笔支出。</small></div>`}`;
}

export {
  expensesPage
};
