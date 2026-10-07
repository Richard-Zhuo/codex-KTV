// Phase 7 自 app.js 迁入；唯一机械转换：模块级可变状态（state/page/filter/searchTerm/
// reportPeriod/storageProblem/APP_ENTRY/DEFAULT_PAGE/modal 等）→ ctx.*，函数体逐字保留。

import { allowedPermission, btn, canReviewSubmission, ctx, currentUser, date, employeeOptions, esc, options, pendingReservations, product, reviewPermissionHint } from '../context.js';
import { openDialog, toast } from '../shell.js';
import { bindPaymentSummary, bindSaleForm, paymentFields, saleItemRow, stepper } from '../forms.js';
import { extraLabels, reservationListMarkup } from '../pages/rooms.js';
import { OTHER_CHARGE_CATEGORIES, bonusAllowance } from '../../rules.js';
import { canExchange, quote } from '../../rooms.js';
import { collectableCharges, nextCollectCharge, outstanding, total } from '../../sales.js';
import { money } from '../../shared/money.js';
import { productIdOf, saleOptions, sellableProducts } from '../../catalog.js';

function showOrder(id) {
  const o=ctx.state.orders.find(o=>o.id===id);
  const bonus=(o.bonusGifts||[]).map(line=>{
    const drinks=(line.drinks||[]).filter(drink=>drink.count), unchanged=drinks.length===1&&drinks[0].product===line.product&&drinks[0].count===line.bottles;
    const giftName=line.productNameSnapshot || `历史商品（${productIdOf(line)}）`;
    return `<div class="bill-line"><span>赠送 · ${giftName} ${line.bottles}支</span><b>¥0</b></div>${unchanged?'':`<div class="drink-list"><p><b>这份赠送实际领取</b></p>${drinks.map(drink=>`<p>${drink.productNameSnapshot || `历史商品（${productIdOf(drink)}）`} <b>${drink.count} 支</b></p>`).join('')}</div>`}`;
  }).join('');
  const requests=(o.giftRequests||[]).filter(request=>request.status==='待确认').map(request=>{const canReview=allowedPermission('gift.approve')&&canReviewSubmission(request);return `<div class="notice"><b>超额赠酒水待审核</b><p>${request.productNameSnapshot || `历史商品（${productIdOf(request)}）`} ${request.halves}个半打，共${request.bottles}支 · ${esc(request.requestedBy)}申请</p>${canReview?`<div class="inline-actions">${btn('批准赠送','approveGift',`data-id="${id}" data-request="${request.id}"`,'primary')}${btn('驳回','rejectGift',`data-id="${id}" data-request="${request.id}"`,'danger')}</div>`:reviewPermissionHint(request)||'<small>需要赠酒水审核权限，审核本人申请还需自审权限。</small>'}</div>`;}).join('');
  const futureReservations=pendingReservations(o.room);
  const futureText=futureReservations.length?`<br>未来预订：${futureReservations.map(booking=>`${date(booking.at)} · ${esc(booking.sessionLabel || '')}`).join('；')}`:'';
  const attribution=o.recordedBy && o.recordedBy!== (o.openedBy || o.person) ? ` · 归属员工：${esc(o.openedBy || o.person || '未记录')} · 代录：${esc(o.recordedBy)}`:'';
  const origin=`<p class="muted">开单：${esc(o.openedBy || o.person || '未记录')}${attribution} · 开房渠道：${esc(o.openSource || '线下')}${o.reservedBy?` · 预订：${esc(o.reservedBy)}（${esc(o.reservationSource || '方式未记录')}）`:''}${futureText}</p>`;
  const voucherNotice=o.voucher?`<div class="notice">${esc(o.voucher.provider)}平台券开房费用 ${money(o.voucher.covered)} · ${esc(o.voucher.status)} · 扫码验券接口待接入</div>`:'';
  const saleLines=o.sales.map(line=>{
    const drinks=(line.drinks||[]).filter(drink=>drink.count);
    const unchanged=drinks.length===1&&drinks[0].product===line.product&&drinks[0].count===line.bottles;
    const saleName=line.productNameSnapshot || `历史商品（${productIdOf(line)}）`, optionName=line.saleOptionNameSnapshot || (line.spec==='dozen'?'整打':line.spec==='half'?'半打':'单支');
    return `<div class="bill-line"><span>${saleName} × ${line.saleQuantity ?? line.count}${optionName}<small> · 归属 ${esc(line.person || o.openedBy || o.person || '未记录')}${line.recordedBy && line.recordedBy!==line.person?` · 代录 ${esc(line.recordedBy)}`:''}</small></span><b>${money(line.amountCents ?? line.amount)}</b></div>${unchanged?'':`<div class="drink-list"><p><b>这笔增购实际领取</b></p>${drinks.map(drink=>`<p>${drink.productNameSnapshot || `历史商品（${productIdOf(drink)}）`} <b>${drink.count} 支</b></p>`).join('')}</div>`}`;
  }).join('');
  const otherLines=(o.otherCharges||[]).map(line=>`<div class="bill-line"><span>其他消费 · ${esc(line.category==='其他'?line.item:line.category)}</span><b>${money(line.amountCents ?? line.amount)}</b></div>`).join('');
  const received=(o.payments||[]).reduce((sum,payment)=>sum+payment.amount,0), due=outstanding(o);
  const exchangeable=[...o.drinks,...o.sales.flatMap(line=>line.drinks||[]),...(o.bonusGifts||[]).flatMap(line=>line.drinks||[])].some(line=>line.count&&product(productIdOf(line)).exchangeLevel&&product(productIdOf(line)).exchangeLevel!==4);
  const actions=o.status==='营业中'?`<div class="action-grid">${allowedPermission('order.sale')?`${btn('＋ 加商品','sale',`data-id="${id}"`,'primary')}${btn('＋ 加其他','otherCharge',`data-id="${id}"`)}`:''}${exchangeable&&allowedPermission('order.exchange')?btn('⇄ 换酒水','exchange',`data-id="${id}"`):''}${allowedPermission('order.gift')?btn('＋ 赠酒水','gift',`data-id="${id}"`):''}${allowedPermission('room.reserve')?btn('预订未来场次','reserveFuture',`data-id="${id}"`):''}${allowedPermission('payment.collect')&&nextCollectCharge(o,ctx.state.catalog)?btn('收钱','collect',`data-id="${id}"`,'primary'):''}${allowedPermission('payment.settle')||allowedPermission('credit.apply')?btn('结账','checkout',`data-id="${id}"`,'primary'):''}</div>`:'';
  const openingDetails=o.gift||o.drinks.length?`<div class="bill-line"><span>${o.voucher?'平台券赠饮（已含）':'套餐赠饮（已含）'}</span><b>${money(o.gift)}</b></div><div class="drink-list">${o.drinks.filter(d=>d.count).map(d=>`<p>${d.productNameSnapshot || `历史商品（${productIdOf(d)}）`} <b>${d.count} 支</b></p>`).join('')}${(o.extras||[]).map(d=>`<p>${extraLabels[d.product] || d.productNameSnapshot || `历史配品（${productIdOf(d)}）`} ${d.count} 份 · ${d.served?'已上':'待上'}</p>`).join('')}</div>`:'';
  openDialog(`${o.room} · 账单`, `<div class="quote"><span>本单总额</span><strong>${money(total(o))}</strong><p>${o.status} · ${date(o.time)} 开房<br>已收 ${money(received)} · 待收 ${money(due)}</p></div>${voucherNotice}${origin}${reservationListMarkup(o.room)}<div class="bill-line"><span>基础包间费</span><b>${money(o.base)}</b></div>${openingDetails}${saleLines}${otherLines}${bonus}${requests}${received?`<div class="bill-line"><span>已登记收款</span><b>${money(received)}</b></div>`:''}<p class="muted">加时费 ¥0 · 按开房时段计价</p>${actions}`);
}

