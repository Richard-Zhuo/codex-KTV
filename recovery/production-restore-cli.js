import {requireOrchestrationSession,ORCHESTRATION_STAGES,orchestrationError} from './production-orchestration.js';
import {createInterface} from 'node:readline/promises';
import {authorizeProductionRestore,inspectProductionAuthorization,revokeProductionAuthorization} from './production-authorization.js';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectProductionRestore,createProductionRestorePlan,
  inspectProductionRestorePlan,safeError} from './production-plan.js';
const fail=code=>Object.assign(Error(code),{code});
function parseArgs(argv,owned=false){
 const [action,...rest]=argv;
 if(!owned&&['freeze-plan','restore-candidate','inspect-candidate','verify-candidate','cutover','prepare-resume','resume'].includes(action))
  throw fail('RESTORE_PRODUCTION_DISABLED');
 if(!['inspect','create-plan','inspect-plan','authorize','reauthorize','inspect-authorization','revoke-authorization','inspect-status',...(owned?ORCHESTRATION_STAGES:[])].includes(action))
  throw fail('PRODUCTION_RESTORE_ARGUMENTS_INVALID');
 const values={};
 for(let i=0;i<rest.length;i+=2){
  const key=rest[i],value=rest[i+1];
  if(key==='--operation-id')throw fail('PRODUCTION_RESTORE_OPERATION_ID_OPERATOR_FORBIDDEN');
  if(!['--config-file','--artifact-dir','--checksum'].includes(key)||
    !value||value.startsWith('--')||Object.hasOwn(values,key))
   throw fail('PRODUCTION_RESTORE_ARGUMENTS_INVALID');
  values[key]=value;
 }
 const expected=['inspect-plan','authorize','reauthorize','inspect-authorization','revoke-authorization','inspect-status',...ORCHESTRATION_STAGES].includes(action)?['--config-file']:
   ['--config-file','--artifact-dir','--checksum'];
 if(Object.keys(values).length!==expected.length||expected.some(k=>!Object.hasOwn(values,k)))
  throw fail('PRODUCTION_RESTORE_ARGUMENTS_INVALID');
 return {action,runtimeConfigFile:values['--config-file'],
  artifactDirectory:values['--artifact-dir'],expectedChecksum:values['--checksum']};
}
export function parseProductionRestoreArgs(argv){return parseArgs(argv);}
async function humanConfirmation({challenge,summary}){
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw fail('AUTHORIZATION_INTERACTIVE_CONFIRMATION_REQUIRED');
 process.stdout.write(JSON.stringify({confirmation:challenge,...summary})+'\n');
 const input=createInterface({input:process.stdin,output:process.stdout});
 try{return (await input.question('Confirm current recovery plan: ')).trim();}
 finally{input.close();}
}
export async function runProductionRestoreCli(argv=process.argv.slice(2),{
 inspect=inspectProductionRestore,createPlan=createProductionRestorePlan,
 inspectPlan=inspectProductionRestorePlan,stdout=process.stdout,stderr=process.stderr,orchestration,confirm=humanConfirmation}={}){
 try{
  const executor=orchestration===undefined?null:requireOrchestrationSession(orchestration);
  const {action,...args}=parseArgs(argv,Boolean(executor));
  if(executor){
   const result=await executor.run(action,{...args,confirm});stdout.write(JSON.stringify(result)+'\n');
   return ['UNKNOWN','BLOCKED'].includes(result.status)?1:0;
  }
  if(action==='inspect-status'){
   const {inspectProductionRestoreStatus}=await import('./production-status.js');
   const result=await inspectProductionRestoreStatus(args.runtimeConfigFile);stdout.write(JSON.stringify(result)+'\n');return result.status==='UNKNOWN'?1:0;
  }
  if(['authorize','reauthorize','inspect-authorization','revoke-authorization'].includes(action)){
   const result=action==='inspect-authorization'?await inspectProductionAuthorization(args.runtimeConfigFile):
    action==='revoke-authorization'?await revokeProductionAuthorization(args.runtimeConfigFile):
    await authorizeProductionRestore(args.runtimeConfigFile,{confirm:humanConfirmation,reauthorize:action==='reauthorize'});
   stdout.write(JSON.stringify(result)+'\n');return 0;
  }
  const result=action==='inspect'?await inspect(args):action==='create-plan'?
   await createPlan(args):await inspectPlan(args);
  stdout.write(JSON.stringify(action==='inspect'?{
   eligible:'YES',backupId:result.backupId,backupCreatedAt:result.backupCreatedAt,
   backupAgeSeconds:result.backupAgeSeconds,backupRevision:result.backupRevision,
   currentRevision:result.currentRevision,lossWindow:result.lossWindow,
   storeId:result.storeId,ledgerId:result.ledgerId,
   CURRENT_PRODUCTION_DB_READABLE:'YES',
   DB_WRITES:'NO',JOURNAL_WRITES:'NO'
  }:result)+'\n');
  return 0;
 }catch(error){
  stderr.write(JSON.stringify(error?.safe??{eligible:'NO',code:orchestrationError(error)})+'\n');
  return 1;
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
 process.exitCode=await runProductionRestoreCli();
