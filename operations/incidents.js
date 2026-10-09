import {randomUUID} from 'node:crypto';
import {EVENTS,operationalEvent,safeContext,hash} from './contract.js';
export function createIncidentLifecycle({store,logger,scope,now=Date.now,secrets=[],maxHistory=500,retentionMs=30*86400000,maxActive=512}){
 const fingerprint=(type,context)=>hash(JSON.stringify([scope,type,safeContext(context,secrets)]));
 async function condition(type,active,context={},severity){
  if(!EVENTS[type])throw Error('OPERATIONAL_EVENT_INVALID');
  let event;
  const result=await store.update(state=>{
   const key=fingerprint(type,context),current=state.incidents.find(i=>i.fingerprint===key&&i.state==='OPEN'),time=now();
   if(active&&current){
    current.lastSeenAt=new Date(time).toISOString();
    if(severity&&['WARN','ERROR','CRITICAL'].indexOf(severity)>['WARN','ERROR','CRITICAL'].indexOf(current.severity)){current.severity=severity;queue(state,current,'ESCALATED',time);event={...operationalEvent(type,context,time,secrets),severity,incidentId:current.incidentId};}
    return current;
   }
   if(!active&&!current)return null;
   if(active){
    if(state.incidents.filter(i=>i.state==='OPEN').length>=maxActive)throw Error('OPERATIONAL_ACTIVE_CAPACITY');
    const clean=operationalEvent(type,context,time,secrets);
    const incident={incidentId:randomUUID(),fingerprint:key,state:'OPEN',type,severity:severity??clean.severity,openedAt:clean.timestamp,lastSeenAt:clean.timestamp,resolvedAt:null,context:safeContext(context,secrets),message:clean.message,action:clean.action,runbook:type};
    state.incidents.push(incident);queue(state,incident,'OPEN',time);event={...clean,severity:incident.severity,incidentId:incident.incidentId};return incident;
   }
   current.state='RESOLVED';current.resolvedAt=new Date(time).toISOString();queue(state,current,'RESOLVED',time);
   event={...operationalEvent(type,context,time,secrets),severity:'INFO',incidentId:current.incidentId,incidentState:'RESOLVED'};return current;
  });
  if(event)logger.log(event);return result;
 }
 function queue(state,incident,transition,time){
  if(state.outbox.filter(e=>e.state==='PENDING').length>=1024)throw Error('OPERATIONAL_OUTBOX_CAPACITY');
  state.outbox.push({deliveryId:randomUUID(),incidentId:incident.incidentId,transition,state:'PENDING',attempts:0,nextAttemptAt:time});
 }
 return {condition,
  async event(type,context={}){const event=operationalEvent(type,context,now(),secrets);logger.log(event);return event;},
  async prune(){const cutoff=now()-retentionMs;await store.update(state=>{
   const resolved=state.incidents.filter(i=>i.state==='RESOLVED'&&Date.parse(i.resolvedAt)>=cutoff).slice(-maxHistory);
   const pendingIds=new Set(state.outbox.filter(e=>e.state==='PENDING').map(e=>e.incidentId));
   state.incidents=state.incidents.filter(i=>i.state==='OPEN'||pendingIds.has(i.incidentId)||resolved.includes(i));
   const ids=new Set(state.incidents.map(i=>i.incidentId));
   state.outbox=state.outbox.filter(e=>ids.has(e.incidentId)&&(e.state==='PENDING'||e.nextAttemptAt>=cutoff)).slice(-2048);
  });}
 };
}
