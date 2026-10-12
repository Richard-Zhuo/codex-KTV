import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {lstat,realpath,readFile,open,rename} from 'node:fs/promises';
import {windowsFileAcl} from '../production/runtime-config.js';
import {validateSmokeAcl,hardenSmokeTemporary} from '../production/wecom-smoke-config.js';
import {canonical,digest,fail} from '../backup/format.js';

const FILE='c1-verification.json';
const checkFile=async path=>validateSmokeAcl(await windowsFileAcl(path));
const identity=p=>({recoveryOperationId:p.recoveryOperationId,planDigest:p.planDigest,
 backupSha256:p.backupSha256,targetDatabase:p.targetDatabase,
 sourceDatabase:p.currentDatabase,serverUuid:p.targetServerUuid});
export function c1EvidenceFresh(evidence,plan,current){
 return evidence?.version===1&&evidence.cutoverEligible===true&&
  Object.entries(identity(plan)).every(([key,value])=>evidence[key]===value)&&
  evidence.candidateDigest===current.candidateDigest&&
  evidence.oldDigest===current.oldDigest&&evidence.alertDigest===current.alertDigest&&
  evidence.journalState==='VERIFYING'&&current.journalState==='VERIFYING'&&
  Array.isArray(evidence.blockingFindings)&&evidence.blockingFindings.length===0&&
  evidence.external&&Object.values(evidence.external).every(value=>
   value==='SAFE'||value==='NON_BLOCKING_MANUAL_FOLLOWUP');
}
export async function readC1Evidence(journal,plan,current,{checkAcl=checkFile}={}){
 const path=join(journal,FILE);
 let info;try{info=await lstat(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}
 if(!info.isFile()||info.isSymbolicLink()||info.size>65536||await realpath(path)!==path)
  throw fail('PRODUCTION_RESTORE_C1_EVIDENCE_INVALID');
 await checkAcl(path);
 let evidence;try{evidence=JSON.parse(await readFile(path,'utf8'));}
 catch{throw fail('PRODUCTION_RESTORE_C1_EVIDENCE_INVALID');}
 return {...evidence,cutoverEligible:c1EvidenceFresh(evidence,plan,current)};
}
export async function writeC1Evidence(journal,plan,report,{harden=hardenSmokeTemporary,checkAcl=checkFile}={}){
 const evidence={version:1,...identity(plan),verifiedAt:new Date().toISOString(),
  journalState:'VERIFYING',candidateDigest:report.candidateDigest,oldDigest:report.oldDigest,
  alertDigest:report.alertDigest,
  cutoverEligible:report.cutoverEligible===true&&report.blocking.length===0&&
   Object.values(report.external).every(value=>value==='SAFE'||
    value==='NON_BLOCKING_MANUAL_FOLLOWUP'),blockingFindings:report.blocking,
  manualFollowups:report.manualFollowups,external:report.external};
 const path=join(journal,FILE),temp=join(journal,'c1-'+randomUUID()+'.tmp');
 let prior;try{prior=await lstat(path);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(prior){
  if(!prior.isFile()||prior.isSymbolicLink()||await realpath(path)!==path)
   throw fail('PRODUCTION_RESTORE_C1_EVIDENCE_INVALID');
  await checkAcl(path);
 }
 const file=await open(temp,'wx',0o600);
 try{await harden(temp);await file.writeFile(canonical(evidence));await file.sync();}
 finally{await file.close();}
 await checkAcl(temp);
 await rename(temp,path);
 await checkAcl(path);
 return {cutoverEligible:evidence.cutoverEligible,evidenceDigest:digest(canonical(evidence)),
  blockingFindings:evidence.blockingFindings,manualFollowups:evidence.manualFollowups,external:evidence.external};
}
