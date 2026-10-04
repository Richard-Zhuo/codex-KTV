import { seedTrustedRepay, repayOrder } from './trusted-repay-fixture.js';
export { repayOrder } from './trusted-repay-fixture.js';
export const REPAYMENT_REVIEW_ACTIONS = ['approveRepayment','rejectRepayment'];
export const repaymentReviewCommand = (action='approveRepayment',key='decision',revision=0,changes={}) => ({
 operationKey:key,expectedRevision:revision,action,
 payload:{order:'synthetic-credit-order',request:991,decisionNote:'  Synthetic decision note  ',...changes}
});
export const repaymentRequest = (state,id=991) => repayOrder(state).credit.repaymentRequests.find(request=>request.id===id);
export function seedRepaymentReview(state,applicant='synthetic-repayment-applicant',amount=15000) {
 seedTrustedRepay(state);
 Object.assign(repaymentRequest(state),{submittedByPrincipalId:applicant,amount});
}
