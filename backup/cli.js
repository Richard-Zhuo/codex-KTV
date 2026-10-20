import {backupEncryptionPolicy,assertSyntheticBackupEncryption} from './encryption-policy.js';
import {reportBackup} from '../operations/backup-report.js';
import { readExternalSecret } from '../production/secret-file.js';
import { backupDatabase,restoreDatabase } from './mysql-backup.js';
import { fail } from './format.js';
import {readBackupIdentity} from '../production/backup-identity.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export async function runBackupCli(argv=process.argv.slice(2),env=process.env,logger=console,{keyProvider}={}) {
  let operationalDirectory,backupAction=false;
  try {
    const [action,...rest]=argv;backupAction=action==='backup';if(!['backup','restore'].includes(action))throw fail('BACKUP_ARGUMENTS_INVALID');
    const options={};
    for(let i=0;i<rest.length;i++) {
      const k=rest[i];if(k==='--restore-to-new-db'){options.restoreToNewDb=true;continue;}
      if(!['--config-file','--output-dir','--artifact-dir','--checksum','--confirm'].includes(k)||options[k]||!rest[i+1]||rest[i+1].startsWith('--'))throw fail('BACKUP_ARGUMENTS_INVALID');options[k]=rest[++i];
    }
    const config=await readExternalSecret(options['--config-file']);
    const allowed=['databaseUrl','environment','storeId','ledgerId','serverUuid','initiatedBy','operationalDirectory',...(backupAction?['runtimeConfigFile','releaseArtifactFile','releaseArtifactChecksum','encryption']:[])];
    if(!config||Object.keys(config).some(k=>!allowed.includes(k)))throw fail('BACKUP_CONFIG_INVALID');
    const encryption=backupAction?backupEncryptionPolicy(config.encryption):{enabled:false};
    operationalDirectory=config.operationalDirectory;
    const applicationCommit=backupAction?await readBackupIdentity({configFile:options['--config-file'],config,env}):undefined;
    operationalDirectory=config.operationalDirectory;
    const args={...config,env,confirmation:options['--confirm']};
    let result;
    if(backupAction){
      const input={...args,outputDirectory:options['--output-dir'],applicationCommit};
      if(encryption.enabled){
        assertSyntheticBackupEncryption(input);
        const {createConfiguredBackup}=await import('./encrypted-pipeline.js');
        result=await createConfiguredBackup(input,{encryption:config.encryption,keyProvider});
      }else result=await backupDatabase(input);
    }else result=await restoreDatabase({...args,directory:options['--artifact-dir'],expectedChecksum:options['--checksum'],restoreToNewDb:options.restoreToNewDb===true});
    if(backupAction&&operationalDirectory)await reportBackup(operationalDirectory,{success:encryption.enabled?result.complete:true,createdAt:result.createdAt});
    logger.log(JSON.stringify(result));return encryption.enabled&&!result.complete?1:0;
  }catch(e){if(backupAction&&operationalDirectory)await reportBackup(operationalDirectory,{success:false}).catch(()=>logger.error(JSON.stringify({code:'BACKUP_REPORT_FAILED'})));logger.error(JSON.stringify({code:/^(BACKUP|RESTORE)_[A-Z_]+$/.test(e.code??'')?e.code:'BACKUP_OPERATION_FAILED'}));return 1;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runBackupCli();
