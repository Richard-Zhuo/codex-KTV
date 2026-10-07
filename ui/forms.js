import { pricedSaleOptions } from '../catalog-pricing.js';
// 通用表单件：步进器、付款行、预订字段、销售行、存酒行、目录规格行、房间异常凭证（Phase 7 自 app.js 迁入）。
// 唯一机械转换：模块级可变状态（state/category/controlSequence/modal）→ ctx.*；函数体逐字保留。

import { btn, ctx, depositChoices, esc, initialMixChoices, options, product } from './context.js';
import { PAYMENT_METHODS, total } from '../sales.js';
import { RESERVATION_SOURCES } from '../rooms.js';
import { cents, money } from '../shared/money.js';
import { categoryLabel, saleOptions, sellableProducts } from '../catalog.js';

function roomIssueEvidenceFields() {
  return `<label>文字说明（与照片至少提交一项）<textarea name="evidenceText" maxlength="500" rows="3" placeholder="例如：空调无法制冷；维修完成并试机正常"></textarea></label><label>现场照片（与文字至少提交一项）<input id="room-issue-photo" type="file" accept="image/*"><input id="room-issue-photo-data" type="hidden" name="evidencePhoto"><input id="room-issue-photo-name" type="hidden" name="evidencePhotoName"></label><p id="room-issue-photo-status" class="muted">支持单张图片，不超过 500KB；${ctx.formalEnabled ? '照片将随业务记录提交服务器。' : '照片仅保存在本机演示数据中。'}</p>`;
}

function roomIssueEvidenceMarkup(request) {
  return `${request.evidenceText?`<p class="notice">${esc(request.evidenceText)}</p>`:''}${request.evidencePhoto?`<a class="issue-proof" href="${esc(request.evidencePhoto)}" target="_blank" rel="noreferrer"><img src="${esc(request.evidencePhoto)}" alt="房间状态留档照片"><span>${esc(request.evidencePhotoName || '查看现场照片')}</span></a>`:''}`;
}

function stepper(max=999, label='数量（支）', name='count', value=1) { const id=`quantity-${++ctx.controlSequence}`; return `<div class="quantity-field"><label for="${id}">${label}</label><div class="stepper">${btn('−','step','data-delta="-1" aria-label="减少数量"')}<input id="${id}" name="${name}" type="number" inputmode="numeric" min="1" max="${max}" value="${value}" required aria-label="${label}">${btn('＋','step','data-delta="1" aria-label="增加数量"')}</div></div>`; }

function paymentRow(amount=0, selected=PAYMENT_METHODS[0]) {
  return `<div class="payment-row"><label>付款方式<select name="paymentMethod">${options(PAYMENT_METHODS.map(method=>[method,method]),selected)}</select></label><label>已收到（元）<input name="paymentAmount" inputmode="decimal" value="${amount?(amount/100).toFixed(2):'0'}" required></label>${btn('移除','removePayment','','quiet')}</div>`;
}

function paymentFields(amount, allowRounding=false) {
  const differenceFields=allowRounding?`<label>差额处理<select name="differenceType"><option value="免零" selected>免零（默认）</option><option value="特殊情况">特殊情况（需店长审核）</option></select></label><div id="difference-note" hidden><label>特殊情况说明<textarea name="differenceNote" maxlength="200" placeholder="请填写少收原因，结账后提醒店长审核"></textarea></label></div>`:'';
  return `<p class="notice">请先核实收款码已到账或现金已收到，再登记。此处不会自动扣款。${allowRounding?'结账少收时请选择差额处理方式；特殊情况需填写说明并提醒店长审核。':''}</p><div id="payment-lines">${paymentRow(amount)}</div>${btn('＋ 添加一笔付款','addPayment','','secondary full')}<p id="pay-sum"></p>${differenceFields}<label class="check"><input type="checkbox" required>我已核实以上款项（演示确认）</label>`;
}

