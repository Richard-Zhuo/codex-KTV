import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {withBackupFixture} from '../test-support/backup-fixture.js';
import {backupDatabase} from '../backup/mysql-backup.js';
import {canonical} from '../backup/format.js';
import {decodeLedgerSnapshot,encodeLedgerSnapshot} from '../ledger/mysql-snapshot.js';
import {syntheticTls,protectSyntheticFile} from '../test-support/runtime-tls.js';
import {windowsFileAcl} from '../production/runtime-config.js';
import {validateSmokeAcl} from '../production/wecom-smoke-config.js';
import {inspectProductionRestore,planBinding} from './production-plan.js';
import {freezePreparedCandidate,restorePreparedCandidate,issueOwnedCandidateCapability} from './production-candidate.js';
import {verifyPreparedCandidate} from './production-c1.js';
import {switchOwnedCandidatePointer} from './production-c2.js';
import {readExecutionState,transitionExecutionState} from './production-journal.js';
import {readCutoverState,transitionCutoverState,assertNormalStartupAllowed} from './production-cutover-journal.js';
import {writeC1Evidence} from './c1-evidence.js';

const enabled=process.env.STAGE5E_RUN==='synthetic-only'&&
 process.env.STAGE5E_FIXTURE_ROOT&&process.env.LEDGER_MYSQL_TEST_URL;
