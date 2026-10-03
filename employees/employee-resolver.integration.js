// Uses the roster fixture's existing seven tables; no DDL or cleanup ownership.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMySqlEmployeeStore } from './mysql-store.js';
import { EmployeeRosterError } from './errors.js';
const isCode=code=>error=>error instanceof EmployeeRosterError&&error.code===code;
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}

export async function runEmployeeResolverIntegrationTests(t,{pool,database,roster,context,create,account,snapshot,readEvents,makeRoster,ownedPool}){
  const quote=String.fromCharCode(96), employees=quote+database+quote+'.'+quote+'employees'+quote;
  const noPool={getConnection(){assert.fail('resolver must not acquire a connection');}};
  const store=createMySqlEmployeeStore({pool:noPool,database});
  function bind(connection,calls=[],{failLookup=false}={}){
    const supplied={
      async query(sql,params){calls.push(['query',sql]);return connection.query(sql,params);},
      async execute(sql,params){calls.push(['sql',sql,params]);
        const actual=failLookup&&sql.startsWith('SELECT employee_id, display_name, enabled')?sql.replace('display_name','missing_employee_test_column'):sql;
        return connection.execute(actual,params);
      }
    };
    for(const method of ['beginTransaction','commit','rollback','release','destroy']) supplied[method]=()=>assert.fail('resolver must not call '+method);
    return store.bindEmployeeResolver(supplied);
  }
  async function inTransaction(work){const connection=await pool.getConnection(), calls=[];
    try{await connection.beginTransaction();return await work(connection,bind(connection,calls),calls);}
    finally{try{await connection.rollback();}finally{connection.release();}}
  }
  const resolve=(bound,employeeId)=>bound.resolveCreditedEmployeeInTransaction({creditedEmployeeId:employeeId});
  const sqlWrite=(connection,employeeId,name)=>connection.execute('UPDATE '+employees+' SET display_name = ? WHERE employee_id = ?',[name,employeeId]);

  await t.test('resolver: enabled employee returns trusted snapshot independently of actual actor and linked principal',async()=>{
    const employee=await create('Synthetic Resolver Enabled'), principalId=await account();
    assert.notEqual(principalId,context.actorPrincipalId);await roster.linkPrincipal({employeeId:employee.employeeId,principalId},context);
    const before=await snapshot();
    await inTransaction(async(connection,bound)=>{const result=await resolve(bound,employee.employeeId);
      assert.deepEqual(result,{employeeId:employee.employeeId,displayName:employee.displayName});assert.equal(Object.isFrozen(result),true);
      assert.ok(!Object.hasOwn(result,'actualActorPrincipalId'));assert.ok(!Object.hasOwn(result,'principalId'));
    });assert.deepEqual(await snapshot(),before);
  });
  await t.test('resolver: disabled employee is rejected and retained without history rewrite',async()=>{
    const employee=await create('Synthetic Resolver Disabled');await roster.disableEmployee({employeeId:employee.employeeId},context);
    const before=await snapshot();await inTransaction(async(connection,bound)=>{await assert.rejects(resolve(bound,employee.employeeId),isCode('EMPLOYEE_DISABLED'));});
    assert.deepEqual(await snapshot(),before);assert.equal((await roster.getEmployee({employeeId:employee.employeeId})).displayName,employee.displayName);
  });
  await t.test('resolver: absent UUID and principal UUID reject without guessing employees',async()=>{
    await inTransaction(async(connection,bound)=>{for(const id of [randomUUID(),context.actorPrincipalId]) await assert.rejects(resolve(bound,id),isCode('EMPLOYEE_NOT_FOUND'));});
  });
  await t.test('resolver: an enabled employee with no account remains valid attribution',async()=>{
    const employee=await create('Synthetic Resolver No Account');assert.equal(employee.principalId,null);
    await inTransaction(async(connection,bound)=>assert.deepEqual(await resolve(bound,employee.employeeId),{employeeId:employee.employeeId,displayName:employee.displayName}));
  });
  await t.test('resolver: same-name employees remain distinct by stable UUID',async()=>{
    const a=await create('Synthetic Resolver Same'), b=await create('Synthetic Resolver Same');
    await inTransaction(async(connection,bound)=>{const first=await resolve(bound,a.employeeId), second=await resolve(bound,b.employeeId);
      assert.equal(first.displayName,second.displayName);assert.notEqual(first.employeeId,second.employeeId);assert.equal(first.employeeId,a.employeeId);assert.equal(second.employeeId,b.employeeId);
    });
  });
  await t.test('resolver: caller rollback undoes prior writes and does not mutate captured snapshots',async()=>{
    const employee=await create('Synthetic Resolver Rollback'), before=await snapshot();
    await inTransaction(async(connection,bound)=>{const first=await resolve(bound,employee.employeeId);
      await sqlWrite(connection,employee.employeeId,'Synthetic Uncommitted Name');const second=await resolve(bound,employee.employeeId);
      assert.equal(second.displayName,'Synthetic Uncommitted Name');assert.equal(first.displayName,employee.displayName);
    });assert.deepEqual(await snapshot(),before);
  });
  await t.test('resolver: only caller connection is used with no lifecycle, audit or activity writes',async()=>{
    const employee=await create('Synthetic Resolver Ownership'), events=await readEvents(employee.employeeId);
    await inTransaction(async(connection,bound,calls)=>{await resolve(bound,employee.employeeId);
      assert.deepEqual(calls.map(call=>call[0]),['sql','query','sql']);assert.equal(calls[0][1],'DO 0');
      assert.equal(calls[1][1],'SELECT DATABASE() AS database_name');assert.ok(calls[2][1].endsWith(' WHERE employee_id = ? FOR SHARE'));
      assert.deepEqual(calls[2][2],[employee.employeeId]);assert.ok(!calls[2][1].includes('principal_id'));
      const [status]=await connection.execute('DO 0');assert.ok(status.serverStatus&1,'caller transaction is still active');
    });assert.deepEqual(await readEvents(employee.employeeId),events);
  });
  await t.test('resolver: actual SQL fault leaves caller transaction active for rollback of earlier writes',async()=>{
    const employee=await create('Synthetic Resolver SQL Fault'), before=await snapshot();
    await inTransaction(async(connection,bound,calls)=>{await sqlWrite(connection,employee.employeeId,'Synthetic To Roll Back');
      const failed=bind(connection,calls,{failLookup:true});await assert.rejects(resolve(failed,employee.employeeId),error=>error.code==='ER_BAD_FIELD_ERROR'&&!(error instanceof EmployeeRosterError));
      const [status]=await connection.execute('DO 0');assert.ok(status.serverStatus&1);
    });assert.deepEqual(await snapshot(),before);
  });
  await t.test('resolver: active transaction is required before lookup and after caller commit',async()=>{
    const employee=await create('Synthetic Resolver Active'), connection=await pool.getConnection(), calls=[];
    try{assert.throws(()=>store.bindEmployeeResolver(pool),TypeError);const bound=bind(connection,calls);
      await assert.rejects(resolve(bound,employee.employeeId),/已开启的事务/);assert.deepEqual(calls.map(call=>call[1]),['DO 0']);
      await connection.beginTransaction();await resolve(bound,employee.employeeId);await connection.commit();const length=calls.length;
      await assert.rejects(resolve(bound,employee.employeeId),/已开启的事务/);assert.equal(calls.length,length+1);assert.equal(calls.at(-1)[1],'DO 0');
    }finally{try{await connection.rollback();}finally{connection.release();}}
  });
  await t.test('resolver: FOR SHARE sees disable despite an older REPEATABLE READ snapshot',async()=>{
    const employee=await create('Synthetic Resolver Current'), connection=await pool.getConnection();
    try{await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await connection.beginTransaction();
      const read=()=>connection.execute('SELECT enabled FROM '+employees+' WHERE employee_id = ?',[employee.employeeId]);
      assert.equal((await read())[0][0].enabled,1);await roster.disableEmployee({employeeId:employee.employeeId},context);
      assert.equal((await read())[0][0].enabled,1,'non-locking repeatable snapshot remains old');
      await assert.rejects(resolve(bind(connection),employee.employeeId),isCode('EMPLOYEE_DISABLED'));
    }finally{try{await connection.rollback();}finally{connection.release();}}
  });
  await t.test('resolver first: shared employee lock blocks disable until caller finishes', {timeout:10000},async()=>{
    const employee=await create('Synthetic Resolver First'), a=await pool.getConnection(), b=await pool.getConnection(), calls=[];
    let oldTimeout;
    try{const [[first]]=await a.query('SELECT CONNECTION_ID() AS id'), [[second]]=await b.query('SELECT CONNECTION_ID() AS id');assert.notEqual(first.id,second.id);
      oldTimeout=Number((await b.query('SELECT @@session.innodb_lock_wait_timeout AS value'))[0][0].value);
      await b.query('SET SESSION innodb_lock_wait_timeout = 1');await a.beginTransaction();
      const captured=await resolve(bind(a),employee.employeeId);
      await assert.rejects(makeRoster(ownedPool(b,calls)).disableEmployee({employeeId:employee.employeeId},context),error=>error.code==='ER_LOCK_WAIT_TIMEOUT');
      assert.equal((await roster.getEmployee({employeeId:employee.employeeId})).enabled,true);
      assert.ok(calls.some(call=>call[0]==='rollback'));assert.ok(!calls.some(call=>call[0]==='commit'));
      const accountLock=calls.findIndex(call=>call[0]==='sql'&&call[1].startsWith('SELECT principal_id')&&call[1].endsWith('FOR UPDATE'));
      const employeeLock=calls.findIndex(call=>call[0]==='sql'&&call[1].startsWith('SELECT employee_id')&&call[1].endsWith('FOR UPDATE'));
      assert.ok(accountLock>=0&&employeeLock>accountLock);
      await a.commit();assert.equal((await makeRoster(ownedPool(b,[])).disableEmployee({employeeId:employee.employeeId},context)).employee.enabled,false);
      assert.equal(captured.displayName,employee.displayName);await a.beginTransaction();
      await assert.rejects(resolve(bind(a),employee.employeeId),isCode('EMPLOYEE_DISABLED'));
      t.diagnostic('resolver-first disable used two independent CONNECTION_ID values and a real InnoDB lock wait timeout');
    }finally{try{await a.rollback();await b.rollback();if(oldTimeout!==undefined)await b.query('SET SESSION innodb_lock_wait_timeout = ?',[oldTimeout]);}finally{a.release();b.release();}}
  });
  await t.test('disable first: resolver waits for exclusive employee lock and then rejects committed disable', {timeout:10000},async()=>{
    const employee=await create('Synthetic Disable First'), a=await pool.getConnection(), b=await pool.getConnection(), calls=[];
    const atCommit=deferred(), finishCommit=deferred();let pending,oldTimeout;
    try{const [[first]]=await a.query('SELECT CONNECTION_ID() AS id'), [[second]]=await b.query('SELECT CONNECTION_ID() AS id');assert.notEqual(first.id,second.id);
      oldTimeout=Number((await a.query('SELECT @@session.innodb_lock_wait_timeout AS value'))[0][0].value);await a.query('SET SESSION innodb_lock_wait_timeout = 1');
      const managed=await ownedPool(b,calls).getConnection(), commit=managed.commit;
      managed.commit=async()=>{atCommit.resolve();await finishCommit.promise;return commit.call(managed);};
      pending=makeRoster({getConnection:async()=>managed}).disableEmployee({employeeId:employee.employeeId},context).then(value=>({value}),error=>({error}));
      await Promise.race([atCommit.promise,pending.then(result=>{throw result.error||Error('disable never reached commit');})]);
      await a.beginTransaction();await assert.rejects(resolve(bind(a),employee.employeeId),error=>error.code==='ER_LOCK_WAIT_TIMEOUT'&&!(error instanceof EmployeeRosterError));
      finishCommit.resolve();const result=await pending;assert.ifError(result.error);assert.equal(result.value.employee.enabled,false);
      await a.rollback();await a.beginTransaction();await assert.rejects(resolve(bind(a),employee.employeeId),isCode('EMPLOYEE_DISABLED'));
      assert.equal((await readEvents(employee.employeeId)).at(-1).event_type,'employee-disabled');
      t.diagnostic('disable-first resolver used two independent CONNECTION_ID values and a real InnoDB lock wait timeout');
    }finally{finishCommit.resolve();if(pending)await pending;
      try{await a.rollback();await b.rollback();if(oldTimeout!==undefined)await a.query('SET SESSION innodb_lock_wait_timeout = ?',[oldTimeout]);}finally{a.release();b.release();}
    }
  });
}
