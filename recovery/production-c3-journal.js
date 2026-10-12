import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {lstat,realpath,readFile,open,rename} from 'node:fs/promises';
import {windowsFileAcl} from '../production/runtime-config.js';
import {validateSmokeAcl,hardenSmokeTemporary} from '../production/wecom-smoke-config.js';
import {canonical,fail} from '../backup/format.js';

const FILE='c3-resume.json';
const STATES=new Set(['READY_INTENT','READY_FOR_RESUME','RESUME_INTENT','RESUMED']);
const TRANSITIONS=new Set(['null>READY_INTENT','READY_INTENT>READY_FOR_RESUME',
 'READY_FOR_RESUME>RESUME_INTENT','RESUME_INTENT>RESUMED']);
const checkFile=async path=>validateSmokeAcl(await windowsFileAcl(path));
const binding=(plan,proof)=>({version:1,recoveryOperationId:plan.recoveryOperationId,
 planDigest:plan.planDigest,backupSha256:plan.backupSha256,
 sourceDatabase:plan.currentDatabase,targetDatabase:plan.targetDatabase,
 serverUuid:plan.targetServerUuid,c1EvidenceDigest:proof.c1EvidenceDigest,
 oldDigest:proof.oldDigest,c1CandidateDigest:proof.c1CandidateDigest,
 candidateBusinessDigest:proof.candidateBusinessDigest,
 alertDigest:proof.alertDigest});
const KEYS=['version','recoveryOperationId','planDigest','backupSha256',
 'sourceDatabase','targetDatabase','serverUuid','c1EvidenceDigest',
 'oldDigest','c1CandidateDigest','candidateBusinessDigest','alertDigest','state'];
const HASH=/^[a-f0-9]{64}$/;
export async function readC3State(journal,plan,{checkAcl=checkFile}={}){
 const path=join(journal,FILE);
 let info;try{info=await lstat(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}
 if(!info.isFile()||info.isSymbolicLink()||info.size>65536||await realpath(path)!==path)
  throw fail('PRODUCTION_C3_JOURNAL_INVALID');
 await checkAcl(path);
 let state;try{state=JSON.parse(await readFile(path,'utf8'));}
 catch{throw fail('PRODUCTION_C3_JOURNAL_INVALID');}
 if(!state||typeof state!=='object'||Array.isArray(state)||
    Object.keys(state).length!==KEYS.length||KEYS.some(key=>!Object.hasOwn(state,key))||
    state.version!==1||!STATES.has(state.state)||
    ['planDigest','backupSha256','c1EvidenceDigest','oldDigest',
     'c1CandidateDigest','candidateBusinessDigest','alertDigest'].some(key=>!HASH.test(state[key]))||
    !/^[a-z][a-z0-9_]{0,63}$/.test(state.sourceDatabase)||
    !/^[a-z][a-z0-9_]{0,63}$/.test(state.targetDatabase)||
    state.sourceDatabase===state.targetDatabase)
  throw fail('PRODUCTION_C3_JOURNAL_INVALID');
 if(plan&&Object.entries(binding(plan,state)).some(([key,value])=>state[key]!==value))
  throw fail('PRODUCTION_C3_JOURNAL_CONFLICT');
 return state;
}
export async function transitionC3State(journal,plan,proof,from,to,{
 read=readC3State,harden=hardenSmokeTemporary,checkAcl=checkFile,move=rename}={}){
 if(!TRANSITIONS.has(String(from)+'>'+to))throw fail('PRODUCTION_C3_JOURNAL_CONFLICT');
 const current=await read(journal,plan,{checkAcl});
 if((current?.state??null)!==from)throw fail('PRODUCTION_C3_JOURNAL_CONFLICT');
 const expected=binding(plan,proof);
 if(current&&Object.entries(expected).some(([key,value])=>current[key]!==value))
  throw fail('PRODUCTION_C3_JOURNAL_CONFLICT');
 const target=join(journal,FILE),temp=join(journal,'c3-'+randomUUID()+'.tmp');
 const file=await open(temp,'wx',0o600);
 try{await harden(temp);await file.writeFile(canonical({...expected,state:to}));await file.sync();}
 finally{await file.close();}
 await checkAcl(temp);
 await move(temp,target);
 await checkAcl(target);
 return to;
}
