import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {lstat,realpath,readFile,open,rename} from 'node:fs/promises';
import {windowsFileAcl} from '../production/runtime-config.js';
import {validateSmokeAcl,hardenSmokeTemporary} from '../production/wecom-smoke-config.js';
import {canonical,fail} from '../backup/format.js';
import {validatePlan} from './production-plan.js';
import {readExecutionState} from './production-journal.js';
import {readC3State} from './production-c3-journal.js';
import {assertCompletedC3Startup} from './production-c3-startup.js';

const FILE='cutover-state.json';
const STATES=new Set(['CUTOVER_INTENT','CUTOVER_SWITCHED']);
const checkFile=async path=>validateSmokeAcl(await windowsFileAcl(path));
const binding=plan=>({version:1,recoveryOperationId:plan.recoveryOperationId,
 planDigest:plan.planDigest,backupSha256:plan.backupSha256,
 sourceDatabase:plan.currentDatabase,targetDatabase:plan.targetDatabase,
 serverUuid:plan.targetServerUuid});
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
 Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export async function readCutoverState(journal,plan,{checkAcl=checkFile}={}){
 const path=join(journal,FILE);
 let info;try{info=await lstat(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}
 if(!info.isFile()||info.isSymbolicLink()||info.size>65536||await realpath(path)!==path)
  throw fail('PRODUCTION_CUTOVER_JOURNAL_INVALID');
 await checkAcl(path);
 let state;try{state=JSON.parse(await readFile(path,'utf8'));}
 catch{throw fail('PRODUCTION_CUTOVER_JOURNAL_INVALID');}
 const keys=['version','recoveryOperationId','planDigest','backupSha256',
  'sourceDatabase','targetDatabase','serverUuid','state'];
 if(!exact(state,keys)||state.version!==1||!STATES.has(state.state)||
    !/^[a-f0-9]{64}$/.test(state.planDigest)||
    !/^[a-f0-9]{64}$/.test(state.backupSha256)||
    !/^[a-z][a-z0-9_]{0,63}$/.test(state.sourceDatabase)||
    !/^[a-z][a-z0-9_]{0,63}$/.test(state.targetDatabase)||
    state.sourceDatabase===state.targetDatabase)
  throw fail('PRODUCTION_CUTOVER_JOURNAL_INVALID');
 if(plan&&Object.entries(binding(plan)).some(([key,value])=>state[key]!==value))
  throw fail('PRODUCTION_CUTOVER_JOURNAL_CONFLICT');
 return state;
}
export async function transitionCutoverState(journal,plan,from,to,{
 read=readCutoverState,harden=hardenSmokeTemporary,checkAcl=checkFile,
 move=rename}={}){
 if(!(from===null&&to==='CUTOVER_INTENT'||
      from==='CUTOVER_INTENT'&&to==='CUTOVER_SWITCHED'))
  throw fail('PRODUCTION_CUTOVER_JOURNAL_CONFLICT');
 const current=await read(journal,plan,{checkAcl});
 if((current?.state??null)!==from)throw fail('PRODUCTION_CUTOVER_JOURNAL_CONFLICT');
 const target=join(journal,FILE),temp=join(journal,'cutover-'+randomUUID()+'.tmp');
 const file=await open(temp,'wx',0o600);
 try{await harden(temp);await file.writeFile(canonical({...binding(plan),state:to}));await file.sync();}
 finally{await file.close();}
 await checkAcl(temp);
 await move(temp,target);
 await checkAcl(target);
 return to;
}
export async function assertNormalStartupAllowed(loaded,{
 read=readCutoverState,readExecution=readExecutionState,
 readC3=readC3State,completionCheck=assertCompletedC3Startup}={}){
 const journal=loaded.config.recovery?.journalDirectory;
 if(!journal)return true;
 const cutover=await read(journal);
 const file=join(journal,'active-plan.json');
 let info;try{info=await lstat(file);}catch(error){
  if(error.code!=='ENOENT')throw error;
  try{await lstat(join(journal,'execution-state.json'));}
  catch(stateError){
   if(stateError.code==='ENOENT'&&!cutover)return true;
   if(stateError.code!=='ENOENT')throw stateError;
  }
  throw fail('PRODUCTION_CUTOVER_STARTUP_BLOCKED');
 }
 if(!info.isFile()||info.isSymbolicLink()||info.size>65536||await realpath(file)!==file)
  throw fail('PRODUCTION_CUTOVER_STARTUP_BLOCKED');
 await checkFile(file);
 let plan;try{plan=validatePlan(JSON.parse(await readFile(file,'utf8')));}
 catch{throw fail('PRODUCTION_CUTOVER_STARTUP_BLOCKED');}
 const execution=await readExecution(journal,plan);
 const progress=await readC3(journal,plan);
 const pointer=decodeURIComponent(new URL(loaded.apiEnv.KTV_MYSQL_URL).pathname.slice(1));
 if(progress?.state==='RESUMED'){
  try{return await completionCheck(loaded,plan,journal,{cutover,execution});}
  catch{throw fail('PRODUCTION_C3_STARTUP_BLOCKED');}
 }
 if(cutover||execution||progress||pointer===plan.targetDatabase)
  throw fail('PRODUCTION_CUTOVER_STARTUP_BLOCKED');
 return true;
}
