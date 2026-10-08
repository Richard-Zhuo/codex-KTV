import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { withBackupFixture } from '../test-support/backup-fixture.js';
import { backupDatabase,restoreDatabase,connect,readTables } from '../backup/mysql-backup.js';
import { verifyRecovery,resumeRecovery } from './operator.js';
import { schemaSpec,canonical,digest } from '../backup/format.js';
import { recoveryMode } from './gate.js';
function processRun(operation,args,checkpoint){
 const child=fork(new URL('../test-support/recovery-process.js',import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc'],env:{...process.env}});
 const messages=[],waiters=[];
 child.on('message',value=>{const waiter=waiters.shift();if(waiter)waiter(value);else messages.push(value);});
 child.send({operation,args,checkpoint});
 return {next:()=>messages.length?Promise.resolve(messages.shift()):new Promise(resolve=>waiters.push(resolve)),
  proceed:()=>child.send({continue:true}),async kill(){if(child.exitCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}},child};
}
const fixtureTest=(name,run)=>test(name,{skip:!process.env.LEDGER_MYSQL_TEST_URL,timeout:60000},()=>withBackupFixture(run));
fixtureTest('restore crash after schema preparation preserves durable RESTORING gate',async f=>{
 const backup=await backupDatabase({...f.backupArgs,outputDirectory:join(f.dir,'schema-crash')}),target=f.targetArgs(backup,'schema_crash');
 const child=processRun('restore',target,'CREATE TABLE recovery_events');
 try{assert.equal((await child.next()).type,'checkpoint');}finally{await child.kill();}
 const c=await connect(target.databaseUrl);
 try{assert.equal((await c.query('SHOW TABLES'))[0].length,20);assert.equal(await recoveryMode(c),'RESTORING');}finally{await c.end();}
 const probe=processRun('probe',target);
 try{const result=await probe.next();assert.equal(result.type,'result');assert.equal(result.result.status,503);assert.equal(result.result.providerCalls,0);assert.equal(result.result.writeCode,'RECOVERY_WRITE_FROZEN');}finally{await probe.kill();}
});
fixtureTest('resume holds authority rows until NORMAL, then retries are no-op',async f=>{
 const backup=await backupDatabase({...f.backupArgs,outputDirectory:join(f.dir,'resume-race')}),target=f.targetArgs(backup,'resume_race');await restoreDatabase(target);await verifyRecovery(target);
 const args={...target,confirmation:target.confirmation+'/RESUME'},child=processRun('resume',args,'SELECT * FROM employees'),c=await connect(target.databaseUrl);
 try{
  assert.equal((await child.next()).type,'checkpoint');await c.query('SET SESSION innodb_lock_wait_timeout=1');
  await assert.rejects(c.execute('UPDATE employees SET display_name=? WHERE employee_id=?',['Concurrent edit',f.people[0].employeeId]),{code:'ER_LOCK_WAIT_TIMEOUT'});
  await assert.rejects(c.query("INSERT INTO auth_events(event_type) VALUES('login-failure')"),{code:'ER_LOCK_WAIT_TIMEOUT'});
  child.proceed();const result=await child.next();assert.equal(result.type,'result');assert.equal(result.result.code,'RECOVERY_RESUMED');
  const before=(await c.query('SELECT COUNT(*) AS n FROM recovery_events'))[0][0].n;
  assert.equal((await resumeRecovery(args)).code,'RECOVERY_ALREADY_NORMAL');
  assert.equal((await c.query('SELECT COUNT(*) AS n FROM recovery_events'))[0][0].n,before);
 }finally{await child.kill();await c.end();}
});
fixtureTest('session invalidation crash rolls back; all recovery modes survive process restart',async f=>{
 await f.auth.login({loginIdentifier:f.people[0].loginIdentifier,password:f.secret});await f.auth.login({loginIdentifier:f.people[0].loginIdentifier,password:f.secret});
 const backup=await backupDatabase({...f.backupArgs,outputDirectory:join(f.dir,'session-crash')}),target=f.targetArgs(backup,'session_crash');await restoreDatabase(target);
 const child=processRun('verify',target,'UPDATE auth_sessions SET revoked_at');
 try{assert.equal((await child.next()).type,'checkpoint');}finally{await child.kill();}
 const c=await connect(target.databaseUrl);
 try{
  assert.equal(await recoveryMode(c),'VERIFYING');assert.equal(Number((await c.query('SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL'))[0][0].n),3);
  const verified=await verifyRecovery(target);assert.equal(verified.sessionsInvalidated,3);
  assert.equal(Number((await c.query('SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL'))[0][0].n),0);
  const [events]=await c.query("SELECT occurred_at,reason_code FROM auth_events WHERE reason_code='recovery-cutover'");assert.equal(events.length,3);assert.ok(events.every(e=>e.occurred_at));
  for(const mode of ['FROZEN','RESTORING','VERIFYING','READY_FOR_RESUME']){
   await c.execute('UPDATE recovery_control SET mode=? WHERE control_id=1',[mode]);
   const first=processRun('probe',target);try{const result=await first.next();assert.equal(result.type,'result');assert.equal(result.result.mode,mode);}finally{await first.kill();}
   const restarted=processRun('probe',target);try{const result=await restarted.next();assert.deepEqual(result.result,{mode,status:503,delegated:false,writeCode:'RECOVERY_WRITE_FROZEN',dispatchCode:'RECOVERY_WORKER_PAUSED',providerCalls:0});}finally{await restarted.kill();}
  }
 }finally{await c.end();}
});
fixtureTest('migration 011 upgrades 001-010 without changing business facts and fails safely on repetition',async f=>{
 const spec=await schemaSpec(),ddl=spec.statements.filter(s=>/^CREATE TABLE recovery_(control|events)/.test(s));assert.equal(ddl.length,2);
 const business=async()=>digest(canonical(await readTables(f.setup,['ledger_heads','auth_accounts'])));
 const before=await business();await f.setup.query('DROP TABLE recovery_events');await f.setup.query('DROP TABLE recovery_control');
 assert.equal((await f.setup.query('SHOW TABLES'))[0].length,18);
 for(const sql of ddl)await f.setup.query(sql);
 assert.equal(await business(),before);assert.equal(await recoveryMode(f.setup),'NORMAL');
 await assert.rejects(f.setup.query(ddl[0]),{code:'ER_TABLE_EXISTS_ERROR'});assert.equal(await business(),before);
 await f.setup.query('DROP TABLE recovery_events');
 await assert.rejects(f.setup.query(ddl[0]),{code:'ER_TABLE_EXISTS_ERROR'});
 await f.setup.query(ddl[1]);assert.equal((await f.setup.query('SHOW TABLES'))[0].length,20);assert.equal(await business(),before);
});

fixtureTest('128 MiB backup failure produces no artifact directory or completed manifest',async f=>{
 const outputDirectory=join(f.dir,'oversize'),child=processRun('size',{...f.backupArgs,outputDirectory});
 try{const result=await child.next();assert.deepEqual(result,{type:'error',code:'BACKUP_SIZE_LIMIT'});await assert.rejects(stat(outputDirectory),{code:'ENOENT'});}finally{await child.kill();}
});
