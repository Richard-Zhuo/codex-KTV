import test from 'node:test';
import assert from 'node:assert/strict';
import {projectEmployeeWorkspace} from './staff-query.js';
import {financialFixture,ownerId,applicantId,reviewerId,orderId,paymentId} from '../test-support/financial-adjustments-fixture.js';
import {createTrustedPrincipal} from '../ledger/command-policy.js';
import {registerTrustedExecutionContext} from '../shared/identity.js';
const context=(id,permissionIds)=>{const principal=createTrustedPrincipal({id,permissionIds});return registerTrustedExecutionContext(Object.freeze({
 mode:'trusted',principalId:id,principal,permissionIds:principal.permissionIds,policyAttributesConfigured:false,policyAttributeIds:null,sessionId:id,dbNow:'2026-10-19T12:00:00.000000Z'}));};
async function source(){
 const f=financialFixture();const result=await f.execute({action:'refundPayment',operationKey:'identity-request',expectedRevision:0,
 payload:{order:orderId,originalPaymentId:paymentId,amount:1000,reason:'Identity display',refundChannel:'\u5fae\u4fe1',refundFundingSource:'NON_CASH'}},applicantId);
 assert.equal(result.status,'committed');return (await f.memory.read()).state;
}
const employees=[{employeeId:'employee-a',principalId:applicantId,displayName:'\u540c\u540d\u5458\u5de5',enabled:true},
 {employeeId:'employee-b',principalId:reviewerId,displayName:'\u540c\u540d\u5458\u5de5',enabled:true},
 {employeeId:'employee-c',principalId:ownerId,displayName:'Never expose roster C',enabled:true}];
test('C3-B identity: eligible reviewer sees only request applicant display name without roster permission',async()=>{
 const state=await source(),before=structuredClone(state),view=projectEmployeeWorkspace(state,context(reviewerId,['financial.approve']),{employees});
 assert.equal(view.financial.requests[0].submittedByDisplayName,'\u540c\u540d\u5458\u5de5');assert.equal(view.financial.requests[0].canApprove,true);
 assert.equal(view.employees,undefined);assert.doesNotMatch(JSON.stringify(view),/Never expose roster C/);assert.deepEqual(state,before);
});
test('C3-B identity: equal names never confer self-review or cross-principal visibility',async()=>{
 const state=await source(),self=projectEmployeeWorkspace(state,context(applicantId,['payment.refund','financial.approve','review.self']),{employees});
 assert.equal(self.financial.requests[0].canApprove,false);
 assert.equal(projectEmployeeWorkspace(state,context(ownerId,[]),{employees}),null);
 assert.equal(projectEmployeeWorkspace(state,context(reviewerId,[]),{employees}),null);
});
test('C3-B identity: missing, disabled or ambiguous trusted mapping stays null',async()=>{
 const state=await source();
 for(const rows of [[],[{...employees[0],enabled:false}],[employees[0],{...employees[0],employeeId:'duplicate',displayName:'Do not guess'}]]){
  const view=projectEmployeeWorkspace(state,context(reviewerId,['financial.approve']),{employees:rows});
  assert.equal(view.financial.requests[0].submittedByDisplayName,null);
 }
});
