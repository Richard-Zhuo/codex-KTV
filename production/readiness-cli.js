import mysql from 'mysql2/promise';
import {readExternalSecret} from './secret-file.js';
import {validateProductionConfig} from './config.js';
import {readProductionReadiness} from './readiness.js';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export async function runReadinessCli(argv=process.argv.slice(2),output=console) {
  let pool;
  try{
    if(argv.length!==2||argv[0]!=='--config-file')throw Error();
    const env=await readExternalSecret(argv[1]),config=validateProductionConfig(env);
    pool=mysql.createPool({uri:env.KTV_MYSQL_URL,connectionLimit:2,supportBigNumbers:true,bigNumberStrings:true});
    const report=await readProductionReadiness({pool,config,credentialFile:env.KTVSKY_CREDENTIALS_FILE});
    output.log(JSON.stringify(report));return report.ready?0:2;
  }catch{output.error(JSON.stringify({code:'PRODUCTION_READINESS_FAILED'}));return 1;}
  finally{if(pool)await pool.end();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runReadinessCli();
