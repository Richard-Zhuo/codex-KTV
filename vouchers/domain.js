// The only authority for platform voucher lifecycle transitions.
export const REDEMPTION_TRANSITIONS = Object.freeze({
  PENDING: Object.freeze(['REDEEMING']),
  REDEEMING: Object.freeze(['REDEEMED', 'FAILED', 'UNKNOWN']),
  UNKNOWN: Object.freeze(['REDEEMED', 'FAILED', 'REVERSED', 'REFUNDED']),
  REDEEMED: Object.freeze(['REVERSED', 'REFUNDED']),
  FAILED: Object.freeze([]), REVERSED: Object.freeze([]), REFUNDED: Object.freeze([])
});
export class VoucherError extends Error {
  constructor(code) { super(code); this.name = 'VoucherError'; this.code = code; }
}
export function createRedemptionIntent(fields) {
  return { ...fields, status: 'PENDING', version: 0 };
}
export function transitionRedemption(record, target) {
  if (!Number.isSafeInteger(record?.version) || record.version < 0 ||
      !REDEMPTION_TRANSITIONS[record.status]?.includes(target)) {
    throw new VoucherError('VOUCHER_INVALID_TRANSITION');
  }
  return { ...record, status: target, version: record.version + 1 };
}

export function bindRedemptionToOrder(record,orderId) {
  if(record?.status!=='REDEEMED'||record.linkedOrderId!==null||typeof orderId!=='string'||!orderId||orderId.length>120)throw new VoucherError('VOUCHER_BINDING_REJECTED');
  if(!Number.isSafeInteger(record.version+1))throw RangeError('Voucher version limit');
  return {...record,linkedOrderId:orderId,version:record.version+1};
}
