// Phase 7 自 app.js 迁入；唯一机械转换：模块级可变状态（state/page/filter/searchTerm/
// reportPeriod/storageProblem/APP_ENTRY/DEFAULT_PAGE/modal 等）→ ctx.*，函数体逐字保留。

import { btn, ctx, date, esc, roomOptions } from '../context.js';
import { openDialog } from '../shell.js';
import { depositItemRow } from '../forms.js';

function openDepositDialog() {
  const prefilledPhone = /^1\d{10}$/.test(ctx.searchTerm) ? ctx.searchTerm : '';
  const prefilledName = ctx.searchTerm && !/^\d+$/.test(ctx.searchTerm) ? ctx.searchTerm : '';
  openDialog('登记存酒',`<p class="muted">手机号、姓名至少填写一个；一次可以添加多种酒。</p><label>手机号（选填）<input type="tel" name="phone" inputmode="tel" pattern="1[0-9]{10}" maxlength="11" value="${esc(prefilledPhone)}"></label><label>姓名（选填）<input name="name" maxlength="30" value="${esc(prefilledName)}"></label><label>房间<select name="room">${roomOptions()}</select></label><div id="deposit-items">${depositItemRow()}</div>${btn('＋ 添加一种酒','addDepositItem','','secondary full')}<p class="muted">存酒日期：${date(ctx.state.clock)}。已售出的酒单独保管，不再扣商品库存。</p>`,'确认存酒','deposit');
}

export {
  openDepositDialog
};
