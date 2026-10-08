import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { createKtvRequestHandler } from '../server.js';
import { createHttpApiFromEnv } from '../http/bootstrap.js';
import { createSafeLogger } from './runtime-log.js';
import {secureRequest,SECURITY_HEADERS,configureHttpServer,createTransportLoginLimiter} from './http-security.js';
export const SHUTDOWN_MS=15000;
export function createProductionRuntime(loaded,{logger=createSafeLogger({secrets:loaded.redactionSecrets}),services}={}){
 services??=createHttpApiFromEnv(loaded.apiEnv,logger,{managed:true,mysqlSsl:loaded.mysqlSsl,loginGate:createTransportLoginLimiter()});
 let phase='STARTING',lastReady=null,checking=null,stopping=null;
 const active=new Set(),sockets=new Set();
 const version={appVersion:loaded.config.applicationCommit,schemaVersion:'001-011',configFingerprint:loaded.configFingerprint};
 const unavailable=(res,requestId,code='service_unavailable',status=503)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Request-Id':requestId});res.end(JSON.stringify({error:{code,requestId}}));};
 const readiness=()=>checking??(checking=(async()=>{
  let report;try{report=await services.readiness();}catch{report={ready:false,blockers:[{code:'DATABASE_OR_SCHEMA_UNAVAILABLE'}]};}
  const blockers=[...(report.blockers??[]).map(b=>b.code)];
  if(!loaded.config.backupPolicyConfigured)blockers.push('PRODUCTION_BACKUP_POLICY_REQUIRED');
  if(phase==='DRAINING'||phase==='STOPPED')blockers.push('RUNTIME_DRAINING');
  const ready=report.ready&&blockers.length===0;
  if(ready!==lastReady){logger.info({event:'readiness_changed',code:ready?'READY':'NOT_READY',blockers,...version});lastReady=ready;}
  return {ready,blockers,...version};
 })().finally(()=>{checking=null;}));
 const handler=createKtvRequestHandler({api:{async handle(req,res){
  if(!new URL(req.url,loaded.config.publicOrigin).pathname.startsWith('/api/'))return false;
  const report=await readiness();if(!report.ready){unavailable(res,req.ktvRequestId);return true;}return services.handle(req,res);
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
   if(path==='/health/ready'){const r=await readiness();res.writeHead(r.ready?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({status:r.ready?'ready':'not_ready',requestId,...r}));return;}
   await handler(req,res);
  })().catch(()=>{logger.error({event:'http_error',requestId,code:'INTERNAL_ERROR'});if(!res.headersSent)unavailable(res,requestId,'internal_error',500);else res.destroy();});
 });
 configureHttpServer(server);
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 return Object.freeze({server,readiness,
  async start(){await readiness();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(loaded.config.port,loaded.config.listenHost,()=>{server.removeListener('error',reject);resolve();});});phase='RUNNING';logger.info({event:'runtime_started',...version});},
  shutdown(reason='STOP'){return stopping??(stopping=(async()=>{
   phase='DRAINING';logger.info({event:'runtime_draining',code:reason,...version});
   const closeHttp=new Promise(resolve=>server.close(resolve));server.closeIdleConnections();
   const drain=(async()=>{await services.stopWorker();await Promise.all([...active]);await closeHttp;await services.close();phase='STOPPED';logger.info({event:'runtime_stopped',...version});return true;})();
   let timer;try{await Promise.race([drain,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),SHUTDOWN_MS);})]);}
   catch{for(const socket of sockets)socket.destroy();logger.error({event:'shutdown_timeout',code:'SHUTDOWN_TIMEOUT'});throw Error('SHUTDOWN_TIMEOUT');}finally{clearTimeout(timer);}
  })());}
 });
}
