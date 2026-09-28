// 审核收件箱投影：只读汇总各领域待审/已审记录，供待办页展示。
// Phase 5 自 app.js 迁出：pendingBusinessReviewCount 与 reviewHistoryRows。
// 投影只读取状态，不决定任何业务状态（审核决定仍在各领域命令，
// 由 rules.transact 委托调用）。过滤口径与展示字段逐字节保留。
import { product } from './catalog.js';
import { businessReviewSections } from './shared/identity.js';
import { money } from './shared/money.js';

export function pendingBusinessReviewCount(state, section) {
  if(section==='creditApproval')return state.orders.filter(order=>order.status==='待审批挂账').length;
  if(section==='creditRepayment')return state.orders.reduce((sum,order)=>sum+(order.credit?.repaymentRequests||[]).filter(request=>request.status==='待审核').length,0);
  if(section==='rounding')return state.orders.filter(order=>order.roundingReview?.status==='待审核').length;
  if(section==='gift')return state.orders.reduce((sum,order)=>sum+(order.giftRequests||[]).filter(request=>request.status==='待确认').length,0);
  if(section==='roomRecovery')return (state.roomIssueReviews||[]).filter(request=>request.status==='待审核').length;
  if(section==='inventory')return (state.inventoryReviews||[]).filter(request=>request.status==='待审核').length;
  if(section==='incident')return (state.incidents||[]).reduce((sum,incident)=>sum+(incident.resolutionReviews||[]).filter(request=>request.status==='待审核').length,0);
  if(section==='expense')return (state.expenses||[]).filter(expense=>expense.status==='待老板审批').length;
  return 0;
}
export function reviewHistoryRows(state, user) {
  const reviewer=user.name, visibleSections=new Set(businessReviewSections(user)), rows=[];
  const add=(section,title,status,time,note='',selfReviewAuthorized=false)=>{if(visibleSections.has(section)&&time)rows.push({section,title,status,time,note,selfReviewAuthorized});};
  for(const request of state.roomIssueReviews||[])if(request.decidedBy===reviewer)add('roomRecovery',`${request.room} · 房间恢复`,request.status,request.decidedAt,request.decisionNote,request.selfReviewAuthorized);
  for(const order of state.orders){
    if(order.credit?.decisionBy===reviewer)add('creditApproval',`${order.room} · 挂账审批`,'已批准',order.credit.decisionAt);
    if(order.roundingReview?.decidedBy===reviewer)add('rounding',`${order.room} · 特殊差额`,order.roundingReview.status,order.roundingReview.decidedAt,order.roundingReview.decisionNote,order.roundingReview.selfReviewAuthorized);
    for(const request of order.giftRequests||[])if(request.decidedBy===reviewer)add('gift',`${order.room} · ${request.productNameSnapshot || product(request.productId || request.product).name}赠酒`,request.status,request.decidedAt,request.decisionNote,request.selfReviewAuthorized);
    for(const request of order.credit?.repaymentRequests||[])if(request.decidedBy===reviewer)add('creditRepayment',`${order.room} · 回款${money(request.amount)}`,request.status,request.decidedAt,request.decisionNote,request.selfReviewAuthorized);
  }
  for(const request of state.inventoryReviews||[])if(request.decidedBy===reviewer){const label=state.catalog.products.find(item=>item.id===request.product)?.name||request.product;add('inventory',`${label} · 库存盘点`,request.status,request.decidedAt,request.decisionNote,request.selfReviewAuthorized);}
  for(const incident of state.incidents||[])for(const request of incident.resolutionReviews||[])if(request.decidedBy===reviewer)add('incident',`${incident.room} · ${incident.type}`,request.status,request.decidedAt,request.decisionNote,request.selfReviewAuthorized);
  for(const expense of state.expenses||[])if(expense.approver===reviewer)add('expense',`${expense.description} · 报销`,expense.status,expense.approvedAt);
  return rows.sort((a,b)=>Date.parse(b.time)-Date.parse(a.time)).slice(0,12);
}
