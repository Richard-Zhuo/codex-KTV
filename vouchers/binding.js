import { BusinessRejection } from '../shared/business-error.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { bindRedemptionToOrder } from './domain.js';

// Same-connection capability. The caller owns the ledger transaction and all its locks.
export function createTransactionBoundVoucherBinding({port,ledgerId,provider,storeId,packageMappings=[]}) {
  if(typeof port?.lockRedemption!=='function'||typeof port?.writeRedemption!=='function'||
      !ledgerId||!provider||!storeId||!Array.isArray(packageMappings))throw TypeError('Explicit voucher binding port required');
  const mappings=new Map();
  for(const item of packageMappings){
    if(typeof item?.productId!=='string'||!item.productId||mappings.has(item.productId)||
       !Array.isArray(item.packageIds)||!item.packageIds.length||item.packageIds.some(id=>typeof id!=='string'||!id))throw TypeError('Explicit provider product/package mapping required');
    mappings.set(item.productId,Object.freeze([...new Set(item.packageIds)]));
  }
  const locked=new Map();
  return Object.freeze({
    async lockForOpen({redemptionId}){
      if(typeof redemptionId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(redemptionId))throw new BusinessRejection('平台券必须引用内部 redemption UUID');
      const row=await port.lockRedemption(redemptionId);
      if(!row||row.ledgerId!==ledgerId||row.provider!==provider||row.storeId!==storeId)throw new BusinessRejection('平台券不属于当前门店账本');
      if(row.status!=='REDEEMED'||row.linkedOrderId!==null||!row.providerFlowId)throw new BusinessRejection('平台券未可信核销或已绑定订单');
      const allowedPackageIds=mappings.get(row.productId);
      if(!allowedPackageIds)throw new AuthorizationDenied('voucher-product-unconfigured');
      locked.set(redemptionId,structuredClone(row));
      return Object.freeze({redemptionId:row.id,provider:row.provider,storeId:row.storeId,version:row.version,
        providerFlowId:row.providerFlowId,productId:row.productId,productNameSnapshot:row.productNameSnapshot,allowedPackageIds});
    },
    async linkToOrder({redemptionId,orderId}){
      const row=locked.get(redemptionId);if(!row)throw TypeError('Voucher must be locked and validated before binding');
      const next=bindRedemptionToOrder(row,orderId);
      await port.writeRedemption(next,row.version);locked.delete(redemptionId);
    }
  });
}
