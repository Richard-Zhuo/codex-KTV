// Owned MySQL/OS/SCM composition only. Never reads ProgramData or a real provider credential.
import mysql from 'mysql2/promise';import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';import {randomBytes} from 'node:crypto';
import {withBackupFixture} from './backup-fixture.js';import {syntheticTls,protectSyntheticFile} from './runtime-tls.js';
import {backupDatabase} from '../backup/mysql-backup.js';import {canonical} from '../backup/format.js';
import {decodeLedgerSnapshot,encodeLedgerSnapshot} from '../ledger/mysql-snapshot.js';
import {createD2AclFixture} from './d2-acl-fixture.js';
import {withOwnedRecoveryReader} from '../recovery/runtime-boundary.js';
import {inspectProductionRestore,checkedPaths} from '../recovery/production-plan.js';
import {issueOwnedCandidateCapability} from '../recovery/production-candidate.js';
import {createOwnedAuthorizationHarness} from '../recovery/production-authorization.js';
import {readOwnedOrchestrationFacts,startupReadContext} from '../recovery/orchestration-facts.js';
import {createOwnedRestoreOrchestration} from '../recovery/production-orchestration.js';
import {runProductionRestoreCli} from '../recovery/production-restore-cli.js';
import {readExecutionState,transitionExecutionState} from '../recovery/production-journal.js';
import {transitionCutoverState} from '../recovery/production-cutover-journal.js';
import {transitionC3State} from '../recovery/production-c3-journal.js';
import {writeC1Evidence} from '../recovery/c1-evidence.js';
import {createProductionRuntime} from '../production/runtime.js';
import {readProductionReadiness} from '../production/readiness.js';
export async function withD2Fixture(work){
 return withBackupFixture(async b=>{
  const id=process.env.STAGE5E_FIXTURE_ID,root=process.env.STAGE5E_FIXTURE_ROOT,serverUuid=process.env.STAGE5E_FIXTURE_UUID;
  if(!id||!root||!serverUuid)throw Error('D2_OWNED_FIXTURE_REQUIRED');
  const user='d2_'+randomBytes(8).toString('hex'),password=randomBytes(24).toString('hex');
  const runtimeUser='d2rt_'+randomBytes(8).toString('hex'),runtimePassword=randomBytes(24).toString('hex');
  let runtime,createdUser=false,createdRuntimeUser=false;
  try{
   await b.setup.query('CREATE USER ?@? IDENTIFIED BY ?',[user,'127.0.0.1',password]);createdUser=true;
   await b.setup.query('CREATE USER ?@? IDENTIFIED BY ?',[runtimeUser,'127.0.0.1',runtimePassword]);createdRuntimeUser=true;
   await b.setup.query('GRANT SELECT, INSERT, UPDATE, DELETE ON *.* TO ?@?',[runtimeUser,'127.0.0.1']);
   await b.setup.query('GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, SHOW DATABASES ON *.* TO ?@?',[user,'127.0.0.1']);
   const operatorUrl=new URL('mysql://127.0.0.1:33313/');operatorUrl.username=user;operatorUrl.password=password;
   const sourceUrl=new URL(operatorUrl);sourceUrl.pathname='/jbhh_ktv_test';
   const fixture={root,names:{id,database:'jbhh_ktv_test'},identity:{server_uuid:serverUuid},port:33313,dbUrl:()=>sourceUrl.href};
   const capability=await issueOwnedCandidateCapability(fixture);
   await b.setup.query("UPDATE production_bootstrap_events SET environment='production'");
   const [[head]]=await b.setup.query('SELECT state_json,state_checksum FROM ledger_heads');
   const state=decodeLedgerSnapshot(head.state_json,head.state_checksum);for(const stock of [...Object.values(state.inventory),...Object.values(state.consumables)])stock.count=1000;
   const encoded=encodeLedgerSnapshot(state);await b.setup.execute('UPDATE ledger_heads SET state_json=?,state_checksum=?',[encoded.json,encoded.checksum]);
   const label=randomBytes(6).toString('hex'),journal=join(root,'artifacts','d2_'+label),authDir=join(root,'artifacts','authorization_d2_'+label),logs=join(root,'artifacts','logs_d2_'+label);
   for(const path of [journal,authDir,logs,join(journal,'orchestration')])await mkdir(path);
   const backup=await backupDatabase({...b.backupArgs,environment:'production',outputDirectory:join(root,'backups','d2_'+label)});
   const tls=await syntheticTls(),configPath=join(journal,'runtime.json'),secretPath=join(journal,'runtime-secrets.json'),policyPath=join(journal,'policy.json'),operatorPath=join(journal,'operator-db.json');
   const operator='S-1-5-21-101-202-303-1001',ADMIN='S-1-5-32-544';let actor={sid:operator,elevated:true},offset=0,outbox=[];
   const config={configVersion:1,applicationCommit:b.backupArgs.applicationCommit,publicOrigin:'https://ktv-smoke.127.0.0.1.sslip.io:8443',listenHost:'127.0.0.1',port:8443,
    storeId:b.storeId,ledgerId:b.ledgerId,timeZone:'Asia/Shanghai',businessDateCutoff:'12:00',sessionRuleVersion:'opening-hours-v1',deviceControlMode:'disabled',liveControlEnabled:false,
    secretsFile:secretPath,logDirectory:logs,serviceAccountSid:tls.sid,backupPolicyConfigured:true,directoryAclReviewed:true,networkModel:'private-vpn',monitoring:{intervalMs:1000,backupDirectory:join(root,'backups')},recovery:{journalDirectory:journal,operatorDbSecretsFile:operatorPath}};
   const runtimeSource=new URL(b.raw);
   const bundle={database:{host:'127.0.0.1',port:33313,name:'jbhh_ktv_test',user:runtimeUser,password:runtimePassword},tls:{certificate:tls.certificate,privateKey:tls.privateKey},ktvsky:{password:'D2_PROVIDER_SENTINEL'}};
   for(const [path,value] of [[configPath,config],[secretPath,bundle],[policyPath,{policyVersion:1,approvedOperatorSid:operator,runtimeServiceSid:tls.sid,runtimeConfigFile:configPath}],[operatorPath,{databaseUrl:operatorUrl.href}]]){await writeFile(path,JSON.stringify(value));await protectSyntheticFile(path,tls.sid);}
   const acl=createD2AclFixture({configPath,secretPath,policyPath,operatorPath,journal,authDir,backupDirectory:backup.directory,backupRoot:join(root,'backups'),runtimeServiceSid:tls.sid,identity:()=>actor});
   return await withOwnedRecoveryReader(capability,{policyPath,identity:async()=>actor,fileAcl:acl.fileFacts,directoryAcl:acl.directoryFacts,env:{NODE_ENV:'production',KTV_HTTP_ENV:'production',KTV_DEPLOYMENT_ENV:'production'}},async reader=>{
    const fileAcl=acl.checkFile;
    const harden=async path=>{acl.category(path);await protectSyntheticFile(path,tls.sid);await acl.checkFile(path);};
    const journalOptions={checkAcl:fileAcl,harden};
    const pathCheck=(loaded,artifact)=>checkedPaths(loaded,artifact,{backupAcl:acl.checkDirectory,journalAcl:acl.checkDirectory,fileAcl});
    const deps={runtimeConfigFile:configPath,load:()=>reader.load(configPath),pathCheck,fileAcl,
     connect:async uri=>mysql.createConnection({uri,dateStrings:true,jsonStrings:true,supportBigNumbers:true,bigNumberStrings:true}),operatorLoad:loaded=>loaded.operatorUrl,
     readState:(dir,p)=>readExecutionState(dir,p,journalOptions),journalOptions,evidenceOptions:{checkAcl:fileAcl},readAlerts:async()=>outbox,
     executionTransition:(dir,p,from,to)=>transitionExecutionState(dir,p,from,to,journalOptions),cutoverTransition:(dir,p,from,to)=>transitionCutoverState(dir,p,from,to,journalOptions),
     c3Transition:(dir,p,proof,from,to)=>transitionC3State(dir,p,proof,from,to,journalOptions),persistEvidence:(dir,p,report)=>writeC1Evidence(dir,p,report,journalOptions)};
    const plan=await inspectProductionRestore({...deps,artifactDirectory:backup.directory,expectedChecksum:backup.checksum});
    const planPath=join(journal,'active-plan.json');await writeFile(planPath,canonical(plan));await protectSyntheticFile(planPath,tls.sid);
    const authorityFacts=async()=>{const f=await readOwnedOrchestrationFacts(capability,deps);return {plan:f.plan,actorSid:f.loaded.actor.sid,runtimeServiceSid:f.loaded.config.serviceAccountSid,deploymentConfigFingerprint:f.loaded.configFingerprint,environment:'production',authorizationDirectory:authDir,checkDirectory:acl.checkDirectory,checkFile:acl.checkFile};};
    const authorization=await createOwnedAuthorizationHarness({capability,facts:authorityFacts,clock:()=>Date.now()+offset,harden:journalOptions.harden});
    const counts={workersStarted:0,workersStopped:0,pointerMoves:0,providerReplay:0},safeLogs=[];
    async function startRuntime(){
     const loaded=await reader.load(configPath),pointer=loaded.pointer.name,runtimeUrl=new URL(b.raw);runtimeUrl.username=runtimeUser;runtimeUrl.password=runtimePassword;runtimeUrl.pathname='/'+pointer;
     const serviceLoaded=startupReadContext({...loaded,apiEnv:{KTV_MYSQL_URL:runtimeUrl.href}},plan);serviceLoaded.productionConfig.database=pointer;
     const pool=mysql.createPool({uri:runtimeUrl.href,connectionLimit:1,dateStrings:true,jsonStrings:true,supportBigNumbers:true,bigNumberStrings:true});
     runtime=createProductionRuntime({...serviceLoaded,config:{...loaded.config,port:0},tls:{cert:tls.certificate,key:tls.privateKey},redactionSecrets:[password,runtimeUrl.href,tls.privateKey]},
      {logger:{info:entry=>safeLogs.push(entry.event),error:entry=>safeLogs.push(entry.code)},services:{readiness:()=>readProductionReadiness({pool,config:serviceLoaded.productionConfig}),startWorker:async()=>{counts.workersStarted++;},stopWorker:async()=>{counts.workersStopped++;},close:()=>pool.end()},operations:{readyBlockers:()=>[],observeReadiness:async()=>{},start:async()=>{},stop:async()=>{}}});
     await runtime.start();if(runtime.status().phase!=='RUNNING')throw Error('D2_RUNTIME_STARTUP_INCOMPLETE');
    }
    await startRuntime();
    const serviceExpected={serviceName:'JbhhKtv',hostExecutable:join(journal,'service-host.exe'),nodeExecutable:process.execPath,entryFile:join(journal,'runtime-entry.js'),configFile:configPath,serviceSid:tls.sid};
    const hostArgs=[serviceExpected.hostExecutable,'--node',serviceExpected.nodeExecutable,'--entry',serviceExpected.entryFile,'--config',configPath];
    let snapshotOverride=null;const hooks={pointerOptions:{harden:journalOptions.harden},verify:{onError:error=>safeLogs.push('c1_error:'+String(error.code??'UNKNOWN'))}};
    const system={snapshot:async()=>{
     if(snapshotOverride)return snapshotOverride;
     if(runtime.status().phase==='STOPPED')return {name:'JbhhKtv',state:'Stopped',pid:0,serviceSid:tls.sid,argv:hostArgs,processes:[]};
     return {name:'JbhhKtv',state:'Running',pid:100,serviceSid:tls.sid,argv:hostArgs,processes:[{pid:100,ppid:4,createdAt:'2026-10-13T00:00:00.000Z',executable:serviceExpected.hostExecutable,argv:hostArgs,sid:tls.sid},{pid:101,ppid:100,createdAt:'2026-10-13T00:00:01.000Z',executable:process.execPath,argv:[process.execPath,serviceExpected.entryFile,'--config-file',configPath],sid:tls.sid}]};
    },command:async action=>{if(action==='stop')await runtime.shutdown();else if(action==='start')await startRuntime();else throw Error('D2_SCM_ACTION_INVALID');},pause:ms=>new Promise(r=>setTimeout(r,ms))};
    const session=await createOwnedRestoreOrchestration({capability,authorization,deps,serviceExpected,system,hooks});
    const cli=async(action,options={})=>{let stdout='',stderr='';const exit=await runProductionRestoreCli([action,'--config-file',configPath],{orchestration:session,confirm:async({challenge})=>challenge,stdout:{write:value=>{stdout+=value;}},stderr:{write:value=>{stderr+=value;}},...options});return {exit,result:JSON.parse(stdout||stderr),stdout,stderr};};
    return await work({b,plan,config,bundle,backup,configPath,secretPath,planPath,journal,authDir,capability,authorization,deps,reader,session,hooks,system,serviceExpected,cli,counts,safeLogs,
     setActor:value=>{actor=value;},actor:()=>actor,advanceClock:ms=>{offset+=ms;},setOutbox:value=>{outbox=value;},overrideScm:value=>{snapshotOverride=value;},runtime:()=>runtime});
   });
  }finally{await runtime?.shutdown();if(createdUser)await b.setup.query('DROP USER ?@?',[user,'127.0.0.1']);if(createdRuntimeUser)await b.setup.query('DROP USER ?@?',[runtimeUser,'127.0.0.1']);}
 });
}
