import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {lstat,realpath,readFile,open,rename} from 'node:fs/promises';
import {windowsFileAcl} from '../production/runtime-config.js';
import {validateSmokeAcl,hardenSmokeTemporary} from '../production/wecom-smoke-config.js';
import {canonical} from '../backup/format.js';

const fail=code=>Object.assign(Error(code),{code});
const FILE='execution-state.json';
const STATES=new Set(['FREEZE_INTENT','FROZEN','RESTORING','VERIFYING','FAILED_AMBIGUOUS']);
const binding=plan=>({recoveryOperationId:plan.recoveryOperationId,planDigest:plan.planDigest});
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
 Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fileAcl=async path=>validateSmokeAcl(await windowsFileAcl(path));

export async function readExecutionState(journal,plan,{checkAcl=fileAcl}={}){
 const path=join(journal,FILE);
 let info;try{info=await lstat(path);}catch(error){
  if(error.code==='ENOENT')return null;throw error;
 }
 if(!info.isFile()||info.isSymbolicLink()||info.size>65536||await realpath(path)!==path)
  throw fail('PRODUCTION_RESTORE_JOURNAL_INVALID');
 await checkAcl(path);
 let state;try{state=JSON.parse(await readFile(path,'utf8'));}
 catch{throw fail('PRODUCTION_RESTORE_JOURNAL_INVALID');}
 if(!exact(state,['version','recoveryOperationId','planDigest','state'])||
   state.version!==1||!STATES.has(state.state)||
   state.recoveryOperationId!==plan.recoveryOperationId||
   state.planDigest!==plan.planDigest)
  throw fail('PRODUCTION_RESTORE_JOURNAL_MISMATCH');
 return state;
}

export async function transitionExecutionState(journal,plan,from,to,{
 read=readExecutionState,harden=hardenSmokeTemporary,checkAcl=fileAcl
}={}){
 if(!STATES.has(to))throw fail('PRODUCTION_RESTORE_JOURNAL_INVALID');
 const current=await read(journal,plan,{checkAcl});
 if((current?.state??null)!==from)throw fail('PRODUCTION_RESTORE_JOURNAL_CONFLICT');
 const target=join(journal,FILE),temp=join(journal,'execution-'+randomUUID()+'.tmp');
 const file=await open(temp,'wx',0o600);
 try{await harden(temp);await file.writeFile(canonical({version:1,...binding(plan),state:to}));
  await file.sync();
 }finally{await file.close();}
 await checkAcl(temp);
 // A failed rename leaves the prior authoritative state and a protected temp for review.
 await rename(temp,target);
 await checkAcl(target);
 return to;
}
