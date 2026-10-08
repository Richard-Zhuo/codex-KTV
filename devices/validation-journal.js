import { open, mkdir, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { denyValidation, insideDirectory, repositoryRoot } from './ktvsky-safety.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses=['UNKNOWN','ACKNOWLEDGED','DESIRED_STATE_CONFIRMED','PRECONDITION_SATISFIED'];
const keys=['schemaVersion','scopeKey','workflowId','stepId','action','status','countdownSeconds','targetEndAt',
  'acknowledged','preExistingDesiredState','causalEffect','evidenceSha256','history'];
export const isPending=record=>record && ['UNKNOWN','ACKNOWLEDGED'].includes(record.status);
export async function journalLocation(directory,key) {
  if(typeof directory!=='string'||!path.isAbsolute(directory)||insideDirectory(repositoryRoot,path.resolve(directory)))denyValidation('EXTERNAL_JOURNAL_REQUIRED');
  await mkdir(directory,{recursive:true,mode:0o700});
  const root=await realpath(directory);
  if(insideDirectory(repositoryRoot,root))denyValidation('EXTERNAL_JOURNAL_REQUIRED');
  return path.join(root,key+'.json');
}
function valid(record,key,historical=false) {
  return record && [1,2].includes(record.schemaVersion) && record.scopeKey===key && uuid.test(record.workflowId) &&
    ['close','open'].includes(record.action) && record.stepId===record.workflowId+':'+record.action &&
    statuses.includes(record.status) && (record.schemaVersion!==1 || record.status==='UNKNOWN') &&
    Object.keys(record).every(k=>keys.includes(k)) &&
    (record.schemaVersion!==1 || Object.keys(record).every(k=>['schemaVersion','scopeKey','workflowId','stepId','action','status','countdownSeconds','targetEndAt'].includes(k))) &&
    (record.action==='open' ? Number.isSafeInteger(record.countdownSeconds) && record.countdownSeconds>0 &&
      typeof record.targetEndAt==='string' && record.targetEndAt.length<=191 && Number.isFinite(Date.parse(record.targetEndAt)) :
      !Object.hasOwn(record,'countdownSeconds') && !Object.hasOwn(record,'targetEndAt')) &&
    (record.status!=='UNKNOWN' || record.acknowledged!==true) &&
    (!['ACKNOWLEDGED','DESIRED_STATE_CONFIRMED'].includes(record.status) ||
      (record.acknowledged===true && record.causalEffect==='UNVERIFIED')) &&
    (record.status!=='PRECONDITION_SATISFIED' ||
      (record.action==='close' && record.preExistingDesiredState===true && record.acknowledged!==true && record.causalEffect==='UNVERIFIED')) &&
    (!Object.hasOwn(record,'acknowledged') || typeof record.acknowledged==='boolean') &&
    (!Object.hasOwn(record,'preExistingDesiredState') || typeof record.preExistingDesiredState==='boolean') &&
    (!Object.hasOwn(record,'causalEffect') || record.causalEffect==='UNVERIFIED') &&
    (!Object.hasOwn(record,'evidenceSha256') || /^[a-f0-9]{64}$/.test(record.evidenceSha256)) &&
    (historical ? !Object.hasOwn(record,'history') :
      (!Object.hasOwn(record,'history') || (Array.isArray(record.history) && record.history.length<=128 && record.history.every(r=>valid(r,key,true)))));
}
export async function readJournal(file,key) {
  try {
    const bytes=await readFile(file);
    if(bytes.length>131072)denyValidation('INVALID_PENDING_RECORD');
    const record=JSON.parse(bytes.toString('utf8'));
    if(!valid(record,key))denyValidation('INVALID_PENDING_RECORD');
    return record;
  }catch(error){
    if(error.code==='ENOENT')return null;
    if(error.code==='INVALID_PENDING_RECORD')throw error;
    denyValidation('INVALID_PENDING_RECORD');
  }
}
// Short exclusive local-file transaction; no provider call runs under this lock.
// A crash may leave the lock and block validation; never expire it into a retry.
export async function updateJournal(file,key,change) {
  let lock,temp;
  try {
    try{lock=await open(file+'.lock','wx',0o600);}
    catch(error){if(error.code==='EEXIST')denyValidation('JOURNAL_BUSY');throw error;}
    const old=await readJournal(file,key),fields=change(old);
    if(!fields)return old;
    const history=old?[...(old.history??[]),Object.fromEntries(Object.entries(old).filter(([k])=>k!=='history'))]:[];
    if(history.length>128)denyValidation('JOURNAL_HISTORY_FULL');
    const next={...fields,schemaVersion:2,scopeKey:key,history};
    if(!valid(next,key))denyValidation('INVALID_PENDING_RECORD');
    temp=file+'.'+randomUUID()+'.tmp';
    const handle=await open(temp,'wx',0o600);
    try{await handle.writeFile(JSON.stringify(next),'utf8');await handle.sync();}finally{await handle.close();}
    await rename(temp,file);temp=null;return next;
  }catch(error){
    if(['INVALID_PENDING_RECORD','JOURNAL_BUSY','JOURNAL_HISTORY_FULL','INVALID_RECOVERY_EVIDENCE'].includes(error.code))throw error;
    denyValidation('JOURNAL_IO_ERROR');
  }finally{
    if(temp)await unlink(temp).catch(()=>{});
    if(lock){await lock.close();await unlink(file+'.lock');}
  }
}
