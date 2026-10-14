import {join,relative,isAbsolute} from 'node:path';import {fileURLToPath} from 'node:url';
import {readProductionOrchestrationFacts} from './orchestration-facts.js';import {createRecoveryServiceAdapter} from '../production/recovery-service.js';import {createActivationReceiptStore} from '../production/activation-receipt.js';import {observeListener} from '../production/process-observation.js';import {observeActivation} from '../production/activation-observation.js';import {verifyActivationCore,expectedActivation} from '../production/activation-verifier-core.js';import {observeOwnedCandidate} from './production-candidate.js';
const owned=new WeakMap();const denied=()=>Object.assign(Error('AUTHORIZATION_AUTHORITY_FORGED'),{code:'AUTHORIZATION_AUTHORITY_FORGED'});
export function productionServiceExpected(configFile,loaded){const root=fileURLToPath(new URL('../',import.meta.url));return {serviceName:'JbhhKtv',hostExecutable:join(root,'deployment','KtvServiceHost.exe'),nodeExecutable:process.execPath,entryFile:join(root,'production','start.js'),configFile,serviceSid:loaded.config.serviceAccountSid};}
// Formal entry takes only a config selector. All policy, identity, OS, ACL and HTTPS facts are read here.
export async function verifyProductionRuntimeActivation(configFile){try{
 const f=await readProductionOrchestrationFacts(configFile),service=createRecoveryServiceAdapter(productionServiceExpected(configFile,f.loaded));
 const verdict=await verifyActivationCore(expectedActivation(f),{scm:service.status,receipt:createActivationReceiptStore(f.loaded).read,
  listener:async pid=>{const endpoint=await observeListener(f.loaded.config.port,pid);const host=f.loaded.config.listenHost;if(host==='localhost'?!['127.0.0.1','::1'].includes(endpoint.host):endpoint.host!==host)throw denied();return endpoint;},
  observe:(socket,challenge)=>observeActivation(f.loaded.config,socket,challenge)});
 const last=await readProductionOrchestrationFacts(configFile);return verdict==='ACTIVE'&&last.observationDigest===f.observationDigest?'ACTIVE':'NOT_PROVEN';
}catch{return 'NOT_PROVEN';}}
// Owned OS substitution is issued only after the private owned MySQL capability proves scope.
export async function createOwnedActivationVerifier(capability,{loaded,scm,listener,observe}){
 await observeOwnedCandidate(capability,async()=>{});const rel=relative(capability.root,loaded.config.logDirectory);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw denied();
 const token=Object.freeze({});owned.set(token,{capability,verify:async f=>{await observeOwnedCandidate(capability,async()=>{});return verifyActivationCore(expectedActivation(f),{scm,receipt:createActivationReceiptStore(loaded).read,listener,observe});}});return token;
}
export function requireOwnedActivationVerifier(token,capability){const value=owned.get(token);if(!value||value.capability!==capability)throw denied();return value.verify;}