function giftDialog(id) {
  const o=ctx.state.orders.find(o=>o.id===id);
  const productIds=[...new Set(o.sales.filter(line=>product(productIdOf(line)).openingGiftEligible&&saleOptions(product(productIdOf(line))).some(option=>option.id==='dozen')).map(line=>productIdOf(line)))];
  if (!productIds.length) { toast('请先增购酒水，再登记赠送'); return; }
  const labels=productIds.map(productId=>{const a=bonusAllowance(o,productId);return [productId,`${product(productId).name} · 已增购${a.purchased}支`];});
  openDialog('赠酒水',`<p class="notice">同一种酒水每增购24支，可由开单员／服务员赠送对应酒水半打；超出数量交老板／店长确认。</p><label>对应酒水<select name="product">${options(labels)}</select></label>${stepper(99,'赠送几个半打','halves')}<div id="gift-hint" class="quote compact"></div>`,'确认赠酒水','gift',{order:id});
  const f=ctx.modal.querySelector('form'), update=()=>{const a=bonusAllowance(o,f.elements.product.value), halves=Number(f.elements.halves.value), manager=allowedPermission('gift.approve'), direct=Math.min(halves,a.availableHalves), excess=Math.max(0,halves-direct);let hint='本次确认后立即赠送',label='确认赠酒水';if(!manager&&excess){hint=direct?`先直接赠${direct}个半打，另${excess}个提交老板／店长确认`:'本次超出规则，提交老板／店长确认';label=direct?'确认赠送并提交额外部分':'提交确认';}document.querySelector('#gift-hint').innerHTML=`已增购 ${a.purchased} 支<br>规则内还可赠 ${a.availableHalves} 个半打<br><small>${hint}</small>`;f.querySelector('[type=submit]').textContent=label;};
  f.addEventListener('input',update);f.addEventListener('change',update);update();
}

