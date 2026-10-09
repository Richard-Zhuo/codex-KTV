import {reportInvariant} from '../operations/signals.js';
import { readExternalSecret } from '../production/secret-file.js';import { freezeDatabase,verifyRecovery,resumeRecovery,inspectRecovery } from './operator.js';import { fail } from '../backup/format.js';import { resolve } from 'node:path';import { fileURLToPath } from 'node:url';
export async function runRecoveryCli(argv=process.argv.slice(2),logger=console){
 let operationalDirectory;
 try{const [action,...rest]=argv,run=new Map([['freeze',freezeDatabase],['inspect',inspectRecovery],['verify',verifyRecovery],['resume',resumeRecovery]]).get(action);if(!run)throw fail('RECOVERY_ARGUMENTS_INVALID');const options={};
  for(let i=0;i<rest.length;i++){const k=rest[i];if(!['--config-file','--artifact-dir','--checksum','--confirm'].includes(k)||options[k]||!rest[i+1])throw fail('RECOVERY_ARGUMENTS_INVALID');options[k]=rest[++i];}
  const config=await readExternalSecret(options['--config-file']);if(Object.keys(config).some(k=>!['databaseUrl','environment','storeId','ledgerId','serverUuid','initiatedBy','operationalDirectory'].includes(k)))throw fail('RECOVERY_CONFIG_INVALID');
  operationalDirectory=config.operationalDirectory;
  const result=await run({...config,directory:options['--artifact-dir'],expectedChecksum:options['--checksum'],confirmation:options['--confirm']});
  if(operationalDirectory&&(action==='inspect'||action==='verify'))await reportInvariant(operationalDirectory,result.ready===false||result.report?.ready===false).catch(()=>logger.error(JSON.stringify({code:'MONITORING_FAILURE'})));
  logger.log(JSON.stringify(result));return 0;
 }catch(e){if(operationalDirectory&&['RECOVERY_INVARIANT_FAILED','RECOVERY_RESTORED_DATA_MISMATCH','RECOVERY_CHANGED_AFTER_VERIFICATION'].includes(e.code))await reportInvariant(operationalDirectory,true).catch(()=>logger.error(JSON.stringify({code:'MONITORING_FAILURE'})));logger.error(JSON.stringify({code:/^(RECOVERY|BACKUP)_[A-Z_]+$/.test(e.code??'')?e.code:'RECOVERY_OPERATION_FAILED'}));return 1;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runRecoveryCli();
