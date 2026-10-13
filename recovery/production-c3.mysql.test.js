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
import {prepareOwnedCandidateResume,resumeOwnedCandidate} from './production-c3.js';
import {readC3State,transitionC3State} from './production-c3-journal.js';
import {assertCompletedC3Startup} from './production-c3-startup.js';
import {createProductionRuntime} from '../production/runtime.js';
import {verifyRecovery,resumeRecovery} from './operator.js';
import {createMySqlAuthStore} from '../auth/mysql-store.js';
import {createAuthService} from '../auth/service.js';
import {createMemoryLoginRateLimiter} from '../auth/rate-limit.js';
import {bindRecoveryWriteGuard} from './gate.js';

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
if(enabled)test('S3-C owned C1-C3 restore makes candidate the sole managed writer',
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
    outputDirectory:join(f.root,'backups','c3_owned')});
   const journal=join(f.root,'artifacts','c3_owned');await mkdir(journal);
   const tls=await syntheticTls(),secretPath=join(f.root,'artifacts','c3-secrets.json');
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
   const recoveryRuntime=async()=>{
    const loaded=await load(),calls=[];
    const started=Promise.withResolvers();
    // The existing parent deadline bounds failure; only runtime_started proves completion.
    const waitForStarted=async signal=>{
     const incomplete=()=>Error('semantic completion not observed');
     if(signal.aborted)throw incomplete();
     let aborted;
     try{
      await Promise.race([started.promise,new Promise((_,reject)=>{
       aborted=()=>reject(incomplete());
       signal.addEventListener('abort',aborted,{once:true});
      })]);
     }finally{signal.removeEventListener('abort',aborted);}
    };
    const runtime=createProductionRuntime({...loaded,
     productionConfig:{database:plan.targetDatabase,storeId:plan.storeId,
      ledgerId:plan.ledgerId,environment:'production',deviceControlMode:'disabled'},
     config:{...loaded.config,publicOrigin:'https://ktv-smoke.127.0.0.1.sslip.io:8443',
      port:0,listenHost:'127.0.0.1',backupPolicyConfigured:true,
      monitoring:{...loaded.config.monitoring,intervalMs:25}},
     tls:{cert:tls.certificate,key:tls.privateKey},redactionSecrets:[],
     configFingerprint:'b'.repeat(64)},
     {logger:{info:entry=>{if(entry.event==='runtime_started')started.resolve();},error:()=>{}},services:{
      readiness:async()=>{calls.push('readiness');return {ready:true,blockers:[]};},
      startWorker:async()=>{calls.push('worker');},close:async()=>{},stopWorker:async()=>{}},
      operations:{readyBlockers:()=>[],observeReadiness:async()=>{},
       start:async()=>{calls.push('operations');},stop:async()=>{}}});
    return {runtime,calls,waitForStarted};
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
   const ordinary=await load();ordinary.config={...ordinary.config};
   delete ordinary.config.recovery;
   assert.equal(await assertNormalStartupAllowed(ordinary),true);
   const ordinaryCalls=[];
   const ordinaryRuntime=createProductionRuntime({...ordinary,
    config:{...ordinary.config,publicOrigin:'https://ktv-smoke.127.0.0.1.sslip.io:8443',
     port:0,listenHost:'127.0.0.1',backupPolicyConfigured:true},
    tls:{cert:tls.certificate,key:tls.privateKey},redactionSecrets:[],
    configFingerprint:'b'.repeat(64)},
    {logger:{info:()=>{},error:()=>{}},services:{
     readiness:async()=>{ordinaryCalls.push('readiness');return {ready:true,blockers:[]};},
     startWorker:async()=>{ordinaryCalls.push('worker');},
     close:async()=>{},stopWorker:async()=>{}},
     operations:{readyBlockers:()=>[],observeReadiness:async()=>{},
      start:async()=>{ordinaryCalls.push('operations');},stop:async()=>{}}});
   try{await ordinaryRuntime.start();
    assert.deepEqual(ordinaryCalls,['readiness','operations','worker']);}
   finally{await ordinaryRuntime.shutdown();}
   await freezePreparedCandidate(args);
   assert.equal((await restorePreparedCandidate(args)).state,'VERIFYING');
   const verifying=await load();verifying.config={...verifying.config};
   const verifyingUrl=new URL(b.raw);verifyingUrl.pathname='/'+plan.targetDatabase;
   verifying.apiEnv.KTV_MYSQL_URL=verifyingUrl.href;
   delete verifying.config.recovery;
   await blocked(()=>assertNormalStartupAllowed(verifying),'PRODUCTION_C3_STARTUP_BLOCKED');
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
    managed=managedChild(b.raw);await managed.wait('READY');
    assert.equal((await cut()).state,'CUTOVER_SWITCHED');
    const c3Options={...deps,capability,managedRuntime:managed,readState,
     readAlerts:async()=>[],journalOptions,evidenceOptions:{checkAcl:fileAcl},
     transition:(dir,p,proof,from,to)=>transitionC3State(dir,p,proof,from,to,journalOptions)};
    const ready=extra=>prepareOwnedCandidateResume({...c3Options,...extra});
    const resume=extra=>resumeOwnedCandidate({...c3Options,...extra});
    const c3State=()=>readC3State(journal,plan,journalOptions);
    await t.test('stale C1/C2, wrong old/candidate and pointer refuse READY',async()=>{
     const evidencePath=join(journal,'c1-verification.json'),
      saved=await readFile(evidencePath,'utf8');
     await writeFile(evidencePath,JSON.stringify({...JSON.parse(saved),alertDigest:'1'.repeat(64)}));
     await blocked(()=>ready(),'PRODUCTION_CUTOVER_C1_EVIDENCE_STALE');
     await writeFile(evidencePath,saved);
     const cutoverPath=join(journal,'cutover-state.json'),
      cutoverSaved=await readFile(cutoverPath,'utf8');
     await writeFile(cutoverPath,JSON.stringify({...JSON.parse(cutoverSaved),planDigest:'2'.repeat(64)}));
     await blocked(()=>ready(),'PRODUCTION_CUTOVER_JOURNAL_CONFLICT');
     await writeFile(cutoverPath,cutoverSaved);
     await b.setup.query("UPDATE recovery_control SET mode='NORMAL' WHERE control_id=1");
     await blocked(()=>ready(),'PRODUCTION_RESTORE_C1_IDENTITY_MISMATCH');
     await b.setup.query("UPDATE recovery_control SET mode='FROZEN' WHERE control_id=1");
     await targetConnection.query("UPDATE recovery_control SET mode='READY_FOR_RESUME' WHERE control_id=1");
     await blocked(()=>ready(),'PRODUCTION_RESTORE_C1_IDENTITY_MISMATCH');
     await targetConnection.query("UPDATE recovery_control SET mode='VERIFYING' WHERE control_id=1");
     await writeFile(secretPath,JSON.stringify(secrets));
     await blocked(()=>ready(),'PRODUCTION_CUTOVER_POINTER_CONFLICT');
     await writeFile(secretPath,JSON.stringify({...secrets,
      database:{...secrets.database,name:plan.targetDatabase}}));
     assert.equal(await c3State(),null);
    });
    await t.test('READY_INTENT with VERIFYING safely retries, startup stays blocked',async()=>{
     await assert.rejects(ready({testHooks:{afterReadyIntent:async()=>{
      throw Error('synthetic-crash-before-ready');}}}));
     assert.equal((await c3State()).state,'READY_INTENT');
     assert.deepEqual(await modes(),{old:'FROZEN',candidate:'VERIFYING'});
     await blocked(async()=>assertNormalStartupAllowed(await load()),
      'PRODUCTION_CUTOVER_STARTUP_BLOCKED');
     assert.equal((await ready()).state,'READY_FOR_RESUME');
     assert.equal((await c3State()).state,'READY_FOR_RESUME');
     assert.deepEqual(await modes(),{old:'FROZEN',candidate:'READY_FOR_RESUME'});
     const noRecovery=await load();noRecovery.config={...noRecovery.config};
     delete noRecovery.config.recovery;
     await blocked(()=>assertNormalStartupAllowed(noRecovery),
      'PRODUCTION_C3_STARTUP_BLOCKED');
     await blocked(async()=>assertNormalStartupAllowed(await load()),
      'PRODUCTION_CUTOVER_STARTUP_BLOCKED');
    });
    await t.test('generic verify and resume remain blocked for plan-bound candidate',async()=>{
     const generic={databaseUrl:target.href,directory:backup.directory,
      expectedChecksum:backup.checksum,environment:'production',
      serverUuid:plan.targetServerUuid,storeId:plan.storeId,ledgerId:plan.ledgerId,
      initiatedBy:'synthetic-generic',confirmation:plan.targetServerUuid+'/'+
       plan.targetDatabase+'/'+plan.storeId+'/'+plan.ledgerId+'/'+backup.checksum,
      env:process.env};
     await blocked(()=>verifyRecovery(generic),'RECOVERY_PLAN_BOUND_CANDIDATE_BLOCKED');
     await blocked(()=>resumeRecovery({...generic,
      confirmation:generic.confirmation+'/RESUME'}),'RECOVERY_PLAN_BOUND_CANDIDATE_BLOCKED');
     assert.equal((await modes()).candidate,'READY_FOR_RESUME');
    });
    await t.test('resume refuses changed evidence, old state, pointer, sessions or alerts',async()=>{
     const evidencePath=join(journal,'c1-verification.json'),
      saved=await readFile(evidencePath,'utf8');
     await writeFile(evidencePath,JSON.stringify({...JSON.parse(saved),alertDigest:'4'.repeat(64)}));
     await blocked(()=>resume(),'PRODUCTION_C3_C1_EVIDENCE_STALE');
     await writeFile(evidencePath,saved);
     await b.setup.query("UPDATE recovery_control SET mode='NORMAL' WHERE control_id=1");
     await blocked(()=>resume(),'PRODUCTION_RESTORE_C1_IDENTITY_MISMATCH');
     await b.setup.query("UPDATE recovery_control SET mode='FROZEN' WHERE control_id=1");
     await writeFile(secretPath,JSON.stringify(secrets));
     await blocked(()=>resume(),'PRODUCTION_C3_POINTER_MISMATCH');
     await writeFile(secretPath,JSON.stringify({...secrets,
      database:{...secrets.database,name:plan.targetDatabase}}));
     const [[session]]=await targetConnection.query(
      'SELECT session_id,CAST(revoked_at AS CHAR(26)) AS original FROM auth_sessions LIMIT 1');
     await targetConnection.execute('UPDATE auth_sessions SET revoked_at=NULL WHERE session_id=?',
      [session.session_id]);
     await blocked(()=>resume(),'PRODUCTION_C3_SESSION_ACTIVE');
     await targetConnection.execute('UPDATE auth_sessions SET revoked_at=? WHERE session_id=?',
      [session.original,session.session_id]);
     await blocked(()=>resume({readAlerts:async()=>[{severity:'CRITICAL',
      state:'UNKNOWN'}]}),'PRODUCTION_C3_EXTERNAL_CHANGED');
     assert.equal((await modes()).candidate,'READY_FOR_RESUME');
     assert.equal((await c3State()).state,'READY_FOR_RESUME');
    });
    await t.test('RESUME_INTENT with READY retries, NORMAL before journal reconciles',async parent=>{
     await assert.rejects(resume({testHooks:{afterResumeIntent:async()=>{
      throw Error('synthetic-crash-before-resume');}}}));
     assert.equal((await c3State()).state,'RESUME_INTENT');
     assert.equal((await modes()).candidate,'READY_FOR_RESUME');
     await blocked(async()=>assertNormalStartupAllowed(await load()),
      'PRODUCTION_CUTOVER_STARTUP_BLOCKED');
     await assert.rejects(resume({testHooks:{afterResumeCommit:async()=>{
      throw Error('synthetic-crash-after-resume');}}}));
     assert.equal((await c3State()).state,'RESUME_INTENT');
     assert.deepEqual(await modes(),{old:'FROZEN',candidate:'NORMAL'});
     const omitted=await load();omitted.config={...omitted.config};
     delete omitted.config.recovery;
     await blocked(()=>assertNormalStartupAllowed(omitted),
      'PRODUCTION_C3_STARTUP_BLOCKED');
     const missingJournal=await load();
     missingJournal.config={...missingJournal.config,recovery:{
      journalDirectory:join(f.root,'artifacts','missing-c3-journal')}};
     await blocked(()=>assertNormalStartupAllowed(missingJournal),
      'PRODUCTION_C3_STARTUP_BLOCKED');
     const calls=[];
     const runtime=createProductionRuntime({...omitted,
      config:{...omitted.config,publicOrigin:'https://ktv-smoke.127.0.0.1.sslip.io:8443',
       port:0,listenHost:'127.0.0.1',backupPolicyConfigured:true},
      tls:{cert:tls.certificate,key:tls.privateKey},redactionSecrets:[],
      configFingerprint:'b'.repeat(64)},
      {logger:{info:()=>{},error:()=>{}},services:{
       readiness:async()=>{calls.push('readiness');return {ready:true,blockers:[]};},
       startWorker:async()=>{calls.push('worker');},close:async()=>{},stopWorker:async()=>{}},
       operations:{readyBlockers:()=>[],observeReadiness:async()=>{},
        start:async()=>{calls.push('operations');},stop:async()=>{}}});
     await blocked(()=>runtime.start(),'PRODUCTION_C3_STARTUP_BLOCKED');
     assert.deepEqual(calls,[]);
     assert.equal(runtime.server.listening,false);
     await blocked(async()=>assertNormalStartupAllowed(await load()),
      'PRODUCTION_CUTOVER_STARTUP_BLOCKED');
     await parent.test('DB outage then RESUME_INTENT remains liveness only',async sub=>{
      const original=mysql.createConnection.bind(mysql);
      let offline=true,probes=0;
      sub.mock.method(mysql,'createConnection',async(...args)=>{
       probes++;
       if(offline)throw Object.assign(Error('synthetic outage'),{code:'ECONNREFUSED'});
       return original(...args);
      });
      const {runtime,calls}=await recoveryRuntime();
      try{
       await runtime.start();
       assert.equal(runtime.status().phase,'LIVENESS_ONLY');
       assert.deepEqual(calls,[]);
       offline=false;
       for(let n=0;n<80&&probes<2;n++)await new Promise(r=>setTimeout(r,25));
       assert.ok(probes>=2);
       assert.equal(runtime.status().phase,'LIVENESS_ONLY');
       assert.equal((await runtime.readiness()).ready,false);
       assert.deepEqual(calls,[]);
      }finally{await runtime.shutdown();}
     });
     assert.deepEqual(await resume(),{state:'RESUMED',replay:true});
     assert.equal((await c3State()).state,'RESUMED');
     assert.deepEqual(await resume(),{state:'RESUMED',replay:true});
    });
    await t.test('completion opens verified startup and candidate is sole managed writer',async parent=>{
     const completionCheck=(loaded,p,dir,context)=>assertCompletedC3Startup(
      loaded,p,dir,{...context,readAlerts:async()=>[],
       readinessCheck:async()=>({ready:true,database:p.targetDatabase,
        storeId:p.storeId,ledgerId:p.ledgerId})});
     assert.equal(await assertNormalStartupAllowed(await load(),{completionCheck}),true);
     await parent.test('DB outage then matching RESUMED activates with pool limit 1 only after trusted guard',async sub=>{
      const original=mysql.createConnection.bind(mysql);
      const createPool=mysql.createPool.bind(mysql),poolLimits=[];
      sub.mock.method(mysql,'createPool',options=>{
       poolLimits.push(options.connectionLimit);
       return createPool(options);
      });
      let offline=true,probes=0;
      sub.mock.method(mysql,'createConnection',async(...args)=>{
       probes++;
       if(offline)throw Object.assign(Error('synthetic outage'),{code:'ECONNREFUSED'});
       return original(...args);
      });
      const {runtime,calls,waitForStarted}=await recoveryRuntime();
      try{
       await runtime.start();
       assert.equal(runtime.status().phase,'LIVENESS_ONLY');
       assert.deepEqual(calls,[]);
       offline=false;
       await waitForStarted(t.signal);
       assert.equal(runtime.status().phase,'RUNNING');
       assert.ok(probes>=2);
       assert.deepEqual(calls.slice(-3),['readiness','operations','worker']);
       assert.deepEqual(poolLimits,[1]);
       assert.equal((await runtime.readiness()).ready,true);
      }finally{await runtime.shutdown();}
     });
     const terminalPath=join(journal,'c3-resume.json');
     const terminalSaved=await readFile(terminalPath,'utf8');
     for(const patch of [{recoveryOperationId:'00000000-0000-4000-8000-000000000000'},
      {planDigest:'5'.repeat(64)}]){
      await writeFile(terminalPath,JSON.stringify({...JSON.parse(terminalSaved),...patch}));
      await assert.rejects(async()=>assertNormalStartupAllowed(await load(),{completionCheck}));
      await writeFile(terminalPath,terminalSaved);
     }
     const terminalOmitted=await load();terminalOmitted.config={...terminalOmitted.config};
     delete terminalOmitted.config.recovery;
     await blocked(()=>assertNormalStartupAllowed(terminalOmitted),
      'PRODUCTION_C3_STARTUP_BLOCKED');
     const candidatePool=mysql.createPool({uri:target.href,connectionLimit:2});
     let candidateManaged;
     try{
      const store=createMySqlAuthStore({pool:candidatePool,database:plan.targetDatabase,
       bindRecoveryGuard:bindRecoveryWriteGuard});
      const auth=createAuthService({store,rateLimiter:createMemoryLoginRateLimiter()});
      assert.equal(await auth.authenticateSession(b.login.token),null);
      const oldGuarded=createAuthService({store:createMySqlAuthStore({pool:b.pool,
       database:plan.currentDatabase,bindRecoveryGuard:bindRecoveryWriteGuard}),
       rateLimiter:createMemoryLoginRateLimiter()});
      await blocked(()=>oldGuarded.login({loginIdentifier:b.people[0].loginIdentifier,
       password:b.secret}),'RECOVERY_WRITE_FROZEN');
      candidateManaged=managedChild(target.href);await candidateManaged.wait('READY');
      assert.equal(managed.status().normalWriterCount,0);
      assert.equal(candidateManaged.status().normalWriterCount,1);
      const fresh=await auth.login({loginIdentifier:b.people[0].loginIdentifier,
       password:b.secret});
      assert.equal(fresh.ok,true);
      // A valid post-resume login changes the candidate snapshot. Restart
      // interlock must still allow this completed operation.
      assert.equal(await assertNormalStartupAllowed(await load(),{completionCheck}),true);
      assert.deepEqual(await modes(),{old:'FROZEN',candidate:'NORMAL'});
      assert.equal(await name(),plan.targetDatabase);
      assert.equal((await c3State()).state,'RESUMED');
     }finally{await candidateManaged?.cleanup();await candidatePool.end();}
    });
    await t.test('different-operation terminal journal is a conflict',async()=>{
     const path=join(journal,'c3-resume.json'),saved=await readFile(path,'utf8');
     await writeFile(path,JSON.stringify({...JSON.parse(saved),planDigest:'3'.repeat(64)}));
     await blocked(()=>resume(),'PRODUCTION_C3_JOURNAL_CONFLICT');
     await writeFile(path,saved);
    });
   }finally{await targetConnection.end();}
  }finally{await managed?.cleanup?.();}
 });
});
