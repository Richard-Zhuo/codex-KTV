// Explicit, expected domain rejection. Unknown errors remain recoverable failures.
export class BusinessRejection extends Error {
  constructor(message) {
    super(message);
    this.name = 'BusinessRejection';
    this.code = 'BUSINESS_REJECTION';
  }
}
