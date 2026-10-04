import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact } from '../rules.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createPolicyAttributeService } from '../auth/policy-attributes.js';
import { repayCommand,repayOrder,seedTrustedRepay } from '../test-support/trusted-repay-fixture.js';
import { creditCommand,seedTrustedCredit } from '../test-support/trusted-credit-fixture.js';
import { creditReviewCommand } from '../test-support/trusted-credit-review-fixture.js';

const denied=e=>e instanceof AuthorizationDenied&&e.status==='authorization-denied';
const sqlAt=(run,name,clause)=>run.calls.findIndex(c=>c.kind==='sql'&&c.sql.includes(name)&&
 (clause.startsWith('FOR ')?c.sql.endsWith(clause):c.sql.startsWith(clause+' ')));
// Reuses the existing guarded fixture; owns no database/schema cleanup.
export async function testTrustedRepay({t,pool,setup,auth,table,provision,seed,inspect,application,assertUnchanged,wrapConnection,poolOptions,database}) {
 const runFor=(id,options={})=>application(id,{employeeBind:null,...options});
 const seedFor=(id,prepare=()=>{})=>seed(id,state=>{seedTrustedRepay(state);prepare(state);});
 const assertNoPayment=(actual,original)=>{
  const order=repayOrder(actual),before=repayOrder(original);
  assert.deepEqual(order.payments,before.payments);assert.deepEqual(order.credit.repayments,before.credit.repayments);
  assert.equal(order.credit.remaining,before.credit.remaining);assert.equal(order.credit.amount,before.credit.amount);assert.equal(order.status,before.status);
 };

 await t.test('repay: one connection atomically saves session applicant and pending request without changing payment or balance',async()=>{
  const login=await provision(['credit.repay']),id='repay-first',original=await seedFor(id),connection=await pool.getConnection();let borrows=0;
  const [[activity]]=await pool.execute('SELECT last_seen_at,idle_expires_at FROM '+table('auth_sessions')+' WHERE session_id=?',[login.sessionId]);
  try{
   const run=runFor(id,{connectionPool:{getConnection:async()=>{borrows++;return wrapConnection(connection,[],false);}}}),cmd=repayCommand();
   const result=await run.app.execute(cmd,login.credential),actual=await inspect(id),order=repayOrder(actual.head.state),row=order.credit.repaymentRequests.at(-1);
   assert.equal(result.status,'committed');assert.equal(result.actorId,login.principalId);assert.equal(actual.head.revision,1);
   assert.equal(row.id,1101);assert.equal(row.amount,20000);assert.equal(row.method,'微信');assert.equal(row.status,'待审核');
   assert.equal(row.submittedByPrincipalId,login.principalId);assert.equal(row.submittedBy,null);assert.equal(row.submittedById,'');assert.equal(row.submittedAt,run.context().dbNow);
   assert.equal(row.decidedBy,'');assert.equal(row.decidedAt,'');assert.equal(row.decisionNote,'');assertNoPayment(actual.head.state,original);
   const {repaymentRequests,...credit}=order.credit,{repaymentRequests:oldRequests,...oldCredit}=repayOrder(original).credit;assert.deepEqual(credit,oldCredit);
   assert.deepEqual(repaymentRequests.slice(0,-1),oldRequests);
   const {credit:newCredit,...rest}=order,{credit:priorCredit,...oldRest}=repayOrder(original);assert.deepEqual(rest,oldRest);
   for(const field of ['rooms','inventory','consumables','ledger','user','clock','permissions','capabilities','administrator'])assert.deepEqual(actual.head.state[field],original[field]);
   assert.deepEqual(actual.head.state.orders[0],original.orders[0]);assert.equal(actual.head.state.orders[0].room,null);
   assert.equal(actual.head.state.inventory.qd.count,null);assert.equal(actual.head.state.inventory.bw.count,0);
   assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);assert.equal(actual.operations[0].actor_principal_id,login.principalId);
   assert.deepEqual(actual.operations[0].terminal_result,result);assert.equal(actual.audit[0].actor_principal_id,login.principalId);assert.equal(actual.audit[0].action,'repay');
   const sequence=[run.calls.findIndex(c=>c.kind==='begin'),sqlAt(run,'ledger_heads','FOR UPDATE'),sqlAt(run,'auth_accounts','FOR UPDATE'),
    sqlAt(run,'auth_sessions','FOR UPDATE'),sqlAt(run,'auth_grants','FOR UPDATE'),sqlAt(run,'auth_policy_attributes','FOR UPDATE'),
    sqlAt(run,'AS db_now','SELECT'),sqlAt(run,'ledger_operations','SELECT'),run.calls.findIndex(c=>c.kind==='transact'),
    sqlAt(run,'ledger_heads','UPDATE'),sqlAt(run,'ledger_operations','INSERT'),sqlAt(run,'ledger_success_audit','INSERT'),run.calls.findIndex(c=>c.kind==='commit')];
   assert.ok(sequence.every(i=>i>=0));assert.deepEqual(sequence,[...sequence].sort((a,b)=>a-b));assert.equal(borrows,1);
   assert.equal(run.calls.filter(c=>c.kind==='db-now').length,1);assert.equal(run.calls.filter(c=>c.kind==='begin').length,1);assert.equal(run.calls.filter(c=>c.kind==='commit').length,1);
   assert.equal(run.context().policyAttributesConfigured,false);assert.equal(run.context().policyAttributeIds,null);assert.equal(sqlAt(run,'employees','FOR SHARE'),-1);
   const [[after]]=await pool.execute('SELECT last_seen_at,idle_expires_at FROM '+table('auth_sessions')+' WHERE session_id=?',[login.sessionId]);assert.deepEqual(after,activity);
  }finally{try{await connection.rollback();}finally{connection.release();}}
 });

 await t.test('repay: original amount/channel/request fields match demo; historical payment and snapshots are never rewritten',async()=>{
  const login=await provision(['credit.repay']);let index=0;
  for(const changes of [{amount:1,method:'现金'},{amount:54500,method:'支付宝'},{method:'美团'},{method:'抖音'}]){
   const id='repay-fields-'+(++index),original=await seedFor(id),run=runFor(id),cmd=repayCommand('fields',0,changes);await run.app.execute(cmd,login.credential);
   const actual=await inspect(id),row=repayOrder(actual.head.state).credit.repaymentRequests.at(-1);
   const demo=repayOrder(transact({...original,user:'boss',clock:run.context().dbNow},'repay',cmd.payload,'demo')).credit.repaymentRequests.at(-1);
   for(const field of ['id','amount','method','status','submittedAt','decidedBy','decidedAt','decisionNote'])assert.deepEqual(row[field],demo[field]);
   assert.equal(row.submittedByPrincipalId,login.principalId);assertNoPayment(actual.head.state,original);
   assert.deepEqual(repayOrder(actual.head.state).sales,repayOrder(original).sales);assert.deepEqual(actual.head.state.rooms,original.rooms);
  }
 });

 await t.test('repay: spoofed actor/applicant/role/grants/clock/status never override authenticated request facts',async()=>{
  const login=await provision(['credit.repay']),id='repay-forged',original=await seedFor(id,s=>{s.user='administrator';s.clock='1900-01-01';}),run=runFor(id);
  const cmd=repayCommand('forged',0,{actorId:'fake',principalId:'fake',actualActorPrincipalId:'fake',submittedByPrincipalId:'fake',submittedById:'administrator',
   submittedBy:'Fake Applicant',person:'Fake',role:'老板',permissions:['*'],clock:'1900-01-01',submittedAt:'1900-01-01',status:'已批准',remaining:0,decidedByPrincipalId:'fake'});
  await run.app.execute(cmd,login.credential);const actual=await inspect(id),row=repayOrder(actual.head.state).credit.repaymentRequests.at(-1);
  assert.equal(row.submittedByPrincipalId,login.principalId);assert.equal(row.submittedBy,null);assert.equal(row.submittedById,'');assert.equal(row.submittedAt,run.context().dbNow);
  assert.equal(row.status,'待审核');assert.equal(row.decidedBy,'');assert.equal(Object.hasOwn(row,'decidedByPrincipalId'),false);assertNoPayment(actual.head.state,original);
 });

 await t.test('repay: missing credit.repay denies without using key; granting it permits same request without creating payment',async()=>{
  let index=0;for(const permissions of [[],['backend.view','credit.repay.approve','review.self'],['credit.approve'],['payment.collect','payment.settle']]){
   const login=await provision(permissions),id='repay-denied-'+(++index),original=await seedFor(id),run=runFor(id),cmd=repayCommand('denied',0,{permissions:['credit.repay'],role:'老板'}),before=await inspect(id);
   await assert.rejects(run.app.execute(cmd,login.credential),e=>denied(e)&&e.reason==='missing-permission');await assertUnchanged(id,before);assert.equal(run.executions(),0);
   await auth.grantPermission({principalId:login.principalId,permissionId:'credit.repay'});assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');assertNoPayment((await inspect(id)).head.state,original);
  }
 });

 await t.test('repay: exact available balance is reserved by pending requests only, never confirmed as payment',async()=>{
  const login=await provision(['credit.repay']),id='repay-pending-balance',original=await seedFor(id),run=runFor(id);
  assert.equal((await run.app.execute(repayCommand('available',0,{amount:54500}),login.credential)).status,'committed');const before=await inspect(id);
  assert.equal(repayOrder(before.head.state).credit.repaymentRequests.at(-1).amount,54500);assertNoPayment(before.head.state,original);
  const result=await run.app.execute(repayCommand('over',1,{amount:1}),login.credential),after=await inspect(id);
  assert.equal(result.status,'business-rejected');assert.deepEqual(after.head,before.head);assert.equal(after.operations.length,2);assert.equal(after.audit.length,1);
 });

 await t.test('repay: enabled actor needs no employee mapping or policy attributes; approved legacy credit can create a new request',async()=>{
  const login=await provision(['credit.repay','staff.record']),id='repay-no-mapping',original=await seedFor(id,s=>{delete repayOrder(s).credit.submittedByPrincipalId;delete repayOrder(s).credit.repaymentRequests;}),run=runFor(id),before=await inspect(id);
  await assert.rejects(run.app.execute(repayCommand('employee',0,{creditedEmployeeId:'10000000-0000-4000-8000-000000000001'}),login.credential),e=>denied(e)&&e.reason==='invalid-attribution');await assertUnchanged(id,before);
  await run.app.execute(repayCommand('plain',0,{amount:69500,employee:'legacy',applicant:'credit-applicant'}),login.credential);
  const actual=await inspect(id),row=repayOrder(actual.head.state).credit.repaymentRequests[0];assert.equal(row.submittedByPrincipalId,login.principalId);
  assert.equal(repayOrder(actual.head.state).credit.repaymentRequests.length,1);assert.equal(Object.hasOwn(row,'creditedEmployeeId'),false);
  assert.equal(run.context().policyAttributesConfigured,false);assert.equal(sqlAt(run,'employees','FOR SHARE'),-1);assertNoPayment(actual.head.state,original);
 });

 await t.test('repay: revoke then reconnect retrieves original terminal; new key denied, regrant uses same previously unused key',async()=>{
  const login=await provision(['credit.repay']),id='repay-replay',original=await seedFor(id),run=runFor(id),cmd=repayCommand(),first=await run.app.execute(cmd,login.credential);
  await auth.revokePermission({principalId:login.principalId,permissionId:'credit.repay'});const before=await inspect(id),reconnect=mysql.createPool(poolOptions);
  try{
   const again=runFor(id,{connectionPool:reconnect,bind:createMySqlAuthStore({pool:reconnect,database}).bindSessionRevalidation,
    transactCommand:(...args)=>{if(args[3]==='first')assert.fail('Saved repay request executed twice');return transact(...args);}});
   assert.deepEqual(await again.app.execute(cmd,login.credential),first);assert.equal(again.executions(),0);await assertUnchanged(id,before);
   const fresh=repayCommand('fresh',1);await assert.rejects(again.app.execute(fresh,login.credential),denied);await assertUnchanged(id,before);
   await auth.grantPermission({principalId:login.principalId,permissionId:'credit.repay'});assert.equal((await again.app.execute(fresh,login.credential)).status,'committed');
   const actual=await inspect(id);assert.equal(actual.head.revision,2);assert.equal(actual.operations.length,2);assert.equal(actual.audit.length,2);assertNoPayment(actual.head.state,original);
   assert.deepEqual(await again.app.execute(cmd,login.credential),first);assert.equal(again.executions(),1);
  }finally{await reconnect.end();}
 });

 await t.test('repay: disabled/revoked/idle/absolute/version-invalid auth blocks saved result before lookup',async()=>{
  for(const invalid of ['disabled','revoked','idle','absolute','version']){
   const login=await provision(['credit.repay']),id='repay-auth-'+invalid;await seedFor(id);const run=runFor(id),cmd=repayCommand();await run.app.execute(cmd,login.credential);const before=await inspect(id);
   if(invalid==='disabled')await auth.disableAccount({principalId:login.principalId});else if(invalid==='revoked')await auth.logout(login.token);
   else if(invalid==='version')await auth.rotateCredential({principalId:login.principalId,password:'synthetic-repay-rotation'});
   else if(invalid==='idle')await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at WHERE session_id=?',[login.sessionId]);
   else await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at,absolute_expires_at=created_at+INTERVAL 1 MICROSECOND WHERE session_id=?',[login.sessionId]);
   run.calls.length=0;await assert.rejects(run.app.execute(cmd,login.credential),e=>e.code==='AUTHENTICATION_REQUIRED');assert.equal(sqlAt(run,'ledger_operations','SELECT'),-1);await assertUnchanged(id,before);
  }
 });

 await t.test('repay: actor, action, amount, method and expectedRevision conflicts retain Stage 1 semantics after revoke',async()=>{
  const login=await provision(['credit.repay']),other=await provision([]),id='repay-conflicts';await seedFor(id);const run=runFor(id),cmd=repayCommand();await run.app.execute(cmd,login.credential);
  await auth.revokePermission({principalId:login.principalId,permissionId:'credit.repay'});const before=await inspect(id);
  const actor=await run.app.execute(cmd,other.credential);assert.equal(actor.status,'idempotency-conflict');assert.equal(actor.reason,'actor-mismatch');
  for(const changed of [{...cmd,expectedRevision:1},{...cmd,action:'approveRepayment'},{...cmd,payload:{...cmd.payload,amount:20001}},{...cmd,payload:{...cmd.payload,method:'现金'}}]){
   const result=await run.app.execute(changed,login.credential);assert.equal(result.status,'idempotency-conflict');assert.equal(result.reason,'request-mismatch');
  }assert.equal(run.executions(),1);await assertUnchanged(id,before);
 });

 await t.test('repay: invalid business inputs stay terminal and leave no partial request, balance change or payment',async()=>{
  const login=await provision(['credit.repay']);let index=0;
  for(const c of [{amount:0},{amount:-1},{amount:1.5},{amount:'20000'},{amount:54501},{method:'invalid'},{order:'missing'},
   {status:'营业中'},{status:'待审批挂账'},{status:'已回款'},{zero:true}]){
   const id='repay-business-'+(++index),original=await seedFor(id,s=>{if(c.status)repayOrder(s).status=c.status;if(c.zero)repayOrder(s).credit.remaining=0;}),run=runFor(id),cmd=repayCommand('business',0,c);
   const result=await run.app.execute(cmd,login.credential),actual=await inspect(id);assert.equal(result.status,'business-rejected');assert.deepEqual(actual.head.state,original);
   assert.equal(actual.head.revision,0);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,0);
   await auth.revokePermission({principalId:login.principalId,permissionId:'credit.repay'});assert.deepEqual(await run.app.execute(cmd,login.credential),result);await assertUnchanged(id,actual);
   await auth.grantPermission({principalId:login.principalId,permissionId:'credit.repay'});
  }
 });

 await t.test('repay: stale revision terminal survives a later request and permission revoke',async()=>{
  const login=await provision(['credit.repay']),id='repay-stale';await seedFor(id);const run=runFor(id),cmd=repayCommand('stale',9),first=await run.app.execute(cmd,login.credential);
  assert.equal(first.status,'revision-conflict');assert.equal(run.executions(),0);await run.app.execute(repayCommand('valid'),login.credential);
  await auth.revokePermission({principalId:login.principalId,permissionId:'credit.repay'});const before=await inspect(id);assert.deepEqual(await run.app.execute(cmd,login.credential),first);await assertUnchanged(id,before);
 });

 for(const fault of ['unknown','sql'])await t.test('repay: '+fault+' failure rolls back request/state/revision/result/audit and original key can retry',async()=>{
  const login=await provision(['credit.repay']),id='repay-fault-'+fault;await seedFor(id);const before=await inspect(id);let broken=true;
  const run=runFor(id,{transactCommand:(...args)=>{const next=transact(...args);if(fault==='unknown'&&broken)throw Error('synthetic repay fault');return next;}}),cmd=repayCommand();
  if(fault==='sql')await setup.query('ALTER TABLE '+table('ledger_success_audit')+" ADD CONSTRAINT chk_repay_fault CHECK (ledger_id <> '"+id+"')");
  try{
   await assert.rejects(run.app.execute(cmd,login.credential),e=>fault==='unknown'?e.message==='synthetic repay fault':e.code==='ER_CHECK_CONSTRAINT_VIOLATED');
   assert.ok(run.calls.some(c=>c.kind==='rollback'));if(fault==='sql'){assert.ok(sqlAt(run,'ledger_heads','UPDATE')>=0);assert.ok(sqlAt(run,'ledger_operations','INSERT')>=0);}await assertUnchanged(id,before);
  }finally{if(fault==='sql')await setup.query('ALTER TABLE '+table('ledger_success_audit')+' DROP CHECK chk_repay_fault');}
  broken=false;assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');const actual=await inspect(id);
  assert.equal(actual.head.revision,1);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);assertNoPayment(actual.head.state,before.head.state);
 });

 for(const sameKey of [false,true])await t.test('repay: two independent connections '+(sameKey?'retry one key':'compete one old revision')+' without duplicate request or payment',async()=>{
  const login=await provision(['credit.repay']),id='repay-race-'+sameKey,original=await seedFor(id),a=await pool.getConnection(),b=await pool.getConnection();
  try{
   const [[aId]]=await a.query('SELECT CONNECTION_ID() AS id'),[[bId]]=await b.query('SELECT CONNECTION_ID() AS id');assert.notEqual(aId.id,bId.id);
   await a.query('SET SESSION innodb_lock_wait_timeout=5');await b.query('SET SESSION innodb_lock_wait_timeout=5');
   const first=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(a,[],false)}}),second=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(b,[],false)}});
   const results=await Promise.all([first.app.execute(repayCommand('a'),login.credential),second.app.execute(repayCommand(sameKey?'a':'b'),login.credential)]);
   if(sameKey)assert.deepEqual(results[0],results[1]);else assert.deepEqual(results.map(r=>r.status).sort(),['committed','revision-conflict']);
   assert.equal(first.executions()+second.executions(),1);const actual=await inspect(id);assert.equal(actual.head.revision,1);assert.equal(actual.operations.length,sameKey?1:2);assert.equal(actual.audit.length,1);
   assert.equal(repayOrder(actual.head.state).credit.repaymentRequests.length,4);assertNoPayment(actual.head.state,original);
   t.diagnostic('repay '+(sameKey?'same-key':'revision')+' race verified two independent CONNECTION_ID values');
  }finally{try{await a.rollback();await b.rollback();}finally{a.release();b.release();}}
 });

 await t.test('repay: creation cannot enable rounding, payment or other unmigrated commands',async()=>{
  const login=await provision(['credit.repay','credit.repay.approve','review.self','rounding.approve','payment.collect','payment.settle','incident.create',
   'incident.resolve','incident.resolve.approve','procurement.create','handover','room.open']),id='repay-closed';await seedFor(id);const run=runFor(id),before=await inspect(id);
  for(const action of ['approveRounding','rejectRounding','collect','settle','pay','resolveIncident',
   'approveIncidentResolution','rejectIncidentResolution','procurement','handover','open']){
   await assert.rejects(run.app.execute({...repayCommand(action),action},login.credential),e=>denied(e)&&e.reason==='trusted-action-not-enabled');await assertUnchanged(id,before);
  }
 });

 await t.test('repay: newly created and approved credit accepts a separate session applicant; request stays pending with no new payment',async()=>{
  const creator=await provision(['credit.apply']),reviewer=await provision(['credit.approve']),requester=await provision(['credit.repay']);
  const attributes=createPolicyAttributeService({store:createMySqlAuthStore({pool,database})});
  await attributes.configurePolicyAttributes({principalId:reviewer.principalId},{actorPrincipalId:reviewer.principalId});
  await attributes.grantPolicyAttribute({principalId:reviewer.principalId,attributeId:'credit.approval.boss'},{actorPrincipalId:reviewer.principalId});
  const id='repay-live-credit';await seed(id,state=>seedTrustedCredit(state));const run=runFor(id);
  await run.app.execute(creditCommand('credit-create'),creator.credential);await run.app.execute(creditReviewCommand('approve','credit-decision',1),reviewer.credential);
  const before=await inspect(id),result=await run.app.execute(repayCommand('repay-create',2),requester.credential),actual=await inspect(id),row=repayOrder(actual.head.state).credit.repaymentRequests.at(-1);
  assert.equal(result.status,'committed');assert.equal(row.submittedByPrincipalId,requester.principalId);assert.notEqual(row.submittedByPrincipalId,creator.principalId);
  assert.notEqual(row.submittedByPrincipalId,reviewer.principalId);assert.equal(row.submittedAt,run.context().dbNow);assert.equal(row.status,'待审核');
  assert.equal(row.amount,20000);assert.equal(actual.head.revision,3);assert.equal(actual.operations.length,3);assert.equal(actual.audit.length,3);
  assertNoPayment(actual.head.state,before.head.state);assert.equal(repayOrder(actual.head.state).credit.repaymentRequests.length,1);
 });
}