function saleDialog(id, staffMode=false) {
  if (!sellableProducts(ctx.state.catalog).length) throw Error('当前没有可销售商品');
  const activeOrders=ctx.state.orders.filter(order=>order.kind!=='retail'&&order.status==='营业中');
  ctx.salePricePlanId = ctx.state.orders.find(order => order.id === (id || activeOrders[0]?.id))?.businessSession?.pricePlanId;
  const orderField=staffMode?`<label>归属账单<select name="order" required>${options(activeOrders.map(order=>[order.id,`${order.room} · ${money(total(order))} · ${order.openedBy || order.person || '未记录'}`]),id)}</select></label><label>归属员工<select name="employee" required>${employeeOptions()}</select></label>`:'';
  openDialog(staffMode?'为员工登记增购商品':'加商品',`${orderField}<p class="notice">一单可以添加多种商品，按“添加一种商品”继续录入。</p><div id="sale-items">${saleItemRow()}</div>${btn('＋ 添加一种商品','addSaleItem','','secondary full')}<div id="sale-total" class="quote compact"></div>`, '确认加单','sale',staffMode?{}:{order:id});
  bindSaleForm();
}

function otherChargeDialog(id) {
  openDialog('加其他',`<p class="notice">其他消费会加入本房账单，可单独收钱，也会计入最终结账。</p><label>类别<select name="category">${options(OTHER_CHARGE_CATEGORIES.map(item=>[item,item]),OTHER_CHARGE_CATEGORIES[0])}</select></label><label id="other-charge-item" hidden>项目<input name="item" maxlength="50" placeholder="例如：生日布置"></label><label>金额（元）<input name="amount" inputmode="decimal" placeholder="例如：88.00" required></label><p id="other-charge-hint" class="muted"></p>`, '确认加到本单','otherCharge',{order:id});
  const f=ctx.modal.querySelector('form'), categorySelect=f.elements.category, itemField=f.querySelector('#other-charge-item'), itemInput=f.elements.item, hint=f.querySelector('#other-charge-hint');
  const update=()=>{const custom=categorySelect.value==='其他';itemField.hidden=!custom;itemInput.disabled=!custom;itemInput.required=custom;hint.textContent=custom?'请填写具体项目和金额。':categorySelect.value==='代驾'?'请填写本次代驾金额。':`请填写本次${categorySelect.value}消费金额。`;};
  categorySelect.addEventListener('change',update);update();
}

function exchangeDialog(id) {
  const o=ctx.state.orders.find(o=>o.id===id);
  const lines=[...o.drinks.map(line=>({key:`gift:${line.id}`,line,label:`套餐 · ${line.productNameSnapshot || product(productIdOf(line)).name}`})),...o.sales.flatMap(sale=>(sale.drinks||[]).map(line=>({key:`sale:${line.id}`,line,label:`增购 · ${line.productNameSnapshot || product(productIdOf(line)).name}`}))),...(o.bonusGifts||[]).flatMap(gift=>(gift.drinks||[]).map(line=>({key:`bonus:${line.id}`,line,label:`赠送 · ${line.productNameSnapshot || product(productIdOf(line)).name}`})))].filter(item=>item.line.count&&product(productIdOf(item.line)).exchangeLevel!==4);
  if (!lines.length) { toast('没有可换出的酒水，瓶装水不能继续换出'); return; }
  openDialog('换酒水 · 不加钱',`<p class="notice">套餐、增购和已赠酒水都可按 1 支换 1 支，可只换几支。原账单金额不变。</p><label>从哪份酒水换出<select name="line">${options(lines.map(item=>[item.key,`${item.label} · 可换${item.line.count}支`]))}</select></label><label>换成<select name="product"></select></label>${stepper()}<p class="muted">换酒后，本单总额仍为 ${money(total(o))}</p>`,'确认换酒水','exchange',{order:id});
  const f=ctx.modal.querySelector('form'); const update=()=> { const item=lines.find(row=>row.key===f.elements.line.value); f.elements.product.innerHTML=options(ctx.state.catalog.products.filter(p=>p.active!==false&&p.sellable&&!p.selectionOnly&&saleOptions(p).length&&canExchange(productIdOf(item.line),p.id,ctx.state.catalog)).map(p=>[p.id,p.name])); f.elements.count.max=item.line.count; f.elements.count.value=1; }; f.elements.line.addEventListener('change',update); update();
}

