import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,realpath} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {readExternalSecret} from '../production/secret-file.js';
import {validateRuntimeConfig,materializeRuntimeContext,windowsFileAcl} from '../production/runtime-config.js';
import {windowsDirectoryAcl} from '../production/wecom-smoke-config.js';
import {externalDirectory,fail} from '../backup/format.js';
import {checkedPaths,readProtectedRestorePlan,preflightPreparedRestore} from './production-plan.js';
import {readExecutionState} from './production-journal.js';

export const RECOVERY_POLICY_FILE='C:\\ProgramData\\JbhhKtv\\private\\recovery-policy.json';
const SYSTEM='S-1-5-18',ADMIN='S-1-5-32-544';
const exec=promisify(execFile);
export const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&
 Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
export async function windowsRecoveryIdentity(){
 if(process.platform!=='win32')throw fail('AUTHORIZATION_WINDOWS_REQUIRED');
 const script="$ErrorActionPreference='Stop';$i=[Security.Principal.WindowsIdentity]::GetCurrent();$p=[Security.Principal.WindowsPrincipal]::new($i);@{sid=$i.User.Value;elevated=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}|ConvertTo-Json -Compress";
 try{const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',
  Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:5000,maxBuffer:4096});
  const value=JSON.parse(stdout);
  if(!exact(value,['sid','elevated'])||!/^S-1-5-(?:\d+-)*\d+$/.test(value.sid)||typeof value.elevated!=='boolean')throw Error();
  return Object.freeze(value);
 }catch{throw fail('AUTHORIZATION_OPERATOR_UNVERIFIED');}
}
export function validateRecoveryPolicy(policy,identity){
 if(!exact(policy,['policyVersion','approvedOperatorSid','runtimeServiceSid','runtimeConfigFile'])||
  policy.policyVersion!==1||typeof policy.runtimeConfigFile!=='string'||
  !/^S-1-5-(?:\d+-)*\d+$/.test(policy.approvedOperatorSid)||
  !/^S-1-5-(?:\d+-)*\d+$/.test(policy.runtimeServiceSid)||
  policy.approvedOperatorSid===policy.runtimeServiceSid||
  identity.sid!==policy.approvedOperatorSid||identity.elevated!==true)
  throw fail('AUTHORIZATION_OPERATOR_DENIED');
 return policy;
}
export function validateRecoveryAcl(acl,{identity,runtimeServiceSid,shared=false,directory=false,policy=false}){
 const allowed=new Set([identity.sid,SYSTEM,ADMIN,...(shared?[runtimeServiceSid]:[])]);
 const ownerAllowed=policy?new Set([SYSTEM,ADMIN]):allowed;
 const usable=r=>r.type==='Allow'&&(r.sid===identity.sid||identity.elevated&&r.sid===ADMIN);
 if(!acl?.protected||acl.current!==identity.sid||!ownerAllowed.has(acl.owner)||
  !Array.isArray(acl.rules)||acl.rules.some(r=>r.type!=='Allow'||!allowed.has(r.sid))||
  !acl.rules.some(r=>usable(r)&&(r.rights&1)&&(!directory||
   (r.rights&197055)===197055&&String(r.inheritance??'').includes('ObjectInherit'))))
  throw fail('AUTHORIZATION_ACL_DENIED');
}
export async function canonicalProtectedPath(path,{directory=false}={}){
 try{
  const actual=await realpath(path),info=await lstat(path);
  if(actual!==resolve(path)||info.isSymbolicLink()||
    !(directory?info.isDirectory():info.isFile())||!directory&&info.size>65536)
   throw Error();
  await externalDirectory(directory?actual:dirname(actual));
  return actual;
 }catch{throw fail('AUTHORIZATION_PATH_DENIED');}
}
export async function loadRecoveryContext(runtimeConfigFile){
 const identity=await windowsRecoveryIdentity();
 const policyPath=await canonicalProtectedPath(RECOVERY_POLICY_FILE);
 const policy=validateRecoveryPolicy(await readExternalSecret(policyPath),identity);
 validateRecoveryAcl(await windowsFileAcl(policyPath),{identity,runtimeServiceSid:policy.runtimeServiceSid,policy:true});
 // Parent replacement rights are checked too; policy root is not supplied by CLI/env.
 validateRecoveryAcl(await windowsDirectoryAcl(dirname(policyPath)),{identity,runtimeServiceSid:policy.runtimeServiceSid,shared:true,directory:true});
 if(await canonicalProtectedPath(runtimeConfigFile)!==await canonicalProtectedPath(policy.runtimeConfigFile))
  throw fail('AUTHORIZATION_DEPLOYMENT_MISMATCH');
 const config=validateRuntimeConfig(await readExternalSecret(runtimeConfigFile));
 if(config.serviceAccountSid!==policy.runtimeServiceSid||identity.sid===config.serviceAccountSid)
  throw fail('AUTHORIZATION_OPERATOR_DENIED');
 const access={identity,runtimeServiceSid:config.serviceAccountSid};
 const sharedFile=async path=>{await canonicalProtectedPath(path);validateRecoveryAcl(await windowsFileAcl(path),{...access,shared:true});};
 const sharedDir=async path=>{await canonicalProtectedPath(path,{directory:true});validateRecoveryAcl(await windowsDirectoryAcl(path),{...access,shared:true});};
 await sharedFile(runtimeConfigFile);await sharedFile(config.secretsFile);
 const loaded=await materializeRuntimeContext(config,await readExternalSecret(config.secretsFile));
 const authorizationDirectory=join(config.recovery?.journalDirectory??'','authorization');
 await canonicalProtectedPath(authorizationDirectory,{directory:true});
 validateRecoveryAcl(await windowsDirectoryAcl(authorizationDirectory),{...access,directory:true});
 const pathCheck=(l,a)=>checkedPaths(l,a,{backupAcl:sharedDir,journalAcl:sharedDir,fileAcl:sharedFile});
 const load=async()=>loaded;
 const operatorLoad=async()=>{
  const path=await canonicalProtectedPath(config.recovery?.operatorDbSecretsFile);
  validateRecoveryAcl(await windowsFileAcl(path),access);
  const secret=await readExternalSecret(path);
  if(!exact(secret,['databaseUrl']))throw fail('AUTHORIZATION_CREDENTIAL_INVALID');
  let operator,active;try{operator=new URL(secret.databaseUrl);active=new URL(loaded.apiEnv.KTV_MYSQL_URL);}catch{throw fail('AUTHORIZATION_CREDENTIAL_INVALID');}
  if(operator.protocol!=='mysql:'||!operator.username||!operator.password||operator.pathname!=='/'||operator.search||operator.hash||
   operator.hostname!==active.hostname||Number(operator.port||3306)!==Number(active.port||3306))
   throw fail('AUTHORIZATION_CREDENTIAL_INVALID');
  return operator.href;
 };
 const readPlan=args=>readProtectedRestorePlan({...args,load,pathCheck,fileAcl:sharedFile});
 const current=await readPlan({runtimeConfigFile});
 const stage=await readExecutionState(current.journal,current.plan,{checkAcl:sharedFile});
 // D1 has no production stage orchestration or stage-dependent reauthorization.
 if(stage)throw fail('AUTHORIZATION_D1_STAGE_UNAVAILABLE');
 const checked=await preflightPreparedRestore({runtimeConfigFile,readPlan,load,pathCheck,operatorLoad});
 return Object.freeze({plan:checked.plan,actorSid:identity.sid,runtimeServiceSid:config.serviceAccountSid,
  deploymentConfigFingerprint:loaded.configFingerprint,environment:'production',authorizationDirectory,
  checkDirectory:async path=>{await canonicalProtectedPath(path,{directory:true});
   validateRecoveryAcl(await windowsDirectoryAcl(path),{...access,directory:true});},
  checkFile:async path=>{await canonicalProtectedPath(path);validateRecoveryAcl(await windowsFileAcl(path),access);}});
}
