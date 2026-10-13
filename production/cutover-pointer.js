import {canonicalProtectedPath} from '../recovery/production-authorization-context.js';
import {validatePlan} from '../recovery/production-plan.js';
import {assertOwnedDatabase} from '../rehearsal/scope.js';
import {assertProductionPlanAuthority} from '../recovery/production-authorization.js';
import {withOwnedCandidateRead,withOwnedCandidateLockContext,assertOwnedCandidateLockContext} from '../recovery/production-candidate.js';
import {readRuntimeDeploymentForRecovery,checkRecoveryPointerStage,checkRecoveryRuntimeFile} from '../recovery/runtime-boundary.js';
import {relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {dirname,join} from 'node:path';
import {lstat,realpath,open,rename,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readExternalSecret} from './secret-file.js';
import {windowsFileAcl,validateFileAcl} from './runtime-config.js';
import {canonical,fail} from '../backup/format.js';

const exec=promisify(execFile);
const safeName=name=>typeof name==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(name);
const inspect=async(path,sid,fileAcl)=>{
 const info=await lstat(path);
 if(!info.isFile()||info.isSymbolicLink()||info.size>65536||await realpath(path)!==path)
  throw fail('PRODUCTION_CUTOVER_CONFIG_INVALID');
 validateFileAcl(await fileAcl(path),sid);
};
// Copy the existing protected DACL/owner to the empty same-directory temp before secrets are written.
export async function hardenCutoverTemp(temp,source){
 if(process.platform!=='win32')throw fail('PRODUCTION_CUTOVER_CONFIG_INVALID');
 const a=Buffer.from(source,'utf8').toString('base64');
 const b=Buffer.from(temp,'utf8').toString('base64');
 const script="$ErrorActionPreference='Stop';$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+a+"'));$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+b+"'));[IO.File]::SetAccessControl($t,[IO.File]::GetAccessControl($s))";
 try{await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',
  Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:5000,maxBuffer:65536});}
 catch{throw fail('PRODUCTION_CUTOVER_CONFIG_INVALID');}
}
async function writePointer(loaded,plan,{
 read=readExternalSecret,fileAcl=windowsFileAcl,harden=hardenCutoverTemp,
 move=rename,beforeMove,check}={}){
 const sid=loaded.config.serviceAccountSid,configured=loaded.config.secretsFile;
 if(!safeName(plan.currentDatabase)||!safeName(plan.targetDatabase)||
    plan.currentDatabase===plan.targetDatabase||!configured)
  throw fail('PRODUCTION_CUTOVER_CONFIG_INVALID');
 // A new target is never selected from the operator's command line.
 const path=await canonicalProtectedPath(configured);
 await (check?check(path):inspect(path,sid,fileAcl));
 const prior=await read(path);
 if(prior?.database?.name!==plan.currentDatabase)
  throw fail('PRODUCTION_CUTOVER_POINTER_CONFLICT');
 const next={...prior,database:{...prior.database,name:plan.targetDatabase}};
 const original=canonical(prior),replacement=canonical(next);
 if(Buffer.byteLength(replacement)>65536)throw fail('PRODUCTION_CUTOVER_CONFIG_INVALID');
 const temp=join(dirname(path),'cutover-secret-'+randomUUID()+'.tmp');
 let moved=false,created=false;
 try{
  const file=await open(temp,'wx',0o600);created=true;
  try{await harden(temp,path);await (check?check(temp):inspect(temp,sid,fileAcl));
   await file.writeFile(replacement);await file.sync();
  }finally{await file.close();}
  await (check?check(temp):inspect(temp,sid,fileAcl));
  await beforeMove?.();
  await (check?check(path):inspect(path,sid,fileAcl));
  if(canonical(await read(path))!==original)
   throw fail('PRODUCTION_CUTOVER_POINTER_CONFLICT');
  await move(temp,path);moved=true;
  await (check?check(path):inspect(path,sid,fileAcl));
  const final=await read(path);
  if(canonical(final)!==replacement||final.database.name!==plan.targetDatabase)
   throw fail('PRODUCTION_CUTOVER_CONFIG_INVALID');
  return {before:plan.currentDatabase,after:plan.targetDatabase,atomic:true,
   aclPreserved:true,secretsPreserved:true};
 }finally{if(created&&!moved)await rm(temp,{force:true});}
}

// Production cannot substitute OS/authority checks through writer options.
export async function updateProtectedDatabasePointer(loaded,plan,{authority,runtimeConfigFile}={}){
 const admit=async()=>{
  const grant=await assertProductionPlanAuthority(authority);
  if(grant.recoveryOperationId!==plan.recoveryOperationId||grant.planDigest!==plan.planDigest)
   throw fail('AUTHORIZATION_BINDING_MISMATCH');
  const d=await readRuntimeDeploymentForRecovery(runtimeConfigFile);
  if(d.config.secretsFile!==loaded.config.secretsFile||d.config.serviceAccountSid!==loaded.config.serviceAccountSid)
   throw fail('AUTHORIZATION_DEPLOYMENT_MISMATCH');
  const stage=await checkRecoveryPointerStage(runtimeConfigFile,plan);
  if(stage.stage!=='CUTOVER_INTENT'||stage.side!=='SOURCE')throw fail('PRODUCTION_CUTOVER_POINTER_CONFLICT');
  return d;
 };
 await assertProductionPlanAuthority(authority);
 validatePlan(plan);
 const d=await admit();
 return writePointer(d,plan,{check:path=>checkRecoveryRuntimeFile(runtimeConfigFile,path),beforeMove:admit});
}
// Separate test authority: the existing owned MySQL capability, never a production token.
export async function updateOwnedDatabasePointer(capability,loaded,plan,options={},heldContext){
 if(heldContext===undefined)return withOwnedCandidateRead(capability,(_connection,held)=>
  updateOwnedDatabasePointer(capability,loaded,plan,options,held));
 return withOwnedCandidateLockContext(capability,heldContext,async()=>{
  const actual=await canonicalProtectedPath(loaded.config.secretsFile);
  const rel=relative(capability.root,actual);
  assertOwnedDatabase(plan.currentDatabase,{id:capability.id,database:capability.database},new Set([plan.currentDatabase]));
  if(!rel||rel.startsWith('..')||isAbsolute(rel))
   throw fail('AUTHORIZATION_TEST_SCOPE_DENIED');
  return writePointer(loaded,plan,{...options,beforeMove:async()=>{
   await options.beforeMove?.();
   await assertOwnedCandidateLockContext(capability,heldContext);
  }});
 });
}
