import {ctx,esc,btn,date} from './context.js';
import {openDialog,commit} from './shell.js';
import {cents,money} from '../shared/money.js';
import {PAYMENT_METHODS} from '../sales.js';

const titles={refundPayment:'退款',reversePayment:'付款冲正',cashOut:'现金取出',cancelOrder:'撤销订单',approveFinancialAdjustment:'批准资金申请',rejectFinancialAdjustment:'驳回资金申请'};
const kindAction={REFUND:'refundPayment',PAYMENT_REVERSAL:'reversePayment',CASH_OUT:'cashOut'};
const actualText={refundPayment:'我已实际将上述金额退还顾客，确认登记。',cashOut:'我已实际从当前收银抽屉取出上述现金，确认登记。',reversePayment:'我确认整笔冲正上述错误收款记录；这不代表已向顾客退款。',cancelOrder:'我确认撤销上述订单；撤单不自动恢复库存。'};
let confirmation=null;
export const financialStatus=value=>({'待审核':'待审批','已批准':'已批准，待实际执行','已驳回':'已拒绝','已执行':'已执行完成'})[value]??'状态待核对';
const positive=value=>{const n=cents(String(value??''));if(n<=0)throw Error('请输入大于零的金额');return n;};
const data=()=>ctx.formal?.workspace?.financial;
const orderLabel=(f,id)=>{const o=f.orders?.find(o=>o.id===id)??ctx.state?.orders?.find(o=>o.id===id);return o?.room?'房间 '+o.room:'订单编号 '+id;};
const paymentLabel=(f,p)=>orderLabel(f,p.orderId)+' · '+money(p.amount)+' '+p.method+' · '+date(p.occurredAt);
export function buildFinancialIntent(f,action,values){
 if(!f||!titles[action])throw Error('当前账号没有这项资金操作权限');
 let payload,amount=null,reason='',object='',actual=false,request=null;
 if(['approveFinancialAdjustment','rejectFinancialAdjustment'].includes(action)){
  request=f.requests.find(r=>r.requestId===values.requestId);
  if(!request||!(action==='approveFinancialAdjustment'?request.canApprove:request.canReject))throw Error('当前申请不能由您审批，请刷新待办');
  if(!request.submittedByDisplayName)throw Error('申请人身份资料未就绪，请先联系管理员核对');
  payload={requestId:request.requestId};
  if(action==='rejectFinancialAdjustment'){const note=String(values.decisionNote??'').trim();if(!note)throw Error('请填写驳回原因');payload.decisionNote=note;}
  amount=request.amount;reason=request.reason;object='申请人：'+request.submittedByDisplayName;
 }else{
  if(!f.capabilities[action]?.allowed)throw Error('当前账号没有这项资金操作权限');
  if(values.requestId){
   request=f.requests.find(r=>r.requestId===values.requestId);
   if(!request?.canExecute||kindAction[request.kind]!==action)throw Error('该申请尚不可执行，请刷新并核对审批状态');
   payload=action==='cashOut'?{requestId:request.requestId}:{order:request.orderId,requestId:request.requestId};
   amount=request.amount;reason=request.reason;object=request.orderId?orderLabel(f,request.orderId):'当前收银抽屉';actual=true;
  }else{
   reason=String(values.reason??'').trim();if(!reason)throw Error('请填写操作原因');
   if(action==='refundPayment'||action==='reversePayment'){
    const p=f.payments.find(p=>p.paymentId===values.paymentId&&!p.unavailableReason);
    if(!p)throw Error('无法核对原付款，请刷新后重新选择');
    amount=action==='reversePayment'?p.amount:positive(values.amount);
    payload={order:p.orderId,originalPaymentId:p.paymentId,amount,reason};object=orderLabel(f,p.orderId)+' · 原付款 '+money(p.amount)+' '+p.method;
    if(action==='refundPayment'){
     if(!PAYMENT_METHODS.includes(values.refundChannel))throw Error('请选择退款方式');
     const source=values.refundChannel==='现金'?values.refundFundingSource:'NON_CASH';
     if(values.refundChannel==='现金'&&!['CURRENT_DRAWER','OUTSIDE_DRAWER'].includes(source))throw Error('请选择现金资金来源');
     Object.assign(payload,{refundChannel:values.refundChannel,refundFundingSource:source});
    }
   }else if(action==='cashOut'){amount=positive(values.amount);payload={amountCents:amount,reason};object='当前收银抽屉';}
   else{const o=f.orders.find(o=>o.id===values.order);if(!o)throw Error('请选择服务器提供的订单');payload={order:o.id,reason};object=o.room?'房间 '+o.room:'订单编号 '+o.id;}
   actual=action==='cancelOrder'||f.capabilities[action].mode==='DIRECT';
  }
 }
 return {action,payload,amount,reason,object,actual,request,
  confirmation:actual?actualText[action]:action==='approveFinancialAdjustment'?'我确认批准；批准不代表资金已经执行。':action==='rejectFinancialAdjustment'?'我确认驳回该资金申请。':'我确认提交申请，待另一名人员批准后再执行。'};
}
function summary(i){
 const channel=i.payload.refundChannel??i.request?.refundChannel,source=i.payload.refundFundingSource??i.request?.refundFundingSource;
 return '<div class="quote"><span>'+esc(titles[i.action])+'</span>'+(i.amount===null?'':'<strong>'+money(i.amount)+'</strong>')+'</div><p>'+esc(i.object)+'</p><p>原因：'+esc(i.reason)+'</p>'+
 (channel?'<p>退款方式：'+esc(channel)+' · '+esc(({CURRENT_DRAWER:'当前收银抽屉',OUTSIDE_DRAWER:'抽屉外现金',NON_CASH:'非现金'})[source])+'</p>':'')+
 (i.action==='reversePayment'?'<p class="notice">付款冲正用于纠正错误收款记录，不代表已向顾客退款。</p>':'')+
 (i.action==='refundPayment'?'<p class="muted">本系统登记人工退款，不自动操作支付平台，也不验证平台到账。</p>':'');
}
function confirmIntent(i){
 confirmation={...i,principalId:ctx.formal.session.principalId};
 openDialog('最终确认 · '+titles[i.action],summary(i)+'<label class="financial-confirm"><input type="checkbox" name="confirmed" value="yes" required> '+esc(i.confirmation)+'</label>',
 i.actual?'确认登记'+titles[i.action]:i.action==='approveFinancialAdjustment'?'确认批准':i.action==='rejectFinancialAdjustment'?'确认驳回':'确认提交申请','financialConfirm');
}
export function financialOrderActions(orderId){
 const f=data();if(!f)return '';
 return '<div class="action-grid financial-actions">'+['refundPayment','reversePayment','cancelOrder'].filter(a=>f.capabilities[a]?.allowed)
 .map(a=>btn(titles[a],'financialStart','data-kind="'+a+'" data-id="'+esc(orderId)+'"')).join('')+'</div>';
}
export function financialPanel({reviews=true}={}){
 const f=data();if(!f)return ctx.formal&&!reviews?'<p class="muted">当前账号没有资金操作权限。</p>':'';
 const actor=ctx.formal.session.principalId,own=f.requests.filter(r=>r.submittedByPrincipalId===actor);
 const review=reviews?f.requests.filter(r=>r.canApprove||r.canReject):[];
 const cards=rows=>rows.map(r=>'<article class="panel financial-card"><div class="split"><h3>'+esc(titles[kindAction[r.kind]])+' '+money(r.amount)+'</h3><span class="badge">'+esc(financialStatus(r.status))+'</span></div>'+
 '<p>申请人：'+esc(r.submittedByDisplayName??'身份资料待核对')+'</p><p>'+esc(r.orderId?orderLabel(f,r.orderId):'当前收银抽屉')+'</p><p>原因：'+esc(r.reason)+'</p><p class="muted">'+date(r.submittedAt)+'</p>'+
 (r.refundChannel?'<p>退款方式：'+esc(r.refundChannel)+'</p>':'')+
 (r.canExecute?btn('确认实际执行','financialExecute','data-request="'+esc(r.requestId)+'"','primary full'):'')+
 (r.submittedByDisplayName&&r.canApprove?'<div class="inline-actions">'+btn('批准','financialApprove','data-request="'+esc(r.requestId)+'"','primary')+btn('驳回','financialReject','data-request="'+esc(r.requestId)+'"','danger')+'</div>':'')+
 (r.status==='已批准'?'<p class="notice">已批准，待实际执行。请勿将审批视为退款或取现完成。</p>':'')+'</article>').join('');
 const launch=['refundPayment','reversePayment','cashOut','cancelOrder'].filter(a=>f.capabilities[a]?.allowed)
  .map(a=>btn(titles[a],'financialStart','data-kind="'+a+'"')).join('');
 const error=ctx.formal.lastFinancialAction&&ctx.formal.lastError?'<p class="notice" role="alert">'+financialErrorText(ctx.formal.lastError)+'</p>':'';
 return '<section class="financial-section"><div class="section-title"><h2>资金操作</h2><span>以服务器状态为准</span></div>'+error+
 '<div class="action-grid">'+launch+'</div>'+(reviews?'<h3>待我审批的资金申请</h3>'+ (cards(review)||'<p class="muted">暂无合格资金待办。</p>'):'')+
 '<h3>我的资金申请</h3>'+(cards(own)||'<p class="muted">暂无本人资金申请。</p>')+
 '<details class="panel"><summary>本人执行记录（'+f.results.length+'）</summary>'+f.results.map(r=>'<div class="bill-line"><span>'+esc(({REFUND:'退款',PAYMENT_REVERSAL:'付款冲正',CASH_OUT:'现金取出',CANCEL_ORDER:'撤销订单'})[r.kind])+' · 已执行完成<br><small>人工确认登记 · '+date(r.occurredAt)+'</small></span><b>'+((r.amount??r.amountCents)!==undefined?money(r.amount??r.amountCents):'')+'</b></div>').join('')+'</details></section>';
}
export function financialErrorText(error){
 if(error?.code==='business_rejection'){
  const reason=error.result?.reason??'';
  if(reason.includes('unambiguous unpaid'))return '执行失败：该订单存在付款、挂账或待处理事项，不能无款撤单。';
  if(reason.includes('cash')||reason.includes('Cash')||reason.includes('现金'))return '执行失败：当前现金来源或余额无法通过校验，请核对抽屉和申请状态。';
  return '执行失败：服务器拒绝了本次操作，请核对金额、原付款和最新申请状态。';
 }
 if(error?.code==='authorization_denied')return '当前账号无权执行此操作，请刷新权限与申请状态。';
 if(error?.code==='revision_conflict')return '门店状态已更新，请核对刷新后的记录，再明确发起操作；系统不会自动重做。';
 return '结果待确认，请先核对记录，不要重复操作。';
}
export function financialClick(action,dataset){
 const f=data();if(!f)throw Error('当前账号没有资金操作权限');
 if(action==='financialExecute'){
  const r=f.requests.find(r=>r.requestId===dataset.request);
  confirmIntent(buildFinancialIntent(f,kindAction[r?.kind],{requestId:r?.requestId}));return;
 }
 if(action==='financialApprove'){confirmIntent(buildFinancialIntent(f,'approveFinancialAdjustment',{requestId:dataset.request}));return;}
 if(action==='financialReject'){
  const r=f.requests.find(r=>r.requestId===dataset.request);
  if(!r?.canReject||!r.submittedByDisplayName)throw Error('当前申请无法由您审批，请核对身份与状态');
  openDialog('驳回资金申请','<p>'+esc(r.submittedByDisplayName)+' · '+money(r.amount)+'</p><label>驳回原因<textarea name="decisionNote" maxlength="300" required></textarea></label>',
   '核对驳回内容','financialDraft',{command:'rejectFinancialAdjustment',requestId:r.requestId});return;
 }
 const command=dataset.kind;if(!f.capabilities[command]?.allowed)throw Error('当前账号没有这项资金操作权限');
 let fields='';
 if(command==='refundPayment'||command==='reversePayment'){
  const ps=f.payments.filter(p=>!p.unavailableReason&&(!dataset.id||p.orderId===dataset.id));
  if(!ps.length)throw Error('暂无可核对的原付款');
  fields='<label>原付款<select name="paymentId" required>'+ps.map(p=>'<option value="'+esc(p.paymentId)+'">'+esc(paymentLabel(f,p))+'</option>').join('')+'</select></label>';
  if(command==='refundPayment')fields+='<label>退款金额（元）<input name="amount" inputmode="decimal" required placeholder="例如：12.34"></label><label>退款方式<select name="refundChannel">'+PAYMENT_METHODS.map(m=>'<option>'+esc(m)+'</option>').join('')+'</select></label><label data-cash-source>现金来源<select name="refundFundingSource"><option value="CURRENT_DRAWER">当前收银抽屉</option><option value="OUTSIDE_DRAWER">抽屉外现金</option></select></label>';
  else fields+='<p class="notice">仅支持整笔付款冲正。付款冲正用于纠正错误收款记录，不代表已向顾客退款。</p>';
 }else if(command==='cashOut')fields='<p>当前可信可用现金：'+(f.drawer?.availableCents===null||f.drawer?.availableCents===undefined?'暂无法核对':money(f.drawer.availableCents))+'</p><label>取出金额（元）<input name="amount" inputmode="decimal" required></label>';
 else fields='<label>订单<select name="order" required>'+f.orders.filter(o=>!dataset.id||o.id===dataset.id).map(o=>'<option value="'+esc(o.id)+'">'+esc(orderLabel(f,o.id))+' · '+esc(o.status)+'</option>').join('')+'</select></label><p class="notice">是否可撤单由服务器判断。撤单不自动恢复库存。</p>';
 fields+='<label>操作原因<textarea name="reason" maxlength="300" required></textarea></label>';
 openDialog(titles[command],fields,'核对操作内容','financialDraft',{command});
 if(command==='refundPayment'){
  const form=ctx.modal.querySelector('form'),channel=form.elements.refundChannel,box=form.querySelector('[data-cash-source]');
  const update=()=>{box.hidden=channel.value!=='现金';box.querySelector('select').disabled=box.hidden;};channel.addEventListener('change',update);update();
 }
}
export async function financialSubmit(form){
 const values=Object.fromEntries(new FormData(form));
 if(form.dataset.form==='financialDraft'){confirmIntent(buildFinancialIntent(data(),values.command,values));return;}
 if(!confirmation||confirmation.principalId!==ctx.formal?.session.principalId)throw Error('请重新核对当前操作');
 if(values.confirmed!=='yes')throw Error('请勾选确认事项');
 const intent=confirmation;ctx.formal.lastFinancialAction=intent.action;
 await commit(intent.action,intent.payload);confirmation=null;
}
