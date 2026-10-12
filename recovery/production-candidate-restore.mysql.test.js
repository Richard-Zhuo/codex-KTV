import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import {join} from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {withBackupFixture} from '../test-support/backup-fixture.js';
import {backupDatabase,restoreDatabase,readTables,createOfficialRestoreSchema,importStructuredBackupRows} from '../backup/mysql-backup.js';
import {canonical,digest,schemaSpec} from '../backup/format.js';
import {validateSchema} from '../production/schema.js';
import {createAuthService} from '../auth/service.js';
import {createMySqlAuthStore} from '../auth/mysql-store.js';
import {createMemoryLoginRateLimiter} from '../auth/rate-limit.js';
import {inspectProductionRestore,planBinding} from './production-plan.js';
import {freezePreparedCandidate,restorePreparedCandidate,issueOwnedCandidateCapability} from './production-candidate.js';
import {readExecutionState,transitionExecutionState} from './production-journal.js';
import {bindRecoveryWriteGuard,withRecoveryDispatch} from './gate.js';
import {verifyRecovery,resumeRecovery} from './operator.js';

function genericArgs(x,resume=false){
 const base={directory:x.backup.directory,expectedChecksum:x.backup.checksum,
  databaseUrl:x.targetUrl,serverUuid:x.b.identity.server_uuid,environment:'production',
  storeId:x.b.storeId,ledgerId:x.b.ledgerId,initiatedBy:'synthetic-drill'};
 const database=x.plan.targetDatabase;
 return {...base,confirmation:base.serverUuid+'/'+database+'/'+base.storeId+'/'+base.ledgerId+
  '/'+base.expectedChecksum+(resume?'/RESUME':'')};
}
const enabled=process.env.STAGE5E_RUN==='synthetic-only'&&
 process.env.STAGE5E_FIXTURE_ROOT&&process.env.LEDGER_MYSQL_TEST_URL;
