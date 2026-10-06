// Phase 7 自 app.js 迁入；唯一机械转换：模块级可变状态（state/page/filter/searchTerm/
// reportPeriod/storageProblem/APP_ENTRY/DEFAULT_PAGE/modal 等）→ ctx.*，函数体逐字保留。

import { ctx, date, dayValue, employeeOptions, esc, options, roomOptions } from '../context.js';
import { openDialog, toast } from '../shell.js';
import { EXPENSE_APPROVAL_THRESHOLD, EXPENSE_NATURES, EXPENSE_TYPES } from '../../expenses.js';
import { INCIDENT_TYPES } from '../../incidents.js';
import { PAYMENT_METHODS } from '../../sales.js';
import { money } from '../../shared/money.js';

function expenseDialog() {
  openDialog('添加支出 / 报销',`<p class="notice">报销金额超过 ${money(EXPENSE_APPROVAL_THRESHOLD)} 需要老板审批；图片凭证为选填，${ctx.formal?'提交后由服务器保存。':'演示数据只保存在当前浏览器。'}</p><div class="field-pair"><label>日期<input type="date" name="date" value="${dayValue(ctx.state.clock)}" required></label><label>记录类型<select name="type">${options(EXPENSE_TYPES.map(type=>[type,type]),EXPENSE_TYPES[0])}</select></label></div><div class="field-pair"><label>支出金额（元）<input name="amount" inputmode="decimal" placeholder="例如：100.00" required></label><label>付款方式<select name="method">${options(PAYMENT_METHODS.map(method=>[method,method]),PAYMENT_METHODS[0])}</select></label></div><label>性质<select name="nature">${options(EXPENSE_NATURES.map(nature=>[nature,nature]),EXPENSE_NATURES[0])}</select></label><label>说明<textarea name="description" maxlength="200" rows="3" placeholder="例如：1月电费、采购水果、员工报销" required></textarea></label><label>图片凭证（选填）<input id="expense-proof" type="file" accept="image/*"><input id="expense-proof-data" type="hidden" name="proof"><input id="expense-proof-name" type="hidden" name="proofName"></label><p id="expense-proof-status" class="muted">支持图片凭证，单张不超过 500KB。</p>`,'保存记录','expense');
}

function procurementDialog() {
  openDialog('登记采购',`<p class="notice">采购会同步写入支出／报销记录；报销金额超过 ${money(EXPENSE_APPROVAL_THRESHOLD)} 会进入老板审批。</p><div class="field-pair"><label>日期<input type="date" name="date" value="${dayValue(ctx.state.clock)}" required></label><label>记录类型<select name="type">${options(EXPENSE_TYPES.map(type=>[type,type]),'支出')}</select></label></div><div class="field-pair"><label>采购项目<input name="item" maxlength="80" placeholder="例如：瓜子、纸巾" required></label><label>数量<input name="quantity" type="number" min="1" step="1" inputmode="numeric" required></label></div><div class="field-pair"><label>单位<input name="unit" maxlength="20" placeholder="包、箱、份" required></label><label>金额（元）<input name="amount" inputmode="decimal" placeholder="例如：120.00" required></label></div><div class="field-pair"><label>付款方式<select name="method">${options(PAYMENT_METHODS.map(method=>[method,method]),PAYMENT_METHODS[0])}</select></label><label>性质<select name="nature">${options(EXPENSE_NATURES.map(nature=>[nature,nature]),EXPENSE_NATURES[0])}</select></label></div><label>说明（选填）<textarea name="description" maxlength="200" rows="3" placeholder="例如：补充消耗品库存"></textarea></label>`,'保存采购并关联支出','procurement');
}

function incidentDialog() {
  openDialog('登记客诉 / 异常',`<p class="notice">未完成项目会在每天14:00提醒；负责人填写处理结果后需审核才算完成。审核本人提交的结果需要额外的自审权限。</p><div class="field-pair"><label>日期<input type="date" name="date" value="${dayValue(ctx.state.clock)}" required></label><label>房号<select name="room">${roomOptions()}</select></label></div><label>问题类型<select name="type">${options(INCIDENT_TYPES.map(type=>[type,type]),INCIDENT_TYPES[0])}</select></label><label>问题描述<textarea name="description" maxlength="300" rows="4" placeholder="请描述发生了什么" required></textarea></label><label>处理负责人<select name="assignee" required>${employeeOptions(ctx.formal ? ctx.state.actorEmployee?.employeeId : ctx.state.user)}</select></label>`,'保存并指派负责人','incident');
}

function resolveIncidentDialog(id) {
  const row=ctx.state.incidents.find(item=>item.id===Number(id));
  if(!row) { toast('这条客诉／异常已经不存在'); return; }
  openDialog(`处理客诉 / 异常 · ${esc(row.room)}`,`<p>${esc(row.date)} · ${esc(row.type)}</p><div class="notice">${esc(row.description)}</div><label>处理结果<textarea name="result" maxlength="300" rows="4" placeholder="例如：已联系客人并完成补偿" required></textarea></label><label>备注<textarea name="note" maxlength="300" rows="3" placeholder="请记录后续跟进信息" required></textarea></label><p class="muted">提交后需具备客诉／异常恢复审核权限的员工批准；本人审核还需额外拥有“允许审核本人申请”权限。</p>`,'提交处理结果审核','resolveIncident',{id});
}

export {
  expenseDialog,
  procurementDialog,
  incidentDialog,
  resolveIncidentDialog
};
