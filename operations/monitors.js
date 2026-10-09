import {X509Certificate} from 'node:crypto';
import {statfs,open,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
export const MONITOR_DEFAULTS=Object.freeze({intervalMs:10000,probeTimeoutMs:2500,offlineMs:120000,verificationMs:120000,backupMaxAgeMs:86400000,tlsWarnDays:30,tlsErrorDays:14,tlsCriticalDays:7,minFreeBytes:1024*1024*1024,retentionDays:30,maxHistory:500,logMaxBytes:10*1024*1024,logMaxFiles:10,authWindowMs:900000,authFailures:5,alertingRequired:false,alertTransport:'none'});
export function monitoringConfig(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!Object.hasOwn(MONITOR_DEFAULTS,k)&&k!=='backupDirectory'))throw Error('MONITORING_CONFIG_INVALID');
 const c={...MONITOR_DEFAULTS,...input};
 for(const key of Object.keys(MONITOR_DEFAULTS).filter(k=>!['alertingRequired','alertTransport'].includes(k)))if(!Number.isSafeInteger(c[key])||c[key]<1||c[key]>365*86400000)throw Error('MONITORING_CONFIG_INVALID');
 if(c.intervalMs<1000||c.intervalMs>60000||c.probeTimeoutMs>10000||c.maxHistory>5000||c.logMaxFiles>100||c.logMaxBytes<1024||c.tlsWarnDays<c.tlsErrorDays||c.tlsErrorDays<c.tlsCriticalDays||typeof c.alertingRequired!=='boolean'||!['none','local'].includes(c.alertTransport)||c.backupDirectory!==undefined&&typeof c.backupDirectory!=='string')throw Error('MONITORING_CONFIG_INVALID');
 return Object.freeze(c);
}
export function readinessFailure(error){return {ready:false,blockers:[{code:['LEDGER_SNAPSHOT_INVALID','BOOTSTRAP_SCHEMA_MISMATCH','PRODUCTION_STORE_MISMATCH'].includes(error?.code)?'DATA_INVARIANT_FAILURE':'DATABASE_OR_SCHEMA_UNAVAILABLE'}]};}
export function boundedProbe(work,ms){
 let timer;return Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('MONITOR_PROBE_TIMEOUT')),ms);})]).finally(()=>clearTimeout(timer));
}
export function tlsSummary(pem,hostname,now=Date.now()){
 const cert=new X509Certificate(pem);return {notBefore:new Date(cert.validFrom).toISOString(),notAfter:new Date(cert.validTo).toISOString(),daysRemaining:Math.floor((Date.parse(cert.validTo)-now)/86400000),hostname,hostnameMatches:!!cert.checkHost(hostname)};
}
export async function directorySummary(directory){
 const stat=await statfs(directory,{bigint:true}),freeBytes=stat.bavail*stat.bsize;
 const path=join(directory,'monitor-probe-'+randomUUID()+'.tmp');let file;
 try{file=await open(path,'wx',0o600);await file.close();file=null;return {writable:true,freeBytes:Number(freeBytes>BigInt(Number.MAX_SAFE_INTEGER)?BigInt(Number.MAX_SAFE_INTEGER):freeBytes)};}finally{await file?.close();await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
export async function observeWorkflow(lifecycle,record,c,{now=Date.now}={}){
 const context={workflowId:record.id,roomId:record.internalRoomId,component:'device'},time=now();
 const events=record.events??[];let enteredAt=record.createdAt;
 for(const e of events){if(e.status!==record.status)enteredAt=null;else if(!enteredAt)enteredAt=e.at;}
 const age=time-Date.parse(record.offlineSince??enteredAt??record.updatedAt??record.createdAt);
 const offline=record.status==='DEVICE_OFFLINE_WAIT'||record.status==='WAITING_DEVICE_ONLINE'||record.status==='DEVICE_OFFLINE'||record.roomReadiness==='WAITING_DEVICE';
 await lifecycle.condition('DEVICE_OFFLINE',offline&&age>=c.offlineMs,context);
 await lifecycle.condition('DEVICE_UNKNOWN',record.uncertain===true||record.status==='DEVICE_UNKNOWN',context);
 await lifecycle.condition('DEVICE_VERIFYING',record.status==='DEVICE_VERIFYING'&&age>=c.verificationMs,context);
 await lifecycle.condition('DEVICE_FAILED',record.status==='DEVICE_FAILED'||record.roomReadiness==='FAILED',context);
 // Provider-wide auth state is projected from the latest explicit evidence in runtime.
}
