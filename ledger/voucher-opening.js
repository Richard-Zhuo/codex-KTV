import { BusinessRejection } from '../shared/business-error.js';
import { randomUUID } from 'node:crypto';
import { withTrustedRoomOpening } from '../shared/identity.js';

const platformSources = new Set(['美团','抖音']);
const untrustedEvidence = ['receiptCode','voucherCode','redeemed','verified','status','skillResult','providerEvidence','voucher','redemption'];
// Only an internal ID may select server evidence. Payload identity remains unrelated.
export async function resolveVoucherOpeningContext(transaction,context,payload){
  if(untrustedEvidence.some(key=>Object.hasOwn(payload,key)))throw new BusinessRejection('开房只能引用 voucherRedemptionId，不能提交核销证据或券码');
  if(payload.voucherRedemptionId===undefined){
    if(platformSources.has(String(payload.openSource??'').trim()))throw new BusinessRejection('平台券开房缺少服务端 voucherRedemptionId');
    return withTrustedRoomOpening(context, { orderId: randomUUID() });
  }
  if(typeof transaction.voucherBinding?.lockForOpen!=='function'||typeof transaction.voucherBinding?.linkToOrder!=='function')throw TypeError('正式平台券开房缺少同事务 voucher binding port');
  const proof=await transaction.voucherBinding.lockForOpen({redemptionId:payload.voucherRedemptionId});
  return withTrustedRoomOpening(context, { orderId: randomUUID(), voucherRedemption: proof });
}
export async function linkOpenedVoucher(transaction,context,previousState,nextState){
  if(!context?.voucherRedemption)return;
  const oldIds=new Set(previousState.orders.map(o=>o.id)),created=nextState.orders.filter(o=>!oldIds.has(o.id));
  if(created.length!==1||created[0].voucherRedemptionId!==context.voucherRedemption.redemptionId||
     created[0].actualActorPrincipalId!==context.principalId)throw Error('Opened voucher order evidence is inconsistent');
  await transaction.voucherBinding.linkToOrder({redemptionId:context.voucherRedemption.redemptionId,orderId:created[0].id});
}
