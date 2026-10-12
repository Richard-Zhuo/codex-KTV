import mysql from 'mysql2/promise';
import {join} from 'node:path';
import {canonical,digest,fail,verifyArtifact} from '../backup/format.js';
import {validateSchema} from '../production/schema.js';
import {readProtectedRestorePlan,checkedPaths} from './production-plan.js';
import {readExecutionState} from './production-journal.js';
import {readCutoverState,transitionCutoverState} from './production-cutover-journal.js';
import {readC1Evidence} from './c1-evidence.js';
import {withOwnedCandidateRead} from './production-candidate.js';
import {requireControl,server,alerts,snapshot,artifactMatches} from './production-c1.js';
import {updateProtectedDatabasePointer} from '../production/cutover-pointer.js';

const targetUrl=(base,name)=>{const url=new URL(base);url.pathname='/'+name;return url.href;};
const stateIsStopped=state=>state?.phase==='STOPPED'&&state.workerStopped===true&&
 state.operationalStopped===true&&state.connectionsClosed===true&&state.normalWriterCount===0;

// No production entry calls this core. The private owned-fixture capability is verified
// before any protected file or database access, and all DB sessions remain read-only.
export async function switchOwnedCandidatePointer({runtimeConfigFile,capability,managedRuntime,
 readPlan=readProtectedRestorePlan,readState=readExecutionState,
 readCutover=readCutoverState,transition=transitionCutoverState,
 readEvidence=readC1Evidence,pathCheck=checkedPaths,verify=verifyArtifact,
 readAlerts=alerts,updatePointer=updateProtectedDatabasePointer,
 journalOptions={},evidenceOptions={},pointerOptions={},
 beforePointer,...dependencies}){
 return withOwnedCandidateRead(capability,async source=>{
  const facts=async()=>{
   const {loaded,plan,journal}=await readPlan({runtimeConfigFile,pathCheck,...dependencies});
   if(plan.formatVersion!==2||plan.currentDatabase!==capability.database||
      plan.targetServerUuid!==capability.serverUuid||plan.targetPort!==capability.port||
      loaded.config.storeId!==plan.storeId||loaded.config.ledgerId!==plan.ledgerId||
      loaded.config.applicationCommit!==plan.applicationCommit)
    throw fail('PRODUCTION_CUTOVER_IDENTITY_MISMATCH');
   const runtimeUrl=new URL(loaded.apiEnv.KTV_MYSQL_URL),
    pointer=decodeURIComponent(runtimeUrl.pathname.slice(1));
   if(runtimeUrl.hostname!==plan.currentHost||Number(runtimeUrl.port||3306)!==plan.currentPort||
      ![plan.currentDatabase,plan.targetDatabase].includes(pointer))
    throw fail('PRODUCTION_CUTOVER_POINTER_CONFLICT');
   if((await readState(journal,plan))?.state!=='VERIFYING')
    throw fail('PRODUCTION_CUTOVER_IDENTITY_MISMATCH');
   const cutover=await readCutover(journal,plan,journalOptions);
   if(pointer===plan.targetDatabase&&!cutover)
    throw fail('PRODUCTION_CUTOVER_POINTER_CONFLICT');
   if(cutover?.state==='CUTOVER_SWITCHED'&&pointer!==plan.targetDatabase)
    throw fail('PRODUCTION_CUTOVER_POINTER_CONFLICT');
   const roots=await pathCheck(loaded,null,dependencies),
    artifactDirectory=join(roots.backup,plan.backupLocator);
   await pathCheck(loaded,artifactDirectory,dependencies);
   const artifact=await verify(artifactDirectory,{expectedChecksum:plan.backupSha256,
    storeId:plan.storeId,ledgerId:plan.ledgerId});
   artifactMatches(plan,artifact);
   await server(source,plan.currentDatabase,plan);
   let candidate;
   try{
    candidate=await mysql.createConnection({uri:targetUrl(capability.url,plan.targetDatabase),
     dateStrings:true,jsonStrings:true,supportBigNumbers:true,bigNumberStrings:true});
    await candidate.query('SET SESSION TRANSACTION READ ONLY');
    await server(candidate,plan.targetDatabase,plan);
    await validateSchema(candidate,plan.targetDatabase);
    const snap=await snapshot(source,candidate,artifact.spec);
    requireControl(snap.oldControl,plan,'FROZEN','plan-bound-recovery-freeze');
    requireControl(snap.candidateControl,plan,'VERIFYING','plan-bound-candidate-restore');
    const outbox=await readAlerts(loaded),alertDigest=digest(canonical({outbox}));
    const evidence=await readEvidence(journal,plan,{
     oldDigest:snap.oldDigest,candidateDigest:snap.candidateDigest,
     alertDigest,journalState:'VERIFYING'},evidenceOptions);
    if(!evidence?.cutoverEligible)
     throw fail('PRODUCTION_CUTOVER_C1_EVIDENCE_STALE');
    return {loaded,plan,journal,pointer,cutover,
     oldDigest:snap.oldDigest,candidateDigest:snap.candidateDigest,alertDigest};
   }finally{await candidate?.end();}
  };
  const first=await facts();
  if(first.cutover?.state==='CUTOVER_INTENT'&&
     ![first.plan.currentDatabase,first.plan.targetDatabase].includes(first.pointer))
   throw fail('PRODUCTION_CUTOVER_POINTER_CONFLICT');
  if(!managedRuntime||typeof managedRuntime.shutdown!=='function'||
     typeof managedRuntime.status!=='function')
   throw fail('PRODUCTION_CUTOVER_RUNTIME_NOT_STOPPED');
  if(!stateIsStopped(managedRuntime.status())){
   if(await managedRuntime.shutdown('RECOVERY_CUTOVER')!==true)
    throw fail('PRODUCTION_CUTOVER_RUNTIME_NOT_STOPPED');
  }
  if(!stateIsStopped(managedRuntime.status()))
   throw fail('PRODUCTION_CUTOVER_RUNTIME_NOT_STOPPED');
  const current=await facts();
  if(current.journal!==first.journal||canonical(current.plan)!==canonical(first.plan)||
     current.oldDigest!==first.oldDigest||
     current.candidateDigest!==first.candidateDigest||
     current.alertDigest!==first.alertDigest||
     current.pointer!==first.pointer||
     !stateIsStopped(managedRuntime.status()))
   throw fail('PRODUCTION_CUTOVER_PRECONDITION_CHANGED');
  if(current.cutover?.state==='CUTOVER_SWITCHED')
   return {state:'CUTOVER_SWITCHED',replay:true,oldState:'FROZEN',
    candidateState:'VERIFYING',runtime:'STOPPED',normalWriterCount:0};
  if(!current.cutover)
   await transition(current.journal,current.plan,null,'CUTOVER_INTENT',journalOptions);
  // The persisted intent precedes the only pointer mutation. A crash can leave
  // intent + old, or intent + candidate; neither state enables normal startup.
  if(current.pointer===current.plan.currentDatabase){
   await beforePointer?.();
   if(!stateIsStopped(managedRuntime.status()))
    throw fail('PRODUCTION_CUTOVER_RUNTIME_NOT_STOPPED');
   const checked=await facts();
   if(checked.pointer!==current.plan.currentDatabase||
      canonical(checked.plan)!==canonical(current.plan)||
      checked.oldDigest!==current.oldDigest||
      checked.candidateDigest!==current.candidateDigest||
      checked.alertDigest!==current.alertDigest)
    throw fail('PRODUCTION_CUTOVER_PRECONDITION_CHANGED');
   await updatePointer(checked.loaded,checked.plan,pointerOptions);
  }
  const switched=await facts();
  if(switched.pointer!==current.plan.targetDatabase||
     canonical(switched.plan)!==canonical(current.plan)||
     switched.oldDigest!==current.oldDigest||
     switched.candidateDigest!==current.candidateDigest||
     switched.alertDigest!==current.alertDigest||
     switched.cutover?.state!=='CUTOVER_INTENT'||
     !stateIsStopped(managedRuntime.status()))
   throw fail('PRODUCTION_CUTOVER_PRECONDITION_CHANGED');
  await transition(switched.journal,switched.plan,'CUTOVER_INTENT','CUTOVER_SWITCHED',journalOptions);
  const final=await facts();
  if(final.cutover?.state!=='CUTOVER_SWITCHED'||
     final.pointer!==final.plan.targetDatabase||!stateIsStopped(managedRuntime.status()))
   throw fail('PRODUCTION_CUTOVER_PRECONDITION_CHANGED');
  return {state:'CUTOVER_SWITCHED',replay:false,oldState:'FROZEN',
   candidateState:'VERIFYING',runtime:'STOPPED',normalWriterCount:0};
 });
}