function bindPaymentSummary(amount, allowRounding=false) {
  const form=ctx.modal.querySelector('form'), output=document.querySelector('#pay-sum');
  if (!output) return;
  const type=form.elements.differenceType, noteBox=document.querySelector('#difference-note'), note=form.elements.differenceNote;
  const syncDifference=()=>{if(!type||!noteBox||!note)return;const special=type.value==='特殊情况';noteBox.hidden=!special;note.disabled=!special;note.required=special;};
  const update=()=> { syncDifference(); try { const expected=typeof amount==='function'?amount():amount, entered=[...form.querySelectorAll('[name="paymentAmount"]')].reduce((sum,input)=>sum+cents(input.value||'0'),0), differenceLabel=type?.value||'免零'; output.textContent=`已填写 ${money(entered)} · ${entered===expected?'金额一致':entered<expected&&allowRounding?`${differenceLabel} ${money(expected-entered)}`:entered<expected?`还差 ${money(expected-entered)}`:`多填 ${money(entered-expected)}`}`; } catch { output.textContent='请填写有效金额'; } };
  form.addEventListener('input',update);form.addEventListener('change',update);update();
}

function bookingFields() { const hour=new Date(ctx.state.clock).getHours(), day=hour>=20?'1':'0', session=hour<14?'afternoon':'night'; return `<div class="field-pair"><label>哪一天<select name="dayChoice">${options([['0','今天'],['1','明天'],['2','后天'],['custom','第几天后']],day)}</select></label><label id="custom-day-field" hidden>第几天后<input type="number" name="customDays" inputmode="numeric" min="3" max="30" value="3"></label></div><label>预订时段<select name="session">${options([['afternoon','下午场（14:00—18:00）'],['night','夜间场（20:00—次日02:00）']],session)}</select></label><fieldset class="choice-field"><legend>预订方式</legend><div class="radio-grid">${RESERVATION_SOURCES.map(source=>`<label class="radio-option"><input type="radio" name="source" value="${source}" ${source==='手机'?'checked':''}><span>${source}</span></label>`).join('')}</div></fieldset><p class="muted">可提前预定；下午场为14:00到18:00，夜间场为20:00到次日2:00。</p><p class="muted">到预订场次仍未开房，系统每隔1小时提醒预订人员。</p><label>备注（选填）<input name="note" maxlength="100" placeholder="例如：王生/130****0000，晚上8点到"></label>`; }

function setupBookingFields() {
  const f = ctx.modal.querySelector('form');
  const select = f?.elements.dayChoice;
  if (!select) return;
  const update = () => { document.querySelector('#custom-day-field').hidden = select.value !== 'custom'; };
  select.addEventListener('change', update); update();
}

function initialMixRow(max, value=1, selected='drink0') { return `<div class="initial-mix-item"><div class="deposit-item-head"><b>酒水种类</b>${btn('移除','removeInitialMix','','quiet')}</div><label>选择酒水<select name="mixProduct">${options(initialMixChoices(),selected)}</select></label>${stepper(max,'数量（支）','mixCount',value)}</div>`; }

const saleFormOptions = p => ctx.formalEnabled ? pricedSaleOptions(p, ctx.salePricePlanId) : saleOptions(p);

const saleCategories=()=>[...new Map(sellableProducts(ctx.state.catalog).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)).map(item=>[item.category,[item.category,categoryLabel(item)]])).values()];

function saleProductLabel(item) {
  const balance=ctx.state.inventory[item.id];
  const stock=item.inventoryManaged ? balance?.count===null || balance?.count===undefined ? ' · 未建账' : ` · 库存 ${balance.count} ${item.baseUnit}` : '';
  return `${item.name}${stock}`;
}

