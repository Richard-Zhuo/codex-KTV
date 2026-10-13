import {relative,isAbsolute} from 'node:path';
import {RECOVERY_POLICY_FILE} from './production-authorization-context.js';
import {withOwnedCandidateRead} from './production-candidate.js';
import {createRuntimeReaderCore} from './runtime-reader-core.js';
export {parseRecoveryDatabaseCredential,validateRecoveryPointer} from './runtime-reader-core.js';
const fail=code=>Object.assign(Error(code),{code});
// Production has no policy/fixture/environment selector. Extra caller options are not consumed.
const production=()=>createRuntimeReaderCore({policyPath:RECOVERY_POLICY_FILE});
export const readRuntimeDeploymentForRecovery=path=>production().deployment(path);
export const readRuntimeDatabasePointerForRecovery=path=>production().pointer(path);
export const loadRecoveryDeployment=path=>production().load(path);
export const checkRecoveryRuntimeFile=(configPath,path)=>production().checkStrictFile(configPath,path);
export const checkRecoveryPointerStage=(path,plan)=>production().checkStage(path,plan);
// OS substitution exists only after the existing disposable MySQL capability proves ownership.
export async function withOwnedRecoveryReader(capability,options,work){
 const owned=await withOwnedCandidateRead(capability,async()=>{
  const scope=async path=>{const rel=relative(capability.root,path);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw fail('AUTHORIZATION_TEST_SCOPE_DENIED');};
  return createRuntimeReaderCore({...options,scope});
 });
 return work(owned);
}
