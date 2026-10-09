import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';import mysql from 'mysql2/promise';
import {launcher,sleep,productionEnv} from './launcher.js';
import {backupRestoredRehearsal} from './restored-backup.js';
import {initialize,makeBackup,restore} from './prepare.js';
import {migrateFresh} from './migration.js';
import {FakeExternalHeartbeatMonitor} from './heartbeat.js';
import {CATEGORIES,cutoverDecision,rollbackDecision} from './gates.js';
import {decodeLedgerSnapshot} from '../ledger/mysql-snapshot.js';
import {total,outstanding,nextCollectCharge} from '../sales.js';
import {freezeDatabase} from '../recovery/operator.js';
import {loadRuntimeConfig} from '../production/runtime-config.js';
import {preflight} from '../production/preflight.js';
import {reportBackup} from '../operations/backup-report.js';
import {businessSessionFor} from '../shared/business-session.js';import {businessDateFor} from '../shared/business-day.js';
export async function eventually(read,predicate,description,timeout=20000){const until=Date.now()+timeout;let result;while(Date.now()<until){try{result=await read();if(predicate(result))return result;}catch(error){if(!['ECONNREFUSED','ECONNRESET','EPIPE'].includes(error.code))throw error;result={code:error.code};}await sleep(200);}throw Error('REHEARSAL_TIMEOUT '+description+' '+JSON.stringify(result));}
export async function scenarios(f,record){
 const evidence={id:f.names.id,startedAt:new Date().toISOString(),package:{current:f.packages.current.sha256,previous:f.packages.previous.sha256,application:f.packages.current.commit,previousApplication:f.packages.previous.commit},checkpoints:f.source.checkpoints};
 const step=async(name,work)=>{record?.(name);const at=new Date().toISOString();const facts=await work();evidence[name]={at,...facts};return facts;};
 // Actual production entry and predecessor artifact, on a separate fresh synthetic database.
 let formal;const formalPreflight=[];
 const entry=await initialize(f,f.names.entryDatabase,'production',async step=>{formal??=await launcher(f,{database:f.names.entryDatabase,label:'formal',formal:true});const r=await preflight(formal.configPath,productionEnv);formalPreflight.push({step,ready:r.ready,blockers:r.blockers});});
 await step('formalEntry',async()=>{
  const initial=await preflight(formal.configPath,productionEnv);assert.equal(initial.ready,true);assert.equal(formalPreflight[0].ready,false);
  const broken=await launcher(f,{database:f.names.failureDatabase,label:'migration-failed',formal:true});assert.equal((await preflight(broken.configPath,productionEnv)).ready,false);broken.start();await eventually(()=>broken.request('/health/live'),r=>r.status===200,'partial schema runtime liveness');assert.equal((await broken.request('/health/ready')).status,503);await broken.stop();
  formal.start();await formal.wait();assert.equal((await formal.request('/')).status,200);const css=await formal.request('/style.css');assert.equal(css.status,200);assert.match(css.headers['content-type'],/text\/css/);await formal.stop();
  formal.start();await formal.wait();await formal.crash();formal.start();await formal.wait();await formal.stop();
  const old=await launcher(f,{database:f.names.entryDatabase,label:'previous',formal:true,previous:true});old.start();await old.wait();await old.stop();
  // Required real channel remains blocked; no fake is silently inserted in start.js.
  const config=JSON.parse(await readFile(formal.configPath,'utf8'));config.monitoring.alertingRequired=true;await writeFile(formal.configPath,JSON.stringify(config));
  const blocked=await preflight(formal.configPath,productionEnv);assert.equal(blocked.ready,false);assert.ok(blocked.blockers.includes('ALERT_CHANNEL_REQUIRED'));
  config.monitoring.alertingRequired=false;await writeFile(formal.configPath,JSON.stringify(config));
  return {productionStart:'PASS',preflightCheckpoints:formalPreflight,freshMigration:entry.migration.last,restart:'PASS',freshProcess:'PASS',previousArtifactStartup:'PASS',schemaCompatibility:'001-011 verified for both accepted artifacts',realRequiredAlertGate:'BLOCKED as intended',actualScmInstall:'BLOCKED',serviceProcessLifecycle:'PASS'};
 });
 await step('tlsFailure',async()=>{
  const saved=await readFile(formal.secretPath,'utf8'),invalid=JSON.parse(saved);invalid.tls.certificate=f.tls.ca;
  await writeFile(formal.secretPath,JSON.stringify(invalid));
  await assert.rejects(loadRuntimeConfig(formal.configPath,productionEnv),{code:'RUNTIME_TLS_INVALID'});
  await writeFile(formal.secretPath,saved);await loadRuntimeConfig(formal.configPath,productionEnv);return {mismatchedCertificate:'rejected',correctCertificate:'accepted',bypass:false};
 });
 let app=await launcher(f);f.app=app;app.start();await app.wait();
 let pool=mysql.createPool({uri:f.dbUrl(f.active.database),connectionLimit:4});f.pools.add(pool);
 const head=async()=>{const [[r]]=await pool.execute('SELECT revision,state_json,state_checksum FROM ledger_heads WHERE ledger_id=?',[f.names.ledgerId]);return {revision:Number(r.revision),state:decodeLedgerSnapshot(r.state_json,r.state_checksum)};};
 f.readHead=head;
 const workflows=async()=>{const [rows]=await pool.execute('SELECT state_json,state_checksum FROM room_control_workflows WHERE ledger_id=?',[f.names.ledgerId]);return rows.map(r=>decodeLedgerSnapshot(r.state_json,r.state_checksum));};
 const calls=async()=>{try{return (await readFile(join(f.root,'fake-device-calls.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
 const accept=async(session,action,payload,body)=>{const r=await app.command(session,action,payload,body);assert.equal(r.status,200,action+' '+r.text);return r;};
 let owner=await app.login(),operator=await app.login(f.source.people[2]);
 const creditedEmployeeId=f.source.people[5].employeeId;
 const open=async(room,session=operator,wait=true)=>{await accept(session,'open',{room,beer:'bw',creditedEmployeeId});const order=(await head()).state.orders.at(-1);if(wait)await eventually(workflows,ws=>ws.find(w=>w.orderId===order.id)?.status==='ACTIVE','open device ready');return order;};
 const finish=async(order,rounding=0,session=operator)=>{const payments=[{method:'\u73b0\u91d1',amount:outstanding(order)-rounding}];await accept(session,'settle',{order:order.id,payments,...(rounding?{differenceType:'\u514d\u96f6'}:{})});};
 await step('security',async()=>{
  const limited=await app.login(f.source.people[3]),viewer=await app.login(f.source.people[4]);
  assert.equal((await app.call(limited,'/api/v1/admin/snapshot')).status,403);
  assert.equal((await app.command(limited,'settle',{order:'absent',payments:[]})).json().error.code,'authorization_denied');
  assert.equal((await app.command(viewer,'approveRounding',{order:'absent'})).json().error.code,'authorization_denied');
  const r=await app.command(owner,'open',{room:'V01',principalId:'forged',creditedEmployeeId});assert.equal(r.json().error.code,'invalid_input');
  assert.equal((await app.request('/api/v1/store/snapshot')).status,401);
  return {limitedStaff:'denied settle and backend',backendViewer:'denied approval',principalSpoof:'denied',unauthenticated:'denied',realProviderMutations:0};
 });
 await step('dayBusiness',async()=>{
  const order=await open('V01');assert.equal(order.businessSession.sessionType,'DAY');
  await eventually(workflows,ws=>ws.find(w=>w.orderId===order.id)?.status==='ACTIVE','DAY device');
  await accept(operator,'sale',{order:order.id,creditedEmployeeId,items:[{product:'bw',spec:'half',count:1},{product:'bw',spec:'dozen',count:1},{product:'drink0',spec:'half',count:1},{product:'drink0',spec:'dozen',count:1},{product:'lm',spec:'half',count:1},{product:'lm',spec:'dozen',count:1}]});
  const saved=(await head()).state.orders.find(o=>o.id===order.id);assert.deepEqual(saved.sales.map(s=>s.amountCents??s.amount),[5000,10000,5000,10000,6000,12000]);
  const charge=nextCollectCharge(saved);const body={operationKey:'rehearsal-payment-'+f.names.id,expectedRevision:(await head()).revision,payload:{order:order.id,charge:charge.id,payments:[{method:'\u5fae\u4fe1',amount:charge.remaining??charge.amount}]}};
  // Observe a committed response, then deliberately discard it as if the client lost it.
  await assert.rejects(app.call(operator,'/api/v1/commands/collect',{method:'POST',body,loseResponse:true}),/SYNTHETIC_RESPONSE_LOST/);
  const committed=await head();const replay=await accept(operator,'collect',body.payload,body);assert.equal((await head()).revision,committed.revision);
  assert.equal(replay.json().result.status,'committed');f.replay={body,action:'collect',person:f.source.people[2]};
  await finish(committed.state.orders.find(o=>o.id===order.id),1000);await accept(operator,'clean',{room:'V01'});
  return {session:order.businessSession,prices:[5000,10000,5000,10000,6000,12000],paymentResponseLossReplay:'same key, same revision, no duplicate',directRoundingCents:1000,settled:true,cleaned:true,actorCreditedEmployeeSeparate:order.actualActorPrincipalId!==creditedEmployeeId};
 });
 await step('nightBusiness',async()=>{
  await app.controls({clock:'2026-10-10T12:00:00.000Z'});owner=await app.login();operator=await app.login(f.source.people[2]);
  const order=await open('V02');assert.equal(order.businessSession.sessionType,'NIGHT');
  await accept(operator,'sale',{order:order.id,creditedEmployeeId,items:[{product:'bw',spec:'half',count:1}]});
  const saved=(await head()).state.orders.find(o=>o.id===order.id);assert.equal(saved.sales.at(-1).amountCents??saved.sales.at(-1).amount,5900);
  await finish(saved,1100);await accept(owner,'approveRounding',{order:order.id});await accept(operator,'clean',{room:'V02'});
  const retail=await accept(operator,'retailSale',{creditedEmployeeId,items:[{product:'water',spec:'single',count:2}],payments:[{method:'\u73b0\u91d1',amount:400}]});
  return {session:order.businessSession,nightHalfCents:5900,excessRoundingCents:1100,approved:true,retailRevision:retail.json().result.revision};
 });
 await step('creditAndCash',async()=>{
  const manager=await app.login(f.source.people[1]);
  for(const [room,large]of [['V03',false],['V05',true]]){
   const o=await open(room);if(large)await accept(operator,'sale',{order:o.id,creditedEmployeeId,items:[{product:'bw',spec:'dozen',count:12}]});
   await accept(owner,'credit',{order:o.id,name:'REHEARSAL customer',phone:'13800000000',note:'synthetic rehearsal',signature:'data:image/png;base64,'+'s'.repeat(100)});
   if(large){const denied=await app.command(manager,'approve',{order:o.id});assert.equal(denied.json().error.code,'authorization_denied');await accept(owner,'approve',{order:o.id});}
   else await accept(manager,'approve',{order:o.id});
   await accept(operator,'clean',{room});
  }
  const before=(await head()).state;await accept(owner,'handover',{actualCash:0});const first=(await head()).state.handovers.at(-1);
  await accept(operator,'retailSale',{creditedEmployeeId,items:[{product:'water',spec:'single',count:1}],payments:[{method:'\u73b0\u91d1',amount:200}]});
  await accept(owner,'handover',{actualCash:200});const second=(await head()).state.handovers.at(-1);
  assert.equal(second.expected,200);
  return {creditWithin1000:'manager approved',creditAbove1000:'manager denied, boss approved',handoverExpected:second.expected,previousActual:0,intervalCashIn:200,intervalCashOut:0,nonCashExcluded:true};
 });
 await step('timeBoundaries',async()=>{
  const expected=[['2026-10-10T09:59:59Z','DAY'],['2026-10-10T10:00:00Z','NIGHT'],['2026-10-10T17:59:59Z','NIGHT'],['2026-10-10T18:00:00Z',null]];
  for(const [instant,type]of expected)assert.equal(businessSessionFor(instant,{timeZone:'Asia/Shanghai'})?.sessionType??null,type);
  assert.equal(businessDateFor('2026-10-10T03:59:59Z',{timeZone:'Asia/Shanghai'}),'2026-10-09');assert.equal(businessDateFor('2026-10-10T04:00:00Z',{timeZone:'Asia/Shanghai'}),'2026-10-10');
  return {sessionBoundaries:'PASS',noonCutover:'PASS',clockAuthority:'private server-only control file'};
 });
 await step('deviceOfflineAndUnknown',async()=>{
  await app.controls({online:false});const o=await open('333',operator,false);
  await eventually(workflows,ws=>ws.find(w=>w.orderId===o.id)?.status==='DEVICE_OFFLINE_WAIT','offline');
  await app.controls({online:true});await eventually(workflows,ws=>ws.find(w=>w.orderId===o.id)?.status==='ACTIVE','online recovery');
  await finish((await head()).state.orders.find(x=>x.id===o.id));await accept(operator,'clean',{room:'333'});
  await app.controls({openUnknown:true,queryUnknown:true});const unknown=await open('666',operator,false);
  await eventually(workflows,ws=>ws.find(w=>w.orderId===unknown.id)?.status==='DEVICE_UNKNOWN','unknown ambiguity held for crash');
  const w=(await workflows()).find(w=>w.orderId===unknown.id),events=w.events??[];assert.ok(events.some(e=>e.status==='DEVICE_UNKNOWN'||e.reason?.includes('unknown')));
  await eventually(async()=>{const r=await app.call(owner,'/api/v1/admin/snapshot');return r.json().view.operations;},p=>p.incidents.some(i=>i.code==='DEVICE_UNKNOWN'),'UNKNOWN incident projected');const logs=await calls(),opens=logs.filter(c=>c.workflowId===w.id&&c.method==='openRoom');assert.equal(opens.length,1);await sleep(1400);
  return {offlineSameOrder:o.id,unknownSameOrder:unknown.id,unknownOpenAttempts:1,mutationRetries:0,queryRecovery:'held UNKNOWN until crash, then query only'};
 });
 await step('runtimeCrashAndHostLoss',async()=>{
  const before=await head(),ws=await workflows();const monitor=new FakeExternalHeartbeatMonitor(app.request);assert.equal((await monitor.probe()).ready,true);
  await app.crash();assert.equal((await monitor.probe()).live,false);
  app.start();await app.wait();assert.equal((await head()).revision,before.revision);assert.equal((await app.call(operator,'/api/v1/auth/session')).status,200);
  await app.controls({queryUnknown:false});await eventually(workflows,rows=>rows.every(w=>w.status==='ACTIVE'),'post-crash query recovery');const after=await workflows();assert.equal(after.length,ws.length);const target=ws.find(w=>w.status==='DEVICE_UNKNOWN');assert.ok(target);assert.equal((await calls()).filter(c=>c.workflowId===target.id&&c.method==='openRoom').length,1);assert.ok((await calls()).some(c=>c.workflowId===target.id&&c.method==='queryRoomState'));
  return {activeOrderPreserved:true,unknownWorkflowSurvived:true,queryOnlyAfterCrash:true,revision:before.revision,sessionsPreserved:true,newProcess:true,externalLossDetected:true,realHeartbeatConfigured:false};
 });
 await step('databaseOutage',async()=>{
  const before=await head();await f.serverGuard();await f.setup.query('ALTER USER ?@? ACCOUNT LOCK',[app.user,'127.0.0.1']);
  const [connections]=await f.setup.query('SELECT ID FROM information_schema.PROCESSLIST WHERE USER=?',[app.user]);
  for(const c of connections)await f.setup.query('KILL '+Number(c.ID));
  const r=await app.call(operator,'/api/v1/commands/clean',{method:'POST',body:{operationKey:'db-outage-'+f.names.id,expectedRevision:before.revision,payload:{room:'999'}}});assert.notEqual(r.status,200);
  await eventually(()=>app.request('/health/ready'),r=>r.status===503,'database readiness');
  await sleep(1200);
  await f.setup.query('ALTER USER ?@? ACCOUNT UNLOCK',[app.user,'127.0.0.1']);await app.wait();assert.equal((await head()).revision,before.revision);
  const admin=await app.call(owner,'/api/v1/admin/snapshot');assert.equal(admin.status,200);const incident=admin.json().view.operations.incidents.find(i=>i.code==='DATABASE_UNAVAILABLE');assert.ok(incident);await eventually(async()=>{const r=await app.call(owner,'/api/v1/admin/snapshot');return r.json().view.operations.incidents.find(i=>i.incidentId===incident.incidentId);},i=>i?.state==='RESOLVED','same DB incident resolves');
  const delivered=(await readFile(join(app.logs,'fake-alerts.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(delivered.some(a=>a.incidentId===incident.incidentId&&a.code==='DATABASE_UNAVAILABLE'));return {writesStopped:true,committedRevisionPreserved:true,incidentId:incident.incidentId,sameIncidentResolved:true,fakeAlertDelivered:true};
 });
 await step('backupAndAlertFailure',async()=>{
  await reportBackup(app.logs,{success:true,createdAt:f.firstBackup.createdAt});await sleep(1200);
  const blockedPath=join(f.dirs.backups,'not-a-directory');await writeFile(blockedPath,'REHEARSAL');await assert.rejects(makeBackup(f,join(blockedPath,'child')));
  await reportBackup(app.logs,{success:false});await sleep(1200);
  let before=await head();await app.controls({alert:'fail',alertDrill:true});
  await accept(operator,'retailSale',{creditedEmployeeId,items:[{product:'water',spec:'single',count:1}],payments:[{method:'\u5fae\u4fe1',amount:200}]});
  assert.equal((await head()).revision,before.revision+1);
  await app.controls({alert:'ok'});await eventually(()=>app.request('/health/ready'),r=>r.status===200,'alert failure delivery retry',45000);
  await sleep(1200);before=await head();await app.controls({alert:'timeout',alertDrill:true});
  await accept(operator,'retailSale',{creditedEmployeeId,items:[{product:'water',spec:'single',count:1}],payments:[{method:'\u5fae\u4fe1',amount:200}]});assert.equal((await head()).revision,before.revision+1);
  await app.controls({alert:'ok'});await app.crash();app.start();await eventually(()=>app.request('/health/ready'),r=>r.status===200,'alert timeout restart and retry',45000);
  const attempts=(await readFile(join(app.logs,'fake-alert-attempts.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(attempts.some(a=>a.outcome==='fail'));assert.ok(attempts.some(a=>a.outcome==='timeout'));
  const admin=(await app.call(owner,'/api/v1/admin/snapshot')).json().view.operations;assert.ok(admin.backup.lastSuccessAt);assert.equal(admin.backup.lastResult,'FAILURE');
  return {backupFailure:'actual invalid destination rejected',lastSuccessfulBackupPreserved:true,alertThrowAndTimeout:'actual post-commit transport faults, HTTP success and committed revisions retained',failedAttempts:attempts.length,realAlertChannel:false};
 });
 await step('formalRecovery',async()=>{
  const before=await head(),oldApp=app,oldActive=f.active;
  const decision=rollbackDecision({businessWrites:before.revision-f.firstBackup.ledgerHeads[0].revision,backupRevision:f.firstBackup.ledgerHeads[0].revision,currentRevision:before.revision,compatible:true,backupVerified:true});assert.equal(decision.code,'PRESERVE_NEW_TRANSACTIONS');
  await freezeDatabase({databaseUrl:f.dbUrl(oldActive.database),serverUuid:f.identity.server_uuid,storeId:f.names.storeId,ledgerId:f.names.ledgerId,environment:'test',confirmation:f.identity.server_uuid+'/'+oldActive.database+'/'+f.names.storeId+'/'+f.names.ledgerId,initiatedBy:'REHEARSAL-RECOVERY',env:{}});
  await oldApp.stop();const latest=await backupRestoredRehearsal(f,oldActive.database,join(f.dirs.backups,'preserve-all-post-GO'));
  await f.setup.query('ALTER USER ?@? ACCOUNT LOCK',[oldApp.user,'127.0.0.1']);
  const recovered=await restore(f,latest,'recovered');f.active=recovered;
  app=await launcher(f,{database:recovered.database,label:'recovered'});f.app=app;app.start();await app.wait();
  assert.equal((await app.call(operator,'/api/v1/auth/session')).status,401);
  operator=await app.login(f.source.people[2]);owner=await app.login();
  pool=mysql.createPool({uri:f.dbUrl(recovered.database),connectionLimit:4});f.pools.add(pool);
  const restored=await head();assert.equal(restored.revision,before.revision);assert.deepEqual(restored.state,before.state);
  const replay=await accept(operator,f.replay.action,f.replay.body.payload,f.replay.body);assert.equal(replay.json().result.status,'committed');assert.equal((await head()).revision,before.revision);
  await accept(operator,'retailSale',{creditedEmployeeId,items:[{product:'water',spec:'single',count:1}],payments:[{method:'\u73b0\u91d1',amount:200}]});assert.equal((await head()).revision,before.revision+1);
  return {verifiedBackup:latest.checksum,backupId:latest.backupId,exporter:'rehearsal-only read-only exporter using official Stage5B format; initial backup uses formal backupDatabase',restoreEngine:'formal restoreDatabase/verifyRecovery/resumeRecovery',backupRevision:before.revision,separateTarget:true,freeze:true,sourceRuntimeStoppedAndAccountLocked:true,verified:true,sessionsInvalidated:recovered.verified.sessionsInvalidated,oldSessionRejected:true,explicitResume:true,newLogin:true,historicalOperationReplay:true,newCommand:true,postGoOldBackupRestore:'DENIED',allNewTransactionsRetained:true,rollbackApplication:'accepted c1502c0 runtime artifact, same business runtime as Stage5E tooling-only change'};
 });
 await step('goNoGo',async()=>{
  const checks=Object.fromEntries(CATEGORIES.map(k=>[k,{status:'PASS',synthetic:true,evidence:'observed synthetic '+k}]));
  // These attestations cover only automatic rehearsal checks; browser and human acceptance remain separate.
  checks.SERVICE={status:'PASS',synthetic:true,evidence:'production/start.js stop, crash and fresh start; actual SCM remains production BLOCKED'};
  checks.BACKUP={status:'PASS',synthetic:true,evidence:'latest frozen snapshot, separate restore, invalidation and post-restore business'};
  checks.CODE={status:'BLOCKED',synthetic:true,evidence:'full candidate regression and human acceptance pending'};checks.OPERATIONS={status:'BLOCKED',synthetic:true,evidence:'final runbook review pending'};checks.TLS={status:'BLOCKED',synthetic:true,evidence:'real Edge supplemental evidence pending'};
  const missing={...checks,EXTERNAL_MONITORING:{status:'BLOCKED',evidence:'missing external checker'}};assert.equal(cutoverDecision({scope:'rehearsal',checks:missing,humanGo:true}).decision,'NO-GO');
  const decision=cutoverDecision({scope:'rehearsal',checks,humanGo:false});assert.equal(decision.decision,'NO-GO');assert.equal(cutoverDecision({scope:'production',checks,humanGo:true}).decision,'NO-GO');
  return {checks,decision:decision.decision,readiness:decision.ready,syntheticHumanGoSimulation:cutoverDecision({scope:'rehearsal',checks,humanGo:true}).decision,humanGoRequired:true,productionGo:false};
 });
 const final=await head();evidence.reconciliation={revision:final.revision,orders:final.state.orders.length,payments:final.state.orders.reduce((n,o)=>n+o.payments.length,0),workflows:(await workflows()).length,operationRecords:Number((await pool.query('SELECT COUNT(*) n FROM ledger_operations'))[0][0].n)};
 evidence.finishedAt=new Date().toISOString();f.evidence=evidence;return evidence;
}
