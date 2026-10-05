import { PlatformVoucherGateway } from './gateway.js';
// DTO seam only. No raw Meituan response may cross into the domain.
export const MEITUAN_SKILL_OPERATIONS = Object.freeze({
  inspectVoucher: 'tuangou_receipt_prepare', redeemVoucher: 'tuangou_receipt_consume',
  queryRedemption: Object.freeze(['getconsumed', 'querylistbydate', 'order_query_info']),
  reverseRedemption: 'tuangou_receipt_reverseconsume'
});
export class MeituanSkillGateway extends PlatformVoucherGateway {
  constructor({ config = {}, credentialProvider, transport, dtoContract } = {}) {
    super();
    this.config = Object.freeze({ ...config });
    // Reserved internal boundaries; intentionally not invoked before formal acceptance.
    this.credentialProvider = credentialProvider; this.transport = transport; this.dtoContract = dtoContract;
  }
  get productionEnabled() { return false; }
  describeBoundary() { return { productionEnabled: false, operations: MEITUAN_SKILL_OPERATIONS,
    dtoContractVerified: false, providerIdempotencyVerified: false }; }
  async inspectVoucher() { return this.#disabled(); }
  async redeemVoucher() { return this.#disabled(); }
  async queryRedemption() { return this.#disabled(); }
  async reverseRedemption() { return this.#disabled(); }
  #disabled() { const e = Error('Meituan production redemption = NOT ENABLED'); e.code = 'MEITUAN_PRODUCTION_NOT_ENABLED'; throw e; }
}
// Test-only provider simulator; never selected automatically as a production fallback.
export class FakePlatformVoucherGateway extends PlatformVoucherGateway {
  get testOnly() { return true; }
  constructor({ storeId = 'synthetic-store', productId = 'synthetic-product', outcomes = {} } = {}) {
    super();
    this.storeId = storeId; this.productId = productId; this.outcomes = outcomes;
    this.calls = { inspectVoucher: 0, redeemVoucher: 0, queryRedemption: 0, reverseRedemption: 0 };
    this.facts = new Map();
  }
  async inspectVoucher(input) {
    this.calls.inspectVoucher++;
    if (this.outcomes.inspectVoucher) return this.outcomes.inspectVoucher(input, this);
    return { provider: input.provider, storeId: this.storeId, productId: this.productId,
      productNameSnapshot: 'Synthetic voucher product', externalOrderId: 'order-' + input.providerRequestId,
      externalVoucherId: 'voucher-' + input.providerRequestId };
  }
  async redeemVoucher(input) {
    this.calls.redeemVoucher++;
    const fact = { provider: input.provider, storeId: this.storeId, providerRequestId: input.providerRequestId,
      externalOrderId: 'order-' + input.providerRequestId, externalVoucherId: 'voucher-' + input.providerRequestId,
      productId: this.productId, productNameSnapshot: 'Synthetic voucher product',
      status: 'REDEEMED', providerFlowId: 'flow-' + input.providerRequestId, providerTraceId: 'trace-' + input.providerRequestId };
    this.facts.set(input.providerRequestId, fact);
    if (this.outcomes.redeemVoucher) return this.outcomes.redeemVoucher(input, this);
    return fact;
  }
  async queryRedemption(input) {
    this.calls.queryRedemption++;
    if (this.outcomes.queryRedemption) return this.outcomes.queryRedemption(input, this);
    return this.facts.get(input.providerRequestId) || { ...input, status: 'UNKNOWN' };
  }
  async reverseRedemption(input) {
    this.calls.reverseRedemption++;
    if (this.outcomes.reverseRedemption) return this.outcomes.reverseRedemption(input, this);
    const fact = { ...this.facts.get(input.providerRequestId), status: 'REVERSED' };
    this.facts.set(input.providerRequestId, fact); return fact;
  }
}
