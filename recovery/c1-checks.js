import {rowsOf} from '../backup/mysql-backup.js';
import {decodeLedgerSnapshot} from '../ledger/mysql-snapshot.js';
import {total,outstanding} from '../sales.js';
import {checkRecoveryInvariants} from './invariants.js';

const finding=(code,area)=>({code,area});
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const unique=values=>[...new Map(values.map(v=>[v.area+':'+v.code,v])).values()];

// Evidence is derived from persisted rows only. It never changes business data.
export function checkCutoverCandidate(data,manifest){
 const base=checkRecoveryInvariants(data,manifest);
 const blocking=base.blockers.map(b=>finding(b.code,'ledger')),manual=[];
 const accounts=new Set(rowsOf(data,'auth_accounts').map(r=>r.principal_id));
 const orderIds=new Set();
 const employees=new Set(rowsOf(data,'employees').map(r=>r.employee_id));
 if(rowsOf(data,'auth_sessions').some(r=>r.revoked_at===null))
  blocking.push(finding('C1_RESTORED_SESSION_ACTIVE','auth'));
 for(const head of rowsOf(data,'ledger_heads')){
  let state;
  try{state=decodeLedgerSnapshot(head.state_json,head.state_checksum);}
  catch{continue;} // checkRecoveryInvariants already blocks a corrupt head.
  const products=new Map((state.catalog?.products??[]).map(p=>[p.id,p]));
  for(const order of state.orders??[]){
   orderIds.add(String(order.id));
   const paid=(order.payments??[]).reduce((n,p)=>n+p.amount,0),amount=total(order);
   if(!integer(amount)||!integer(paid)||paid>amount||
      (order.status===String.fromCodePoint(0x5df2,0x7ed3,0x8d26)&&outstanding(order)!==0))
    blocking.push(finding('C1_MONEY_MISMATCH','money'));
   const credit=order.credit;
   if(credit&&(!integer(credit.amount)||!integer(credit.remaining)||
      credit.remaining>credit.amount||(credit.repayments??[]).some(r=>!integer(r.amount))||
      credit.amount-(credit.repayments??[]).reduce((sum,r)=>sum+r.amount,0)!==credit.remaining))
    blocking.push(finding('C1_CREDIT_MISMATCH','money'));
   for(const record of [...(order.roundingHistory??[]),order]){
    const review=record.roundingReview;
    if(review&&(!integer(record.rounding)||review.amount!==record.rounding||
       (review.status===String.fromCodePoint(0x5df2,0x6279,0x51c6)&&!review.decidedAt)))
     blocking.push(finding('C1_ROUNDING_MISMATCH','money'));
   }
   if(order.actualActorPrincipalId&&!accounts.has(order.actualActorPrincipalId)||
      order.creditedEmployeeId&&!employees.has(order.creditedEmployeeId))
    blocking.push(finding('C1_ATTRIBUTION_REFERENCE','references'));
   for(const line of [...(order.sales??[]),...(order.resolvedComponents??[])]){
    if(line.productId&&(!line.productNameSnapshot||!line.baseUnitSnapshot))
     blocking.push(finding('C1_CATALOG_SNAPSHOT','references'));
    if(line.productId&&!products.has(line.productId))
     manual.push(finding('C1_HISTORIC_PRODUCT_NOT_IN_CURRENT_CATALOG','references'));
   }
  }
  for(const product of state.catalog?.products??[]){
   const stock=(product.kind==='consumable'?state.consumables:state.inventory)?.[product.id];
   if(product.inventoryManaged&&product.active!==false&&(!stock||stock.count===null||!integer(stock.count)))
    blocking.push(finding('C1_OPENING_STOCK_MISSING','inventory'));
  }
 }
 for(const record of rowsOf(data,'voucher_redemptions')){
  if(record.linked_order_id&&!orderIds.has(String(record.linked_order_id)))
   blocking.push(finding('C1_VOUCHER_ORDER_REFERENCE','references'));
  if(['REDEEMING','UNKNOWN'].includes(record.status))
   blocking.push(finding('C1_VOUCHER_OUTCOME_UNKNOWN','voucher'));
  else if(record.status==='PENDING')manual.push(finding('C1_VOUCHER_PENDING','voucher'));
  else if(['REVERSED','REFUNDED'].includes(record.status)&&record.linked_order_id)
   blocking.push(finding('C1_VOUCHER_LINKED_ORDER_RECONCILE','voucher'));
 }
 if(rowsOf(data,'voucher_exceptions').length)
  blocking.push(finding('C1_VOUCHER_EXCEPTION','voucher'));
 for(const row of rowsOf(data,'room_control_workflows')){
  let workflow;
  try{workflow=decodeLedgerSnapshot(row.state_json,row.state_checksum);}catch{continue;}
  if(workflow.uncertain===true||workflow.inFlight||
     !['ACTIVE','DEVICE_FAILED'].includes(workflow.status))
   blocking.push(finding('C1_DEVICE_OUTCOME_UNKNOWN','device'));
  else if(workflow.status==='DEVICE_FAILED')
   manual.push(finding('C1_DEVICE_FAILED_FOLLOWUP','device'));
 }
 const b=unique(blocking),m=unique(manual);
 return {blocking:b,manualFollowups:m,external:{
  voucher:b.some(v=>v.area==='voucher')?'BLOCKING_UNKNOWN':m.some(v=>v.area==='voucher')?'NON_BLOCKING_MANUAL_FOLLOWUP':'SAFE',
  device:b.some(v=>v.area==='device')?'BLOCKING_UNKNOWN':m.some(v=>v.area==='device')?'NON_BLOCKING_MANUAL_FOLLOWUP':'SAFE',
  payment:'SAFE',alerts:'SAFE'},counts:base.counts};
}
