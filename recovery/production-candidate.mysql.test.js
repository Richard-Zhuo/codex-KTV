import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {withBackupFixture} from '../test-support/backup-fixture.js';
import {backupDatabase} from '../backup/mysql-backup.js';
import {canonical,digest} from '../backup/format.js';
import {inspectProductionRestore,preflightPreparedRestore,readProtectedRestorePlan,planBinding,candidateName} from './production-plan.js';
import {freezePreparedCandidate,issueOwnedCandidateCapability} from './production-candidate.js';
import {readExecutionState,transitionExecutionState} from './production-journal.js';
import {bindRecoveryWriteGuard,withRecoveryDispatch} from './gate.js';

const fixtureTest=(name,work)=>{
 if(process.env.STAGE5E_RUN==='synthetic-only'&&process.env.STAGE5E_FIXTURE_ROOT&&
  process.env.LEDGER_MYSQL_TEST_URL)
  test(name,{timeout:120000},()=>withBackupFixture(work));
};
fixtureTest('S3-B plan-bound freeze on owned MySQL blocks known writers and supports same-operation replay',async b=>{
 const f={root:process.env.STAGE5E_FIXTURE_ROOT,names:{id:process.env.STAGE5E_FIXTURE_ID,database:'jbhh_ktv_test'},
  identity:{server_uuid:process.env.STAGE5E_FIXTURE_UUID},port:33313,dbUrl:()=>b.raw};
 const capability=await issueOwnedCandidateCapability(f);
 await b.setup.query("UPDATE production_bootstrap_events SET environment='production'");
 const backup=await backupDatabase({...b.backupArgs,environment:'production',
  outputDirectory:join(process.env.STAGE5E_FIXTURE_ROOT,'backups','s3b-phase1')});
 const active=new URL(b.raw),admin=new URL(b.raw);admin.pathname='/';
 const config={config:{storeId:b.storeId,ledgerId:b.ledgerId,
   applicationCommit:b.backupArgs.applicationCommit,serviceAccountSid:'S-1-5-21-1-2-3-1001',
   monitoring:{backupDirectory:join(process.env.STAGE5E_FIXTURE_ROOT,'backups')},
   recovery:{journalDirectory:join(process.env.STAGE5E_FIXTURE_ROOT,'artifacts')}},
  apiEnv:{KTV_MYSQL_URL:active.href}};
 const load=async()=>config;
 const pathCheck=async(_loaded,artifact)=>({backup:config.config.monitoring.backupDirectory,
  journal:config.config.recovery.journalDirectory,artifact});
 const connect=async url=>{
  const c=await mysql.createConnection({uri:url,dateStrings:true,jsonStrings:true,
   supportBigNumbers:true,bigNumberStrings:true});
  return {query:(sql,...params)=>sql==='SHOW GRANTS FOR CURRENT_USER()'?
   Promise.resolve([[{grant:'GRANT SHOW DATABASES ON *.* TO synthetic_operator'}]]):
   c.query(sql,...params),execute:(...args)=>c.execute(...args),end:()=>c.end()};
 };
 const deps={runtimeConfigFile:'synthetic-fixture',load,pathCheck,connect,
  operatorLoad:async()=>admin.href,fileAcl:async()=>{}};
 const plan=await inspectProductionRestore({...deps,artifactDirectory:backup.directory,
  expectedChecksum:backup.checksum,now:new Date()});
 assert.equal(plan.formatVersion,2);
 await writeFile(join(config.config.recovery.journalDirectory,'active-plan.json'),canonical(plan));
 const journalOptions={checkAcl:async()=>{},harden:async()=>{}};
 const readState=(journal,p)=>readExecutionState(journal,p,journalOptions);
 const transition=(journal,p,from,to)=>transitionExecutionState(journal,p,from,to,journalOptions);
 const run=()=>freezePreparedCandidate({...deps,capability,readState,transition});
 await preflightPreparedRestore(deps);
 const {planDigest:discarded,...changedBody}=plan;
 changedBody.recoveryOperationId=randomUUID();
 changedBody.targetDatabase=candidateName(changedBody.recoveryOperationId);
 const changedPlan={...changedBody,planDigest:digest(canonical(changedBody))};
 const activePlanPath=join(config.config.recovery.journalDirectory,'active-plan.json');
 const swapAfterInitialRead=async args=>{
  const original=await readProtectedRestorePlan(args);
  await writeFile(activePlanPath,canonical(changedPlan));
  return original;
 };
 await assert.rejects(freezePreparedCandidate({...deps,capability,readState,transition,
  readPlan:swapAfterInitialRead}),{code:'PRODUCTION_RESTORE_PLAN_PRECONDITION_CHANGED'});
 const [beforeFreeze]=await b.setup.query('SELECT mode FROM recovery_control WHERE control_id=1');
 assert.ok(beforeFreeze.length===0||beforeFreeze[0].mode==='NORMAL');
 const [beforeEvents]=await b.setup.query("SELECT event_id FROM recovery_events WHERE reason='plan-bound-freeze'");
 assert.equal(beforeEvents.length,0);
 await writeFile(activePlanPath,canonical(plan));
 await transition(config.config.recovery.journalDirectory,plan,null,'FREEZE_INTENT');
 assert.equal((await readState(config.config.recovery.journalDirectory,plan)).state,'FREEZE_INTENT');
 const first=await run();assert.equal(first.state,'FROZEN');assert.equal(first.replay,false);
 const [[row]]=await b.setup.query('SELECT mode,facts FROM recovery_control WHERE control_id=1');
 assert.equal(row.mode,'FROZEN');
 assert.deepEqual(Object.fromEntries(Object.entries(planBinding(plan)).map(([k])=>[k,JSON.parse(row.facts)[k]])),
  planBinding(plan));
 const [events]=await b.setup.query("SELECT event_id FROM recovery_events WHERE reason='plan-bound-freeze'");
 assert.equal(events.length,1);
 await assert.rejects(bindRecoveryWriteGuard(b.setup),{code:'RECOVERY_WRITE_FROZEN'});
 await assert.rejects(withRecoveryDispatch(b.pool,'jbhh_ktv_test',async()=>{}),
  {code:'RECOVERY_WORKER_PAUSED'});
 await transition(config.config.recovery.journalDirectory,plan,'FROZEN','FREEZE_INTENT');
 const replay=await run();assert.equal(replay.replay,true);
 const [after]=await b.setup.query("SELECT event_id FROM recovery_events WHERE reason='plan-bound-freeze'");
 assert.equal(after.length,1);
 const [target]=await b.setup.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',
  [plan.targetDatabase]);
 assert.equal(target.length,0);
 const wrong={...plan,recoveryOperationId:randomUUID()};
 wrong.targetDatabase=candidateName(wrong.recoveryOperationId);
 delete wrong.planDigest;wrong.planDigest=digest(canonical(wrong));
 await writeFile(join(config.config.recovery.journalDirectory,'active-plan.json'),canonical(wrong));
 await assert.rejects(run());
 const [[unchanged]]=await b.setup.query('SELECT mode,facts FROM recovery_control WHERE control_id=1');
 assert.equal(unchanged.mode,'FROZEN');
 assert.deepEqual(JSON.parse(unchanged.facts),JSON.parse(row.facts));
 const [unchangedEvents]=await b.setup.query("SELECT event_id FROM recovery_events WHERE reason='plan-bound-freeze'");
 assert.equal(unchangedEvents.length,1);
});