const blocked=async(work,code)=>assert.rejects(work,{code});
function managedChild(url){
 const code=`import mysql from 'mysql2/promise';
 const c=await mysql.createConnection({uri:process.env.C2_OWNED_URL});
 const timer=setInterval(()=>{},1000);process.stdout.write('READY\\n');
 process.stdin.setEncoding('utf8');process.stdin.on('data',async text=>{
  if(text.includes('STOP')){clearInterval(timer);await c.end();process.stdout.write('STOPPED\\n');process.exit(0);}
 });`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],
  {env:{...process.env,C2_OWNED_URL:url},windowsHide:true,stdio:['pipe','pipe','pipe']});
 let text='',stopped=false;
 child.stdout.on('data',b=>{text+=b.toString();});
 child.stderr.on('data',()=>{});
 const wait=async value=>{for(let n=0;n<100;n++){if(text.includes(value))return;
  if(child.exitCode!==null)throw Error('SYNTHETIC_MANAGED_RUNTIME_EXIT');
  await new Promise(r=>setTimeout(r,20));}throw Error('SYNTHETIC_MANAGED_RUNTIME_TIMEOUT');};
 return {child,wait,status:()=>({phase:stopped?'STOPPED':'RUNNING',workerStopped:stopped,
  operationalStopped:stopped,connectionsClosed:stopped,normalWriterCount:stopped?0:1}),
  async shutdown(){child.stdin.write('STOP\n');await wait('STOPPED');
   if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));
   stopped=true;return true;},
  async cleanup(){if(child.exitCode===null){child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));}}};
}
if(enabled)test('S3-C C2 owned cutover stops runtime, switches protected pointer, and stays before resume',
 {timeout:240000},async t=>{
 const f={root:process.env.STAGE5E_FIXTURE_ROOT,
  names:{id:process.env.STAGE5E_FIXTURE_ID,database:'jbhh_ktv_test'},
  identity:{server_uuid:process.env.STAGE5E_FIXTURE_UUID},port:33313,
  dbUrl:()=>process.env.LEDGER_MYSQL_TEST_URL};
 const capability=await issueOwnedCandidateCapability(f);
 await withBackupFixture(async b=>{
  let managed;
  try{
   await b.setup.query("UPDATE production_bootstrap_events SET environment='production'");
   const [[head]]=await b.setup.query('SELECT state_json,state_checksum FROM ledger_heads');
   const state=decodeLedgerSnapshot(head.state_json,head.state_checksum);
   for(const stock of [...Object.values(state.inventory),...Object.values(state.consumables)])
    stock.count=1000;
   const encoded=encodeLedgerSnapshot(state);
   await b.setup.execute('UPDATE ledger_heads SET state_json=?,state_checksum=?',
    [encoded.json,encoded.checksum]);
   const backup=await backupDatabase({...b.backupArgs,environment:'production',
    outputDirectory:join(f.root,'backups','c2_owned')});
   const journal=join(f.root,'artifacts','c2_owned');await mkdir(journal);
   const tls=await syntheticTls(),secretPath=join(f.root,'artifacts','c2-secrets.json');
   const secrets={database:{host:'127.0.0.1',port:33313,name:'jbhh_ktv_test',
    user:'synthetic',password:'synthetic-private-password'},
    tls:{certificate:tls.certificate,privateKey:tls.privateKey},
    alerting:{wecom:{secret:'synthetic-wecom-secret'}},
    ktvsky:{password:'synthetic-device-secret'}};
   await writeFile(secretPath,JSON.stringify(secrets));await protectSyntheticFile(secretPath,tls.sid);
   const active=new URL(b.raw),admin=new URL(b.raw);admin.pathname='/';
   const config={config:{storeId:b.storeId,ledgerId:b.ledgerId,
    applicationCommit:b.backupArgs.applicationCommit,serviceAccountSid:tls.sid,
    secretsFile:secretPath,monitoring:{backupDirectory:join(f.root,'backups')},
    recovery:{journalDirectory:journal}},apiEnv:{KTV_MYSQL_URL:active.href}};
   const load=async()=>{
    const current=JSON.parse(await readFile(secretPath,'utf8'));
    const url=new URL(b.raw);url.pathname='/'+current.database.name;
    return {...config,apiEnv:{KTV_MYSQL_URL:url.href}};
   };
   const pathCheck=async(_loaded,artifact)=>({backup:config.config.monitoring.backupDirectory,
    journal,artifact});
   const connect=async url=>{
    const c=await mysql.createConnection({uri:url,dateStrings:true,jsonStrings:true,
     supportBigNumbers:true,bigNumberStrings:true});
    return {query:(sql,...params)=>sql==='SHOW GRANTS FOR CURRENT_USER()'?
      Promise.resolve([[{grant:'GRANT SHOW DATABASES ON *.* TO synthetic_operator'}]]):
      c.query(sql,...params),execute:(...args)=>c.execute(...args),end:()=>c.end()};
   };
   const fileAcl=async path=>{validateSmokeAcl(await windowsFileAcl(path));};
   const journalOptions={checkAcl:fileAcl,harden:path=>protectSyntheticFile(path,tls.sid)};
   const readState=(dir,p)=>readExecutionState(dir,p,journalOptions);
   const transitionState=(dir,p,from,to)=>transitionExecutionState(dir,p,from,to,journalOptions);
   const deps={runtimeConfigFile:'synthetic-owned-fixture',load,pathCheck,connect,
    operatorLoad:async()=>admin.href,fileAcl:async()=>{}};
   const plan=await inspectProductionRestore({...deps,artifactDirectory:backup.directory,
    expectedChecksum:backup.checksum,now:new Date()});
   const planPath=join(journal,'active-plan.json');
   await writeFile(planPath,canonical(plan));await protectSyntheticFile(planPath,tls.sid);
   const args={...deps,capability,readState,transition:transitionState};
   await freezePreparedCandidate(args);
   assert.equal((await restorePreparedCandidate(args)).state,'VERIFYING');
   const c1=await verifyPreparedCandidate({...args,readAlerts:async()=>[],
    persist:(dir,p,report)=>writeC1Evidence(dir,p,report,journalOptions),
    testHooks:{onError:error=>{throw error;}}});
   assert.equal(c1.cutoverEligible,true);
   await blocked(async()=>assertNormalStartupAllowed(await load()),'PRODUCTION_CUTOVER_STARTUP_BLOCKED');
   const pointerOptions={harden:path=>protectSyntheticFile(path,tls.sid)};
   const cut=extra=>switchOwnedCandidatePointer({...deps,capability,readState,
    readAlerts:async()=>[],managedRuntime:managed,journalOptions,
    evidenceOptions:{checkAcl:fileAcl},pointerOptions,...extra});
   const name=async()=>JSON.parse(await readFile(secretPath,'utf8')).database.name;
   const target=new URL(b.raw);target.pathname='/'+plan.targetDatabase;
   const targetConnection=await mysql.createConnection({uri:target.href});
   const modes=async()=>({old:(await b.setup.query('SELECT mode FROM recovery_control WHERE control_id=1'))[0][0].mode,
    candidate:(await targetConnection.query('SELECT mode FROM recovery_control WHERE control_id=1'))[0][0].mode});
   try{
    await t.test('stale C1 evidence and wrong old/candidate identity never switch',async()=>{
     await blocked(()=>cut(),'PRODUCTION_CUTOVER_RUNTIME_NOT_STOPPED'); // no managed runtime
     const evidencePath=join(journal,'c1-verification.json'),saved=await readFile(evidencePath,'utf8');
     await writeFile(evidencePath,JSON.stringify({...JSON.parse(saved),candidateDigest:'changed'}));
     await blocked(()=>cut(),'PRODUCTION_CUTOVER_C1_EVIDENCE_STALE');
     await writeFile(evidencePath,saved);
     await b.setup.query("UPDATE recovery_control SET mode='NORMAL' WHERE control_id=1");
     await blocked(()=>cut(),'PRODUCTION_RESTORE_C1_IDENTITY_MISMATCH');
     await b.setup.query("UPDATE recovery_control SET mode='FROZEN' WHERE control_id=1");
     await targetConnection.query("UPDATE recovery_control SET mode='READY_FOR_RESUME' WHERE control_id=1");
     await blocked(()=>cut(),'PRODUCTION_RESTORE_C1_IDENTITY_MISMATCH');
     await targetConnection.query("UPDATE recovery_control SET mode='VERIFYING' WHERE control_id=1");
     assert.equal(await name(),plan.currentDatabase);
     assert.equal(await readCutoverState(journal,plan,journalOptions),null);
    });
    await t.test('different operation and wrong config target fail before stop',async()=>{
     const original=canonical({reason:'plan-bound-recovery-freeze',...planBinding(plan)});
     await b.setup.execute('UPDATE recovery_control SET facts=? WHERE control_id=1',
      [canonical({...planBinding(plan),reason:'plan-bound-recovery-freeze',planDigest:'other'})]);
     await blocked(()=>cut(),'PRODUCTION_RESTORE_C1_IDENTITY_MISMATCH');
     await b.setup.execute('UPDATE recovery_control SET facts=? WHERE control_id=1',[original]);
     await writeFile(secretPath,JSON.stringify({...secrets,database:{...secrets.database,name:'other_database'}}));
     await blocked(()=>cut(),'PRODUCTION_CUTOVER_POINTER_CONFLICT');
     await writeFile(secretPath,JSON.stringify(secrets));
     assert.equal(await name(),plan.currentDatabase);
    });
    await t.test('managed runtime stop failure preserves old pointer and no intent',async()=>{
     managed={status:()=>({phase:'RUNNING'}),shutdown:async()=>false};
     await blocked(()=>cut(),'PRODUCTION_CUTOVER_RUNTIME_NOT_STOPPED');
     assert.equal(await name(),plan.currentDatabase);
     assert.equal(await readCutoverState(journal,plan,journalOptions),null);
    });
    managed=managedChild(b.raw);await managed.wait('READY');
    await t.test('intent before pointer, atomic failure, and zero managed writers',async()=>{
     await assert.rejects(cut({beforePointer:async()=>{throw Error('synthetic-crash-before-pointer');}}));
     assert.equal((await readCutoverState(journal,plan,journalOptions)).state,'CUTOVER_INTENT');
     assert.equal(await name(),plan.currentDatabase);
     assert.equal(managed.status().normalWriterCount,0);
     await blocked(async()=>assertNormalStartupAllowed(await load()),'PRODUCTION_CUTOVER_STARTUP_BLOCKED');
     await assert.rejects(cut({pointerOptions:{...pointerOptions,
      move:async()=>{throw Error('synthetic-atomic-failure');}}}));
     assert.equal(await name(),plan.currentDatabase);
     assert.equal((await readCutoverState(journal,plan,journalOptions)).state,'CUTOVER_INTENT');
    });
    await t.test('pointer switched before journal finalization reconciles same operation only',async()=>{
     const transition=async(dir,p,from,to,options)=>to==='CUTOVER_SWITCHED'?
      Promise.reject(Error('synthetic-crash-after-pointer')):
      transitionCutoverState(dir,p,from,to,options);
     await assert.rejects(cut({transition}));
     assert.equal(await name(),plan.targetDatabase);
     assert.equal((await readCutoverState(journal,plan,journalOptions)).state,'CUTOVER_INTENT');
     await blocked(async()=>assertNormalStartupAllowed(await load()),'PRODUCTION_CUTOVER_STARTUP_BLOCKED');
     const result=await cut();assert.equal(result.state,'CUTOVER_SWITCHED');
     assert.equal(result.replay,false);
     assert.equal((await readCutoverState(journal,plan,journalOptions)).state,'CUTOVER_SWITCHED');
    });
    await t.test('final state has no normal writer, no resume, safe replay and secrets intact',async()=>{
     const result=await cut({updatePointer:async()=>{throw Error('replay-updater-called');}});
     assert.equal(result.replay,true);
     assert.equal(await name(),plan.targetDatabase);
     assert.deepEqual(await modes(),{old:'FROZEN',candidate:'VERIFYING'});
     assert.equal(managed.status().phase,'STOPPED');
     assert.equal(managed.status().normalWriterCount,0);
     const current=JSON.parse(await readFile(secretPath,'utf8'));
     assert.deepEqual({...current,database:{...current.database,name:plan.currentDatabase}},secrets);
     await blocked(async()=>assertNormalStartupAllowed(await load()),'PRODUCTION_CUTOVER_STARTUP_BLOCKED');
     const cutoverPath=join(journal,'cutover-state.json'),saved=await readFile(cutoverPath,'utf8');
     await writeFile(cutoverPath,JSON.stringify({...JSON.parse(saved),planDigest:'c'.repeat(64)}));
     await blocked(()=>cut(),'PRODUCTION_CUTOVER_JOURNAL_CONFLICT');
     await writeFile(cutoverPath,saved);
    });
   }finally{await targetConnection.end();}
  }finally{await managed?.cleanup?.();}
 });
});
