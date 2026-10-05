import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact } from '../rules.js';
import { collected } from '../sales.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { REPAYMENT_REVIEW_ACTIONS, repaymentReviewCommand, seedRepaymentReview, repayOrder, repaymentRequest } from '../test-support/trusted-repayment-review-fixture.js';
import { repayCommand } from '../test-support/trusted-repay-fixture.js';

const denied=e=>e instanceof AuthorizationDenied&&e.status==='authorization-denied';
const sqlAt=(run,name,clause)=>run.calls.findIndex(c=>c.kind==='sql'&&c.sql.includes(name)&&
 (clause.startsWith('FOR ')?c.sql.endsWith(clause):c.sql.startsWith(clause+' ')));
function addSecond(state){const request=structuredClone(repaymentRequest(state));request.id=1111;request.amount=10000;repayOrder(state).credit.repaymentRequests.push(request);}
// Uses only the shared guarded eleven-table fixture; owns no DDL/cleanup scope.
export async function testTrustedRepaymentReviews({t,pool,setup,auth,table,provision,seed,inspect,application,assertUnchanged,wrapConnection,poolOptions,database}){
 const runFor=(id,options={})=>application(id,{employeeBind:null,...options});
 const seedFor=(id,prepare=()=>{},applicant='synthetic-repayment-applicant')=>seed(id,state=>{seedRepaymentReview(state,applicant);prepare(state);});
 function money(actual,original,action,actor){
  const order=repayOrder(actual),before=repayOrder(original),request=repaymentRequest(actual),prior=repaymentRequest(original),approved=action==='approveRepayment';
  assert.equal(request.status,approved?'已批准':'已驳回');assert.equal(request.decidedByPrincipalId,actor);assert.equal(request.decidedBy,null);
  assert.equal(request.amount,prior.amount);assert.equal(request.method,prior.method);assert.equal(request.submittedByPrincipalId,prior.submittedByPrincipalId);
  assert.equal(order.credit.remaining,before.credit.remaining-(approved?prior.amount:0));
  assert.equal(order.status,approved&&order.credit.remaining===0?'已回款':before.status);
  assert.equal(order.payments.length,before.payments.length+(approved?1:0));assert.equal(order.credit.repayments.length,before.credit.repayments.length+(approved?1:0));
  assert.deepEqual(order.payments.slice(0,before.payments.length),before.payments);assert.deepEqual(order.credit.repayments.slice(0,before.credit.repayments.length),before.credit.repayments);
  assert.equal(collected(actual)-collected(original),approved?prior.amount:0);
  if(approved){const payment=order.payments.at(-1),{paymentId,occurredAt,recordedByPrincipalId,...compatible}=payment;
   assert.match(paymentId,/^[0-9a-f-]{36}$/);assert.equal(occurredAt,request.decidedAt);assert.equal(recordedByPrincipalId,actor);assert.deepEqual(compatible,{amount:prior.amount,method:prior.method,chargeId:'credit-repayment',time:request.decidedAt,
   person:prior.submittedBy,approvedBy:null,repaymentRequestId:prior.id,approvedByPrincipalId:actor});assert.deepEqual(order.credit.repayments.at(-1),payment);}
 }

 for(const action of REPAYMENT_REVIEW_ACTIONS){
  await t.test('repayment '+action+': one connection commits request/payment/balance/result/audit using session actor and frozen DB time',async()=>{
   const login=await provision(['credit.repay.approve']),id='rr-first-'+action,original=await seedFor(id),connection=await pool.getConnection();let borrows=0;
   const [[activity]]=await pool.execute('SELECT last_seen_at,idle_expires_at FROM '+table('auth_sessions')+' WHERE session_id=?',[login.sessionId]);
   try{
    const run=runFor(id,{connectionPool:{getConnection:async()=>{borrows++;return wrapConnection(connection,[],false);}}}),cmd=repaymentReviewCommand(action),result=await run.app.execute(cmd,login.credential),actual=await inspect(id);
    assert.equal(result.status,'committed');assert.equal(result.actorId,login.principalId);assert.equal(actual.head.revision,1);assert.equal(repaymentRequest(actual.head.state).decidedAt,run.context().dbNow);
    assert.equal(repaymentRequest(actual.head.state).selfReviewAuthorized,false);assert.equal(repaymentRequest(actual.head.state).decisionNote,'Synthetic decision note');money(actual.head.state,original,action,login.principalId);
    const order=repayOrder(actual.head.state),before=repayOrder(original);
    assert.deepEqual(order.credit.repaymentRequests.filter(r=>r.id!==991),before.credit.repaymentRequests.filter(r=>r.id!==991));
    for(const field of ['amount','name','phone','note','person','submittedByPrincipalId','approver','submittedAt','due','decidedByPrincipalId','decisionBy','decisionAt'])assert.deepEqual(order.credit[field],before.credit[field]);
    for(const field of ['sales','otherCharges','creditHistory','time','openedBy','reservedBy'])assert.deepEqual(order[field],before[field]);
    for(const field of ['rooms','inventory','consumables','ledger','serial','user','clock','permissions','capabilities','administrator'])assert.deepEqual(actual.head.state[field],original[field]);
    assert.deepEqual(actual.head.state.orders[0],original.orders[0]);assert.equal(actual.head.state.orders[0].room,null);assert.equal(actual.head.state.inventory.qd.count,null);assert.equal(actual.head.state.inventory.bw.count,0);
    assert.equal(actual.operations.length,1);assert.deepEqual(actual.operations[0].terminal_result,result);assert.equal(actual.operations[0].actor_principal_id,login.principalId);
    assert.equal(actual.audit.length,1);assert.equal(actual.audit[0].actor_principal_id,login.principalId);assert.equal(actual.audit[0].action,action);
    const sequence=[run.calls.findIndex(c=>c.kind==='begin'),sqlAt(run,'ledger_heads','FOR UPDATE'),sqlAt(run,'auth_accounts','FOR UPDATE'),sqlAt(run,'auth_sessions','FOR UPDATE'),
     sqlAt(run,'auth_grants','FOR UPDATE'),sqlAt(run,'auth_policy_attributes','FOR UPDATE'),sqlAt(run,'AS db_now','SELECT'),sqlAt(run,'ledger_operations','SELECT'),run.calls.findIndex(c=>c.kind==='transact'),
     sqlAt(run,'ledger_heads','UPDATE'),sqlAt(run,'ledger_operations','INSERT'),sqlAt(run,'ledger_success_audit','INSERT'),run.calls.findIndex(c=>c.kind==='commit')];
    assert.ok(sequence.every(i=>i>=0));assert.deepEqual(sequence,[...sequence].sort((a,b)=>a-b));assert.equal(borrows,1);assert.equal(run.calls.filter(c=>c.kind==='db-now').length,1);
    assert.equal(run.calls.filter(c=>c.kind==='begin').length,1);assert.equal(run.calls.filter(c=>c.kind==='commit').length,1);assert.equal(sqlAt(run,'employees','FOR SHARE'),-1);
    assert.equal(run.context().policyAttributesConfigured,false);assert.equal(run.context().policyAttributeIds,null);
    const [[after]]=await pool.execute('SELECT last_seen_at,idle_expires_at FROM '+table('auth_sessions')+' WHERE session_id=?',[login.sessionId]);assert.deepEqual(after,activity);
   }finally{try{await connection.rollback();}finally{connection.release();}}
  });

  await t.test('repayment '+action+': self-review uses current request, requires both permissions and never follows original credit actor',async()=>{
   const reviewer=await provision(['credit.repay.approve']),id='rr-self-'+action,original=await seedFor(id,s=>{repayOrder(s).credit.submittedByPrincipalId='another-credit-creator';},reviewer.principalId),run=runFor(id),cmd=repaymentReviewCommand(action,'self'),before=await inspect(id);
   await assert.rejects(run.app.execute(cmd,reviewer.credential),e=>denied(e)&&e.reason==='missing-permission');await assertUnchanged(id,before);
   await auth.grantPermission({principalId:reviewer.principalId,permissionId:'review.self'});await run.app.execute(cmd,reviewer.credential);const actual=await inspect(id);
   assert.equal(repaymentRequest(actual.head.state).selfReviewAuthorized,true);money(actual.head.state,original,action,reviewer.principalId);
   const nonSelf=await provision(['credit.repay.approve']),otherId='rr-credit-actor-'+action;
   await seedFor(otherId,s=>{repayOrder(s).credit.submittedByPrincipalId=nonSelf.principalId;repaymentRequest(s).submittedById=nonSelf.principalId;
    repayOrder(s).credit.repaymentRequests[0].submittedByPrincipalId=nonSelf.principalId;});
   const other=runFor(otherId);await other.app.execute(repaymentReviewCommand(action),nonSelf.credential);assert.equal(repaymentRequest((await inspect(otherId)).head.state).selfReviewAuthorized,false);
   const onlySelf=await provision(['review.self']),selfOnlyId='rr-self-only-'+action;await seedFor(selfOnlyId,()=>{},onlySelf.principalId);const selfBefore=await inspect(selfOnlyId);
   await assert.rejects(runFor(selfOnlyId).app.execute(cmd,onlySelf.credential),denied);await assertUnchanged(selfOnlyId,selfBefore);
  });

  await t.test('repayment '+action+': legacy request applicant cannot be inferred from payload, names, old IDs or credit principal',async()=>{
   const login=await provision(['credit.repay.approve','review.self']);let index=0;
   for(const applicant of [undefined,null,'',' whitespace ','x'.repeat(192),123]){
    const id='rr-legacy-'+action+'-'+(++index);await seedFor(id,s=>{if(applicant===undefined)delete repaymentRequest(s).submittedByPrincipalId;else repaymentRequest(s).submittedByPrincipalId=applicant;repayOrder(s).credit.submittedByPrincipalId=login.principalId;});
    const before=await inspect(id),run=runFor(id);await assert.rejects(run.app.execute(repaymentReviewCommand(action,'legacy',0,{submittedByPrincipalId:'fake',applicant:'fake',selfReview:false}),login.credential),e=>denied(e)&&e.reason==='untrusted-repayment-applicant');await assertUnchanged(id,before);
   }
  });

  await t.test('repayment '+action+': spoofed identity/grants/amount/method/clock have no effect; denied key succeeds after real grant',async()=>{
   const login=await provision([]),id='rr-forged-'+action,original=await seedFor(id),run=runFor(id),before=await inspect(id);
   const cmd=repaymentReviewCommand(action,'forged',0,{actorId:'fake',principalId:'fake',submittedByPrincipalId:'fake',applicant:'fake',selfReview:false,
    approver:'fake',decidedByPrincipalId:'fake',approvedByPrincipalId:'fake',role:'老板',permissions:['*'],clock:'1900-01-01',time:'1900-01-01',amount:999999,method:'invalid'});
   await assert.rejects(run.app.execute(cmd,login.credential),denied);await assertUnchanged(id,before);assert.equal(run.executions(),0);
   await auth.grantPermission({principalId:login.principalId,permissionId:'credit.repay.approve'});const result=await run.app.execute(cmd,login.credential),actual=await inspect(id);
   assert.equal(result.actorId,login.principalId);money(actual.head.state,original,action,login.principalId);assert.equal(repaymentRequest(actual.head.state).decidedAt,run.context().dbNow);
   assert.equal(repaymentRequest(actual.head.state).selfReviewAuthorized,false);
  });

  await t.test('repayment '+action+': revoke approve or review.self then reconnect replays terminal without repeated money; new key uses current grants',async()=>{
   for(const permission of ['credit.repay.approve','review.self']){
    const login=await provision(['credit.repay.approve','review.self']),id='rr-replay-'+action+'-'+permission;await seedFor(id,addSecond,login.principalId);
    const run=runFor(id),cmd=repaymentReviewCommand(action),first=await run.app.execute(cmd,login.credential);await auth.revokePermission({principalId:login.principalId,permissionId:permission});
    const before=await inspect(id),reconnect=mysql.createPool(poolOptions);
    try{
     const again=runFor(id,{connectionPool:reconnect,bind:createMySqlAuthStore({pool:reconnect,database}).bindSessionRevalidation,
      transactCommand:(...args)=>{if(args[3]==='decision')assert.fail('Saved repayment decision executed twice');return transact(...args);}});
     assert.deepEqual(await again.app.execute(cmd,login.credential),first);assert.equal(again.executions(),0);await assertUnchanged(id,before);
     const next=repaymentReviewCommand(action,'next',1,{request:1111});await assert.rejects(again.app.execute(next,login.credential),denied);await assertUnchanged(id,before);
     await auth.grantPermission({principalId:login.principalId,permissionId:permission});await again.app.execute(next,login.credential);const after=await inspect(id);
     assert.equal(after.head.revision,2);assert.equal(after.operations.length,2);assert.equal(after.audit.length,2);assert.equal(repayOrder(after.head.state).credit.remaining,action==='approveRepayment'?44500:69500);
     assert.equal(repayOrder(after.head.state).payments.length,repayOrder(before.head.state).payments.length+(action==='approveRepayment'?1:0));
     const executionsBeforeReplay=again.executions();assert.deepEqual(await again.app.execute(cmd,login.credential),first);assert.equal(again.executions(),executionsBeforeReplay);
    }finally{await reconnect.end();}
   }
  });

  for(const fault of ['unknown','sql'])await t.test('repayment '+action+': '+fault+' failure rolls back request/payment/balance/history/revision/result/audit; original key can retry',async()=>{
   const login=await provision(['credit.repay.approve']),id='rr-fault-'+action+'-'+fault;await seedFor(id);const before=await inspect(id);let broken=true;
   const run=runFor(id,{transactCommand:(...args)=>{const next=transact(...args);if(fault==='unknown'&&broken)throw Error('synthetic repayment review fault');return next;}}),cmd=repaymentReviewCommand(action);
   if(fault==='sql')await setup.query('ALTER TABLE '+table('ledger_success_audit')+" ADD CONSTRAINT chk_repayment_decision_fault CHECK (ledger_id <> '"+id+"')");
   try{
    await assert.rejects(run.app.execute(cmd,login.credential),e=>fault==='unknown'?e.message==='synthetic repayment review fault':e.code==='ER_CHECK_CONSTRAINT_VIOLATED');
    assert.ok(run.calls.some(c=>c.kind==='rollback'));if(fault==='sql'){assert.ok(sqlAt(run,'ledger_heads','UPDATE')>=0);assert.ok(sqlAt(run,'ledger_operations','INSERT')>=0);}await assertUnchanged(id,before);
   }finally{if(fault==='sql')await setup.query('ALTER TABLE '+table('ledger_success_audit')+' DROP CHECK chk_repayment_decision_fault');}
   broken=false;assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');const actual=await inspect(id);
   assert.equal(actual.head.revision,1);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);money(actual.head.state,before.head.state,action,login.principalId);
  });

  await t.test('repayment '+action+': two independent connections replay one key and produce one decision/one possible payment',async()=>{
   const login=await provision(['credit.repay.approve']),id='rr-same-key-'+action,original=await seedFor(id),a=await pool.getConnection(),b=await pool.getConnection();
   try{
    const [[aId]]=await a.query('SELECT CONNECTION_ID() AS id'),[[bId]]=await b.query('SELECT CONNECTION_ID() AS id');assert.notEqual(aId.id,bId.id);
    await a.query('SET SESSION innodb_lock_wait_timeout=5');await b.query('SET SESSION innodb_lock_wait_timeout=5');
    const first=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(a,[],false)}}),second=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(b,[],false)}}),cmd=repaymentReviewCommand(action);
    const results=await Promise.all([first.app.execute(cmd,login.credential),second.app.execute(cmd,login.credential)]);assert.deepEqual(results[0],results[1]);assert.equal(first.executions()+second.executions(),1);
    const actual=await inspect(id);assert.equal(actual.head.revision,1);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);money(actual.head.state,original,action,login.principalId);
    t.diagnostic('repayment '+action+' same-key race verified two independent CONNECTION_ID values');
   }finally{try{await a.rollback();await b.rollback();}finally{a.release();b.release();}}
  });
 }

 for(const secondAction of ['approveRepayment','rejectRepayment'])await t.test('repayment competition: approve/'+secondAction+' different keys and actors on two independent connections commit at most one funds effect',async()=>{
  const firstLogin=await provision(['credit.repay.approve']),secondLogin=await provision(['credit.repay.approve']),id='rr-revision-'+secondAction,original=await seedFor(id),a=await pool.getConnection(),b=await pool.getConnection();
  try{
   const [[aId]]=await a.query('SELECT CONNECTION_ID() AS id'),[[bId]]=await b.query('SELECT CONNECTION_ID() AS id');assert.notEqual(aId.id,bId.id);assert.notEqual(firstLogin.principalId,secondLogin.principalId);
   await a.query('SET SESSION innodb_lock_wait_timeout=5');await b.query('SET SESSION innodb_lock_wait_timeout=5');
   const first=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(a,[],false)}}),second=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(b,[],false)}});
   const results=await Promise.all([first.app.execute(repaymentReviewCommand('approveRepayment','a'),firstLogin.credential),second.app.execute(repaymentReviewCommand(secondAction,'b'),secondLogin.credential)]);
   assert.deepEqual(results.map(r=>r.status).sort(),['committed','revision-conflict']);assert.equal(first.executions()+second.executions(),1);const winner=results.find(r=>r.status==='committed'),actual=await inspect(id);
   assert.equal(actual.head.revision,1);assert.equal(actual.operations.length,2);assert.equal(actual.audit.length,1);const decidedAction=repaymentRequest(actual.head.state).status==='已批准'?'approveRepayment':'rejectRepayment';
   money(actual.head.state,original,decidedAction,winner.actorId);if(secondAction==='approveRepayment')assert.equal(decidedAction,'approveRepayment');
   const handled=await runFor(id).app.execute(repaymentReviewCommand('approveRepayment','handled',1),firstLogin.credential);assert.equal(handled.status,'business-rejected');const after=await inspect(id);
   assert.deepEqual(after.head,actual.head);assert.deepEqual(after.audit,actual.audit);assert.equal(after.operations.length,3);
   t.diagnostic('repayment approve/'+secondAction+' race verified two independent CONNECTION_ID values and two session principals');
  }finally{try{await a.rollback();await b.rollback();}finally{a.release();b.release();}}
 });

 await t.test('repayment decisions: disabled/revoked/idle/absolute/version-invalid auth cannot read saved decision',async()=>{
  for(const action of REPAYMENT_REVIEW_ACTIONS)for(const invalid of ['disabled','revoked','idle','absolute','version']){
   const login=await provision(['credit.repay.approve']),id='rr-auth-'+action+'-'+invalid;await seedFor(id);const run=runFor(id),cmd=repaymentReviewCommand(action);await run.app.execute(cmd,login.credential);const before=await inspect(id);
   if(invalid==='disabled')await auth.disableAccount({principalId:login.principalId});else if(invalid==='revoked')await auth.logout(login.token);
   else if(invalid==='version')await auth.rotateCredential({principalId:login.principalId,password:'synthetic-repayment-review-rotation'});
   else if(invalid==='idle')await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at WHERE session_id=?',[login.sessionId]);
   else await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at,absolute_expires_at=created_at+INTERVAL 1 MICROSECOND WHERE session_id=?',[login.sessionId]);
   run.calls.length=0;await assert.rejects(run.app.execute(cmd,login.credential),e=>e.code==='AUTHENTICATION_REQUIRED');assert.equal(sqlAt(run,'ledger_operations','SELECT'),-1);await assertUnchanged(id,before);
  }
 });

 await t.test('repayment decisions: actor/action/request/note/expectedRevision conflicts preserve the first result after revoke',async()=>{
  for(const action of REPAYMENT_REVIEW_ACTIONS){const login=await provision(['credit.repay.approve']),other=await provision([]),id='rr-conflict-'+action;await seedFor(id);
   const run=runFor(id),cmd=repaymentReviewCommand(action);await run.app.execute(cmd,login.credential);await auth.revokePermission({principalId:login.principalId,permissionId:'credit.repay.approve'});const before=await inspect(id);
   const actor=await run.app.execute(cmd,other.credential);assert.equal(actor.status,'idempotency-conflict');assert.equal(actor.reason,'actor-mismatch');
   for(const changed of [{...cmd,expectedRevision:1},{...cmd,action:action==='approveRepayment'?'rejectRepayment':'approveRepayment'},
    {...cmd,payload:{...cmd.payload,request:992}},{...cmd,payload:{...cmd.payload,decisionNote:'new note'}},{...cmd,payload:{...cmd.payload,submittedByPrincipalId:'fake'}}]){
    const result=await run.app.execute(changed,login.credential);assert.equal(result.status,'idempotency-conflict');assert.equal(result.reason,'request-mismatch');
   }assert.equal(run.executions(),1);await assertUnchanged(id,before);
  }
 });

 await t.test('repayment decisions: handled/missing requests, empty reject reason and changed balance remain terminal business failures without money',async()=>{
  const login=await provision(['credit.repay.approve']);let index=0;
  for(const c of [{order:'missing'},{request:9999},{handled:true},{creditMissing:true},{action:'rejectRepayment',decisionNote:''},{remaining:10000},{status:'营业中'},{status:'已回款'}]){
   const id='rr-business-'+(++index);await seedFor(id,s=>{if(c.handled)repaymentRequest(s).status='已批准';if(c.remaining!==undefined)repayOrder(s).credit.remaining=c.remaining;if(c.status)repayOrder(s).status=c.status;if(c.creditMissing)repayOrder(s).credit=null;});
   const run=runFor(id),before=await inspect(id),cmd=repaymentReviewCommand(c.action??'approveRepayment','business',0,c),result=await run.app.execute(cmd,login.credential),after=await inspect(id);
   assert.equal(result.status,'business-rejected');assert.deepEqual(after.head,before.head);assert.deepEqual(after.audit,before.audit);assert.equal(after.operations.length,1);
   await auth.revokePermission({principalId:login.principalId,permissionId:'credit.repay.approve'});assert.deepEqual(await run.app.execute(cmd,login.credential),result);await assertUnchanged(id,after);
   await auth.grantPermission({principalId:login.principalId,permissionId:'credit.repay.approve'});
  }
 });

 await t.test('repayment approval: whole remaining closes credit with trusted occurredAt and compatible original time',async()=>{
  const login=await provision(['credit.repay.approve']),id='rr-whole',original=await seedFor(id,s=>{repaymentRequest(s).amount=69500;repaymentRequest(s).method='支付宝';}),run=runFor(id),cmd=repaymentReviewCommand();
  const first=await run.app.execute(cmd,login.credential),actual=await inspect(id);money(actual.head.state,original,'approveRepayment',login.principalId);
  assert.equal(repayOrder(actual.head.state).status,'已回款');assert.equal(repayOrder(actual.head.state).credit.remaining,0);assert.equal(repayOrder(actual.head.state).time,repayOrder(original).time);
  assert.equal(repayOrder(actual.head.state).payments.at(-1).time,run.context().dbNow);assert.equal(repayOrder(actual.head.state).payments.at(-1).occurredAt,run.context().dbNow);
  assert.deepEqual(await run.app.execute(cmd,login.credential),first);await assertUnchanged(id,actual);
 });

 await t.test('repayment decisions: stale revision terminal survives a later decision and permission revoke',async()=>{
  for(const action of REPAYMENT_REVIEW_ACTIONS){const login=await provision(['credit.repay.approve']),id='rr-stale-'+action;await seedFor(id);const run=runFor(id),cmd=repaymentReviewCommand(action,'stale',9),first=await run.app.execute(cmd,login.credential);
   assert.equal(first.status,'revision-conflict');assert.equal(run.executions(),0);await run.app.execute(repaymentReviewCommand(action,'valid'),login.credential);
   await auth.revokePermission({principalId:login.principalId,permissionId:'credit.repay.approve'});const before=await inspect(id);assert.deepEqual(await run.app.execute(cmd,login.credential),first);await assertUnchanged(id,before);
  }
 });

 await t.test('repayment live chain: session request creator differs from original credit actor; independent reviewer approves exactly one new payment',async()=>{
  const creator=await provision(['credit.repay']),reviewer=await provision(['credit.repay.approve']),id='rr-live-request';await seedFor(id,s=>{repayOrder(s).credit.submittedByPrincipalId=reviewer.principalId;});
  const run=runFor(id);await run.app.execute(repayCommand('create'),creator.credential);const before=await inspect(id),request=repayOrder(before.head.state).credit.repaymentRequests.at(-1);
  assert.equal(request.submittedByPrincipalId,creator.principalId);const cmd=repaymentReviewCommand('approveRepayment','approve',1,{request:request.id});await run.app.execute(cmd,reviewer.credential);
  const actual=await inspect(id),order=repayOrder(actual.head.state),decided=order.credit.repaymentRequests.at(-1),payment=order.payments.at(-1);
  assert.equal(actual.head.revision,2);assert.equal(actual.operations.length,2);assert.equal(actual.audit.length,2);assert.equal(decided.decidedByPrincipalId,reviewer.principalId);
  assert.equal(decided.submittedByPrincipalId,creator.principalId);assert.equal(decided.selfReviewAuthorized,false);assert.equal(decided.status,'已批准');
  assert.equal(payment.approvedByPrincipalId,reviewer.principalId);assert.equal(payment.person,null);assert.equal(payment.approvedBy,null);assert.equal(payment.repaymentRequestId,request.id);
  assert.equal(payment.amount,20000);assert.equal(order.credit.remaining,49500);assert.equal(order.payments.length,repayOrder(before.head.state).payments.length+1);
  const saved=await inspect(id);assert.deepEqual(await run.app.execute(cmd,reviewer.credential),saved.operations.find(r=>r.operation_key==='approve').terminal_result);await assertUnchanged(id,saved);
 });

 await t.test('repayment decisions: review grants cannot enable remaining rounding, open or handover actions',async()=>{
  const login=await provision(['credit.repay.approve','review.self','rounding.approve','payment.collect','payment.settle','incident.create','incident.resolve','incident.resolve.approve','procurement.create','handover','room.open']),id='rr-closed';await seedFor(id);const run=runFor(id),before=await inspect(id);
  for(const action of [ 'open']){
   await assert.rejects(run.app.execute({...repaymentReviewCommand(action),action},login.credential),e=>denied(e)&&e.reason==='trusted-action-not-enabled');await assertUnchanged(id,before);
  }
 });
}
