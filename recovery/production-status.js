import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {readProductionOrchestrationFacts,productionAuthorizationObservationContext,startupReadContext} from './orchestration-facts.js';
import {readAuthorizationObservation} from './production-authorization.js';
import {createRecoveryServiceAdapter} from '../production/recovery-service.js';
import {assertNormalStartupAllowed} from './production-cutover-journal.js';
import {orchestrationError} from './production-orchestration.js';
export async function inspectProductionRestoreStatus(runtimeConfigFile){
 try{
  const first=await readProductionOrchestrationFacts(runtimeConfigFile),a=await readAuthorizationObservation(await productionAuthorizationObservationContext(first));
  const root=fileURLToPath(new URL('../',import.meta.url));
  const adapter=createRecoveryServiceAdapter({serviceName:'JbhhKtv',hostExecutable:join(root,'deployment','KtvServiceHost.exe'),nodeExecutable:process.execPath,entryFile:join(root,'production','start.js'),configFile:runtimeConfigFile,serviceSid:first.loaded.config.serviceAccountSid});
  const service=await adapter.status(),last=await readProductionOrchestrationFacts(runtimeConfigFile),b=await readAuthorizationObservation(await productionAuthorizationObservationContext(last));
  if(first.observationDigest!==last.observationDigest||a.revision!==b.revision)return {status:'UNKNOWN',code:'PRODUCTION_ORCHESTRATION_OBSERVATION_CHANGED',writes:'NO',authorityIssued:'NO'};
  let status=last.c3?.state??last.cutover?.state??last.execution?.state??'PREPARED';
  if(last.execution&&last.c3?.state!=='RESUMED'&&service.phase!=='STOPPED')status='UNKNOWN';
  if(last.c3?.state==='RESUMED'){
   await assertNormalStartupAllowed(startupReadContext(last.loaded,last.plan));
   status=b.active?.state==='CONSUMED'&&service.phase==='RUNNING'&&service.normalWriterCount===1?'TERMINAL_SUCCESS':'UNKNOWN';
  }
  return {status,authorization:b.active?.state??'MISSING',plan:'PREPARED',execution:last.execution?.state??null,source:last.sourceMode,candidate:last.candidateMode,pointer:last.pointer.name,c1:last.c1?.cutoverEligible?'PASS':'NOT_CURRENT',c2:last.cutover?.state??null,c3:last.c3?.state??null,service:service.phase,writes:'NO',authorityIssued:'NO'};
 }catch(error){return {status:'UNKNOWN',code:orchestrationError(error),writes:'NO',authorityIssued:'NO'};}
}
