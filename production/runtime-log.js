import { randomUUID } from 'node:crypto';
import {EVENTS} from '../operations/contract.js';
const allowed=new Set(['requestId','event','code','status','elapsedMs','appVersion','schemaVersion','configFingerprint','blockers','signal','severity','eventType','incidentId','incidentState','principalId','operationKey','workflowId','roomId','component','category','message','action','runbook']);
export function createSafeLogger({write=line=>process.stdout.write(line),secrets=[]}={}){
 const scrub=value=>{
  let s=String(value);
  for(const secret of secrets.filter(v=>typeof v==='string'&&v.length>=3))s=s.split(secret).join('[REDACTED]');
  return s.replace(/mysql:\/\/[^\s"']+/gi,'[REDACTED_DB_URL]');
 };
 const emit=(level,entry={})=>{
  const output={timestamp:new Date().toISOString(),level};
  if(typeof entry==='object'&&entry!==null)for(const [key,value]of Object.entries(entry)){
   if(!allowed.has(key))continue;
   if(['message','action','runbook'].includes(key)){const definition=EVENTS[entry.eventType??entry.code];if(definition&&value===definition[key])output[key]=scrub(value);continue;}
   if(key==='blockers'&&Array.isArray(value))output[key]=value.filter(v=>typeof v==='string'&&/^[A-Z0-9_]{1,80}$/.test(v)).map(scrub);
   else if(['status','elapsedMs'].includes(key)&&Number.isFinite(value))output[key]=value;
   else if(typeof value==='string'&&value.length<=128)output[key]=scrub(value);
  }
  write(JSON.stringify(output)+'\n');
 };
 return Object.freeze({info:entry=>emit('info',entry),error:entry=>emit('error',entry),log:entry=>emit(['ERROR','CRITICAL'].includes(entry?.severity)?'error':entry?.severity==='WARN'?'warn':'info',entry),newRequestId:randomUUID});
}
