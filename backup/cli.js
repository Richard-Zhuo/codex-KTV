import {reportBackup} from '../operations/backup-report.js';
import { readExternalSecret } from '../production/secret-file.js';
import { backupDatabase,restoreDatabase } from './mysql-backup.js';
import { fail } from './format.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export async function runBackupCli(argv=process.argv.slice(2),env=process.env,logger=console) {
  let operationalDirectory,backupAction=false;
  try {
    const [action,...rest]=argv;backupAction=action==='backup';if(!['backup','restore'].includes(action))throw fail('BACKUP_ARGUMENTS_INVALID');
    const options={};
    for(let i=0;i<rest.length;i++) {
      const k=rest[i];if(k==='--restore-to-new-db'){options.restoreToNewDb=true;continue;}
      if(!['--config-file','--output-dir','--artifact-dir','--checksum','--confirm'].includes(k)||options[k]||!rest[i+1]||rest[i+1].startsWith('--'))throw fail('BACKUP_ARGUMENTS_INVALID');options[k]=rest[++i];
    }
    const config=await readExternalSecret(options['--config-file']);
    const allowed=['databaseUrl','environment','storeId','ledgerId','serverUuid','initiatedBy','operationalDirectory'];
    if(!config||Object.keys(config).some(k=>!allowed.includes(k)))throw fail('BACKUP_CONFIG_INVALID');
    operationalDirectory=config.operationalDirectory;
    const args={...config,env,confirmation:options['--confirm']};
    const result=action==='backup'?await backupDatabase({...args,outputDirectory:options['--output-dir'],applicationCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:fileURLToPath(new URL('../',import.meta.url)),encoding:'utf8'}).trim()}):await restoreDatabase({...args,directory:options['--artifact-dir'],expectedChecksum:options['--checksum'],restoreToNewDb:options.restoreToNewDb===true});
    if(backupAction&&operationalDirectory)await reportBackup(operationalDirectory,{success:true,createdAt:result.createdAt});
    logger.log(JSON.stringify(result));return 0;
  }catch(e){if(backupAction&&operationalDirectory)await reportBackup(operationalDirectory,{success:false}).catch(()=>logger.error(JSON.stringify({code:'BACKUP_REPORT_FAILED'})));logger.error(JSON.stringify({code:/^(BACKUP|RESTORE)_[A-Z_]+$/.test(e.code??'')?e.code:'BACKUP_OPERATION_FAILED'}));return 1;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runBackupCli();
