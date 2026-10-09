import {acquireOperationalWriter} from './writer-lock.js';
import {createOperationalStore} from './store.js';
import {createIncidentLifecycle} from './incidents.js';
import {createAlertDispatcher,localAlertTransport} from './alerts.js';
import {MONITOR_DEFAULTS,monitoringConfig,boundedProbe,tlsSummary,directorySummary,observeWorkflow,readinessFailure} from './monitors.js';
import {consumeInvariants} from './signals.js';
import {consumeBackupReports} from './backup-report.js';
import {EVENTS,hash,safeContext} from './contract.js';
export async function createOperationalRuntime({loaded,logger,transport,now=Date.now}){
 const c=monitoringConfig(loaded.config.monitoring??{}),scope=hash(loaded.config.storeId+':'+loaded.config.ledgerId);
 const store=await createOperationalStore(loaded.logDirectory,scope),lifecycle=createIncidentLifecycle({store,logger,scope,now,secrets:loaded.redactionSecrets,maxHistory:c.maxHistory,retentionMs:c.retentionDays*86400000});
 transport??=c.alertTransport==='local'?localAlertTransport(logger):null;
 const dispatcher=createAlertDispatcher({store,transport,logger,now,secrets:loaded.redactionSecrets,timeoutMs:c.probeTimeoutMs});
 let timer=null,running=null,started=false,failed=false,services,stopping=false,releaseWriter,activeLogins=0,failureEpoch=0;
 const safely=async work=>{try{return await work();}catch(error){failed=true;failureEpoch++;if(error?.code==='LEDGER_SNAPSHOT_INVALID')await lifecycle.condition('DATA_INVARIANT_FAILURE',true,{component:'device'}).catch(()=>{});logger.log({event:'monitoring_failure',code:'MONITORING_FAILURE',severity:'ERROR'});return null;}};
 const readyBlockers=()=>[...(!loaded.config.monitoring?['MONITORING_CONFIG_REQUIRED']:[]),...(!c.backupDirectory?['BACKUP_DIRECTORY_REQUIRED']:[]),...(!loaded.config.backupPolicyConfigured?['PRODUCTION_BACKUP_POLICY_REQUIRED']:[]),...(c.alertingRequired&&!transport?.configured?['ALERT_CHANNEL_REQUIRED']:[]),...(failed?['MONITORING_UNAVAILABLE']:[]),...(c.alertingRequired&&transport?.configured&&store.read().outbox.some(e=>e.state==='EXHAUSTED'||e.state==='PENDING'&&e.attempts>0)?['ALERT_DELIVERY_UNAVAILABLE']:[])];
 async function observeReadiness(report){
  if(!started||stopping)return;
  const codes=[...new Set([...(report.blockers??[]).map(b=>typeof b==='string'?b:b.code),...readyBlockers()])],databaseDown=codes.includes('DATABASE_OR_SCHEMA_UNAVAILABLE');
  report={...report,ready:report.ready===true&&codes.length===0};
  const previous=store.read().observations;
  const invariant=codes.includes('DATA_INVARIANT_FAILURE')||codes.includes('INVENTORY_INVALID');
  await lifecycle.condition('DATA_INVARIANT_FAILURE',invariant,{component:'ledger'});
  if(previous.readiness?.ready===report.ready&&previous.database?.available===!databaseDown)return;
  await lifecycle.condition('DATABASE_UNAVAILABLE',databaseDown,{component:'database'});
  // Suppress new cascades, but only actual readiness can resolve an existing incident.
  if(report.ready||!databaseDown)await lifecycle.condition('READINESS_LOST',!report.ready,{component:'runtime'});
  await lifecycle.condition('BACKUP_POLICY_MISSING',!loaded.config.backupPolicyConfigured,{component:'backup'});
  await store.update(s=>{s.observations.readiness={ready:report.ready,at:new Date(now()).toISOString()};s.observations.database={available:!databaseDown,at:new Date(now()).toISOString()};});
 }
 async function backup(report){
  const at=Date.parse(report.at);
  await store.update(s=>{const previous=s.observations.backup??{};if(at<(previous.lastReportAt??0))return;s.observations.backup={...previous,lastReportAt:at,...(!report.success?{lastFailureAt:at}:{}),lastResult:report.success?'SUCCESS':'FAILURE',...(report.success&&Date.parse(report.createdAt)<=now()?{lastSuccessAt:Math.max(previous.lastSuccessAt??0,Date.parse(report.createdAt))}:{})};});
  const latest=store.read().observations.backup;
  await lifecycle.condition('BACKUP_FAILURE',latest.lastResult==='FAILURE',{component:'backup'});
  if(report.success)await lifecycle.event('BACKUP_SUCCESS',{component:'backup'});
 }
 async function checkTls(summary){
  const invalid=Date.parse(summary.notBefore)>now()||!summary.hostnameMatches||summary.daysRemaining<0;
  const severity=invalid||summary.daysRemaining<=c.tlsCriticalDays?'CRITICAL':summary.daysRemaining<=c.tlsErrorDays?'ERROR':'WARN';
  await lifecycle.condition('TLS_EXPIRING',invalid||summary.daysRemaining<=c.tlsWarnDays,{component:'tls'},severity);
  await store.update(s=>{s.observations.tls={daysRemaining:summary.daysRemaining,valid:!invalid,notAfter:summary.notAfter};});
 }
 async function login({accountHash,sourceHash,outcome}){
  if(!started||activeLogins>=100)return;
  activeLogins++;
  try{await safely(async()=>{await store.update(s=>{
   const cutoff=now()-c.authWindowMs;
   for(const [key,value]of Object.entries(s.auth)){value.failures=value.failures.filter(t=>t>=cutoff);if(!value.failures.length)delete s.auth[key];}
   for(const [kind,value]of [['account',accountHash],['source',sourceHash]]){
    if(!/^[a-f0-9]{64}$/.test(value??''))continue;const key=kind+':'+value;
    if(outcome==='success'&&kind==='account'){delete s.auth[key];continue;}
    if(outcome==='success')continue;
    if(!s.auth[key]&&Object.keys(s.auth).length>=1000)continue;
    const bucket=s.auth[key]??={kind,hash:value,failures:[]};bucket.failures.push(now());bucket.failures=bucket.failures.slice(-c.authFailures);
    bucket.rateLimited=outcome==='rate_limited';
   }
  });await authConditions();});}finally{activeLogins--;}
 }
 async function authConditions(){
  const auth=store.read().auth;
  for(const [key,value]of Object.entries(auth)){
   value.failures=value.failures.filter(t=>t>=now()-c.authWindowMs);
   const context={component:'authentication',category:key};
   await lifecycle.condition('AUTH_REPEATED_FAILURES',value.failures.length>=c.authFailures,context);
   await lifecycle.condition('AUTH_RATE_LIMITED',value.rateLimited&&value.failures.length>0,context);
  }
  for(const i of store.read().incidents.filter(i=>i.state==='OPEN'&&['AUTH_REPEATED_FAILURES','AUTH_RATE_LIMITED'].includes(i.type))){
   if(!auth[i.context.category]||!auth[i.context.category].failures.some(t=>t>=now()-c.authWindowMs))await lifecycle.condition(i.type,false,i.context);
  }
 }
 async function poll(){
  if(stopping)return;
  const epoch=failureEpoch;let report;
  // A malformed report or unavailable probe must not starve unrelated sources.
  await safely(()=>consumeBackupReports(loaded.logDirectory,backup));
  await safely(()=>consumeInvariants(loaded.logDirectory,r=>lifecycle.condition(r.code,r.active,{component:'recovery',category:'invariant'})));
  await safely(async()=>{
   const backupState=store.read().observations.backup;
   await lifecycle.condition('BACKUP_POLICY_MISSING',!loaded.config.backupPolicyConfigured,{component:'backup'});
   await lifecycle.condition('BACKUP_OVERDUE',loaded.config.backupPolicyConfigured===true&&(!backupState?.lastSuccessAt||now()-backupState.lastSuccessAt>c.backupMaxAgeMs),{component:'backup'});
  });
  await safely(()=>lifecycle.condition('ALERT_CHANNEL_MISSING',!transport?.configured,{component:'alerts'}));
  await safely(()=>checkTls(tlsSummary(loaded.tls.cert,new URL(loaded.config.publicOrigin).hostname,now())));
  for(const [component,directory]of [['logs',loaded.logDirectory],['backup',c.backupDirectory]]){
   if(!directory)continue;
   await safely(async()=>{try{const result=await boundedProbe(()=>directorySummary(directory),c.probeTimeoutMs);await lifecycle.condition('DIRECTORY_UNWRITABLE',false,{component});await lifecycle.condition('DISK_CAPACITY_LOW',result.freeBytes<c.minFreeBytes,{component});}
   catch{await lifecycle.condition('DIRECTORY_UNWRITABLE',true,{component});}});
  }
  if(services){
   try{report=await boundedProbe(()=>services.readiness(),c.probeTimeoutMs);}catch(error){report=readinessFailure(error);}
   await safely(()=>observeReadiness(report));
   if(store.read().observations.database?.available&&services.operationalFacts)await safely(async()=>{
    const facts=await boundedProbe(()=>services.operationalFacts(),c.probeTimeoutMs),mode=facts.recoveryMode;
    await lifecycle.condition('RECOVERY_IN_PROGRESS',mode!=='NORMAL'&&mode!=='READY_FOR_RESUME',{component:'recovery'});
    await lifecycle.condition('RECOVERY_READY_FOR_RESUME',mode==='READY_FOR_RESUME',{component:'recovery'});
    for(const record of facts.workflows??[])await observeWorkflow(lifecycle,record,c,{now});
    const provider=(facts.workflows??[]).filter(r=>r.lastEvidence?.diagnosticCode==='AUTH_REQUIRED'||['STATE','APPLIED','ACKNOWLEDGED'].includes(r.lastEvidence?.kind)).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt))[0];
    if(provider)await lifecycle.condition('PROVIDER_AUTH_FAILURE',provider.lastEvidence.diagnosticCode==='AUTH_REQUIRED',{component:'provider'});
    await store.update(s=>{s.observations.recoveryMode=mode;s.observations.worker=facts.worker;});
   });
  }
  await safely(authConditions);await safely(()=>dispatcher.remind());await safely(()=>lifecycle.prune());
  await safely(()=>lifecycle.condition('PROCESS_CRASH_LOOP',store.read().process.crashes.filter(t=>t>=now()-600000).length>=3,{component:'runtime'}));
  failed=failureEpoch!==epoch;
  await safely(()=>dispatcher.tick());
  if(report)await safely(()=>observeReadiness(report));
  if(!failed&&store.read().observations.readiness?.ready)await safely(async()=>{for(const code of ['PROCESS_FAILURE','UNCAUGHT_EXCEPTION','UNHANDLED_REJECTION','LOG_WRITE_FAILURE'])await lifecycle.condition(code,false,{component:'runtime'});});
 }
 function tick(){return running??(running=poll().finally(()=>{running=null;}));}
 return {store,lifecycle,dispatcher,config:c,readyBlockers,
  async start(source){
   releaseWriter=await acquireOperationalWriter(loaded.logDirectory,scope);
   try{await store.reload();}catch(error){await releaseWriter();releaseWriter=null;throw error;}
   services=source;started=true;
   const previous=store.read().process;
   await store.update(s=>{s.process={running:true,startedAt:now(),crashes:[...previous.crashes.filter(t=>t>=now()-600000),...(previous.running?[now()]:[])]};});
   if(previous.running)await lifecycle.condition('PROCESS_FAILURE',true,{component:'runtime'});
   await lifecycle.event('PROCESS_STARTED',{component:'runtime'});await tick();
   const schedule=()=>{timer=setTimeout(()=>{void tick().finally(()=>{if(!stopping)schedule();});},c.intervalMs);timer.unref();};schedule();
  },tick,observeReadiness:report=>safely(()=>observeReadiness(report)),login,backup,checkTls,
  async fatal(code){if(EVENTS[code])await safely(()=>lifecycle.condition(code,true,{component:'runtime'}));},
  async stop({clean=true}={}){
   stopping=true;clearTimeout(timer);await running;
   await safely(()=>lifecycle.event('PROCESS_STOPPING',{component:'runtime'}));
   if(clean)await safely(()=>store.update(s=>{s.process.running=false;}));await store.flush();await releaseWriter?.();
  },
  snapshot(){
   const s=store.read(),visible=[...s.incidents.filter(i=>i.state==='OPEN'),...s.incidents.filter(i=>i.state==='RESOLVED').slice(-c.maxHistory)],incidents=visible.map(i=>({incidentId:i.incidentId,code:i.type,severity:i.severity,state:i.state,openedAt:i.openedAt,resolvedAt:i.resolvedAt,...safeContext(i.context,loaded.redactionSecrets),message:EVENTS[i.type]?.message,action:EVENTS[i.type]?.action,runbook:i.type}));
   return {runtime:stopping?'STOPPING':started?'RUNNING':'STARTING',ready:s.observations.readiness?.ready===true&&readyBlockers().length===0,database:s.observations.database?.available===true?'AVAILABLE':'UNAVAILABLE',recoveryMode:s.observations.recoveryMode??'UNKNOWN',worker:s.observations.worker??'DISABLED',backup:{lastSuccessAt:s.observations.backup?.lastSuccessAt?new Date(s.observations.backup.lastSuccessAt).toISOString():null,lastResult:s.observations.backup?.lastResult??'NOT_OBSERVED',lastFailureAt:s.observations.backup?.lastFailureAt?new Date(s.observations.backup.lastFailureAt).toISOString():null,ageMs:s.observations.backup?.lastSuccessAt?Math.max(0,now()-s.observations.backup.lastSuccessAt):null,policy:loaded.config.backupPolicyConfigured?'CONFIGURED':'NOT_CONFIGURED',overdue:loaded.config.backupPolicyConfigured?(!s.observations.backup?.lastSuccessAt||now()-s.observations.backup.lastSuccessAt>c.backupMaxAgeMs):null},tls:s.observations.tls??null,criticalIncidents:s.incidents.filter(i=>i.state==='OPEN'&&i.severity==='CRITICAL').length,alerting:transport?.configured?'CONFIGURED':'NOT_CONFIGURED',monitoring:failed?'DEGRADED':'AVAILABLE',alertDelivery:store.read().outbox.some(e=>e.state==='EXHAUSTED'||e.state==='PENDING'&&e.attempts>0)?'DEGRADED':'AVAILABLE',incidents};
  }
 };
}
