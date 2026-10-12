import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectProductionRestore,createProductionRestorePlan,
  inspectProductionRestorePlan,safeError} from './production-plan.js';
const fail=code=>Object.assign(Error(code),{code});
export function parseProductionRestoreArgs(argv){
 const [action,...rest]=argv;
 if(['freeze-plan','restore-candidate','inspect-candidate'].includes(action))
  throw fail('RESTORE_PRODUCTION_DISABLED');
 if(!['inspect','create-plan','inspect-plan'].includes(action))
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
 const expected=action==='inspect-plan'?['--config-file']:
   ['--config-file','--artifact-dir','--checksum'];
 if(Object.keys(values).length!==expected.length||expected.some(k=>!Object.hasOwn(values,k)))
  throw fail('PRODUCTION_RESTORE_ARGUMENTS_INVALID');
 return {action,runtimeConfigFile:values['--config-file'],
  artifactDirectory:values['--artifact-dir'],expectedChecksum:values['--checksum']};
}
export async function runProductionRestoreCli(argv=process.argv.slice(2),{
 inspect=inspectProductionRestore,createPlan=createProductionRestorePlan,
 inspectPlan=inspectProductionRestorePlan,stdout=process.stdout,stderr=process.stderr}={}){
 try{
  const {action,...args}=parseProductionRestoreArgs(argv);
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
  stderr.write(JSON.stringify(error?.safe??{eligible:'NO',code:safeError(error)})+'\n');
  return 1;
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
 process.exitCode=await runProductionRestoreCli();
