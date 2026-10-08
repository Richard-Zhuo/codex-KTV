import { readExternalSecret } from '../production/secret-file.js';import { freezeDatabase,verifyRecovery,resumeRecovery,inspectRecovery } from './operator.js';import { fail } from '../backup/format.js';import { resolve } from 'node:path';import { fileURLToPath } from 'node:url';
export async function runRecoveryCli(argv=process.argv.slice(2),logger=console){
 try{const [action,...rest]=argv,run={freeze:freezeDatabase,inspect:inspectRecovery,verify:verifyRecovery,resume:resumeRecovery}[action];if(!run)throw fail('RECOVERY_ARGUMENTS_INVALID');const options={};
  for(let i=0;i<rest.length;i++){const k=rest[i];if(!['--config-file','--artifact-dir','--checksum','--confirm'].includes(k)||options[k]||!rest[i+1])throw fail('RECOVERY_ARGUMENTS_INVALID');options[k]=rest[++i];}
  const config=await readExternalSecret(options['--config-file']);if(Object.keys(config).some(k=>!['databaseUrl','environment','storeId','ledgerId','serverUuid','initiatedBy'].includes(k)))throw fail('RECOVERY_CONFIG_INVALID');
  logger.log(JSON.stringify(await run({...config,directory:options['--artifact-dir'],expectedChecksum:options['--checksum'],confirmation:options['--confirm']})));return 0;
 }catch(e){logger.error(JSON.stringify({code:/^(RECOVERY|BACKUP)_[A-Z_]+$/.test(e.code??'')?e.code:'RECOVERY_OPERATION_FAILED'}));return 1;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runRecoveryCli();
