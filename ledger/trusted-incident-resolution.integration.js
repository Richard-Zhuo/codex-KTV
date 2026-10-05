import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { transact } from '../rules.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlEmployeeStore } from '../employees/mysql-store.js';
import { createEmployeeService } from '../employees/service.js';
import { incidentCommand } from '../test-support/trusted-incident-fixture.js';
import { resolutionCommand,seedIncidentResolution } from '../test-support/trusted-incident-resolution-fixture.js';
// Only the guarded parent fixture owns DDL and cleanup of its eleven tables.
export async function testTrustedIncidentResolution({t,pool,setup,auth,table,provision,seed,inspect,application,roster,
 assertUnchanged,wrapConnection,poolOptions,database}){
 const denied=e=>e instanceof AuthorizationDenied&&e.status==='authorization-denied';
 const sqlAt=(run,name,clause)=>run.calls.findIndex(c=>c.kind==='sql'&&c.sql.includes(name)&&(clause.startsWith('FOR ')?c.sql.endsWith(clause):c.sql.startsWith(clause+' ')));
 async function linked(permissions=['incident.resolve'],displayName='Synthetic Resolution Employee'){
  const login=await provision(permissions),employee=await roster.createEmployee({displayName},{actorPrincipalId:login.principalId});
  await roster.linkPrincipal({employeeId:employee.employeeId,principalId:login.principalId},{actorPrincipalId:login.principalId});return {...login,employee};
 }
 const seedFor=(id,employee,prepare=()=>{})=>seed(id,s=>{seedIncidentResolution(s,employee.employeeId);prepare(s);});
 await t.test('resolveIncident: session linkage, matched assignee, pending request, actor, revision and audit commit on one connection',async()=>{
  const login=await linked(),id='incident-resolution-first',original=await seedFor(id,login.employee),c=await pool.getConnection();let borrows=0;
  const [[activity]]=await pool.execute('SELECT last_seen_at,idle_expires_at FROM '+table('auth_sessions')+' WHERE session_id=?',[login.sessionId]);
  try{const run=application(id,{connectionPool:{getConnection:async()=>{borrows++;return wrapConnection(c,[],false);}}}),cmd=resolutionCommand('first',0,
   {actorId:'administrator',principalId:'forged',assigneeEmployeeId:randomUUID(),employeeId:randomUUID(),assignee:'forged',submittedByPrincipalId:'forged',submittedBy:'forged',role:'administrator',permissions:['*'],clock:'1900-01-01'});
   const result=await run.app.execute(cmd,login.credential),actual=await inspect(id),incident=actual.head.state.incidents[0],request=incident.resolutionReviews[0];
   assert.equal(result.status,'committed');assert.equal(result.actorId,login.principalId);assert.equal(request.submittedByPrincipalId,login.principalId);
   assert.equal(request.submittedByEmployeeId,login.employee.employeeId);assert.equal(request.submittedBy,login.employee.displayName);assert.equal(request.submittedById,null);
   assert.equal(request.submittedAt,run.context().dbNow);assert.equal(request.status,'待审核');assert.equal(request.result,'Synthetic result');assert.equal(request.note,'Synthetic note');
   assert.equal(incident.status,'待审核');assert.equal(incident.result,'');assert.equal(incident.note,'');assert.equal(incident.assignee,'Historical Assignee');assert.equal(incident.lastReminderDate,'');
   const expected=structuredClone(original);expected.serial++;expected.incidents[0]={...expected.incidents[0],status:'待审核',lastReminderDate:'',resolutionReviews:[request]};expected.processed.push('first');
   assert.deepEqual(actual.head.state,expected);assert.equal(actual.head.revision,1);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);
   assert.equal(actual.operations[0].actor_principal_id,login.principalId);assert.equal(actual.audit[0].actor_principal_id,login.principalId);
   assert.notEqual(run.context().actorEmployeeId,run.context().principalId);assert.equal(run.context().actorEmployeeId,login.employee.employeeId);assert.ok(!Object.hasOwn(run.context(),'creditedEmployeeId'));
   const order=[run.calls.findIndex(c=>c.kind==='begin'),sqlAt(run,'ledger_heads','FOR UPDATE'),sqlAt(run,'auth_accounts','FOR UPDATE'),sqlAt(run,'auth_sessions','FOR UPDATE'),
    sqlAt(run,'auth_grants','FOR UPDATE'),sqlAt(run,'AS db_now','SELECT'),sqlAt(run,'ledger_operations','SELECT'),sqlAt(run,table('employees'),'FOR SHARE'),
    run.calls.findIndex(c=>c.kind==='transact'),sqlAt(run,'ledger_heads','UPDATE'),sqlAt(run,'ledger_operations','INSERT'),sqlAt(run,'ledger_success_audit','INSERT'),run.calls.findIndex(c=>c.kind==='commit')];
   assert.ok(order.every(i=>i>=0));assert.deepEqual(order,[...order].sort((a,b)=>a-b));assert.equal(borrows,1);assert.equal(run.calls.filter(c=>c.kind==='begin').length,1);
   assert.equal(run.calls.filter(c=>c.kind==='commit').length,1);assert.equal(run.calls.filter(c=>c.kind==='db-now').length,1);
   const [[after]]=await pool.execute('SELECT last_seen_at,idle_expires_at FROM '+table('auth_sessions')+' WHERE session_id=?',[login.sessionId]);assert.deepEqual(after,activity);
   assert.equal(actual.head.state.orders[0].room,null);assert.equal(actual.head.state.inventory.bw.count,0);assert.equal(actual.head.state.inventory.qd.count,null);
  }finally{await c.rollback();c.release();}
 });
 await t.test('resolveIncident: permission denied is nonterminal and granting permission allows the same key',async()=>{
  const login=await linked(['backend.view','incident.resolve.approve']),id='incident-resolution-grant';await seedFor(id,login.employee);
  const run=application(id),before=await inspect(id),cmd=resolutionCommand('grant',0,{permissions:['incident.resolve'],role:'administrator'});
  await assert.rejects(run.app.execute(cmd,login.credential),denied);await assertUnchanged(id,before);assert.equal(run.executions(),0);assert.equal(sqlAt(run,table('employees'),'FOR SHARE'),-1);
  await auth.grantPermission({principalId:login.principalId,permissionId:'incident.resolve'});assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');
 });
 await t.test('resolveIncident: same-name wrong employee and forged manager/viewAll facts cannot override locked assignee',async()=>{
  const login=await linked(['incident.resolve','incident.resolve.approve'],'Synthetic Same Name'),other=await linked(['incident.resolve'],'Synthetic Same Name'),id='incident-resolution-wrong';
  await seedFor(id,other.employee,s=>{s.incidents[0].assignee=login.employee.displayName;s.user='administrator';s.capabilities={administrator:['incident.viewAll','incident.resolve']};});const before=await inspect(id);
  await assert.rejects(application(id).app.execute(resolutionCommand('wrong',0,{assigneeEmployeeId:login.employee.employeeId,employeeId:other.employee.employeeId,principalId:other.principalId,assignee:login.employee.displayName,permissions:['incident.viewAll','incident.resolve'],role:'老板'}),login.credential),e=>denied(e)&&e.reason==='incident-assignee-mismatch');await assertUnchanged(id,before);
 });
 await t.test('resolveIncident: no association fails closed; an explicit later link allows original unoccupied key',async()=>{
  const login=await provision(['incident.resolve']),employee=await roster.createEmployee({displayName:'Synthetic No Link'},{actorPrincipalId:login.principalId}),id='incident-resolution-unlinked';
  await seedFor(id,employee);const run=application(id),before=await inspect(id),cmd=resolutionCommand('link');await assert.rejects(run.app.execute(cmd,login.credential),e=>denied(e)&&e.reason==='actor-employee-not-linked');await assertUnchanged(id,before);
  await roster.linkPrincipal({employeeId:employee.employeeId,principalId:login.principalId},{actorPrincipalId:login.principalId});assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');
 });
 await t.test('resolveIncident: disabled linked employee is denied without request, revision, operation or audit',async()=>{
  const login=await linked(),id='incident-resolution-disabled-employee';await seedFor(id,login.employee);await roster.disableEmployee({employeeId:login.employee.employeeId},{actorPrincipalId:login.principalId});
  const before=await inspect(id);await assert.rejects(application(id).app.execute(resolutionCommand(),login.credential),e=>denied(e)&&e.reason==='actor-employee-disabled');await assertUnchanged(id,before);
 });
 await t.test('resolveIncident: legacy name/demo ID lacks provable assignee; forged stable ID cannot authorize',async()=>{
  const login=await linked();
  for(const invalid of ['absent','demo','principal']){const id='incident-resolution-legacy-'+invalid;await seedFor(id,login.employee,s=>{
   s.incidents[0].assignee=login.employee.displayName;if(invalid==='absent')delete s.incidents[0].assigneeEmployeeId;
   else s.incidents[0].assigneeEmployeeId=invalid==='demo'?'wife':login.principalId;
  });const before=await inspect(id);await assert.rejects(application(id).app.execute(resolutionCommand('legacy',0,{assigneeEmployeeId:login.employee.employeeId,assignee:login.employee.displayName}),login.credential),denied);await assertUnchanged(id,before);}
 });
 await t.test('resolveIncident: permission revoke, unlink and reconnect preserve prior terminal without resolving employee again',async()=>{
  const login=await linked(),id='incident-resolution-replay';await seedFor(id,login.employee);const cmd=resolutionCommand('replay'),first=await application(id).app.execute(cmd,login.credential),before=await inspect(id);
  await auth.revokePermission({principalId:login.principalId,permissionId:'incident.resolve'});await roster.unlinkPrincipal({employeeId:login.employee.employeeId},{actorPrincipalId:login.principalId});
  const fresh=mysql.createPool({...poolOptions,connectionLimit:1});
  try{const replay=application(id,{connectionPool:fresh,employeeBind:null,transactCommand:()=>assert.fail('must not repeat resolution')});
   assert.deepEqual(await replay.app.execute(cmd,login.credential),first);assert.equal(replay.executions(),0);assert.equal(sqlAt(replay,table('employees'),'FOR SHARE'),-1);
   await assert.rejects(replay.app.execute(resolutionCommand('new',1),login.credential),denied);await assertUnchanged(id,before);
  }finally{await fresh.end();}
 });
 for(const invalid of ['disabled','revoked','idle','absolute','credential'])await t.test('resolveIncident: '+invalid+' authentication cannot access a stored terminal',async()=>{
  const login=await linked(),id='incident-resolution-auth-'+invalid;await seedFor(id,login.employee);const run=application(id),cmd=resolutionCommand('private');await run.app.execute(cmd,login.credential);const before=await inspect(id);
  if(invalid==='disabled')await auth.disableAccount({principalId:login.principalId});else if(invalid==='revoked')await auth.revokeSession({sessionId:login.sessionId});
  else if(invalid==='credential')await auth.rotateCredential({principalId:login.principalId,password:'synthetic-resolution-rotated'});
  else if(invalid==='idle')await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at WHERE session_id=?',[login.sessionId]);
  else await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at,absolute_expires_at=created_at+INTERVAL 1 MICROSECOND WHERE session_id=?',[login.sessionId]);
  run.calls.length=0;await assert.rejects(run.app.execute(cmd,login.credential),e=>e.code==='AUTHENTICATION_REQUIRED');await assertUnchanged(id,before);assert.equal(sqlAt(run,'ledger_operations','SELECT'),-1);
 });
 await t.test('resolveIncident: actor/payload/revision conflicts precede fresh authorization and employee lookup',async()=>{
  const login=await linked(),other=await provision([]),id='incident-resolution-conflicts';await seedFor(id,login.employee);const cmd=resolutionCommand('same'),run=application(id);await run.app.execute(cmd,login.credential);const before=await inspect(id);
  await auth.revokePermission({principalId:login.principalId,permissionId:'incident.resolve'});assert.equal((await run.app.execute(cmd,other.credential)).reason,'actor-mismatch');
  for(const changed of [{...cmd,expectedRevision:1},{...cmd,payload:{...cmd.payload,result:'changed'}},{...cmd,action:'approveIncidentResolution'}])assert.equal((await run.app.execute(changed,login.credential)).reason,'request-mismatch');await assertUnchanged(id,before);
 });
 await t.test('resolveIncident: original status/result/note rejections are terminal; truncation and rejected history remain unchanged',async()=>{
  const login=await linked();
  for(const [label,prepare,changes] of [['absent',s=>{s.incidents=[];},{}],['completed',s=>{s.incidents[0].status='已完成';},{}],['pending',s=>{s.incidents[0].resolutionReviews=[{id:42,status:'待审核'}];},{}],['result',()=>{},{result:' '}],['note',()=>{},{note:' '}]]){
   const id='incident-resolution-domain-'+label,original=await seedFor(id,login.employee,prepare),cmd=resolutionCommand('invalid',0,changes),run=application(id),result=await run.app.execute(cmd,login.credential),actual=await inspect(id);
   assert.equal(result.status,'business-rejected');assert.deepEqual(actual.head.state,original);assert.equal(actual.head.revision,0);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,0);assert.deepEqual(await run.app.execute(cmd,login.credential),result);
  }
  const id='incident-resolution-long',original=await seedFor(id,login.employee,s=>{s.incidents[0].resolutionReviews=[{id:40,status:'已驳回',submittedBy:'Historic'}];});
  await pool.execute('UPDATE '+table('employees')+' SET display_name=? WHERE employee_id=?',['Renamed Employee',login.employee.employeeId]);
  assert.equal((await application(id).app.execute(resolutionCommand('long',0,{result:'r'.repeat(350),note:'n'.repeat(350)}),login.credential)).status,'committed');
  const incident=(await inspect(id)).head.state.incidents[0];assert.deepEqual(incident.resolutionReviews[0],original.incidents[0].resolutionReviews[0]);assert.equal(incident.resolutionReviews[1].result.length,300);assert.equal(incident.resolutionReviews[1].note.length,300);assert.equal(incident.assignee,'Historical Assignee');assert.equal(incident.resolutionReviews[1].submittedBy,'Renamed Employee');
 });
 await t.test('resolveIncident: stale revision persists before employee lookup and stays terminal after permission revoke',async()=>{
  const login=await linked(),id='incident-resolution-stale';await seedFor(id,login.employee);const run=application(id,{employeeBind:null}),cmd=resolutionCommand('stale',1),result=await run.app.execute(cmd,login.credential);
  assert.equal(result.status,'revision-conflict');assert.equal(run.executions(),0);const before=await inspect(id);await auth.revokePermission({principalId:login.principalId,permissionId:'incident.resolve'});assert.deepEqual(await run.app.execute(cmd,login.credential),result);await assertUnchanged(id,before);
 });
 await t.test('resolveIncident: missing resolver/revalidation and copied context cannot fall back to demo',async()=>{
  const login=await linked(),id='incident-resolution-port';await seedFor(id,login.employee);const before=await inspect(id);
  for(const options of [{employeeBind:null},{bind:null},{bind:()=>({revalidateSessionInTransaction:async()=>({mode:'trusted',principalId:login.principalId})})}]){
   await assert.rejects(async()=>application(id,options).app.execute(resolutionCommand('blocked'),login.credential),TypeError);await assertUnchanged(id,before);
  }
 });
 await t.test('resolveIncident: actual employee SQL fault rolls back without reserving key; repair permits retry',async()=>{
  const login=await linked(),id='incident-resolution-resolver-sql';await seedFor(id,login.employee);const before=await inspect(id),store=createMySqlEmployeeStore({pool,database});
  const bind=c=>store.bindEmployeeResolver({query:(...args)=>c.query(...args),execute:(sql,values)=>c.execute(sql.startsWith('SELECT employee_id, display_name, enabled, principal_id')?sql.replace('display_name','missing_resolution_employee_column'):sql,values)});
  const run=application(id,{employeeBind:bind}),cmd=resolutionCommand('repair');await assert.rejects(run.app.execute(cmd,login.credential),e=>e.code==='ER_BAD_FIELD_ERROR');await assertUnchanged(id,before);assert.ok(run.calls.some(c=>c.kind==='rollback'));assert.equal((await application(id).app.execute(cmd,login.credential)).status,'committed');
 });
 await t.test('resolveIncident: unknown exception after request creation rolls back all state and the key can retry',async()=>{
  const login=await linked(),id='incident-resolution-unknown';await seedFor(id,login.employee);const before=await inspect(id);let fail=true;
  const run=application(id,{transactCommand:(...args)=>{const next=transact(...args);if(fail)throw Error('synthetic resolution unknown');return next;}}),cmd=resolutionCommand('repair');
  await assert.rejects(run.app.execute(cmd,login.credential),/synthetic resolution unknown/);await assertUnchanged(id,before);fail=false;assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');
 });
 await t.test('resolveIncident: audit SQL fault after head/operation writes rolls back request, revision, result and audit',async()=>{
  const login=await linked(),id='incident-resolution-sql';await seedFor(id,login.employee);const before=await inspect(id),run=application(id),cmd=resolutionCommand('repair');
  await setup.query('ALTER TABLE '+table('ledger_success_audit')+" ADD CONSTRAINT chk_resolution_fault CHECK (ledger_id <> 'incident-resolution-sql')");
  try{await assert.rejects(run.app.execute(cmd,login.credential),e=>e.code==='ER_CHECK_CONSTRAINT_VIOLATED');assert.ok(sqlAt(run,'ledger_heads','UPDATE')>=0);assert.ok(sqlAt(run,'ledger_operations','INSERT')>=0);assert.ok(run.calls.some(c=>c.kind==='rollback'));await assertUnchanged(id,before);}
  finally{await setup.query('ALTER TABLE '+table('ledger_success_audit')+' DROP CHECK chk_resolution_fault');}
  assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');
 });
 await t.test('resolveIncident: two independent connections compete with one request effect for old revision or identical key',async()=>{
  const login=await linked(),a=await pool.getConnection(),b=await pool.getConnection();
  try{assert.notEqual((await a.query('SELECT CONNECTION_ID() AS id'))[0][0].id,(await b.query('SELECT CONNECTION_ID() AS id'))[0][0].id);
   for(const sameKey of [false,true]){const id='incident-resolution-race-'+sameKey;await seedFor(id,login.employee);
    const first=application(id,{connectionPool:{getConnection:async()=>wrapConnection(a,[],false)}}),second=application(id,{connectionPool:{getConnection:async()=>wrapConnection(b,[],false)}});
    const results=await Promise.all([first.app.execute(resolutionCommand('a'),login.credential),second.app.execute(resolutionCommand(sameKey?'a':'b'),login.credential)]);
    if(sameKey)assert.deepEqual(results[0],results[1]);else assert.deepEqual(results.map(r=>r.status).sort(),['committed','revision-conflict']);
    const actual=await inspect(id);assert.equal(actual.head.revision,1);assert.equal(actual.head.state.incidents[0].resolutionReviews.length,1);assert.equal(actual.audit.length,1);assert.equal(actual.operations.length,sameKey?1:2);assert.equal(first.executions()+second.executions(),1);
   }t.diagnostic('resolveIncident races used two verified distinct CONNECTION_ID values');
  }finally{try{await a.rollback();await b.rollback();}finally{a.release();b.release();}}
 });
 await t.test('resolveIncident: account then employee locks order a concurrent employee disable after command commit',{timeout:10000},async()=>{
  const login=await linked(),admin=await provision([]),id='incident-resolution-disable-race';await seedFor(id,login.employee);const a=await pool.getConnection(),b=await pool.getConnection();
  let releaseLookup,lookupLocked,commandWork,disableWork;const held=new Promise(resolve=>{releaseLookup=resolve;}),locked=new Promise(resolve=>{lookupLocked=resolve;});
  try{assert.notEqual((await a.query('SELECT CONNECTION_ID() AS id'))[0][0].id,(await b.query('SELECT CONNECTION_ID() AS id'))[0][0].id);
   const store=createMySqlEmployeeStore({pool,database});const bind=c=>{const inner=store.bindEmployeeResolver(c);return {...inner,async resolvePrincipalEmployeeInTransaction(input){const employee=await inner.resolvePrincipalEmployeeInTransaction(input);lookupLocked();await held;return employee;}};};
   const run=application(id,{connectionPool:{getConnection:async()=>wrapConnection(a,[],false)},employeeBind:bind});commandWork=run.app.execute(resolutionCommand('before-disable'),login.credential);
   let timeout;try{await Promise.race([locked,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('actor employee lock timeout')),5000);})]);}finally{clearTimeout(timeout);}
   const disableRoster=createEmployeeService({store:createMySqlEmployeeStore({pool:{getConnection:async()=>wrapConnection(b,[],false)},database})});let disabled=false;
   disableWork=disableRoster.disableEmployee({employeeId:login.employee.employeeId},{actorPrincipalId:admin.principalId}).then(value=>{disabled=true;return value;});
   await new Promise(resolve=>setTimeout(resolve,60));assert.equal(disabled,false);releaseLookup();assert.equal((await commandWork).status,'committed');assert.equal((await disableWork).employee.enabled,false);
   const before=await inspect(id);await assert.rejects(application(id).app.execute(resolutionCommand('after-disable',1),login.credential),denied);await assertUnchanged(id,before);
  }finally{releaseLookup();await Promise.allSettled([commandWork,disableWork].filter(Boolean));try{await a.rollback();await b.rollback();}finally{a.release();b.release();}}
 });
 await t.test('resolveIncident: real trusted registration by another principal resolves only for the explicitly linked assignee',async()=>{
  const creator=await provision(['incident.create','incident.resolve']),assignee=await linked(),id='incident-resolution-chain';await seed(id);const run=application(id);
  assert.equal((await run.app.execute(incidentCommand('create',assignee.employee.employeeId),creator.credential)).status,'committed');const incident=(await inspect(id)).head.state.incidents.at(-1);
  const cmd=resolutionCommand('resolve',1,{id:incident.id});const before=await inspect(id);await assert.rejects(run.app.execute(cmd,creator.credential),denied);await assertUnchanged(id,before);
  assert.equal((await run.app.execute(cmd,assignee.credential)).status,'committed');const actual=await inspect(id),request=actual.head.state.incidents.at(-1).resolutionReviews[0];
  assert.equal(request.submittedByPrincipalId,assignee.principalId);assert.notEqual(request.submittedByPrincipalId,incident.submittedByPrincipalId);assert.equal(actual.head.revision,2);
 });
 await t.test('resolveIncident: all other unmigrated actions remain fail closed',async()=>{
  const login=await linked(['incident.resolve','incident.resolve.approve','rounding.approve','payment.collect','payment.settle','procurement.create','handover','room.open']),id='incident-resolution-closed';await seedFor(id,login.employee);const before=await inspect(id);
  for(const action of ['handover', 'open'])await assert.rejects(application(id).app.execute({...resolutionCommand(action),action},login.credential),e=>denied(e)&&e.reason==='trusted-action-not-enabled');await assertUnchanged(id,before);
 });
}
