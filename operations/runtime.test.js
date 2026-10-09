import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createOperationalStore} from './store.js';import {createIncidentLifecycle} from './incidents.js';
import {FakeAlertTransport,createAlertDispatcher} from './alerts.js';import {createOperationalRuntime} from './runtime.js';
import {acquireOperationalWriter} from './writer-lock.js';import {reportBackup,consumeBackupReports} from './backup-report.js';
import {createRotatingLog} from '../production/rotating-log.js';import {createSafeLogger} from '../production/runtime-log.js';
import {syntheticTls} from '../test-support/runtime-tls.js';import {renderAdminPage} from '../ui/admin-view.js';
async function fixture(work){const dir=await mkdtemp(join(tmpdir(),'ktv-stage5d-test-'));try{await work(dir);}finally{await rm(dir,{recursive:true,force:true});}}
const silent={log(){}};
test('alert delivery deduplicates, retries with backoff, exhausts and recovers without business rollback',()=>fixture(async dir=>{
 let time=Date.now();const store=await createOperationalStore(dir,'synthetic'),life=createIncidentLifecycle({store,scope:'synthetic',logger:silent,now:()=>time}),transport=new FakeAlertTransport({failures:2}),dispatcher=createAlertDispatcher({store,transport,logger:silent,now:()=>time,backoffMs:100});
 const incident=await life.condition('DATABASE_UNAVAILABLE',true,{component:'database',requestId:'r1'});
 assert.equal((await life.condition('DATABASE_UNAVAILABLE',true,{component:'database',requestId:'r2'})).incidentId,incident.incidentId);
 await dispatcher.tick();await dispatcher.tick();assert.equal(store.read().outbox[0].attempts,1);time+=100;await dispatcher.tick();time+=200;await dispatcher.tick();
 assert.equal(transport.messages.length,1);assert.equal(store.read().outbox[0].state,'DELIVERED');
 await life.condition('DATABASE_UNAVAILABLE',false,{component:'database'});await dispatcher.tick();assert.equal(transport.messages[1].transition,'RESOLVED');
 const outage=new FakeAlertTransport({failures:99}),d=createAlertDispatcher({store,transport:outage,logger:silent,now:()=>time,backoffMs:1,maxAttempts:3});
 await life.condition('DEVICE_UNKNOWN',true,{workflowId:'synthetic'});for(let n=0;n<4;n++){time+=10;await d.tick();}
 assert.equal(store.read().outbox.at(-1).state,'EXHAUSTED');assert.equal(store.read().outbox.at(-1).attempts,3);
}));
test('timed out alert send cannot create repeated hanging calls in one process',()=>fixture(async dir=>{
 const store=await createOperationalStore(dir,'synthetic'),life=createIncidentLifecycle({store,scope:'synthetic',logger:silent});await life.condition('DEVICE_UNKNOWN',true);
 let calls=0,time=Date.now();const d=createAlertDispatcher({store,logger:silent,now:()=>time,timeoutMs:10,backoffMs:1,transport:{send(){calls++;return new Promise(()=>{});}}});
 await d.tick();time+=100;await d.tick();assert.equal(calls,1);
}));
test('dedicated operational writer prevents competing runtimes; stale crash lock is reclaimed',()=>fixture(async dir=>{
 const release=await acquireOperationalWriter(dir,'synthetic');await assert.rejects(acquireOperationalWriter(dir,'synthetic'),/ALREADY_RUNNING/);await release();
 const again=await acquireOperationalWriter(dir,'synthetic');await again();
}));
test('runtime monitors TLS thresholds, backup failures, recovery, auth buckets and safe admin projection',()=>fixture(async dir=>{
 const tls=await syntheticTls();let time=Date.now();const secrets=['synthetic-password','synthetic-token','synthetic-cookie','synthetic-xsrf'];
 const loaded={logDirectory:dir,redactionSecrets:secrets,tls:{cert:tls.certificate},config:{storeId:'synthetic',ledgerId:'synthetic',publicOrigin:'https://ktv-smoke.127.0.0.1.sslip.io:8443',backupPolicyConfigured:true,monitoring:{intervalMs:1000,minFreeBytes:1,authFailures:2}}};
 const logs=[],transport=new FakeAlertTransport(),ops=await createOperationalRuntime({loaded,logger:{log:e=>logs.push(e)},transport,now:()=>time});
 let down=false,mode='NORMAL';const services={readiness:async()=>{if(down)throw Error(secrets[0]);return {ready:mode==='NORMAL',blockers:mode==='NORMAL'?[]:[{code:'RECOVERY_PAUSED'}]};},operationalFacts:async()=>({recoveryMode:mode,worker:'DISABLED',workflows:[]})};
 await ops.start(services);
 try{
  await ops.checkTls({notBefore:new Date(time-1).toISOString(),notAfter:new Date(time+31*86400000).toISOString(),hostnameMatches:true,daysRemaining:31});
  for(const [days,severity]of [[30,'WARN'],[14,'ERROR'],[7,'CRITICAL']]){await ops.checkTls({notBefore:new Date(time-1).toISOString(),notAfter:new Date(time+days*86400000).toISOString(),hostnameMatches:true,daysRemaining:days});assert.equal(ops.store.read().incidents.findLast(i=>i.type==='TLS_EXPIRING').severity,severity);}
  await ops.checkTls({notBefore:new Date(time-1).toISOString(),notAfter:new Date(time+31*86400000).toISOString(),hostnameMatches:true,daysRemaining:31});assert.equal(ops.store.read().incidents.findLast(i=>i.type==='TLS_EXPIRING').state,'RESOLVED');
  await ops.backup({success:true,at:new Date(time).toISOString(),createdAt:new Date(time).toISOString()});const success=ops.snapshot().backup.lastSuccessAt;time++;
  await ops.backup({success:false,at:new Date(time).toISOString()});assert.equal(ops.snapshot().backup.lastSuccessAt,success);assert.equal(ops.snapshot().backup.lastResult,'FAILURE');
  down=true;await ops.tick();const id=ops.store.read().incidents.find(i=>i.type==='DATABASE_UNAVAILABLE').incidentId;await ops.tick();assert.equal(ops.store.read().incidents.filter(i=>i.type==='DATABASE_UNAVAILABLE').length,1);assert.equal(ops.store.read().incidents.some(i=>i.type==='READINESS_LOST'&&i.state==='OPEN'),false);
  down=false;mode='READY_FOR_RESUME';await ops.tick();assert.equal(ops.store.read().incidents.find(i=>i.incidentId===id).state,'RESOLVED');assert.equal(ops.snapshot().recoveryMode,mode);
  const accountHash='a'.repeat(64),sourceHash='b'.repeat(64);await ops.login({accountHash,sourceHash,outcome:'failed'});await ops.login({accountHash,sourceHash,outcome:'rate_limited'});assert.equal(ops.store.read().incidents.filter(i=>i.type==='AUTH_REPEATED_FAILURES').length,2);
  await ops.login({accountHash,sourceHash,outcome:'success'});assert.equal(ops.store.read().incidents.find(i=>i.type==='AUTH_REPEATED_FAILURES'&&i.context.category.startsWith('account')).state,'RESOLVED');
  const serialized=JSON.stringify({projection:ops.snapshot(),events:logs,payloads:transport.messages,state:ops.store.read()});
  for(const value of [...secrets,'password','Cookie','X-TOKEN','stack',dir])assert.equal(serialized.includes(value),false);
  assert.match(renderAdminPage({phase:'ready',session:{principalId:'synthetic'},snapshot:{revision:0,view:{dashboard:{},rooms:[],reviewQueue:[],operations:ops.snapshot()}}}),/运维状态/);
 }finally{await ops.stop();}
}));
test('backup mailbox preserves verified success and rejects raw sensitive context',()=>fixture(async dir=>{
 await reportBackup(dir,{success:true,createdAt:new Date().toISOString()});await reportBackup(dir,{success:false});const reports=[];assert.equal(await consumeBackupReports(dir,r=>reports.push(r)),2);assert.equal((await readdir(dir)).length,0);
 await assert.rejects(reportBackup(dir,{success:true,createdAt:'invalid'}),/BACKUP_REPORT_INVALID/);
}));
test('single log sink bounds rotation and keeps unrelated state, secrets and stack out',()=>fixture(async dir=>{
 await writeFile(join(dir,'operational-state.json'),'protected');const sink=createRotatingLog(dir,{maxBytes:1024,maxFiles:2}),logger=createSafeLogger({write:s=>sink.write(s),secrets:['synthetic-secret']});
 for(let n=0;n<100;n++)logger.log({code:'DEVICE_UNKNOWN',severity:'ERROR',eventType:'DEVICE_UNKNOWN',message:'safe',password:'synthetic-secret',stack:'C:/private'});
 sink.close();const names=(await readdir(dir)).filter(n=>n.endsWith('.jsonl'));assert.ok(names.length<=2);assert.equal(await readFile(join(dir,'operational-state.json'),'utf8'),'protected');
 const text=(await Promise.all(names.map(n=>readFile(join(dir,n),'utf8')))).join('');assert.equal(text.includes('synthetic-secret'),false);assert.equal(text.includes('C:/private'),false);
}));
