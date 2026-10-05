// Named database-independent domain port. Implementations own provider DTO translation.
export class PlatformVoucherGateway {
  async inspectVoucher() { throw Error('inspectVoucher not implemented'); }
  async redeemVoucher() { throw Error('redeemVoucher not implemented'); }
  async queryRedemption() { throw Error('queryRedemption not implemented'); }
  async reverseRedemption() { throw Error('reverseRedemption not implemented'); }
}
// An explicit mapping boundary for the still-unverified real mt-tech response contract.
// There are no guessed field mappings and no default parser that trusts redeemed=true.
export class MeituanSkillDtoMapper {
  constructor(verifiedContract) { this.contract = verifiedContract; }
  encode(operation, domainRequest) {
    if (typeof this.contract?.encode !== 'function') { const e=Error('Meituan DTO contract unverified');e.code='MEITUAN_DTO_CONTRACT_UNVERIFIED';throw e; }
    return this.contract.encode(operation, domainRequest);
  }
  decode(operation, skillResult) {
    if (typeof this.contract?.decode !== 'function') { const e=Error('Meituan DTO contract unverified');e.code='MEITUAN_DTO_CONTRACT_UNVERIFIED';throw e; }
    return this.contract.decode(operation, skillResult);
  }
}