if(enabled)test('S3-B owned candidate restore reaches VERIFYING and fails closed on drift/partial candidates',
 {timeout:240000},async t=>{
 const f={root:process.env.STAGE5E_FIXTURE_ROOT,
  names:{id:process.env.STAGE5E_FIXTURE_ID,database:'jbhh_ktv_test'},
  identity:{server_uuid:process.env.STAGE5E_FIXTURE_UUID},port:33313,
  dbUrl:()=>process.env.LEDGER_MYSQL_TEST_URL};
 const capability=await issueOwnedCandidateCapability(f);
 let index=0;
 async function scenario(label,work,{beforeBackup}={}){
  await withBackupFixture(async b=>{
   const name='phase2_'+String(++index)+'_'+label;
   await b.setup.query("UPDATE production_bootstrap_events SET environment='production'");
   await beforeBackup?.(b);
   const backup=await backupDatabase({...b.backupArgs,environment:'production',
    outputDirectory:join(f.root,'backups','s3b_'+name)});
   const journal=join(f.root,'artifacts',name);await mkdir(journal);
   const active=new URL(b.raw),admin=new URL(b.raw);admin.pathname='/';
   const config={config:{storeId:b.storeId,ledgerId:b.ledgerId,
    applicationCommit:b.backupArgs.applicationCommit,serviceAccountSid:'S-1-5-21-1-2-3-1001',
    monitoring:{backupDirectory:join(f.root,'backups')},
    recovery:{journalDirectory:journal}},apiEnv:{KTV_MYSQL_URL:active.href}};
   const connect=async url=>{
    const c=await mysql.createConnection({uri:url,dateStrings:true,jsonStrings:true,
     supportBigNumbers:true,bigNumberStrings:true});
    return {query:(sql,...params)=>sql==='SHOW GRANTS FOR CURRENT_USER()'?
     Promise.resolve([[{grant:'GRANT SHOW DATABASES ON *.* TO synthetic_operator'}]]):
     c.query(sql,...params),execute:(...args)=>c.execute(...args),end:()=>c.end()};
   };
   const load=async()=>config;
   const pathCheck=async(_loaded,artifact)=>({backup:config.config.monitoring.backupDirectory,
    journal,artifact});
   const deps={runtimeConfigFile:'synthetic-owned-fixture',load,pathCheck,connect,
    operatorLoad:async()=>admin.href,fileAcl:async()=>{}};
   const plan=await inspectProductionRestore({...deps,artifactDirectory:backup.directory,
    expectedChecksum:backup.checksum,now:new Date()});
   const planPath=join(journal,'active-plan.json');
   await writeFile(planPath,canonical(plan));
   const journalOptions={checkAcl:async()=>{},harden:async()=>{}};
   const readState=(dir,p)=>readExecutionState(dir,p,journalOptions);
   const transition=(dir,p,from,to)=>transitionExecutionState(dir,p,from,to,journalOptions);
   const args={...deps,capability,readState,transition};
   const freeze=()=>freezePreparedCandidate(args);
   const restore=extra=>restorePreparedCandidate({...args,...extra});
   const targetExists=async()=>{
    const [rows]=await b.setup.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',
     [plan.targetDatabase]);return rows.length!==0;
   };
   const targetUrl=new URL(b.raw);targetUrl.pathname='/'+plan.targetDatabase;
   await work({b,backup,plan,planPath,journal,readState,transition,freeze,restore,targetExists,
    targetUrl:targetUrl.href,config,deps});
  });
 }
 await t.test('valid plan-bound FROZEN import reaches VERIFYING, revokes sessions and leaves active data intact',
  ()=>scenario('success',async x=>{
   const spec=await schemaSpec(),business=spec.tables.filter(n=>!['recovery_control','recovery_events'].includes(n));
   const before=digest(canonical({tables:await readTables(x.b.setup,business)}));
   await x.freeze();
   const result=await x.restore();
   assert.equal(result.state,'VERIFYING');
   assert.equal(await x.targetExists(),true);
   assert.equal((await x.readState(x.journal,x.plan)).state,'VERIFYING');
   const target=await mysql.createConnection({uri:x.targetUrl,dateStrings:true,jsonStrings:true,
    supportBigNumbers:true,bigNumberStrings:true});
   const pool=mysql.createPool({uri:x.targetUrl,connectionLimit:2});
   try{
    await validateSchema(target,x.plan.targetDatabase);
    const [[row]]=await target.query('SELECT mode,backup_digest,facts FROM recovery_control WHERE control_id=1');
    assert.equal(row.mode,'VERIFYING');assert.equal(row.backup_digest,x.plan.backupSha256);
    assert.deepEqual(Object.fromEntries(Object.entries(planBinding(x.plan)).map(([k])=>[k,JSON.parse(row.facts)[k]])),
     planBinding(x.plan));
    const [[sessions]]=await target.query('SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL');
    assert.equal(Number(sessions.n),0);
    const auth=createAuthService({store:createMySqlAuthStore({pool,database:x.plan.targetDatabase}),
     rateLimiter:createMemoryLoginRateLimiter()});
    assert.equal(await auth.authenticateSession(x.b.login.token),null);
    await assert.rejects(bindRecoveryWriteGuard(target),{code:'RECOVERY_WRITE_FROZEN'});
    await assert.rejects(withRecoveryDispatch(pool,x.plan.targetDatabase,async()=>{}),
     {code:'RECOVERY_WORKER_PAUSED'});
    const [[old]]=await x.b.setup.query('SELECT mode FROM recovery_control WHERE control_id=1');
    assert.equal(old.mode,'FROZEN');
    assert.equal(digest(canonical({tables:await readTables(x.b.setup,business)})),before);
   }finally{await pool.end();await target.end();}
  }));
 await t.test('RESTORING intent with no candidate retries the same operation after preflight',
  ()=>scenario('intent',async x=>{
   await x.freeze();
   await x.transition(x.journal,x.plan,'FROZEN','RESTORING');
   assert.equal(await x.targetExists(),false);
   assert.equal((await x.restore()).state,'VERIFYING');
   assert.equal((await x.readState(x.journal,x.plan)).state,'VERIFYING');
  }));
 await t.test('plan digest, backup checksum, wrong freeze and server drift refuse CREATE',
  ()=>scenario('drift',async x=>{
   await x.freeze();
   const original=await readFile(x.planPath,'utf8');
   await writeFile(x.planPath,canonical({...x.plan,backupId:randomUUID()}));
   await assert.rejects(x.restore());assert.equal(await x.targetExists(),false);
   await writeFile(x.planPath,original);
   await writeFile(join(x.backup.directory,'manifest.sha256'),'0'.repeat(64)+'\n');
   await assert.rejects(x.restore());assert.equal(await x.targetExists(),false);
   await writeFile(join(x.backup.directory,'manifest.sha256'),x.backup.checksum+'\n');
   await x.b.setup.execute('UPDATE recovery_control SET facts=? WHERE control_id=1',
    [canonical({...planBinding(x.plan),recoveryOperationId:randomUUID()})]);
   await assert.rejects(x.restore());assert.equal(await x.targetExists(),false);
   await x.b.setup.execute('UPDATE recovery_control SET facts=? WHERE control_id=1',
    [canonical({reason:'plan-bound-recovery-freeze',...planBinding(x.plan)})]);
   const wrongConnect=async url=>{
    const c=await x.deps.connect(url);
    return {...c,query:(sql,...params)=>sql==='SELECT @@server_uuid AS server_uuid, VERSION() AS version'?
     Promise.resolve([[{server_uuid:'wrong-owned-server',version:'8.4.11'}]]):c.query(sql,...params)};
   };
   await assert.rejects(x.restore({connect:wrongConnect}));assert.equal(await x.targetExists(),false);
  }));
 await t.test('existing target refuses CREATE without reuse',()=>scenario('exists',async x=>{
  await x.freeze();await x.b.setup.query('CREATE DATABASE '+x.plan.targetDatabase);
  await assert.rejects(x.restore());assert.equal(await x.targetExists(),true);
 }));
 await t.test('failure after CREATE leaves an unusable candidate',()=>scenario('created',async x=>{
  await x.freeze();
  await assert.rejects(x.restore({testHooks:{afterCreate:()=>{throw Error('synthetic-after-create');}}}));
  assert.equal(await x.targetExists(),true);
  assert.equal((await x.readState(x.journal,x.plan)).state,'FAILED_AMBIGUOUS');
  await assert.rejects(x.restore(),{code:'PRODUCTION_RESTORE_JOURNAL_CONFLICT'});
 }));
 await t.test('partial schema failure leaves candidate unusable',()=>scenario('schema',async x=>{
  await x.freeze();
  const broken=async(c,spec,target,control)=>{
   const ddl=spec.statements.find(sql=>/^CREATE TABLE recovery_control\b/.test(sql));
   await c.query(ddl);await control();throw Error('synthetic-mid-schema');
  };
  await assert.rejects(x.restore({schema:broken}));
  assert.equal((await x.readState(x.journal,x.plan)).state,'FAILED_AMBIGUOUS');
  await assert.rejects(x.restore(),{code:'PRODUCTION_RESTORE_JOURNAL_CONFLICT'});
 }));
 await t.test('DML import failure rolls back rows and never verifies',()=>scenario('import',async x=>{
  await x.freeze();
  const broken=async(c,artifact)=>{await importStructuredBackupRows(c,artifact);throw Error('synthetic-mid-import');};
  await assert.rejects(x.restore({importRows:broken}));
  const target=await mysql.createConnection({uri:x.targetUrl});
  try{
   const [[count]]=await target.query('SELECT COUNT(*) AS n FROM ledger_heads');
   assert.equal(Number(count.n),0);
   const [[control]]=await target.query('SELECT mode FROM recovery_control WHERE control_id=1');
   assert.equal(control.mode,'RESTORING');
  }finally{await target.end();}
  assert.equal((await x.readState(x.journal,x.plan)).state,'FAILED_AMBIGUOUS');
 }));
 await t.test('row count and normalized digest mismatch never verify',async()=>{
  for(const kind of ['rowcount','digest'])await scenario(kind,async x=>{
   await x.freeze();
   const broken=async(c,artifact)=>{
    await importStructuredBackupRows(c,artifact);
    if(kind==='rowcount')await c.execute("INSERT INTO recovery_events(event_type,initiated_by,reason,facts) VALUES('synthetic','fixture','extra','{}')");
    else await c.execute('UPDATE ledger_heads SET state_checksum=?',['0'.repeat(64)]);
   };
   await assert.rejects(x.restore({importRows:broken}),{code:'PRODUCTION_RESTORE_IMPORT_MISMATCH'});
   assert.equal((await x.readState(x.journal,x.plan)).state,'FAILED_AMBIGUOUS');
   const target=await mysql.createConnection({uri:x.targetUrl});
   try{const [[row]]=await target.query('SELECT mode FROM recovery_control WHERE control_id=1');
    assert.equal(row.mode,'RESTORING');}finally{await target.end();}
  });
 });
 await t.test('generic verify refuses S3-B candidate with zero active restored sessions before mutation',
  ()=>scenario('generic_zero',async x=>{
   await x.freeze();assert.equal((await x.restore()).state,'VERIFYING');
   const c=await mysql.createConnection({uri:x.targetUrl,dateStrings:true,jsonStrings:true,
    supportBigNumbers:true,bigNumberStrings:true});
   try{
    const [[active]]=await c.query('SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL');
    assert.equal(Number(active.n),0);
    const spec=await schemaSpec(),before=digest(canonical({tables:await readTables(c,spec.tables)}));
    await assert.rejects(verifyRecovery(genericArgs(x)),
     {code:'RECOVERY_PLAN_BOUND_CANDIDATE_BLOCKED'});
    const [[control]]=await c.query('SELECT mode FROM recovery_control WHERE control_id=1');
    assert.equal(control.mode,'VERIFYING');
    assert.equal(digest(canonical({tables:await readTables(c,spec.tables)})),before);
   }finally{await c.end();}
  },{beforeBackup:async b=>{
   await b.setup.query('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP(6) WHERE revoked_at IS NULL');
  }}));
 await t.test('generic verify refuses S3-B candidate even if an active session is present',
  ()=>scenario('generic_session',async x=>{
   await x.freeze();assert.equal((await x.restore()).state,'VERIFYING');
   const c=await mysql.createConnection({uri:x.targetUrl,dateStrings:true,jsonStrings:true,
    supportBigNumbers:true,bigNumberStrings:true});
   try{
    await c.query('UPDATE auth_sessions SET revoked_at=NULL LIMIT 1');
    const [[active]]=await c.query('SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL');
    assert.equal(Number(active.n),1);
    const spec=await schemaSpec(),before=digest(canonical({tables:await readTables(c,spec.tables)}));
    await assert.rejects(verifyRecovery(genericArgs(x)),
     {code:'RECOVERY_PLAN_BOUND_CANDIDATE_BLOCKED'});
    const [[control]]=await c.query('SELECT mode FROM recovery_control WHERE control_id=1');
    assert.equal(control.mode,'VERIFYING');
    assert.equal(digest(canonical({tables:await readTables(c,spec.tables)})),before);
   }finally{await c.end();}
  }));
 await t.test('generic resume refuses S3-B candidate even with READY_FOR_RESUME facts',
  ()=>scenario('generic_resume',async x=>{
   await x.freeze();assert.equal((await x.restore()).state,'VERIFYING');
   const c=await mysql.createConnection({uri:x.targetUrl,dateStrings:true,jsonStrings:true,
    supportBigNumbers:true,bigNumberStrings:true});
   try{
    const spec=await schemaSpec(),preserved=spec.tables.filter(n=>
     !['recovery_control','recovery_events'].includes(n));
    const preparedDigest=digest(canonical({tables:await readTables(c,preserved)}));
    const [[original]]=await c.query('SELECT facts FROM recovery_control WHERE control_id=1');
    await c.execute("UPDATE recovery_control SET mode='READY_FOR_RESUME',facts=? WHERE control_id=1",
     [canonical({...JSON.parse(original.facts),preparedDigest,verifiedAt:new Date().toISOString()})]);
    const before=digest(canonical({tables:await readTables(c,spec.tables)}));
    await assert.rejects(resumeRecovery(genericArgs(x,true)),
     {code:'RECOVERY_PLAN_BOUND_CANDIDATE_BLOCKED'});
    const [[control]]=await c.query('SELECT mode FROM recovery_control WHERE control_id=1');
    assert.equal(control.mode,'READY_FOR_RESUME');
    assert.equal(digest(canonical({tables:await readTables(c,spec.tables)})),before);
   }finally{await c.end();}
  }));
 await t.test('ordinary Stage5B recovery still verifies and resumes',()=>withBackupFixture(async b=>{
  const backup=await backupDatabase({...b.backupArgs,
   outputDirectory:join(b.dir,'generic-compatibility')});
  const target=b.targetArgs(backup,'generic_compatibility');
  assert.equal((await restoreDatabase(target)).mode,'VERIFYING');
  assert.equal((await verifyRecovery(target)).mode,'READY_FOR_RESUME');
  assert.equal((await resumeRecovery({...target,confirmation:target.confirmation+'/RESUME'})).mode,'NORMAL');
 }));});
