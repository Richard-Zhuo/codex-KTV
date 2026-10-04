import { seedCreditReview } from './trusted-credit-review-fixture.js';
import { creditOrder } from './trusted-credit-fixture.js';
export { creditOrder as repayOrder } from './trusted-credit-fixture.js';
export const repayCommand = (key='first',revision=0,changes={}) => ({
  operationKey:key,expectedRevision:revision,action:'repay',
  payload:{order:'synthetic-credit-order',amount:20000,method:'微信',...changes}
});
export function seedTrustedRepay(state) {
  seedCreditReview(state,'synthetic-original-credit-applicant',104500);
  state.serial=1100;
  const order=creditOrder(state),credit=order.credit;
  order.status='已挂账';
  Object.assign(credit,{remaining:69500,decidedByPrincipalId:'synthetic-original-credit-decider',
    decisionBy:'Historical credit decider',decisionAt:'2026-01-01T13:00:00Z',decisionStatus:'已批准',selfReviewAuthorized:false});
  const payment={amount:35000,method:'支付宝',chargeId:'credit-repayment',time:'2026-01-02T12:00:00Z',
    person:'Historical collector',approvedBy:'Historical reviewer',repaymentRequestId:990};
  credit.repayments=[structuredClone(payment)];order.payments.push(structuredClone(payment));
  credit.repaymentRequests=[
    {id:990,amount:35000,method:'支付宝',status:'已批准',submittedBy:'Historical collector',submittedById:'legacy',submittedAt:'2026-01-02T11:00:00Z',decidedBy:'Historical reviewer',decidedAt:'2026-01-02T12:00:00Z',decisionNote:''},
    {id:991,amount:15000,method:'现金',status:'待审核',submittedBy:'Historical applicant',submittedById:'legacy',submittedAt:'2026-01-03T12:00:00Z',decidedBy:'',decidedAt:'',decisionNote:''},
    {id:992,amount:99999,method:'微信',status:'已驳回',submittedBy:'Historical applicant',submittedById:'legacy',submittedAt:'2026-01-03T13:00:00Z',decidedBy:'Historical reviewer',decidedAt:'2026-01-03T14:00:00Z',decisionNote:'Historical rejection'}
  ];
}
