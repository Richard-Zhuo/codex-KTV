// Phase 7 自 app.js 迁入；唯一机械转换：模块级可变状态（state/page/filter/searchTerm/
// reportPeriod/storageProblem/APP_ENTRY/DEFAULT_PAGE/modal 等）→ ctx.*，函数体逐字保留。

import { allowedPermission, btn, ctx, employeeOptions, options, roomOptions } from '../context.js';
import { openDialog } from '../shell.js';
import { bindPaymentSummary, bindSaleForm, bookingFields, paymentFields, saleItemRow, setupBookingFields } from '../forms.js';
import { USERS } from '../../shared/identity.js';
import { quote } from '../../rooms.js';
import { total } from '../../sales.js';
import { sellableProducts } from '../../catalog.js';

function retailDialog() {
  if (!allowedPermission('retail.sale')) throw Error('当前身份没有独立零售权限');
  if (!sellableProducts(ctx.state.catalog).length) throw Error('当前没有可销售商品');
  const employeeField=allowedPermission('staff.record')?`<label>销售归属员工（选填）<select name="employee">${options([['','当前登记人'],...Object.entries(USERS).filter(([id,user])=>!user.legacy&&id!=='administrator').map(([id,user])=>[id,user.name])])}</select></label>`:'';
  openDialog('独立零售成交',`${employeeField}<div id="sale-items">${saleItemRow()}</div>${btn('＋ 添加一种商品','addSaleItem','','secondary full')}<div id="sale-total" class="quote compact"></div>${paymentFields(0)}`,'确认收款并完成零售','retailSale');
  const expected=bindSaleForm(), form=ctx.modal.querySelector('form');
  form.elements.paymentAmount.value=(expected()/100).toFixed(2);
  bindPaymentSummary(expected);
}

function staffBookingDialog() {
  openDialog('为员工登记订房',`<p class="notice">登记后订单归属所选员工，当前操作人会保留为登记人。</p><label>归属员工<select name="employee" required>${employeeOptions()}</select></label><label>房号<select name="room" required>${roomOptions()}</select></label>${bookingFields()}`,'确认登记订房','reserve');
  setupBookingFields();
}

export {
  retailDialog,
  staffBookingDialog
};
