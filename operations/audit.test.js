import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';
import {createOperationalStore} from './store.js';import {createIncidentLifecycle} from './incidents.js';import {createAlertDispatcher,FakeAlertTransport,alertPayload} from './alerts.js';import {createOperationalRuntime} from './runtime.js';import {operationalEvent} from './contract.js';import {createSafeLogger} from '../production/runtime-log.js';import {syntheticTls} from '../test-support/runtime-tls.js';
const silent={log(){}};let tlsPromise;const certificate=()=>tlsPromise??=syntheticTls();
async function fixture(work){const dir=await mkdtemp(join(tmpdir(),'ktv-stage5d-audit-'));try{await work(dir);}finally{await rm(dir,{recursive:true,force:true});}}
async function loaded(dir,overrides={}){return {logDirectory:dir,redactionSecrets:[],tls:{cert:(await certificate()).certificate},config:{storeId:'synthetic',ledgerId:'synthetic',publicOrigin:'https://ktv-smoke.127.0.0.1.sslip.io:8443',backupPolicyConfigured:true,monitoring:{intervalMs:60000,minFreeBytes:1,backupDirectory:dir},...overrides}};}
const healthy={readiness:async()=>({ready:true,blockers:[]})};
test('audit: physical send attempts are reserved durably before three actual process crashes',{timeout:20000},()=>fixture(async dir=>{
 const store=await createOperationalStore(dir,'synthetic'),life=createIncidentLifecycle({store,scope:'synthetic',logger:silent});await life.condition('DEVICE_UNKNOWN',true,{roomId:'V01',workflowId:'audit'});
 const delivery=store.read().outbox[0];let clock=Date.now();
 for(let attempt=1;attempt<=3;attempt++){
  const code=`import {createOperationalStore} from ${JSON.stringify(new URL('./store.js',import.meta.url).href)};import {createAlertDispatcher} from ${JSON.stringify(new URL('./alerts.js',import.meta.url).href)};const store=await createOperationalStore(${JSON.stringify(dir)},'synthetic');const d=createAlertDispatcher({store,logger:{log(){}},now:()=>${clock},backoffMs:100,timeoutMs:10000,transport:{send(){process.send('sent');return new Promise(()=>{});}}});await d.tick();`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});child.stderr.resume();
  try{const [message]=await once(child,'message',{signal:AbortSignal.timeout(5000)});assert.equal(message,'sent');}
  finally{if(child.exitCode===null){const dead=once(child,'exit');child.kill('SIGKILL');await dead;}}
  const persisted=(await createOperationalStore(dir,'synthetic')).read().outbox[0];assert.equal(persisted.attempts,attempt);assert.equal(persisted.deliveryId,delivery.deliveryId);assert.equal(persisted.sequence,delivery.sequence);assert.ok(persisted.nextAttemptAt>clock);clock+=20000;
 }
 const restarted=await createOperationalStore(dir,'synthetic');let calls=0;await createAlertDispatcher({store:restarted,logger:silent,now:()=>clock,transport:{async send(){calls++;return {accepted:true};}}}).tick();assert.equal(calls,0);assert.equal(restarted.read().outbox[0].state,'EXHAUSTED');
}));
test('audit: preconstructed successor reloads state after obtaining ownership',()=>fixture(async dir=>{
 const config=await loaded(dir),first=await createOperationalRuntime({loaded:config,logger:silent,transport:new FakeAlertTransport()});await first.start(healthy);
 const next=await createOperationalRuntime({loaded:config,logger:silent,transport:new FakeAlertTransport()});
 const incident=await first.lifecycle.condition('DEVICE_UNKNOWN',true,{roomId:'V06',workflowId:'latest'});
 await first.stop();await next.start(healthy);
 try{assert.equal(next.store.read().incidents.find(i=>i.incidentId===incident.incidentId)?.state,'OPEN');assert.equal(next.store.read().incidents.filter(i=>i.type==='PROCESS_FAILURE').length,0);}finally{await next.stop();}
}));
test('audit: required-channel blocker never oscillates to false recovery on monitoring ticks',()=>fixture(async dir=>{
 const config=await loaded(dir,{monitoring:{intervalMs:60000,minFreeBytes:1,backupDirectory:dir,alertingRequired:true}}),ops=await createOperationalRuntime({loaded:config,logger:silent});await ops.start(healthy);
 try{for(let n=0;n<4;n++){await ops.observeReadiness({ready:false,blockers:['ALERT_CHANNEL_REQUIRED']});await ops.tick();assert.equal(ops.snapshot().ready,false);}
 const history=ops.store.read().incidents.filter(i=>i.type==='READINESS_LOST');assert.equal(history.length,1);assert.equal(history[0].state,'OPEN');assert.equal(ops.store.read().outbox.some(e=>e.incidentId===history[0].incidentId&&e.transition==='RESOLVED'),false);}finally{await ops.stop();}
}));
test('audit: missing backup policy differs from overdue under an established policy',()=>fixture(async dir=>{
 const ops=await createOperationalRuntime({loaded:await loaded(dir,{backupPolicyConfigured:false}),logger:silent,transport:new FakeAlertTransport()});await ops.start(healthy);
 try{assert.ok(ops.snapshot().incidents.some(i=>i.code==='BACKUP_POLICY_MISSING'&&i.state==='OPEN'));assert.equal(ops.snapshot().incidents.some(i=>i.code==='BACKUP_OVERDUE'&&i.state==='OPEN'),false);assert.equal(ops.snapshot().backup.overdue,null);}finally{await ops.stop();}
 const configured=await createOperationalRuntime({loaded:await loaded(dir),logger:silent,transport:new FakeAlertTransport()});await configured.start(healthy);
 try{assert.equal(configured.snapshot().backup.overdue,true);assert.ok(configured.snapshot().incidents.some(i=>i.code==='BACKUP_OVERDUE'&&i.state==='OPEN'));}finally{await configured.stop();}
}));
test('audit: partial mailboxes and failing TLS do not starve DB or other probes; cycle is serial',()=>fixture(async dir=>{
 await writeFile(join(dir,'backup-report-00000000-0000-4000-8000-000000000001.json'),'{');await writeFile(join(dir,'invariant-report-00000000-0000-4000-8000-000000000002.json'),'');
 const config=await loaded(dir),ops=await createOperationalRuntime({loaded:config,logger:silent,transport:new FakeAlertTransport()});let probes=0,release;
 const services={readiness:async()=>{probes++;return {ready:false,blockers:[{code:'DATABASE_OR_SCHEMA_UNAVAILABLE'}]};}};
 await ops.start(services);
 try{assert.ok(probes>0);assert.ok(ops.snapshot().incidents.some(i=>i.code==='DATABASE_UNAVAILABLE'&&i.state==='OPEN'));assert.equal(ops.snapshot().monitoring,'DEGRADED');
 config.tls.cert='invalid';const before=probes;await ops.tick();assert.ok(probes>before);
 config.tls.cert=(await certificate()).certificate;services.readiness=async()=>{probes++;await new Promise(r=>{release=r;});return {ready:true,blockers:[]};};
 const a=ops.tick(),b=ops.tick();assert.equal(a,b);while(!release)await new Promise(r=>setTimeout(r,1));release();await a;
 }finally{await ops.stop();}
}));
test('audit: nested casing/raw error secrets are absent from every operational surface',()=>fixture(async dir=>{
 const marker='synthetic-private-marker',privateData={Password:marker,PASSWORD:marker,password:marker,Authorization:marker,authorization:marker,Cookie:marker,cookie:marker,'x-token':marker,'X-TOKEN':marker,error:{context:{headers:{cookie:marker}}},provider:{config:{password:marker}},cause:{request:{headers:{authorization:marker}}},db:{connection:{url:'mysql://user:'+marker+'@localhost/db'}},array:[{nested:marker}],message:'X-TOKEN '+marker+' rejected',stack:marker};
 const config=await loaded(dir),ops=await createOperationalRuntime({loaded:config,logger:silent,transport:new FakeAlertTransport()}),logs=[],logger=createSafeLogger({write:s=>logs.push(s)});
 logger.log(privateData);logger.error(new Error(privateData.message));
 const event=operationalEvent('DEVICE_UNKNOWN',privateData),i=await ops.lifecycle.condition('DEVICE_UNKNOWN',true,privateData),payload=alertPayload(i,ops.store.read().outbox[0]);
 const serialized=JSON.stringify({logs,event,incident:i,payload,pending:ops.store.read().outbox,admin:ops.snapshot()});assert.equal(serialized.includes(marker),false);
}));
test('audit: atomic rejection, distinct rooms, recurrence and bounded retention preserve active deliveries',()=>fixture(async dir=>{
 let time=Date.now();const store=await createOperationalStore(dir,'synthetic'),life=createIncidentLifecycle({store,scope:'synthetic',logger:silent,now:()=>time,maxHistory:2,retentionMs:100});
 const a=await life.condition('DEVICE_UNKNOWN',true,{roomId:'V01',workflowId:'one',requestId:'first'}),b=await life.condition('DEVICE_UNKNOWN',true,{roomId:'V06',workflowId:'two'});assert.notEqual(a.incidentId,b.incidentId);
 assert.equal((await life.condition('DEVICE_UNKNOWN',true,{roomId:'V01',workflowId:'one',requestId:'second'})).incidentId,a.incidentId);
 await life.condition('DEVICE_UNKNOWN',false,{roomId:'V01',workflowId:'one'});const again=await life.condition('DEVICE_UNKNOWN',true,{roomId:'V01',workflowId:'one'});assert.notEqual(a.incidentId,again.incidentId);
 const before=store.read();await assert.rejects(store.update(s=>{s.incidents.push({broken:true});throw Error('synthetic abort');}));assert.deepEqual(store.read(),before);
 time+=1000;await life.prune();const ids=new Set(store.read().incidents.map(i=>i.incidentId));assert.ok(ids.has(b.incidentId)&&ids.has(again.incidentId));assert.ok(store.read().outbox.filter(e=>e.state==='PENDING').every(e=>ids.has(e.incidentId)));
}));
test('audit: crash-loop count survives fresh runtimes; planned stop stays normal',()=>fixture(async dir=>{
 const config=await loaded(dir);let clock=Date.now();
 for(let n=0;n<4;n++){const ops=await createOperationalRuntime({loaded:config,logger:silent,transport:new FakeAlertTransport(),now:()=>clock});await ops.start(healthy);if(n===3){assert.ok(ops.snapshot().incidents.some(i=>i.code==='PROCESS_CRASH_LOOP'&&i.severity==='CRITICAL'&&i.state==='OPEN'));clock+=600001;await ops.tick();assert.equal(ops.snapshot().incidents.find(i=>i.code==='PROCESS_CRASH_LOOP').state,'RESOLVED');await ops.stop();}else{await ops.stop({clean:false});clock+=100;}}
 const planned=await createOperationalRuntime({loaded:config,logger:silent,transport:new FakeAlertTransport(),now:()=>clock});await planned.start(healthy);try{assert.equal(planned.snapshot().incidents.some(i=>i.code==='PROCESS_FAILURE'&&i.state==='OPEN'),false);}finally{await planned.stop();}
}));
