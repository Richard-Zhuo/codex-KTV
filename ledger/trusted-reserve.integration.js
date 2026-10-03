import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { transact } from '../rules.js';
import { reservationTarget } from '../rooms.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createMySqlEmployeeStore } from '../employees/mysql-store.js';
import { createEmployeeService } from '../employees/service.js';

// Uses the guarded parent fixture only; this helper performs no DDL or cleanup.
export async function testTrustedReserve({t,pool,setup,auth,table,provision,seed,inspect,application,roster,
  assertUnchanged,wrapConnection,poolOptions,database}) {
  const prepare=state=>{state.rooms[0].status=state.rooms[1].status='空闲';};
  const command=(key,employeeId,revision=0,changes={})=>({operationKey:key,expectedRevision:revision,action:'reserve',
    payload:{room:'V01',employee:employeeId,dayOffset:2,session:'night',source:'手机',note:'original note',...changes}});
  const denied=error=>error instanceof AuthorizationDenied&&error.status==='authorization-denied';
  const employee=(login,name='Synthetic Reserve Employee')=>roster.createEmployee({displayName:name},{actorPrincipalId:login.principalId});
  const readEmployees=async()=>{
    const [rows]=await pool.execute('SELECT employee_id,display_name,enabled,principal_id FROM '+table('employees')+' ORDER BY employee_id');
    const [events]=await pool.execute('SELECT event_id,employee_id,event_type,actor_principal_id FROM '+table('employee_events')+' ORDER BY event_id');
    return {rows,events};
  };
  const sqlAt=(run,name,clause)=>run.calls.findIndex(call=>call.kind==='sql'&&call.sql.includes(name)&&
    (clause.startsWith('FOR ') ? call.sql.endsWith(clause) : call.sql.startsWith(clause+' ')));

  await t.test('reserve: one connection locks auth then resolves employee; frozen DB time, actor, snapshot and audit commit atomically',async()=>{
    const login=await provision(['staff.record']), credited=await employee(login), id='reserve-first';
    assert.equal(credited.principalId,null);assert.notEqual(credited.employeeId,login.principalId);
    const original=await seed(id,prepare), rosterBefore=await readEmployees(), connection=await pool.getConnection();
    const [[sessionBefore]]=await pool.execute('SELECT last_seen_at,idle_expires_at FROM '+table('auth_sessions')+' WHERE session_id=?',[login.sessionId]);
    let borrows=0;
    try {
      const run=application(id,{connectionPool:{getConnection:async()=>{borrows++;return wrapConnection(connection,[],false);}}});
      const cmd=command('first',credited.employeeId,0,{actorId:'administrator',principalId:'forged',user:'administrator',role:'administrator',
        permissions:['*'],clock:'1900-01-01',person:'forged',recordedBy:'forged',actualActorPrincipalId:'forged',
        creditedEmployeeNameSnapshot:'forged',displayName:'forged'});
      const result=await run.app.execute(cmd,login.credential),actual=await inspect(id),booking=actual.head.state.reservations.at(-1);
      assert.equal(result.status,'committed');assert.equal(result.actorId,login.principalId);assert.equal(actual.head.revision,1);
      assert.equal(booking.actualActorPrincipalId,login.principalId);assert.equal(booking.recordedBy,login.principalId);
      assert.equal(booking.creditedEmployeeId,credited.employeeId);assert.equal(booking.employeeId,credited.employeeId);
      assert.equal(booking.person,credited.displayName);assert.equal(booking.creditedEmployeeNameSnapshot,credited.displayName);
      assert.equal(booking.at,reservationTarget(run.context().dbNow,2,'night'));assert.equal(booking.dayOffset,2);
      assert.equal(booking.sessionLabel,'夜间场（20:00—次日02:00）');assert.equal(booking.source,'手机');
      const expected=structuredClone(original);expected.serial++;expected.reservations.push(booking);expected.processed.push('first');
      assert.deepEqual(actual.head.state,expected);assert.equal(actual.head.state.orders[0].room,null);
      assert.equal(actual.head.state.inventory.bw.count,0);assert.equal(actual.head.state.inventory.qd.count,null);
      assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);
      assert.equal(actual.operations[0].actor_principal_id,login.principalId);assert.deepEqual(actual.operations[0].terminal_result,result);
      assert.equal(actual.audit[0].actor_principal_id,login.principalId);assert.equal(actual.audit[0].action,'reserve');
      const order=[run.calls.findIndex(call=>call.kind==='begin'),sqlAt(run,'ledger_heads','FOR UPDATE'),
        sqlAt(run,'auth_accounts','FOR UPDATE'),sqlAt(run,'auth_sessions','FOR UPDATE'),sqlAt(run,'auth_grants','FOR UPDATE'),
        sqlAt(run,'AS db_now','SELECT'),sqlAt(run,'ledger_operations','SELECT'),sqlAt(run,table('employees'),'FOR SHARE'),
        run.calls.findIndex(call=>call.kind==='transact'),sqlAt(run,'ledger_heads','UPDATE'),sqlAt(run,'ledger_operations','INSERT'),
        sqlAt(run,'ledger_success_audit','INSERT'),run.calls.findIndex(call=>call.kind==='commit')];
      assert.ok(order.every(index=>index>=0));assert.deepEqual(order,[...order].sort((a,b)=>a-b));
      assert.equal(borrows,1);assert.equal(run.calls.filter(c=>c.kind==='begin').length,1);
      assert.equal(run.calls.filter(c=>c.kind==='commit').length,1);assert.equal(run.calls.filter(c=>c.kind==='rollback').length,0);
      assert.equal(run.calls.filter(c=>c.kind==='db-now').length,1);assert.equal(run.context().dbNow,run.calls.find(c=>c.kind==='db-now').value);
      const [[sessionAfter]]=await pool.execute('SELECT last_seen_at,idle_expires_at FROM '+table('auth_sessions')+' WHERE session_id=?',[login.sessionId]);
      assert.deepEqual(sessionAfter,sessionBefore);assert.deepEqual(await readEmployees(),rosterBefore);
    } finally {await connection.rollback();connection.release();}
  });

  await t.test('reserve: same-name UUIDs and an employee linked to a different disabled principal remain valid attribution',async()=>{
    const login=await provision(['staff.record']), other=await provision([]), a=await employee(login,'Synthetic Same Name'),b=await employee(login,'Synthetic Same Name');
    await roster.linkPrincipal({employeeId:b.employeeId,principalId:other.principalId},{actorPrincipalId:login.principalId});
    await auth.disableAccount({principalId:other.principalId});
    await seed('reserve-same-name',prepare);const run=application('reserve-same-name');
    const canonical=command('a',a.employeeId);delete canonical.payload.employee;canonical.payload.creditedEmployeeId=a.employeeId;
    assert.equal((await run.app.execute(canonical,login.credential)).status,'committed');
    assert.equal((await run.app.execute(command('b',b.employeeId,1,{dayOffset:3,creditedEmployeeId:b.employeeId}),login.credential)).status,'committed');
    const actual=await inspect('reserve-same-name'),bookings=actual.head.state.reservations;
    assert.deepEqual(bookings.map(r=>r.creditedEmployeeId),[a.employeeId,b.employeeId]);
    assert.equal(bookings[0].person,bookings[1].person);assert.ok(bookings.every(r=>r.actualActorPrincipalId===login.principalId));
  });

  await t.test('reserve: forged fields and room.reserve alone cannot bypass original staff.record; denied key succeeds after grant',async()=>{
    const login=await provision(['room.reserve','backend.view']), credited=await employee(login), id='reserve-denied';
    await seed(id,s=>{prepare(s);s.user='administrator';s.permissions={administrator:['管理员']};s.clock='2099-01-01';});
    const before=await inspect(id),run=application(id),cmd=command('denied',credited.employeeId,0,{permissions:['staff.record'],role:'administrator',actorId:login.principalId});
    await assert.rejects(run.app.execute(cmd,login.credential),denied);await assertUnchanged(id,before);
    assert.equal(run.executions(),0);assert.equal(sqlAt(run,table('employees'),'FOR SHARE'),-1);
    await auth.grantPermission({principalId:login.principalId,permissionId:'staff.record'});
    assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');assert.equal(run.executions(),1);
  });

  await t.test('reserve: disabled/unknown employees persist only business rejection and replay original terminal',async()=>{
    for(const unavailable of ['disabled','unknown']) {
      const login=await provision(['staff.record']),credited=await employee(login),id='reserve-employee-'+unavailable;
      if(unavailable==='disabled') await roster.disableEmployee({employeeId:credited.employeeId},{actorPrincipalId:login.principalId});
      await seed(id,prepare);const run=application(id),before=await inspect(id),cmd=command('rejected',unavailable==='unknown'?randomUUID():credited.employeeId);
      const result=await run.app.execute(cmd,login.credential);assert.equal(result.status,'business-rejected');
      const actual=await inspect(id);assert.deepEqual(actual.head,before.head);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,0);assert.equal(run.executions(),0);
      if(unavailable==='disabled') await pool.execute('UPDATE '+table('employees')+' SET enabled=1 WHERE employee_id=?',[credited.employeeId]);
      await auth.revokePermission({principalId:login.principalId,permissionId:'staff.record'});const calls=run.calls.length;
      assert.deepEqual(await run.app.execute(cmd,login.credential),result);await assertUnchanged(id,actual);
      assert.ok(!run.calls.slice(calls).some(c=>c.kind==='sql'&&c.sql.includes(table('employees'))));
    }
  });

  await t.test('reserve: reconnect after revoke/rename/disable returns original snapshot without resolving employee again',async()=>{
    const login=await provision(['staff.record']),credited=await employee(login),id='reserve-replay';await seed(id,prepare);
    const run=application(id),cmd=command('original',credited.employeeId),first=await run.app.execute(cmd,login.credential),before=await inspect(id);
    await pool.execute('UPDATE '+table('employees')+' SET display_name=?,updated_at=UTC_TIMESTAMP(6) WHERE employee_id=?',['Changed Name',credited.employeeId]);
    await roster.disableEmployee({employeeId:credited.employeeId},{actorPrincipalId:login.principalId});
    await auth.revokePermission({principalId:login.principalId,permissionId:'staff.record'});
    const reconnect=mysql.createPool(poolOptions);
    try {
      const again=application(id,{connectionPool:reconnect,bind:createMySqlAuthStore({pool:reconnect,database}).bindSessionRevalidation,employeeBind:null});
      assert.deepEqual(await again.app.execute(cmd,login.credential),first);assert.equal(again.executions(),0);
      assert.equal(sqlAt(again,table('employees'),'FOR SHARE'),-1);
      await assert.rejects(again.app.execute({...cmd,operationKey:'new',expectedRevision:1},login.credential),denied);
      await assertUnchanged(id,before);
    } finally {await reconnect.end();}
  });

  await t.test('reserve: disabled/revoked/idle/absolute/credential invalidation prevents terminal access',async()=>{
    for(const invalid of ['disabled','revoked','idle','absolute','credential']) {
      const login=await provision(['staff.record']),credited=await employee(login),id='reserve-auth-'+invalid;await seed(id,prepare);
      const run=application(id),cmd=command('private',credited.employeeId);await run.app.execute(cmd,login.credential);const before=await inspect(id);
      if(invalid==='disabled') await auth.disableAccount({principalId:login.principalId});
      else if(invalid==='revoked') assert.equal(await auth.logout(login.token),true);
      else if(invalid==='credential') await auth.rotateCredential({principalId:login.principalId,password:'synthetic-new-reserve-password'});
      else if(invalid==='idle') await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at WHERE session_id=?',[login.sessionId]);
      else await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at,absolute_expires_at=created_at+INTERVAL 1 MICROSECOND WHERE session_id=?',[login.sessionId]);
      run.calls.length=0;
      await assert.rejects(run.app.execute(cmd,login.credential),error=>error.code==='AUTHENTICATION_REQUIRED');await assertUnchanged(id,before);
      assert.equal(sqlAt(run,'ledger_operations','SELECT'),-1);assert.equal(sqlAt(run,table('employees'),'FOR SHARE'),-1);
    }
  });

  await t.test('reserve: actor/fingerprint conflicts precede current permission and employee validation',async()=>{
    const login=await provision(['staff.record']),other=await provision([]),credited=await employee(login),id='reserve-conflicts';await seed(id,prepare);
    const run=application(id),cmd=command('same',credited.employeeId);await run.app.execute(cmd,login.credential);const before=await inspect(id);
    await auth.revokePermission({principalId:login.principalId,permissionId:'staff.record'});
    assert.equal((await run.app.execute(cmd,other.credential)).reason,'actor-mismatch');
    for(const changed of [{...cmd,expectedRevision:1},{...cmd,payload:{...cmd.payload,employee:randomUUID()}},
      {...cmd,payload:{...cmd.payload,note:'changed'}},{...cmd,action:'open'}]) {
      assert.equal((await run.app.execute(changed,login.credential)).reason,'request-mismatch');
    }
    assert.equal(run.executions(),1);await assertUnchanged(id,before);
  });

  await t.test('reserve: stale revision is terminal before any employee lookup',async()=>{
    const login=await provision(['staff.record']),id='reserve-stale';await seed(id,prepare);const run=application(id),cmd=command('stale',randomUUID(),99);
    const result=await run.app.execute(cmd,login.credential);assert.equal(result.status,'revision-conflict');assert.equal(run.executions(),0);
    assert.equal(sqlAt(run,table('employees'),'FOR SHARE'),-1);const before=await inspect(id);assert.equal(before.head.revision,0);assert.equal(before.audit.length,0);
    await auth.revokePermission({principalId:login.principalId,permissionId:'staff.record'});
    assert.deepEqual(await run.app.execute(cmd,login.credential),result);await assertUnchanged(id,before);
  });

  await t.test('reserve: future bookings preserve room state/history and original duplicate/review/source validation',async()=>{
    const login=await provision(['staff.record']),credited=await employee(login),id='reserve-domain';const original=await seed(id,s=>{prepare(s);s.rooms[0].status='营业中';});
    const run=application(id);assert.equal((await run.app.execute(command('a',credited.employeeId),login.credential)).status,'committed');
    assert.equal((await run.app.execute(command('b',credited.employeeId,1,{dayOffset:3,session:'afternoon',source:'美团'}),login.credential)).status,'committed');
    assert.equal((await run.app.execute(command('duplicate',credited.employeeId,2),login.credential)).status,'business-rejected');
    const actual=await inspect(id);assert.equal(actual.head.revision,2);assert.equal(actual.head.state.reservations.length,2);
    assert.equal(actual.head.state.rooms[0].status,'营业中');assert.deepEqual(actual.head.state.orders,original.orders);assert.deepEqual(actual.head.state.inventory,original.inventory);
    for(const [label,changes,prepareState] of [['source',{source:'微信'},prepare],['date',{dayOffset:31},prepare],['session',{session:'invalid'},prepare],
      ['room',{},s=>{prepare(s);s.rooms[0].status='故障/维护中';}],['review',{},s=>{prepare(s);s.roomIssueReviews.push({room:'V01',status:'待审核'});}]]) {
      const ledgerId='reserve-invalid-'+label;const state=await seed(ledgerId,prepareState),testRun=application(ledgerId);
      assert.equal((await testRun.app.execute(command('invalid',credited.employeeId,0,changes),login.credential)).status,'business-rejected');
      const rejected=await inspect(ledgerId);assert.equal(rejected.head.revision,0);assert.deepEqual(rejected.head.state,state);assert.equal(rejected.audit.length,0);
    }
  });

  await t.test('reserve: missing resolver cannot fall back to USERS, demo identity or clock',async()=>{
    const login=await provision(['staff.record']),credited=await employee(login),id='reserve-no-resolver';await seed(id,prepare);const before=await inspect(id);
    const run=application(id,{employeeBind:null});await assert.rejects(run.app.execute(command('blocked',credited.employeeId),login.credential),TypeError);
    assert.equal(run.executions(),0);await assertUnchanged(id,before);
  });

  await t.test('reserve: actual employee SELECT SQL failure rolls back and original key can retry after repair',async()=>{
    const login=await provision(['staff.record']),credited=await employee(login),id='reserve-resolver-sql';await seed(id,prepare);const before=await inspect(id);
    const store=createMySqlEmployeeStore({pool,database});
    const bind=connection=>store.bindEmployeeResolver({query:(...args)=>connection.query(...args),execute:(sql,values)=>connection.execute(
      sql.startsWith('SELECT employee_id, display_name, enabled')?sql.replace('employee_id,','missing_reserve_column,'):sql,values)});
    const run=application(id,{employeeBind:bind});await assert.rejects(run.app.execute(command('repair',credited.employeeId),login.credential),error=>error.code==='ER_BAD_FIELD_ERROR');
    assert.ok(run.calls.some(c=>c.kind==='rollback'));await assertUnchanged(id,before);
    assert.equal((await application(id).app.execute(command('repair',credited.employeeId),login.credential)).status,'committed');
  });

  await t.test('reserve: unknown error after domain mutation rolls back; original key is not consumed',async()=>{
    const login=await provision(['staff.record']),credited=await employee(login),id='reserve-unknown';await seed(id,prepare);const before=await inspect(id);let fail=true;
    const run=application(id,{transactCommand:(...args)=>{const next=transact(...args);if(fail) throw Error('synthetic reserve unknown fault');return next;}});
    await assert.rejects(run.app.execute(command('repair',credited.employeeId),login.credential),/synthetic reserve unknown fault/);await assertUnchanged(id,before);
    fail=false;assert.equal((await run.app.execute(command('repair',credited.employeeId),login.credential)).status,'committed');
  });

  await t.test('reserve: audit SQL failure after state/operation writes fully rolls back, including revision',async()=>{
    const login=await provision(['staff.record']),credited=await employee(login),id='reserve-sql';await seed(id,prepare);
    const before=await inspect(id),rosterBefore=await readEmployees(),run=application(id);
    await setup.query('ALTER TABLE '+table('ledger_success_audit')+" ADD CONSTRAINT chk_reserve_fault CHECK (ledger_id <> 'reserve-sql')");
    try {
      await assert.rejects(run.app.execute(command('repair',credited.employeeId),login.credential),error=>error.code==='ER_CHECK_CONSTRAINT_VIOLATED');
      assert.ok(sqlAt(run,'ledger_heads','UPDATE')>=0);assert.ok(sqlAt(run,'ledger_operations','INSERT')>=0);
      assert.ok(run.calls.some(c=>c.kind==='rollback'));await assertUnchanged(id,before);assert.deepEqual(await readEmployees(),rosterBefore);
    } finally {await setup.query('ALTER TABLE '+table('ledger_success_audit')+' DROP CHECK chk_reserve_fault');}
    assert.equal((await run.app.execute(command('repair',credited.employeeId),login.credential)).status,'committed');
  });

  await t.test('reserve: two independent connections preserve one old-revision success and same-key single execution',async()=>{
    const login=await provision(['staff.record']),credited=await employee(login),a=await pool.getConnection(),b=await pool.getConnection();
    try {
      const [[aId]]=await a.query('SELECT CONNECTION_ID() AS id'),[[bId]]=await b.query('SELECT CONNECTION_ID() AS id');assert.notEqual(aId.id,bId.id);
      const aPool={getConnection:async()=>wrapConnection(a,[],false)},bPool={getConnection:async()=>wrapConnection(b,[],false)};
      for(const sameKey of [false,true]) {
        const id='reserve-race-'+sameKey;await seed(id,prepare);const first=application(id,{connectionPool:aPool}),second=application(id,{connectionPool:bPool});
        const results=await Promise.all([first.app.execute(command('a',credited.employeeId),login.credential),
          second.app.execute(command(sameKey?'a':'b',credited.employeeId,0,sameKey?{}:{room:'V02'}),login.credential)]);
        if(sameKey) assert.deepEqual(results[0],results[1]);else assert.deepEqual(results.map(r=>r.status).sort(),['committed','revision-conflict']);
        const actual=await inspect(id);assert.equal(actual.head.revision,1);assert.equal(actual.head.state.reservations.length,1);
        assert.equal(actual.operations.length,sameKey?1:2);assert.equal(actual.audit.length,1);assert.equal(first.executions()+second.executions(),1);
      }
      t.diagnostic('reserve revision/same-key races used two verified independent CONNECTION_ID values');
    } finally {try {await a.rollback();await b.rollback();} finally {a.release();b.release();}}
  });

  await t.test('reserve: employee shared lock holds until commit; independent disable waits then succeeds',async()=>{
    const login=await provision(['staff.record']),admin=await provision([]),credited=await employee(login),id='reserve-before-disable';await seed(id,prepare);
    const a=await pool.getConnection(),b=await pool.getConnection(),store=createMySqlEmployeeStore({pool,database});
    const [[previous]]=await b.query('SELECT @@innodb_lock_wait_timeout AS seconds');let unblock,heldResolve,heldReject;
    const gate=new Promise(resolve=>{unblock=resolve;}),held=new Promise((resolve,reject)=>{heldResolve=resolve;heldReject=reject;});
    const bind=connection=>{const resolver=store.bindEmployeeResolver(connection);return {async resolveCreditedEmployeeInTransaction(input){
      const facts=await resolver.resolveCreditedEmployeeInTransaction(input);heldResolve();await gate;return facts;
    }};};
    const run=application(id,{connectionPool:{getConnection:async()=>wrapConnection(a,[],false)},employeeBind:bind});let executing;
    try {
      const [[aId]]=await a.query('SELECT CONNECTION_ID() AS id'),[[bId]]=await b.query('SELECT CONNECTION_ID() AS id');assert.notEqual(aId.id,bId.id);
      await b.query('SET SESSION innodb_lock_wait_timeout=1');executing=run.app.execute(command('first',credited.employeeId),login.credential);executing.catch(heldReject);await held;
      const other=createEmployeeService({store:createMySqlEmployeeStore({pool:{getConnection:async()=>wrapConnection(b,[],false)},database})});
      await assert.rejects(other.disableEmployee({employeeId:credited.employeeId},{actorPrincipalId:admin.principalId}),error=>error.code==='ER_LOCK_WAIT_TIMEOUT');
      unblock();assert.equal((await executing).status,'committed');
      assert.equal((await other.disableEmployee({employeeId:credited.employeeId},{actorPrincipalId:admin.principalId})).changed,true);
      const actual=await inspect(id);assert.equal(actual.head.state.reservations[0].creditedEmployeeNameSnapshot,credited.displayName);
      assert.equal(actual.head.revision,1);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);
      t.diagnostic('reserve-first/disable uses two verified connections; InnoDB row wait was actually observed');
    } finally {unblock();if(executing)await Promise.allSettled([executing]);try {await a.rollback();await b.rollback();await b.query('SET SESSION innodb_lock_wait_timeout=?',[Number(previous.seconds)]);}finally{a.release();b.release();}}
  });

  await t.test('reserve: prior employee disable blocks resolver; rollback leaves key free, committed disable rejects retry',async()=>{
    const login=await provision(['staff.record']),admin=await provision([]),credited=await employee(login),id='disable-before-reserve';await seed(id,prepare);const before=await inspect(id);
    const a=await pool.getConnection(),b=await pool.getConnection();const [[previous]]=await a.query('SELECT @@innodb_lock_wait_timeout AS seconds');
    let unblock,heldResolve,heldReject;const gate=new Promise(resolve=>{unblock=resolve;}),held=new Promise((resolve,reject)=>{heldResolve=resolve;heldReject=reject;});let disabling;
    try {
      const [[aId]]=await a.query('SELECT CONNECTION_ID() AS id'),[[bId]]=await b.query('SELECT CONNECTION_ID() AS id');assert.notEqual(aId.id,bId.id);
      await a.query('SET SESSION innodb_lock_wait_timeout=1');
      const store=createMySqlEmployeeStore({pool:{getConnection:async()=>wrapConnection(b,[],false)},database});
      disabling=store.runTransaction(async tx=>{
        assert.equal((await tx.lockAccount(admin.principalId)).enabled,true);await tx.lockEmployee(credited.employeeId);
        await tx.disableEmployee(credited.employeeId);await tx.appendEvent({employeeId:credited.employeeId,actorPrincipalId:admin.principalId,
          eventType:'employee-disabled',beforePrincipalId:null,afterPrincipalId:null});heldResolve();await gate;
      });disabling.catch(heldReject);await held;
      const run=application(id,{connectionPool:{getConnection:async()=>wrapConnection(a,[],false)}}),cmd=command('retry',credited.employeeId);
      await assert.rejects(run.app.execute(cmd,login.credential),error=>error.code==='ER_LOCK_WAIT_TIMEOUT');await assertUnchanged(id,before);
      unblock();await disabling;
      assert.equal((await run.app.execute(cmd,login.credential)).status,'business-rejected');
      const actual=await inspect(id);assert.deepEqual(actual.head,before.head);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,0);
      t.diagnostic('disable-first/reserve uses two verified connections; actual row-lock timeout then current disabled read');
    } finally {unblock();if(disabling)await Promise.allSettled([disabling]);try{await a.rollback();await b.rollback();await a.query('SET SESSION innodb_lock_wait_timeout=?',[Number(previous.seconds)]);}finally{a.release();b.release();}}
  });
}