function saleItemRow(selectedCategory=ctx.category, selectedProduct='', selectedSpec='single', value=1) {
  const categories=saleCategories(), uiCategory=categories.some(([id])=>id===selectedCategory)?selectedCategory:categories[0]?.[0];
  const products=sellableProducts(ctx.state.catalog).filter(p=>p.category===uiCategory);
  const productId=products.some(p=>p.id===selectedProduct)?selectedProduct:products[0]?.id;
  const p=productId?product(productId):products[0];
  const specs=saleFormOptions(p).map(option=>[option.id,`${option.name} · ${money(option.priceCents)}`]);
  const spec=specs.some(([id])=>id===selectedSpec)?selectedSpec:specs[0]?.[0];
  return `<div class="sale-item"><div class="deposit-item-head"><b>商品品项</b>${btn('移除','removeSaleItem','','quiet')}</div><label>类别<select name="saleCategory">${options(categories,uiCategory)}</select></label><label>商品<select name="saleProduct">${options(products.map(item=>[item.id,saleProductLabel(item)]),productId)}</select></label><label>销售规格<select name="saleSpec">${options(specs,spec)}</select></label>${stepper(999,'数量（按所选规格）','saleCount',value)}<p class="sale-line-total muted"></p></div>`;
}

function bindSaleForm() {
  const f=ctx.modal.querySelector('form');
  let amount=0;
  const updateAll=()=> {
    amount=0;
    if (ctx.formalEnabled && f.dataset.form === 'sale') {
      ctx.salePricePlanId = ctx.state.orders.find(order => order.id === f.elements.order?.value)?.businessSession?.pricePlanId;
    }
    f.querySelectorAll('.sale-item').forEach(row=>{
      const categorySelect=row.querySelector('[name="saleCategory"]'), productSelect=row.querySelector('[name="saleProduct"]'), specSelect=row.querySelector('[name="saleSpec"]');
      const currentProduct=productSelect.value, products=sellableProducts(ctx.state.catalog).filter(p=>p.category===categorySelect.value);
      productSelect.innerHTML=options(products.map(item=>[item.id,saleProductLabel(item)]),currentProduct);
      const p=product(productSelect.value), currentSpec=specSelect.value, specs=saleFormOptions(p).map(option=>[option.id,`${option.name} · ${money(option.priceCents)}`]);
      specSelect.innerHTML=options(specs,currentSpec);
      const spec=specSelect.value, count=Math.max(1,Number(row.querySelector('[name="saleCount"]').value)||1), option=saleFormOptions(p).find(option=>option.id===spec), price=option?.priceCents || 0;
      amount+=price*count;
      row.querySelector('.sale-line-total').textContent=`本行 ${money(price*count)} · ${p.name} ${option?.name || ''}`;
    });
    document.querySelector('#sale-total').textContent=`本次商品合计 ${money(amount)}`;
  };
  f.addEventListener('change',updateAll); f.addEventListener('input',updateAll); f._updateSale=updateAll; updateAll();
  return ()=>amount;
}

function depositItemRow() { return `<div class="deposit-item"><div class="deposit-item-head"><b>存酒品项</b>${btn('移除','removeDepositItem','','quiet')}</div><label>酒名<select name="depositProduct">${options(depositChoices())}</select></label>${stepper(999,'数量（支）','depositCount')}</div>`; }

function catalogSaleOptionRow(option = {}) {
  return `<div class="sale-item catalog-sale-option"><div class="deposit-item-head"><b>销售规格</b>${btn('移除','removeCatalogSaleOption','','quiet')}</div><label>规格 ID<input name="saleOptionId" maxlength="40" pattern="[A-Za-z][A-Za-z0-9._-]*" value="${esc(option.id || '')}" placeholder="例如 pack" required></label><label>规格名称<input name="saleOptionName" maxlength="30" value="${esc(option.name || '')}" placeholder="例如 1 包" required></label><label>每规格对应基础数量<input name="saleOptionBaseQuantity" type="number" min="1" step="1" value="${option.baseQuantity || 1}" required></label><label>当前售价（元）<input name="saleOptionPrice" inputmode="decimal" value="${option.priceCents === undefined ? '' : (option.priceCents / 100).toFixed(2)}" placeholder="由后台录入" required></label></div>`;
}

export {
  roomIssueEvidenceFields,
  roomIssueEvidenceMarkup,
  stepper,
  paymentRow,
  paymentFields,
  bindPaymentSummary,
  bookingFields,
  setupBookingFields,
  initialMixRow,
  saleCategories,
  saleProductLabel,
  saleItemRow,
  bindSaleForm,
  depositItemRow,
  catalogSaleOptionRow
};
