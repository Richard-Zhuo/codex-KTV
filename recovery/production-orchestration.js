import {assertProductionPlanAuthority,requireOwnedAuthorizationHarness} from './production-authorization.js';
import {observeOwnedCandidate,freezePreparedCandidate,restorePreparedCandidate} from './production-candidate.js';
import {verifyPreparedCandidate} from './production-c1.js';
import {switchOwnedCandidatePointer} from './production-c2.js';
import {prepareOwnedCandidateResume,resumeOwnedCandidate} from './production-c3.js';
import {assertNormalStartupAllowed} from './production-cutover-journal.js';
import {readOwnedOrchestrationFacts,startupReadContext} from './orchestration-facts.js';
import {requireOwnedActivationVerifier} from './runtime-activation.js';
import {createRecoveryServiceAdapter} from '../production/recovery-service.js';
import {canonical,digest,fail} from '../backup/format.js';
import {canonicalProtectedPath} from './production-authorization-context.js';
import {join,relative,isAbsolute} from 'node:path';
import {open,readdir,readFile,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const sessions=new WeakMap();
export const ORCHESTRATION_STAGES=Object.freeze(['freeze-plan','restore-candidate','verify-candidate','cutover','prepare-resume','resume']);
export const orchestrationError=error=>{
 const code=error?.code;
 // Keep the namespace gate. Require a string and true end-of-input, including after newlines.
 return typeof code==='string'&&/^(AUTHORIZATION|PRODUCTION_RESTORE|PRODUCTION_ORCHESTRATION|PRODUCTION_CUTOVER|PRODUCTION_C3|RECOVERY_SERVICE|RESTORE_PRODUCTION|BACKUP|RUNTIME)_[A-Z0-9_]+(?![\s\S])/.test(code)?code:'PRODUCTION_ORCHESTRATION_FAILED';
};
export async function executeProductionRestoreStage(authority){
 await assertProductionPlanAuthority(authority);
 // Release gate: intentionally closed in code, never configurable by CLI/env/boolean.
 throw fail('RESTORE_PRODUCTION_DISABLED');
}
export function requireOrchestrationSession(session){
 const value=sessions.get(session);if(!value)throw fail('AUTHORIZATION_AUTHORITY_FORGED');return value;
}
const stopped=s=>s?.phase==='STOPPED';
const scoped=async(cap,path,directory=false)=>{const p=await canonicalProtectedPath(path,{directory}),rel=relative(cap.root,p);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw fail('AUTHORIZATION_TEST_SCOPE_DENIED');return p;};
export async function createOwnedRestoreOrchestration({capability,authorization,deps,serviceExpected,system,activation,hooks={}}){
 // Validate ownership and private D1 harness provenance before invoking adapters/callbacks.
 await observeOwnedCandidate(capability,async()=>{});
 requireOwnedAuthorizationHarness(authorization,capability);
 if(!system||!['snapshot','command','pause'].every(k=>typeof system[k]==='function'))throw fail('PRODUCTION_ORCHESTRATION_SCM_REQUIRED');
 await scoped(capability,deps.runtimeConfigFile);
 if(serviceExpected.configFile!==deps.runtimeConfigFile)throw fail('PRODUCTION_ORCHESTRATION_BINDING_MISMATCH');
 const service=createRecoveryServiceAdapter(serviceExpected,system);
 const verifyActivation=requireOwnedActivationVerifier(activation,capability);
 const facts=()=>readOwnedOrchestrationFacts(capability,deps);
 const initial=await facts(),binding={operation:initial.plan.recoveryOperationId,digest:initial.plan.planDigest,fingerprint:initial.loaded.configFingerprint,journal:initial.journal};
 const auditDirectory=join(initial.journal,'orchestration');await scoped(capability,auditDirectory,true);
 let cache=null;
 const refresh=async()=>cache=await service.status();
 const bridge={status:()=>stopped(cache)?{phase:'STOPPED',workerStopped:true,operationalStopped:true,connectionsClosed:true,normalWriterCount:0}:cache,shutdown:async()=>{const result=await service.shutdown();await refresh();return result;}};
 const fresh=async()=>{
  const f=await facts();
  if(f.plan.recoveryOperationId!==binding.operation||f.plan.planDigest!==binding.digest||f.loaded.configFingerprint!==binding.fingerprint||f.journal!==binding.journal)throw fail('PRODUCTION_ORCHESTRATION_BINDING_MISMATCH');
  return f;
 };
 async function audit(stage,type,code='NONE'){
  if(![...ORCHESTRATION_STAGES,'authorize','reauthorize','revoke-authorization'].includes(stage)||!['INTENT','PASS','BLOCKED','CHECKPOINT'].includes(type))throw fail('PRODUCTION_ORCHESTRATION_AUDIT_INVALID');
  await scoped(capability,auditDirectory,true);
  const path=join(auditDirectory,'d2-attempt-'+randomUUID()+'.json');
  const h=await open(path,'wx',0o600);
  try{await deps.journalOptions.harden(path);await deps.journalOptions.checkAcl(path);await h.writeFile(canonical({version:1,recoveryOperationId:binding.operation,planDigest:binding.digest,stage,type,code,at:new Date().toISOString()}));await h.sync();}
  finally{await h.close();}
 }
 async function hasCheckpoint(){
  for(const name of await readdir(auditDirectory)){
   if(!/^d2-attempt-[a-f0-9-]+\.json$/.test(name))throw fail('PRODUCTION_ORCHESTRATION_AUDIT_INVALID');
   const p=join(auditDirectory,name);await scoped(capability,p);await deps.journalOptions.checkAcl(p);
   const record=JSON.parse(await readFile(p,'utf8'));
   if(record.recoveryOperationId!==binding.operation||record.planDigest!==binding.digest)throw fail('PRODUCTION_ORCHESTRATION_AUDIT_INVALID');
   if(record.stage==='cutover'&&record.type==='CHECKPOINT')return true;
  }
  return false;
 }
 async function terminal(f,serviceState){
  if(f.c3?.state!=='RESUMED'||f.cutover?.state!=='CUTOVER_SWITCHED'||f.sourceMode!=='FROZEN'||f.candidateMode!=='NORMAL'||f.pointer.name!==f.plan.targetDatabase||!f.c1?.cutoverEligible)throw fail('PRODUCTION_ORCHESTRATION_TERMINAL_INCOMPLETE');
  await assertNormalStartupAllowed(startupReadContext(f.loaded,f.plan));
  if(serviceState.phase!=='RUNNING'||await verifyActivation(f)!=='ACTIVE')throw fail('PRODUCTION_ORCHESTRATION_TERMINAL_INCOMPLETE');
  return {source:'FROZEN',candidate:'NORMAL',pointer:f.pointer.name,oldWriters:0,candidateWriters:1,totalWriters:1,startup:'PASS'};
 }
 async function inspect(){
  try{
   const first=await fresh(),a=await authorization.peek(),serviceState=await refresh(),last=await fresh(),b=await authorization.peek();
   if(first.observationDigest!==last.observationDigest||a.revision!==b.revision)throw fail('PRODUCTION_ORCHESTRATION_OBSERVATION_CHANGED');
   let status=last.c3?.state??last.cutover?.state??last.execution?.state??'PREPARED';
   if(last.execution&&last.c3?.state!=='RESUMED'&&!stopped(serviceState))throw fail('PRODUCTION_ORCHESTRATION_RUNTIME_NOT_STOPPED');
   let proof=null;
   if(last.c3?.state==='RESUMED'){
    proof=await terminal(last,serviceState);
    status=b.active?.state==='CONSUMED'?'TERMINAL_SUCCESS':'RESUMED_AUTHORIZATION_PENDING';
   }
   return {status,authorization:b.active?.state??'MISSING',plan:'PREPARED',execution:last.execution?.state??null,source:last.sourceMode,candidate:last.candidateMode,pointer:last.pointer.name,c1:last.c1?.cutoverEligible?'PASS':'NOT_CURRENT',c2:last.cutover?.state??null,c3:last.c3?.state??null,service:serviceState.phase,terminal:proof,authorityIssued:'NO',writes:'NO'};
  }catch(error){return {status:'UNKNOWN',code:orchestrationError(error),authorityIssued:'NO',writes:'NO'};}
 }
 async function run(action,{runtimeConfigFile,confirm}={}){
  if(runtimeConfigFile!==deps.runtimeConfigFile)throw fail('AUTHORIZATION_TEST_SCOPE_DENIED');
  if(action==='inspect-status')return inspect();
  if(![...ORCHESTRATION_STAGES,'authorize','reauthorize','inspect-authorization','revoke-authorization'].includes(action))throw fail('PRODUCTION_ORCHESTRATION_ARGUMENTS_INVALID');
  if(action==='inspect-authorization')return authorization.peek();
  let f;await audit(action,'INTENT');
  try{
   f=await fresh();
   if(['authorize','reauthorize','revoke-authorization'].includes(action)){
    const result=action==='revoke-authorization'?await authorization.revoke():await authorization.authorize({confirm,reauthorize:action==='reauthorize'});await audit(action,'PASS');return result;
   }
   const prior=await authorization.peek();
   if(action==='resume'&&prior.active?.state==='CONSUMED'){
    const proof=await terminal(f,await refresh());await audit(action,'PASS','REPLAY');return {state:'RESUMED',replay:true,authorization:'CONSUMED',...proof};
   }
   const token=await authorization.issue();
   const result=await authorization.admit(token,async revalidate=>{
    const check=async()=>{await revalidate();return fresh();};
    f=await check();await refresh();
    if(f.c3?.state==='RESUMED'&&action!=='resume')throw fail('PRODUCTION_ORCHESTRATION_STAGE_CONFLICT');
    const args={...deps,capability};let result;
    if(action==='freeze-plan'){
     if(f.cutover||f.c3)throw fail('PRODUCTION_ORCHESTRATION_STAGE_CONFLICT');
     await bridge.shutdown();if(!stopped(cache))throw fail('PRODUCTION_ORCHESTRATION_RUNTIME_NOT_STOPPED');await check();
     result=await freezePreparedCandidate({...args,transition:deps.executionTransition});
    }else if(action==='restore-candidate'){
     if(!stopped(cache))throw fail('PRODUCTION_ORCHESTRATION_RUNTIME_NOT_STOPPED');
     if(f.execution?.state==='VERIFYING'&&f.candidateMode==='VERIFYING'&&!f.cutover&&!f.c3)result={state:'VERIFYING',replay:true};
     else result=await restorePreparedCandidate({...args,transition:deps.executionTransition,testHooks:hooks.restore??{}});
    }else if(action==='verify-candidate'){
     if(!stopped(cache)||f.cutover||f.c3)throw fail('PRODUCTION_ORCHESTRATION_STAGE_CONFLICT');
     result=f.c1?.cutoverEligible?{cutoverEligible:true,replay:true}:await verifyPreparedCandidate({...args,persist:deps.persistEvidence,testHooks:hooks.verify??{}});
     if(!result.cutoverEligible)throw fail('PRODUCTION_ORCHESTRATION_C1_BLOCKED');
    }else if(action==='cutover'){
     if(f.c3||!f.c1?.cutoverEligible)throw fail('PRODUCTION_ORCHESTRATION_C1_BLOCKED');
     await bridge.shutdown();await check();
     if(!await hasCheckpoint()){
      const challenge='CUTOVER '+f.plan.recoveryOperationId.slice(0,8)+' '+f.plan.planDigest.slice(-12);
      if(typeof confirm!=='function'||await confirm({challenge,summary:{recoveryOperationId:f.plan.recoveryOperationId,planDigest:f.plan.planDigest,targetDatabase:f.plan.targetDatabase,backupCreatedAt:f.plan.backupCreatedAt,lossWindow:f.plan.lossWindow}})!==challenge)throw fail('PRODUCTION_ORCHESTRATION_CHECKPOINT_REQUIRED');
      await check();await refresh();if(!stopped(cache))throw fail('PRODUCTION_ORCHESTRATION_RUNTIME_NOT_STOPPED');await audit(action,'CHECKPOINT');
     }
     result=await switchOwnedCandidatePointer({...args,transition:deps.cutoverTransition,managedRuntime:bridge,beforePointer:async()=>{await check();await refresh();if(!stopped(cache))throw fail('PRODUCTION_ORCHESTRATION_RUNTIME_NOT_STOPPED');await hooks.beforePointer?.();},pointerOptions:hooks.pointerOptions??{}});
    }else if(action==='prepare-resume'){
     if(!stopped(cache))throw fail('PRODUCTION_ORCHESTRATION_RUNTIME_NOT_STOPPED');
     result=await prepareOwnedCandidateResume({...args,transition:deps.c3Transition,managedRuntime:bridge,testHooks:hooks.prepare??{}});
    }else{
     if(f.c3?.state!=='RESUMED'){
      if(!stopped(cache))throw fail('PRODUCTION_ORCHESTRATION_RUNTIME_NOT_STOPPED');
      result=await resumeOwnedCandidate({...args,transition:deps.c3Transition,managedRuntime:bridge,testHooks:hooks.resume??{}});
     }else result={state:'RESUMED',replay:true};
     f=await check();await assertNormalStartupAllowed(startupReadContext(f.loaded,f.plan));
     await service.start();await terminal(await check(),await refresh());
    }
    return result;
   });
   if(action==='resume'){await authorization.admit(token,async revalidate=>{await revalidate();await terminal(await fresh(),await refresh());});await authorization.consume();}
   await audit(action,'PASS');await hooks.afterStage?.(action,result);
   return {...result,authorityRealm:'OWNED_REHEARSAL',realProductionTokenRun:'NOT_EXECUTED'};
  }catch(error){try{await audit(action,'BLOCKED',orchestrationError(error));}catch{error.auditUnavailable=true;}throw error;}
 }
 const session=Object.freeze({});sessions.set(session,{run,inspect,realm:'OWNED_REHEARSAL'});return session;
}
