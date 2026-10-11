import {randomUUID} from 'node:crypto';
import {boundedProbe} from './monitors.js';
import {EVENTS,safeContext} from './contract.js';
export class FakeAlertTransport {
 constructor({failures=0,hang=false}={}){this.messages=[];this.failures=failures;this.hang=hang;this.configured=true;}
 async send(payload){if(this.hang)return new Promise(()=>{});if(this.failures-->0)throw Error('SYNTHETIC_ALERT_FAILURE');const last=this.messages.findLast(m=>m.incidentId===payload.incidentId);if(!last||payload.sequence>last.sequence)this.messages.push(structuredClone(payload));return {accepted:true};}
}
export function localAlertTransport(logger){return {configured:false,async send(payload){logger.log({event:'local_alert',code:payload.code,severity:payload.severity,incidentId:payload.incidentId,incidentState:payload.state});return {accepted:true};}};}
export function alertPayload(incident,delivery,secrets=[]){
 const definition=EVENTS[incident.type];if(!definition)throw Error('ALERT_PAYLOAD_INVALID');
 const code=delivery.transition==='RESOLVED'?({DATABASE_UNAVAILABLE:'DATABASE_RESTORED',READINESS_LOST:'READINESS_RESTORED',RECOVERY_IN_PROGRESS:'RECOVERY_RESUMED',RECOVERY_READY_FOR_RESUME:'RECOVERY_RESUMED',PROVIDER_AUTH_FAILURE:'PROVIDER_RESTORED'})[incident.type]??incident.type:incident.type;
 return {deliveryId:delivery.deliveryId,incidentId:incident.incidentId,sequence:delivery.sequence??0,occurredAt:delivery.occurredAt??incident.openedAt,transition:delivery.transition,state:delivery.transition==='RESOLVED'?'RESOLVED':'OPEN',code,severity:delivery.transition==='RESOLVED'?'INFO':delivery.severity??incident.severity,openedAt:incident.openedAt,resolvedAt:incident.resolvedAt,...safeContext(incident.context,secrets),message:EVENTS[code].message,action:EVENTS[code].action,runbook:definition.runbook};
}
// Dispatch remains outside business transactions. A timed-out send is not retried
// in this process; restart reuses the same deliveryId and recipient snapshot.
export function createAlertDispatcher({store,transport,logger,now=Date.now,secrets=[],timeoutMs=2000,maxAttempts=3,backoffMs=30000,batchSize=4}){
 const uncertain=new Set(),inFlight=new Set();let running=null;
 async function dispatch(){
  const due=store.read().outbox.filter(e=>e.state==='PENDING'&&e.nextAttemptAt<=now()&&!uncertain.has(e.deliveryId)).slice(0,batchSize);
  for(const entry of due){
   const current=store.read();if(!current.outbox.some(e=>e.deliveryId===entry.deliveryId&&e.state==='PENDING'))continue;
   const incident=current.incidents.find(i=>i.incidentId===entry.incidentId);if(!incident)continue;
   if(!transport)break;
   const recipients=transport.targetsFor ? entry.recipients??transport.targetsFor(incident,entry) : undefined;
   if(transport.targetsFor&&(!Array.isArray(recipients)||!recipients.length)){
    await store.update(s=>{const item=s.outbox.find(e=>e.deliveryId===entry.deliveryId);if(item?.state==='PENDING')item.state='EXHAUSTED';});
    logger.log({event:'alert_delivery',code:'ALERT_DELIVERY_FAILED',severity:'ERROR',incidentId:incident.incidentId});
    continue;
   }
   const payload=alertPayload(incident,entry,secrets);
   let content;try{content=transport.messageFor?entry.content??transport.messageFor(payload):undefined;}catch{
    await store.update(s=>{const item=s.outbox.find(e=>e.deliveryId===entry.deliveryId);if(item?.state==='PENDING')item.state='EXHAUSTED';});
    logger.log({event:'alert_delivery',code:'ALERT_DELIVERY_FAILED',severity:'ERROR',incidentId:incident.incidentId});continue;
   }
   inFlight.add(entry.deliveryId);try{
   const reserved=await store.update(s=>{const item=s.outbox.find(e=>e.deliveryId===entry.deliveryId);if(!item||item.state!=='PENDING')return false;
    if(item.attempts>=maxAttempts){item.state='EXHAUSTED';return false;}
    if(recipients&&!item.recipients)item.recipients=[...recipients];
    if(recipients)item.uncertain=true;
    if(content!==undefined&&!item.content)item.content=content;
    item.attempts++;item.nextAttemptAt=now()+backoffMs*2**(item.attempts-1);if(item.attempts>=maxAttempts)item.state='EXHAUSTED';return true;
   });
   if(!reserved||store.read().outbox.find(e=>e.deliveryId===entry.deliveryId)?.state==='SUPERSEDED')continue;
   let result=null,timeout=false,failure=null;
   try{result=await boundedProbe(()=>transport.send(payload,recipients,content,{incident,entry}),timeoutMs);}
   catch(e){failure=e;timeout=e.message==='MONITOR_PROBE_TIMEOUT'||['WECOM_TIMEOUT','WECOM_NETWORK_UNKNOWN'].includes(e.code);}
   const accepted=result?.accepted===true;
   const acceptedRecipients=recipients&&Array.isArray(result?.acceptedRecipients)
     ?result.acceptedRecipients.filter(id=>recipients.includes(id)):[];
   const partial=recipients&&Array.isArray(result?.invalidRecipients)&&result.invalidRecipients.length>0;
   await store.update(s=>{
    const item=s.outbox.find(e=>e.deliveryId===entry.deliveryId);
    const record=s.incidents.find(i=>i.incidentId===entry.incidentId);
    if(record&&acceptedRecipients.length)
      record.notifiedRecipients=[...new Set([...(record.notifiedRecipients??[]),...acceptedRecipients])];
    if(record&&timeout&&recipients?.length)
      record.possiblyNotifiedRecipients=[...new Set([...(record.possiblyNotifiedRecipients??[]),...recipients])];
    if(!item||!['PENDING','EXHAUSTED'].includes(item.state))return;
    if(recipients)item.uncertain=timeout;
    item.state=accepted?'DELIVERED':partial?'EXHAUSTED':item.attempts>=maxAttempts?'EXHAUSTED':'PENDING';
   });
   if(timeout)uncertain.add(entry.deliveryId);
   if(!accepted)logger.log({event:'alert_delivery',code:failure?.code?.startsWith('WECOM_')?failure.code:'ALERT_DELIVERY_FAILED',severity:'ERROR',incidentId:incident.incidentId,deliveryId:entry.deliveryId,attempt:store.read().outbox.find(e=>e.deliveryId===entry.deliveryId)?.attempts,provider:transport.messageFor?'wecom':undefined,operation:transport.messageFor?'send-message':undefined,providerCode:failure?.providerCode});
   }finally{inFlight.delete(entry.deliveryId);}
  }
 }
 return {isInFlight:id=>inFlight.has(id),tick(){return running??(running=dispatch().finally(()=>{running=null;}));},async remind(intervalMs=3600000){
  await store.update(s=>{for(const i of s.incidents.filter(i=>i.state==='OPEN')){
   if(i.reminders>=3||s.outbox.some(e=>e.incidentId===i.incidentId&&e.state==='PENDING')||now()-(i.lastReminderAt??Date.parse(i.openedAt))<intervalMs)continue;
   if(s.outbox.filter(e=>e.state==='PENDING').length>=1024)break;
   i.reminders=(i.reminders??0)+1;i.lastReminderAt=now();i.deliverySequence=(i.deliverySequence??0)+1;s.outbox.push({deliveryId:randomUUID(),incidentId:i.incidentId,sequence:i.deliverySequence,severity:i.severity,occurredAt:new Date(now()).toISOString(),transition:'REMINDER',state:'PENDING',attempts:0,nextAttemptAt:now()});
  }});
 }};
}
