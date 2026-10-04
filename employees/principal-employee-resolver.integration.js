// Extends only the existing guarded roster fixture; no DDL or cleanup ownership.
import assert from 'node:assert/strict';
import { createMySqlEmployeeStore } from './mysql-store.js';
import { EmployeeRosterError } from './errors.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { digestSessionToken } from '../auth/session-token.js';
const isCode=code=>error=>error instanceof EmployeeRosterError&&error.code===code;
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
export async function runPrincipalEmployeeResolverIntegrationTests(t,{pool,database,roster,context,create,auth,snapshot,makeRoster,ownedPool}){
 const quote=String.fromCharCode(96),table=name=>quote+database+quote+'.'+quote+name+quote;
 const noPool={getConnection(){assert.fail('resolver must use caller connection');}};
 const store=createMySqlEmployeeStore({pool:noPool,database}),authStore=createMySqlAuthStore({pool:noPool,database});let serial=0;
 async function provision({linked=true,disabled=false,name='Synthetic Principal Employee'}={}){
  const loginIdentifier='synthetic-principal-resolver-'+(++serial),password='synthetic-principal-resolver-password';
  const account=await auth.createAccount({loginIdentifier,password}),login=await auth.login({loginIdentifier,password});assert.equal(login.ok,true);
  let employee=null;
  if(linked){employee=await create(name);await roster.linkPrincipal({employeeId:employee.employeeId,principalId:account.principalId},context);
   if(disabled)await roster.disableEmployee({employeeId:employee.employeeId},context);}
  return {...account,employee,tokenDigest:digestSessionToken(login.token)};
 }
 function bind(connection,calls=[],fail=false){
  const supplied={query:async(sql,p)=>{calls.push(['query',sql]);return connection.query(sql,p);},
   execute:async(sql,p)=>{calls.push(['sql',sql,p]);return connection.execute(fail&&sql.startsWith('SELECT employee_id, display_name, enabled, principal_id')?sql.replace('display_name','missing_principal_employee_column'):sql,p);}};
  for(const method of ['beginTransaction','commit','rollback','release','destroy']) supplied[method]=()=>assert.fail('resolver must not '+method);
  return store.bindEmployeeResolver(supplied);
 }
 async function revalidate(connection,login){const trustedContext=await authStore.bindSessionRevalidation(connection).revalidateSessionInTransaction({tokenDigest:login.tokenDigest});assert.ok(trustedContext);return trustedContext;}
 async function inTransaction(login,work){const connection=await pool.getConnection(),calls=[];
  try{await connection.beginTransaction();const trustedContext=await revalidate(connection,login);return await work(connection,bind(connection,calls),trustedContext,calls);}
  finally{try{await connection.rollback();}finally{connection.release();}}
 }
 const resolve=(bound,trustedContext)=>bound.resolvePrincipalEmployeeInTransaction({trustedContext});
 await t.test('principal resolver: session principal locates linked enabled employee without conflating IDs',async()=>{
  const login=await provision(),before=await snapshot();
  await inTransaction(login,async(c,bound,trustedContext)=>{const employee=await resolve(bound,trustedContext);
   assert.deepEqual(employee,{employeeId:login.employee.employeeId,displayName:login.employee.displayName});
   assert.notEqual(employee.employeeId,trustedContext.principalId);assert.equal(Object.isFrozen(employee),true);
  });assert.deepEqual(await snapshot(),before);
 });
 await t.test('principal resolver: unlinked account fails closed even when same-name employees exist',async()=>{
  const login=await provision({linked:false});await create('Synthetic Principal Employee');
  await inTransaction(login,async(c,bound,trustedContext)=>assert.rejects(resolve(bound,trustedContext),isCode('EMPLOYEE_PRINCIPAL_NOT_LINKED')));
 });
 await t.test('principal resolver: disabled linked employee fails closed and is retained',async()=>{
  const login=await provision({disabled:true}),before=await snapshot();
  await inTransaction(login,async(c,bound,trustedContext)=>assert.rejects(resolve(bound,trustedContext),isCode('EMPLOYEE_DISABLED')));
  assert.deepEqual(await snapshot(),before);
 });
 await t.test('principal resolver: same-name employees remain distinct by explicit principal associations',async()=>{
  const a=await provision(),b=await provision();
  const first=await inTransaction(a,(c,bound,ctx)=>resolve(bound,ctx)),second=await inTransaction(b,(c,bound,ctx)=>resolve(bound,ctx));
  assert.equal(first.displayName,second.displayName);assert.notEqual(first.employeeId,second.employeeId);
  assert.equal(first.employeeId,a.employee.employeeId);assert.equal(second.employeeId,b.employee.employeeId);
 });
 await t.test('principal resolver: caller owns connection and transaction; only current shared linkage read',async()=>{
  const login=await provision();const sessions=async()=> (await pool.execute('SELECT * FROM '+table('auth_sessions')+' WHERE principal_id = ?',[login.principalId]))[0];
  const before=await sessions();
  await inTransaction(login,async(c,bound,ctx,calls)=>{await resolve(bound,ctx);
   assert.deepEqual(calls.map(x=>x[0]),['sql','query','sql']);assert.equal(calls[0][1],'DO 0');
   assert.ok(calls[2][1].endsWith(' WHERE principal_id = ? FOR SHARE'));assert.deepEqual(calls[2][2],[login.principalId]);
   const [status]=await c.execute('DO 0');assert.ok(status.serverStatus&1);
  });assert.deepEqual(await sessions(),before);
 });
 await t.test('principal resolver: caller rollback undoes writes while snapshots remain immutable',async()=>{
  const login=await provision(),before=await snapshot();
  await inTransaction(login,async(c,bound,ctx)=>{const first=await resolve(bound,ctx);
   await c.execute('UPDATE '+table('employees')+' SET display_name = ? WHERE employee_id = ?',['Synthetic Uncommitted',login.employee.employeeId]);
   assert.equal((await resolve(bound,ctx)).displayName,'Synthetic Uncommitted');assert.equal(first.displayName,login.employee.displayName);
  });assert.deepEqual(await snapshot(),before);
 });
 await t.test('principal resolver: actual SQL failure belongs to caller and rolls back earlier writes',async()=>{
  const login=await provision(),before=await snapshot();
  await inTransaction(login,async(c,bound,ctx,calls)=>{
   await c.execute('UPDATE '+table('employees')+' SET display_name = ? WHERE employee_id = ?',['Synthetic SQL Rollback',login.employee.employeeId]);
   await assert.rejects(resolve(bind(c,calls,true),ctx),error=>error.code==='ER_BAD_FIELD_ERROR'&&!(error instanceof EmployeeRosterError));
   const [status]=await c.execute('DO 0');assert.ok(status.serverStatus&1);
  });assert.deepEqual(await snapshot(),before);
 });
 await t.test('principal resolver: inactive transaction and raw identity fields cannot bypass the capability',async()=>{
  const login=await provision(),c=await pool.getConnection();
  try{await c.beginTransaction();const ctx=await revalidate(c,login);await c.commit();
   await assert.rejects(resolve(bind(c),ctx),/已开启的事务/);
   await c.beginTransaction();await assert.rejects(bind(c).resolvePrincipalEmployeeInTransaction({principalId:login.principalId}),TypeError);
  }finally{try{await c.rollback();}finally{c.release();}}
 });
 await t.test('principal resolver first: account then employee locks serialize concurrent disable on two connections',{timeout:10000},async()=>{
  const login=await provision(),a=await pool.getConnection(),b=await pool.getConnection(),calls=[];let oldTimeout;
  try{assert.notEqual((await a.query('SELECT CONNECTION_ID() AS id'))[0][0].id,(await b.query('SELECT CONNECTION_ID() AS id'))[0][0].id);
   oldTimeout=Number((await b.query('SELECT @@session.innodb_lock_wait_timeout AS value'))[0][0].value);await b.query('SET SESSION innodb_lock_wait_timeout = 1');
   await a.beginTransaction();const ctx=await revalidate(a,login);await resolve(bind(a),ctx);
   await assert.rejects(makeRoster(ownedPool(b,calls)).disableEmployee({employeeId:login.employee.employeeId},context),error=>error.code==='ER_LOCK_WAIT_TIMEOUT');
   assert.ok(calls.some(x=>x[0]==='sql'&&x[1].includes('auth_accounts')&&x[1].endsWith('FOR UPDATE')));
   assert.ok(calls.some(x=>x[0]==='rollback'));await a.commit();
   await makeRoster(ownedPool(b,[])).disableEmployee({employeeId:login.employee.employeeId},context);
   await a.beginTransaction();const current=await revalidate(a,login);await assert.rejects(resolve(bind(a),current),isCode('EMPLOYEE_DISABLED'));
  }finally{try{await a.rollback();await b.rollback();if(oldTimeout!==undefined)await b.query('SET SESSION innodb_lock_wait_timeout = ?',[oldTimeout]);}finally{a.release();b.release();}}
 });
 await t.test('disable first: authenticated resolution waits for account lock then rejects disabled employee',{timeout:10000},async()=>{
  const login=await provision(),a=await pool.getConnection(),b=await pool.getConnection(),calls=[];
  const atCommit=deferred(),finish=deferred();let pending,oldTimeout;
  try{assert.notEqual((await a.query('SELECT CONNECTION_ID() AS id'))[0][0].id,(await b.query('SELECT CONNECTION_ID() AS id'))[0][0].id);
   oldTimeout=Number((await a.query('SELECT @@session.innodb_lock_wait_timeout AS value'))[0][0].value);await a.query('SET SESSION innodb_lock_wait_timeout = 1');
   const managed=await ownedPool(b,calls).getConnection(),commit=managed.commit;
   managed.commit=async()=>{atCommit.resolve();await finish.promise;return commit.call(managed);};
   pending=makeRoster({getConnection:async()=>managed}).disableEmployee({employeeId:login.employee.employeeId},context).then(value=>({value}),error=>({error}));
   await Promise.race([atCommit.promise,pending.then(result=>{throw result.error||Error('disable missed commit');})]);
   await a.beginTransaction();await assert.rejects(revalidate(a,login),error=>error.code==='ER_LOCK_WAIT_TIMEOUT');await a.rollback();
   finish.resolve();const result=await pending;assert.ifError(result.error);assert.equal(result.value.employee.enabled,false);
   await a.beginTransaction();const ctx=await revalidate(a,login);await assert.rejects(resolve(bind(a),ctx),isCode('EMPLOYEE_DISABLED'));
  }finally{finish.resolve();if(pending)await pending;
   try{await a.rollback();await b.rollback();if(oldTimeout!==undefined)await a.query('SET SESSION innodb_lock_wait_timeout = ?',[oldTimeout]);}finally{a.release();b.release();}}
 });
}