function collectDialog(id) {
  const o=ctx.state.orders.find(o=>o.id===id), charge=nextCollectCharge(o,ctx.state.catalog);
  if (!charge) { toast('本单没有待收费用'); return; }
  openDialog(`${o.room} · 收钱`,`<div class="quote"><span>本次只收</span><strong>${money(charge.remaining)}</strong><p>${esc(charge.label)}</p></div><p class="muted">收钱后房间继续营业。若刚增购酒水，本次只收最近一笔未收的增购；否则收开房费用。</p>${paymentFields(charge.remaining)}`,`确认收到 ${money(charge.remaining)}`,'collect',{order:id,charge:charge.id});
  bindPaymentSummary(charge.remaining);
}

function checkout(id) {
  const o=ctx.state.orders.find(o=>o.id===id), due=outstanding(o), received=total(o)-due;
  const pending=collectableCharges(o,ctx.state.catalog).map(charge=>`<div class="bill-line"><span>${esc(charge.label)}</span><b>${money(charge.remaining)}</b></div>`).join('');
  const canReceive=allowedPermission('payment.settle');
  const payment=due?(canReceive?paymentFields(due,true):'<p class="notice">当前身份可申请挂账；实际收款结账请切换有收银员或老板权限的身份。</p>'):'<p class="notice">费用已经通过“收钱”登记完毕。确认结账后，房间转为待清洁。</p>';
  const creditButton=due&&allowedPermission('credit.apply')?btn('客人暂未付款，申请挂账','credit',`data-id="${id}"`,'quiet full'):'';
  openDialog(`${o.room} · 结账`,`<div class="quote"><span>结账待收</span><strong>${money(due)}</strong><p>本单总额 ${money(total(o))} · 已收 ${money(received)}</p></div>${pending||'<p class="muted">没有未收费用。</p>'}<p class="muted">结账汇总“收钱”尚未登记的费用；完成结账后房间才转为待清洁。</p>${payment}${creditButton}`,canReceive?(due?`确认结账并收到 ${money(due)}`:'确认结账，转待清洁'):'',canReceive?'settle':'',{order:id});
  if (canReceive&&due) bindPaymentSummary(due,true);
}

function creditDialog(id) {
  const o=ctx.state.orders.find(o=>o.id===id), amount=outstanding(o);
  if (!amount) { toast('本单已经收清，无需挂账'); return; }
  openDialog('申请挂账',`<p>挂账 ${money(amount)} · 交给${amount>100000?'老板':'店长'}审批</p><div class="notice">开单：${esc(o.openedBy || o.person || '未记录')}<br>开房渠道：${esc(o.openSource || '线下')}<br>${o.reservedBy?`预订：${esc(o.reservedBy)}（${esc(o.reservationSource || '方式未记录')}）`:'本单没有预订记录'}</div><p class="muted">手机号或顾客姓名至少填写一个。</p><label>客人手机号（选填）<input name="phone" type="tel" inputmode="tel" pattern="1[0-9]{10}" maxlength="11"></label><label>顾客姓名（选填）<input name="name" maxlength="30"></label><label>挂账备注<textarea name="note" maxlength="200" required placeholder="例如：王生宴请，承诺明晚结清"></textarea></label><p>挂账经办：<b>${currentUser().name}</b>（不可改选）</p><label>经办员工本人手写签字<canvas id="signature" width="600" height="220" aria-label="手写签名区域"></canvas></label>${btn('重新签字','clearSignature','','quiet')}<p class="muted">签字提交起算24小时。申请后锁定结账，房间释放为待清洁；审批通过前不计实收。</p>`,'签字完成，提交审批','credit',{order:id});
  const canvas=document.querySelector('#signature'), ctx2d=canvas.getContext('2d'); ctx2d.lineWidth=4; ctx2d.lineCap='round'; ctx2d.strokeStyle='#183c32'; let down=false;
  const pos=e=> { const r=canvas.getBoundingClientRect(); return [(e.clientX-r.left)*canvas.width/r.width,(e.clientY-r.top)*canvas.height/r.height]; };
  canvas.addEventListener('pointerdown',e=>{ down=true; canvas.setPointerCapture(e.pointerId); ctx2d.beginPath(); ctx2d.moveTo(...pos(e)); });
  canvas.addEventListener('pointermove',e=>{ if(down){ctx2d.lineTo(...pos(e));ctx2d.stroke();canvas.dataset.signed='yes';} });
  canvas.addEventListener('pointerup',()=>down=false); canvas.addEventListener('pointercancel',()=>down=false);
}

export {
  showOrder,
  giftDialog,
  saleDialog,
  otherChargeDialog,
  exchangeDialog,
  collectDialog,
  checkout,
  creditDialog
};
