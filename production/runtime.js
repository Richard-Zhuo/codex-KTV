import https from 'node:https';
import {boundedProbe,readinessFailure} from '../operations/monitors.js';
import { randomUUID } from 'node:crypto';
import { createKtvRequestHandler } from '../server.js';
import { createHttpApiFromEnv } from '../http/bootstrap.js';
import { createSafeLogger } from './runtime-log.js';
import {secureRequest,SECURITY_HEADERS,configureHttpServer,createTransportLoginLimiter} from './http-security.js';
import {assertNormalStartupAllowed,readCurrentRecoveryControl} from '../recovery/production-cutover-journal.js';
export const SHUTDOWN_MS=15000;
export function createProductionRuntime(loaded,{logger=createSafeLogger({secrets:loaded.redactionSecrets}),services,operations,activation,backupExecution,backupScheduler}={}){
 services??=createHttpApiFromEnv(loaded.apiEnv,logger,{managed:true,mysqlSsl:loaded.mysqlSsl,loginGate:createTransportLoginLimiter(),operationalSnapshot:()=>operations?.snapshot(),onLoginOutcome:value=>operations?.login(value)});
 let phase='STARTING',lastReady=null,checking=null,stopping=null,activating=null,retryTimer=null;
 let startupBlocker='PRODUCTION_STARTUP_GATE_PENDING',operationsStarted=false,workerStarted=false;
 let activationPublished=false;
 const invalidateActivation=async()=>{activationPublished=false;await activation?.invalidate();};
 let workerStopped=false,operationalStopped=false,connectionsClosed=false;
 const active=new Set(),sockets=new Set();
 const version={appVersion:loaded.config.applicationCommit,schemaVersion:'001-011',configFingerprint:loaded.configFingerprint};
 const unavailable=(res,requestId,code='service_unavailable',status=503)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Request-Id':requestId});res.end(JSON.stringify({error:{code,requestId}}));};
 const pendingReadiness=()=>{
  if(lastReady!==false){logger.info({event:'readiness_changed',code:'NOT_READY',blockers:[startupBlocker],...version});lastReady=false;}
  return Promise.resolve({ready:false,blockers:[startupBlocker],...version});
 };
 const readiness=()=>phase==='LIVENESS_ONLY'?pendingReadiness():checking??(checking=(async()=>{
  let report;try{report=await boundedProbe(()=>services.readiness(),loaded.config.monitoring?.probeTimeoutMs??2500);}catch(error){report=readinessFailure(error);}
  const blockers=[...(report.blockers??[]).map(b=>b.code)];
  if(!loaded.config.backupPolicyConfigured)blockers.push('PRODUCTION_BACKUP_POLICY_REQUIRED');
  if(phase==='DRAINING'||phase==='STOPPED')blockers.push('RUNTIME_DRAINING');
  blockers.push(...(operations?.readyBlockers()??[]));
  const ready=report.ready&&blockers.length===0;
  if(!ready&&activationPublished)await invalidateActivation().catch(()=>{});
  if(ready!==lastReady){logger.info({event:'readiness_changed',code:ready?'READY':'NOT_READY',blockers,...version});lastReady=ready;}
  await operations?.observeReadiness({ready,blockers});
  if(ready&&phase==='RUNNING'&&activation&&!activationPublished){
   try{await assertNormalStartupAllowed(loaded);await activation.publish();activationPublished=true;}
   catch{activationPublished=false;return {ready:false,blockers:['RUNTIME_ACTIVATION_NOT_PROVEN'],...version};}
  }
  return {ready,blockers,...version};
 })().finally(()=>{checking=null;}));
 const retryDelay=loaded.config.monitoring?.intervalMs??1000;
 function scheduleRetry(){
  if(phase!=='LIVENESS_ONLY'||retryTimer||stopping)return;
  retryTimer=setTimeout(()=>{retryTimer=null;void activate(false).then(scheduleRetry,()=>{
   startupBlocker='RUNTIME_ACTIVATION_FAILED';
   logger.error({event:'runtime_activation_failed',code:'RUNTIME_ACTIVATION_FAILED'});
   if(phase==='DRAINING')void services.close().catch(()=>{}).finally(()=>{connectionsClosed=true;phase='STOPPED';server.close();});
  });},retryDelay);
  retryTimer.unref();
 }
 function activate(initial){
  if(activating)return activating;
  activating=(async()=>{
   try{
    if(loaded.config.recovery&&loaded.apiEnv?.KTV_MYSQL_URL)await readCurrentRecoveryControl(loaded);
    await assertNormalStartupAllowed(loaded);
   }
   catch(error){
    startupBlocker=error?.code==='PRODUCTION_STARTUP_DATABASE_UNAVAILABLE'?
     'DATABASE_OR_SCHEMA_UNAVAILABLE':(error?.code??'PRODUCTION_C3_STARTUP_BLOCKED');
    if(initial&&error?.code!=='PRODUCTION_STARTUP_DATABASE_UNAVAILABLE')throw error;
    return false;
   }
   if(phase!=='LIVENESS_ONLY')return false;
   let report;try{report=await boundedProbe(()=>services.readiness(),loaded.config.monitoring?.probeTimeoutMs??2500);}
   catch(error){report=readinessFailure(error);}
   if(!report.ready){
    startupBlocker=report.blockers?.[0]?.code??'PRODUCTION_NOT_READY';return false;
   }
   if(phase!=='LIVENESS_ONLY')return false;
   try{
    await operations?.start(services);operationsStarted=Boolean(operations);
    if(phase!=='LIVENESS_ONLY')return false;
    await services.startWorker?.();workerStarted=true;
   }catch(error){
    await backupScheduler?.stop().catch(()=>{});
    await services.stopWorker?.().catch(()=>{});
    await operations?.stop({clean:false}).catch(()=>{});
    operationsStarted=false;workerStarted=false;throw error;
   }
   if(phase!=='LIVENESS_ONLY')return false;
   phase='RUNNING';startupBlocker=null;
   try{await activation?.publish();activationPublished=Boolean(activation);}catch(error){
    phase='DRAINING';activationPublished=false;await activation?.invalidate().catch(()=>{});
    await backupScheduler?.stop().catch(()=>{});
    await services.stopWorker?.();workerStarted=false;await operations?.stop({clean:false});operationsStarted=false;throw error;
   }
   logger.info({event:'runtime_started',...version});return true;
  })().finally(()=>{activating=null;});
  return activating;
 }
 const handler=createKtvRequestHandler({api:{async handle(req,res){
  if(!new URL(req.url,loaded.config.publicOrigin).pathname.startsWith('/api/'))return false;
  const report=await readiness();if(!report.ready||phase!=='RUNNING'){unavailable(res,req.ktvRequestId);return true;}return services.handle(req,res);
 }}});
 const server=https.createServer(loaded.tls,(req,res)=>{
  const requestId=randomUUID(),start=performance.now();req.ktvRequestId=requestId;req.ktvProduction=true;
  for(const [key,value]of Object.entries(SECURITY_HEADERS))res.setHeader(key,value);res.setHeader('X-Request-Id',requestId);
  const done=new Promise(resolve=>res.once('close',resolve));active.add(done);done.finally(()=>active.delete(done));
  res.once('finish',()=>logger.info({event:'http_completed',requestId,status:res.statusCode,elapsedMs:Math.round(performance.now()-start)}));
  void (async()=>{
   const denied=secureRequest(req,loaded.config.publicOrigin);if(denied){res.setHeader('Connection','close');unavailable(res,requestId,denied,denied==='payload_too_large'?413:403);req.resume();return;}
   if(phase==='DRAINING'||phase==='STOPPED'){unavailable(res,requestId);return;}
   const path=new URL(req.url,loaded.config.publicOrigin).pathname;
   if(path==='/health/live'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({status:'alive',requestId,...version}));return;}
   if(path==='/health/ready'){const r=await readiness();const challenge=new URL(req.url,loaded.config.publicOrigin).searchParams.get('activationChallenge');
    let observation;if(challenge!==null){if(!/^[a-f0-9]{64}$/.test(challenge)){unavailable(res,requestId,'invalid_input',400);return;}observation=activation?.observation(challenge,{phase,ready:r.ready,workersActive:workerStarted&&activationPublished})??{challenge,state:'NOT_PROVEN'};}
    res.writeHead(r.ready?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({status:r.ready?'ready':'not_ready',requestId,...r,...(observation?{activation:observation}:{})}));return;}
   if(phase==='LIVENESS_ONLY'){unavailable(res,requestId);return;}
   await handler(req,res);
  })().catch(()=>{logger.error({event:'http_error',requestId,code:'INTERNAL_ERROR'});if(!res.headersSent)unavailable(res,requestId,'internal_error',500);else res.destroy();});
 });
 configureHttpServer(server);
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 return Object.freeze({server,readiness,...(backupExecution?{backupExecution}:{}),
  status:()=>({phase,workerStopped,operationalStopped,connectionsClosed,
   normalWriterCount:phase==='RUNNING'?null:0}),
  async start(){
   await activation?.initialize();
   phase='LIVENESS_ONLY';
   await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(loaded.config.port,loaded.config.listenHost,()=>{server.removeListener('error',reject);resolve();});});
   try{await activate(true);await backupScheduler?.start();}catch(error){
    await backupScheduler?.stop().catch(()=>{});
    await backupExecution?.stop().catch(()=>{});
    if(activationPublished)await invalidateActivation().catch(()=>{});
    if(workerStarted){await services.stopWorker?.().catch(()=>{});workerStarted=false;workerStopped=true;}
    if(operationsStarted||operations?.ownsWriter?.())await operations.stop({clean:false}).catch(()=>{});
    await new Promise(resolve=>server.close(resolve));await services.close().catch(()=>{});connectionsClosed=true;phase='STOPPED';throw error;
   }
   scheduleRetry();
  },
  shutdown(reason='STOP'){return stopping??(stopping=(async()=>{
   phase='DRAINING';activationPublished=false;clearTimeout(retryTimer);
   const scheduleStopped=backupScheduler?.stop();
   const backupStopped=backupExecution?.stop();
   await activation?.invalidate().catch(()=>{});
   logger.info({event:'runtime_draining',code:reason,...version});
   const closeHttp=new Promise(resolve=>server.close(resolve));server.closeIdleConnections();
   const drain=(async()=>{await scheduleStopped;await backupStopped;await activating?.catch(()=>{});
    if(workerStarted)await services.stopWorker();workerStopped=true;
    await Promise.all([...active]);await closeHttp;
    if(operationsStarted||operations?.ownsWriter?.())await operations.stop({clean:!['FATAL','LOG_IO_FAILED'].includes(reason)});
    operationalStopped=true;await services.close();connectionsClosed=true;phase='STOPPED';
    logger.info({event:'runtime_stopped',...version});return true;})();
   let timer;try{await Promise.race([drain,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),SHUTDOWN_MS);})]);}
   catch{for(const socket of sockets)socket.destroy();logger.error({event:'shutdown_timeout',code:'SHUTDOWN_TIMEOUT'});throw Error('SHUTDOWN_TIMEOUT');}finally{clearTimeout(timer);}
  })());}
 });
}
