import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact } from '../rules.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { creditCommand,creditOrder,seedTrustedCredit } from '../test-support/trusted-credit-fixture.js';

const denied=e=>e instanceof AuthorizationDenied&&e.status==='authorization-denied';
const sqlAt=(run,name,clause)=>run.calls.findIndex(c=>c.kind==='sql'&&c.sql.includes(name)&&
 (clause.startsWith('FOR ')?c.sql.endsWith(clause):c.sql.startsWith(clause+' ')));

// Shares the existing guarded test database fixture; owns no DDL or cleanup.
export async function testTrustedCredit({t,pool,setup,auth,table,provision,seed,inspect,application,assertUnchanged,wrapConnection,poolOptions,database}) {
 const runFor=(id,options={})=>application(id,{employeeBind:null,...options});
 const seedFor=(id,prepare=()=>{})=>seed(id,state=>{seedTrustedCredit(state);prepare(state);});

 await t.test('credit: one connection commits session applicant, frozen deadline and room release with state/result/audit',async()=>{
  const login=await provision(['credit.apply']),id='credit-first',original=await seedFor(id),connection=await pool.getConnection();let borrows=0;
  const [[activity]]=await pool.execute('SELECT last_seen_at,idle_expires_at FROM '+table('auth_sessions')+' WHERE session_id=?',[login.sessionId]);
  try {
   const run=runFor(id,{connectionPool:{getConnection:async()=>{borrows++;return wrapConnection(connection,[],false);}}});
   const cmd=creditCommand('first',0,{actorId:'fake',principalId:'fake',actualActorPrincipalId:'fake',person:'Fake Applicant',submittedBy:'Fake',
    submittedById:'administrator',submittedByPrincipalId:'fake',permissions:['*'],role:'老板',clock:'1900-01-01',amount:1,remaining:1,due:'1900-01-01',approver:'fake',policyAttributeIds:['expense.approval.boss']});
   const result=await run.app.execute(cmd,login.credential),actual=await inspect(id),order=creditOrder(actual.head.state),row=order.credit;
   assert.equal(result.status,'committed');assert.equal(result.actorId,login.principalId);assert.equal(actual.head.revision,1);
   assert.equal(row.submittedByPrincipalId,login.principalId);assert.equal(row.submittedById,'');assert.equal(row.person,null);
   assert.equal(row.amount,104500);assert.equal(row.remaining,104500);assert.equal(row.submittedAt,run.context().dbNow);assert.equal(Date.parse(row.due)-Date.parse(run.context().dbNow),86400000);
   assert.equal(row.approver,'老板');assert.equal(order.status,'待审批挂账');assert.equal(actual.head.state.rooms[0].status,'待清洁');assert.equal(actual.head.state.rooms[0].order,null);
   assert.equal(row.name,'Synthetic Customer');assert.equal(row.phone,'13800000000');assert.equal(row.note,'Synthetic credit note');assert.equal(row.signature,cmd.payload.signature);
   assert.deepEqual(row.repayments,[]);assert.deepEqual(row.repaymentRequests,[]);
   const {credit,status,...rest}=order,{credit:oldCredit,status:oldStatus,...oldRest}=creditOrder(original);assert.deepEqual(rest,oldRest);
   for(const field of ['inventory','consumables','ledger','expenses','procurements','user','clock','permissions','capabilities','administrator'])assert.deepEqual(actual.head.state[field],original[field],field);
   assert.deepEqual(actual.head.state.orders[0],original.orders[0]);assert.deepEqual(actual.head.state.rooms.slice(1),original.rooms.slice(1));
   assert.equal(actual.head.state.orders[0].room,null);assert.equal(actual.head.state.inventory.qd.count,null);assert.equal(actual.head.state.inventory.bw.count,0);
   assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);assert.equal(actual.operations[0].actor_principal_id,login.principalId);assert.deepEqual(actual.operations[0].terminal_result,result);
   assert.equal(actual.audit[0].actor_principal_id,login.principalId);assert.equal(actual.audit[0].action,'credit');
   const locks=[run.calls.findIndex(c=>c.kind==='begin'),sqlAt(run,'ledger_heads','FOR UPDATE'),sqlAt(run,'auth_accounts','FOR UPDATE'),sqlAt(run,'auth_sessions','FOR UPDATE'),
    sqlAt(run,'auth_grants','FOR UPDATE'),sqlAt(run,'auth_policy_attributes','FOR UPDATE'),sqlAt(run,'AS db_now','SELECT'),sqlAt(run,'ledger_operations','SELECT'),
    run.calls.findIndex(c=>c.kind==='transact'),sqlAt(run,'ledger_heads','UPDATE'),sqlAt(run,'ledger_operations','INSERT'),sqlAt(run,'ledger_success_audit','INSERT'),run.calls.findIndex(c=>c.kind==='commit')];
   assert.ok(locks.every(i=>i>=0));assert.deepEqual(locks,[...locks].sort((a,b)=>a-b));assert.equal(borrows,1);
   assert.equal(run.calls.filter(c=>c.kind==='begin').length,1);assert.equal(run.calls.filter(c=>c.kind==='commit').length,1);assert.equal(run.calls.filter(c=>c.kind==='db-now').length,1);
   assert.equal(run.context().policyAttributesConfigured,false);assert.equal(run.context().policyAttributeIds,null);assert.equal(sqlAt(run,'employees','FOR SHARE'),-1);
   const [[after]]=await pool.execute('SELECT last_seen_at,idle_expires_at FROM '+table('auth_sessions')+' WHERE session_id=?',[login.sessionId]);assert.deepEqual(after,activity);
  }finally{try{await connection.rollback();}finally{connection.release();}}
 });

 await t.test('credit: customer inputs, saved balance, routing labels and original attribution match demo without policy attributes',async()=>{
  const login=await provision(['credit.apply']);let index=0;
  for(const c of [{phone:'',name:' Customer only '},{phone:'13800000000',name:''},{phone:' 13800000000 ',name:' '+ 'n'.repeat(40)+' ',note:' '+ 'x'.repeat(220)+' '},
   {amount:1,approver:'店长'},{amount:100000,approver:'店长'},{amount:100001,approver:'老板'},{fallback:true}]){
   const id='credit-fields-'+(++index),original=await seedFor(id,s=>{const o=creditOrder(s);if(c.amount)Object.assign(o,{packageBaseCents:c.amount,packageGiftValueCents:0,sales:[],otherCharges:[],payments:[]});
    if(c.fallback){delete o.openedBy;delete o.person;delete o.openSource;delete o.reservedBy;delete o.reservationSource;s.rooms[0].order='another-order';}}),run=runFor(id),cmd=creditCommand('fields',0,c);
   await run.app.execute(cmd,login.credential);const actual=await inspect(id),row=creditOrder(actual.head.state).credit;
   const demo=transact({...original,user:'administrator',clock:run.context().dbNow},'credit',cmd.payload,'demo');
   for(const field of ['id','amount','remaining','phone','name','note','openedBy','openSource','reservedBy','reservationSource','signature','submittedAt','due','approver','repayments','repaymentRequests'])assert.deepEqual(row[field],creditOrder(demo).credit[field],field);
   assert.deepEqual(actual.head.state.rooms,demo.rooms);assert.equal(row.submittedByPrincipalId,login.principalId);assert.equal(run.context().policyAttributesConfigured,false);
   if(c.amount){assert.equal(row.amount,c.amount);assert.equal(row.approver,c.approver);}
  }
 });

 await t.test('credit: authorization denial writes nothing and original key works after current grant despite forged state/payload',async()=>{
  const login=await provision(['backend.view','credit.approve','review.self','payment.settle','staff.record']),id='credit-denied';
  await seedFor(id,s=>{s.user='administrator';s.clock='1900-01-01';});const run=runFor(id),before=await inspect(id),cmd=creditCommand('denied',0,{permissions:['credit.apply'],role:'老板',actorId:'administrator'});
  await assert.rejects(run.app.execute(cmd,login.credential),denied);await assertUnchanged(id,before);assert.equal(run.executions(),0);
  await auth.grantPermission({principalId:login.principalId,permissionId:'credit.apply'});assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');
  const after=await inspect(id);assert.equal(after.head.revision,1);assert.equal(after.operations.length,1);assert.equal(after.audit.length,1);assert.equal(creditOrder(after.head.state).credit.submittedByPrincipalId,login.principalId);
 });

 await t.test('credit: credited employee cannot replace actor or authorization; customer name remains independent business input',async()=>{
  const login=await provision(['credit.apply','staff.record']),id='credit-attribution';await seedFor(id);const before=await inspect(id),run=runFor(id);
  await assert.rejects(run.app.execute(creditCommand('employee',0,{creditedEmployeeId:'10000000-0000-4000-8000-000000000001'}),login.credential),e=>denied(e)&&e.reason==='invalid-attribution');await assertUnchanged(id,before);
  await run.app.execute(creditCommand('customer',0,{name:'Different customer',phone:'',employee:'unmapped-legacy'}),login.credential);
  const row=creditOrder((await inspect(id)).head.state).credit;assert.equal(row.name,'Different customer');assert.equal(row.submittedByPrincipalId,login.principalId);assert.equal(Object.hasOwn(row,'creditedEmployeeId'),false);
 });

 await t.test('credit: revoked grant then new pool reconnect replays old terminal without re-creating request; new key denied',async()=>{
  const login=await provision(['credit.apply']),id='credit-replay';await seedFor(id);const cmd=creditCommand(),first=await runFor(id).app.execute(cmd,login.credential);
  await auth.revokePermission({principalId:login.principalId,permissionId:'credit.apply'});const before=await inspect(id),reconnect=mysql.createPool(poolOptions);
  try{
   const again=runFor(id,{connectionPool:reconnect,bind:createMySqlAuthStore({pool:reconnect,database}).bindSessionRevalidation,transactCommand:()=>assert.fail('saved result must not execute credit')});
   assert.deepEqual(await again.app.execute(cmd,login.credential),first);assert.equal(again.executions(),0);
   await assert.rejects(again.app.execute(creditCommand('new',1),login.credential),denied);await assertUnchanged(id,before);
  }finally{await reconnect.end();}
 });

 await t.test('credit: disabled/revoked/idle/absolute/version invalidation blocks terminal before lookup',async()=>{
  for(const invalid of ['disabled','revoked','idle','absolute','version']){
   const login=await provision(['credit.apply']),id='credit-auth-'+invalid;await seedFor(id);const run=runFor(id),cmd=creditCommand();await run.app.execute(cmd,login.credential);const before=await inspect(id);
   if(invalid==='disabled')await auth.disableAccount({principalId:login.principalId});else if(invalid==='revoked')await auth.logout(login.token);else if(invalid==='version')await auth.rotateCredential({principalId:login.principalId,password:'synthetic-credit-rotation'});
   else if(invalid==='idle')await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at WHERE session_id=?',[login.sessionId]);
   else await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at,absolute_expires_at=created_at+INTERVAL 1 MICROSECOND WHERE session_id=?',[login.sessionId]);
   run.calls.length=0;await assert.rejects(run.app.execute(cmd,login.credential),e=>e.code==='AUTHENTICATION_REQUIRED');assert.equal(sqlAt(run,'ledger_operations','SELECT'),-1);assert.equal(run.executions(),1);await assertUnchanged(id,before);
  }
 });

 await t.test('credit: actor/action/payload/revision conflicts precede current authorization after revoke',async()=>{
  const login=await provision(['credit.apply']),other=await provision([]),id='credit-conflicts';await seedFor(id);const run=runFor(id),cmd=creditCommand();await run.app.execute(cmd,login.credential);const before=await inspect(id);
  await auth.revokePermission({principalId:login.principalId,permissionId:'credit.apply'});const actor=await run.app.execute(cmd,other.credential);assert.equal(actor.status,'idempotency-conflict');assert.equal(actor.reason,'actor-mismatch');
  for(const changed of [{...cmd,expectedRevision:1},{...cmd,action:'approve'},{...cmd,payload:{...cmd.payload,name:'Changed customer'}}]){const result=await run.app.execute(changed,login.credential);assert.equal(result.status,'idempotency-conflict');assert.equal(result.reason,'request-mismatch');}
  assert.equal(run.executions(),1);await assertUnchanged(id,before);
 });

 await t.test('credit: original invalid customer/signature/pending-gift/order/balance is terminal without partial room/state changes',async()=>{
  const login=await provision(['credit.apply']);let index=0;
  for(const c of [{payload:{phone:'',name:''}},{payload:{phone:'123'}},{payload:{note:''}},{payload:{signature:'data:image/png;base64,short'}},{payload:{order:'missing'}},{status:'已结账'},{gift:true},{paid:true}]){
   const id='credit-invalid-'+(++index),original=await seedFor(id,s=>{const o=creditOrder(s);if(c.status)o.status=c.status;if(c.gift)o.giftRequests=[{status:'待确认'}];if(c.paid)o.payments=[{amount:107500,method:'现金'}];}),run=runFor(id),cmd=creditCommand('invalid',0,c.payload);
   const result=await run.app.execute(cmd,login.credential),after=await inspect(id);assert.equal(result.status,'business-rejected');assert.deepEqual(after.head.state,original);assert.equal(after.head.revision,0);assert.equal(after.operations.length,1);assert.equal(after.audit.length,0);
   await auth.revokePermission({principalId:login.principalId,permissionId:'credit.apply'});assert.deepEqual(await run.app.execute(cmd,login.credential),result);assert.equal(run.executions(),1);await assertUnchanged(id,after);await auth.grantPermission({principalId:login.principalId,permissionId:'credit.apply'});
  }
 });

 await t.test('credit: stale revision remains terminal after state advances and grant is revoked',async()=>{
  const login=await provision(['credit.apply']),id='credit-stale';await seedFor(id);const run=runFor(id),cmd=creditCommand('stale',9),first=await run.app.execute(cmd,login.credential);assert.equal(first.status,'revision-conflict');assert.equal(run.executions(),0);
  await run.app.execute(creditCommand('valid'),login.credential);const before=await inspect(id);await auth.revokePermission({principalId:login.principalId,permissionId:'credit.apply'});
  assert.deepEqual(await run.app.execute(cmd,login.credential),first);assert.equal(run.executions(),1);await assertUnchanged(id,before);
 });

 await t.test('credit: repayment, rounding, payments and other unconverted commands remain disabled',async()=>{
  const login=await provision(['credit.apply','credit.approve','credit.repay','credit.repay.approve','rounding.approve','payment.collect','payment.settle','incident.create','incident.resolve','incident.resolve.approve','procurement.create','handover','room.open','review.self']),id='credit-blocked';await seedFor(id);const run=runFor(id);await run.app.execute(creditCommand(),login.credential);const before=await inspect(id);
  for(const action of ['repay','approveRepayment','rejectRepayment','approveRounding','rejectRounding','collect','settle','pay','incident','resolveIncident','approveIncidentResolution','rejectIncidentResolution','procurement','handover','open']){
   await assert.rejects(run.app.execute({...creditCommand(action,1),action},login.credential),e=>denied(e)&&e.reason==='trusted-action-not-enabled');await assertUnchanged(id,before);
  }
 });

 for(const fault of ['unknown','sql'])await t.test('credit: '+fault+' mid-transaction failure fully rolls back request/room/state/revision/result/audit; original key retries',async()=>{
  const login=await provision(['credit.apply']),id='credit-rollback-'+fault;await seedFor(id);const before=await inspect(id);let broken=true;
  const run=runFor(id,{transactCommand:(...args)=>{const next=transact(...args);if(fault==='unknown'&&broken)throw Error('synthetic credit fault');return next;}}),cmd=creditCommand();
  if(fault==='sql')await setup.query('ALTER TABLE '+table('ledger_success_audit')+" ADD CONSTRAINT chk_credit_fault CHECK (ledger_id <> '"+id+"')");
  try{await assert.rejects(run.app.execute(cmd,login.credential),e=>fault==='unknown'?e.message==='synthetic credit fault':e.code==='ER_CHECK_CONSTRAINT_VIOLATED');assert.ok(run.calls.some(c=>c.kind==='rollback'));
   if(fault==='sql'){assert.ok(sqlAt(run,'ledger_heads','UPDATE')>=0);assert.ok(sqlAt(run,'ledger_operations','INSERT')>=0);}await assertUnchanged(id,before);
  }finally{if(fault==='sql')await setup.query('ALTER TABLE '+table('ledger_success_audit')+' DROP CHECK chk_credit_fault');}
  broken=false;assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');const after=await inspect(id);assert.equal(after.head.revision,1);assert.equal(after.operations.length,1);assert.equal(after.audit.length,1);
  assert.equal(creditOrder(after.head.state).credit.id,1001);assert.equal(after.head.state.rooms[0].status,'待清洁');
 });

 for(const sameKey of [false,true])await t.test('credit: two independent connections '+(sameKey?'replay same key exactly once':'compete old revision with one success'),async()=>{
  const login=await provision(['credit.apply']),id='credit-race-'+sameKey;await seedFor(id);const a=await pool.getConnection(),b=await pool.getConnection();
  try{
   const [[aId]]=await a.query('SELECT CONNECTION_ID() AS id'),[[bId]]=await b.query('SELECT CONNECTION_ID() AS id');assert.notEqual(aId.id,bId.id);await a.query('SET SESSION innodb_lock_wait_timeout=5');await b.query('SET SESSION innodb_lock_wait_timeout=5');
   const first=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(a,[],false)}}),second=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(b,[],false)}});
   const results=await Promise.all([first.app.execute(creditCommand('first'),login.credential),second.app.execute(creditCommand(sameKey?'first':'second'),login.credential)]);
   if(sameKey)assert.deepEqual(results[0],results[1]);else assert.deepEqual(results.map(r=>r.status).sort(),['committed','revision-conflict']);
   const after=await inspect(id);assert.equal(first.executions()+second.executions(),1);assert.equal(after.head.revision,1);assert.equal(after.operations.length,sameKey?1:2);assert.equal(after.audit.length,1);
   assert.equal(creditOrder(after.head.state).credit.id,1001);assert.equal(creditOrder(after.head.state).credit.amount,104500);assert.equal(after.head.state.serial,1001);assert.equal(after.head.state.rooms[0].order,null);
   t.diagnostic('credit '+(sameKey?'same-key':'revision')+' race verified two independent CONNECTION_ID values');
  }finally{try{await a.rollback();await b.rollback();}finally{a.release();b.release();}}
 });
}
