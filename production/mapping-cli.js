import mysql from 'mysql2/promise';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {validateTarget,refused} from './plan.js';
import {readExternalSecret} from './secret-file.js';
import {bootstrapMappings,validateMappingPlan} from './mapping.js';
export async function runMappingCli(argv=process.argv.slice(2),env=process.env,output=console) {
  let pool;
  try {
    const options={},allowed=['--plan','--secrets-file','--confirm-target','--initiated-by'];
    for(let i=0;i<argv.length;i++) {
      const key=argv[i];
      if(key==='--dry-run'||key==='--apply'){if(options.mode)throw refused('BOOTSTRAP_INVALID_ARGUMENTS');options.mode=key;continue;}
      if(!allowed.includes(key)||Object.hasOwn(options,key)||!argv[i+1]||argv[i+1].startsWith('--'))throw refused('BOOTSTRAP_INVALID_ARGUMENTS');
      options[key]=argv[++i];
    }
    const plan=validateMappingPlan(JSON.parse(await readFile(options['--plan'],'utf8'))),secret=await readExternalSecret(options['--secrets-file']);
    validateTarget(plan,secret.databaseUrl,options['--confirm-target'],env);
    pool=mysql.createPool({uri:secret.databaseUrl,connectionLimit:1});
    output.log(JSON.stringify(await bootstrapMappings({pool,plan,databaseUrl:secret.databaseUrl,confirmation:options['--confirm-target'],initiatedBy:options['--initiated-by'],dryRun:options.mode!=='--apply',env})));return 0;
  }catch(error){output.error(JSON.stringify({code:/^BOOTSTRAP_[A-Z_]+$/.test(error?.code??'')?error.code:'BOOTSTRAP_FAILED'}));return 1;}
  finally{if(pool)await pool.end();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runMappingCli();
