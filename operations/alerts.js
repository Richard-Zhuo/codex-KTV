import {randomUUID} from 'node:crypto';
import {boundedProbe} from './monitors.js';
import {EVENTS,safeContext} from './contract.js';
export class FakeAlertTransport {
 constructor({failures=0,hang=false}={}){this.messages=[];this.failures=failures;this.hang=hang;this.configured=true;}
 async send(payload){if(this.hang)return new Promise(()=>{});if(this.failures-->0)throw Error('SYNTHETIC_ALERT_FAILURE');this.messages.push(structuredClone(payload));return {accepted:true};}
}
export function localAlertTransport(logger){return {configured:false,async send(payload){logger.log({event:'local_alert',code:payload.code,severity:payload.severity,incidentId:payload.incidentId,incidentState:payload.state});return {accepted:true};}};}
export function alertPayload(incident,delivery,secrets=[]){
 const definition=EVENTS[incident.type];if(!definition)throw Error('ALERT_PAYLOAD_INVALID');
 const code=delivery.transition==='RESOLVED'?({DATABASE_UNAVAILABLE:'DATABASE_RESTORED',READINESS_LOST:'READINESS_RESTORED',RECOVERY_IN_PROGRESS:'RECOVERY_RESUMED',RECOVERY_READY_FOR_RESUME:'RECOVERY_RESUMED',PROVIDER_AUTH_FAILURE:'PROVIDER_RESTORED'})[incident.type]??incident.type:incident.type;
 return {deliveryId:delivery.deliveryId,incidentId:incident.incidentId,transition:delivery.transition,state:delivery.transition==='RESOLVED'?'RESOLVED':'OPEN',code,severity:delivery.transition==='RESOLVED'?'INFO':incident.severity,openedAt:incident.openedAt,resolvedAt:incident.resolvedAt,...safeContext(incident.context,secrets),message:EVENTS[code].message,action:EVENTS[code].action,runbook:definition.runbook};
}
// Local dispatch occurs outside business transactions. An in-flight timeout is never
// resent during the same process; a restarted dispatcher uses the stable deliveryId.
export function createAlertDispatcher({store,transport,logger,now=Date.now,secrets=[],timeoutMs=2000,maxAttempts=3,backoffMs=30000,batchSize=10}){
 const uncertain=new Set();let running=null;
 async function dispatch(){
  const due=store.read().outbox.filter(e=>e.state==='PENDING'&&e.nextAttemptAt<=now()&&!uncertain.has(e.deliveryId)).slice(0,batchSize);
  for(const entry of due){
   const incident=store.read().incidents.find(i=>i.incidentId===entry.incidentId);if(!incident)continue;
   if(!transport)break; // Unconfigured does not pretend delivery succeeded.
   let ok=false,timeout=false;
   try{const result=await boundedProbe(()=>transport.send(alertPayload(incident,entry,secrets)),timeoutMs);ok=result?.accepted===true;}catch(e){timeout=e.message==='MONITOR_PROBE_TIMEOUT';}
   await store.update(s=>{const item=s.outbox.find(e=>e.deliveryId===entry.deliveryId);if(!item||item.state!=='PENDING')return;item.attempts++;item.nextAttemptAt=now()+backoffMs*2**(item.attempts-1);item.state=ok?'DELIVERED':item.attempts>=maxAttempts?'EXHAUSTED':'PENDING';});
   if(timeout)uncertain.add(entry.deliveryId);
   if(!ok)logger.log({event:'alert_delivery',code:'ALERT_DELIVERY_FAILED',severity:'ERROR',incidentId:incident.incidentId});
  }
 }
 return {tick(){return running??(running=dispatch().finally(()=>{running=null;}));},async remind(intervalMs=3600000){
  await store.update(s=>{for(const i of s.incidents.filter(i=>i.state==='OPEN')){
   if(i.reminders>=3||s.outbox.some(e=>e.incidentId===i.incidentId&&e.state==='PENDING')||now()-(i.lastReminderAt??Date.parse(i.openedAt))<intervalMs)continue;
   if(s.outbox.filter(e=>e.state==='PENDING').length>=1024)break;
   i.reminders=(i.reminders??0)+1;i.lastReminderAt=now();s.outbox.push({deliveryId:randomUUID(),incidentId:i.incidentId,transition:'REMINDER',state:'PENDING',attempts:0,nextAttemptAt:now()});
  }});
 }};
}
