import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validateRuntimeConfig, privateHost } from './runtime-config.js';
import { readExternalSecret } from './secret-file.js';
import { validateFirstInstallPlan, inspectFirstInstall, applyInitialLedger, applyOpeningInventory } from './first-install.js';
import { refused } from './plan.js';

function optionsFrom(argv) {
  const options={},valued=new Set(['--plan','--config-file','--actor-secrets-file','--confirm-target','--initiated-by']);
  for(let i=0;i<argv.length;i++) {
    const key=argv[i];
    if(key==='--dry-run'||key==='--apply') {
      if(options.mode)throw refused('S1_ARGUMENTS_INVALID');
      options.mode=key;continue;
    }
    if(!valued.has(key)||Object.hasOwn(options,key)||!argv[i+1]||argv[i+1].startsWith('--'))throw refused('S1_ARGUMENTS_INVALID');
    options[key]=argv[++i];
  }
  if(!options['--plan']||!options['--config-file']||!options.mode ||
     (options.mode==='--apply'&&(!options['--confirm-target']||!options['--initiated-by'])))throw refused('S1_ARGUMENTS_INVALID');
  return options;
}
function databaseFrom(secrets) {
  const db=secrets?.database;
  if(!db || typeof db!=='object' || Array.isArray(db) || !privateHost(db.host) ||
     !Number.isInteger(db.port)||db.port<1||db.port>65535 ||
     typeof db.name!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(db.name) ||
     typeof db.user!=='string'||!db.user || typeof db.password!=='string'||db.password.length<16 ||
     (!['localhost','127.0.0.1','::1'].includes(db.host)&&typeof db.ca!=='string'))throw refused('S1_DATABASE_CONFIG_INVALID');
  const url=new URL('mysql://localhost');
  url.hostname=db.host;url.port=String(db.port);url.username=db.user;url.password=db.password;url.pathname='/'+db.name;
  return {databaseUrl:url.href,ssl:db.ca?{ca:db.ca,rejectUnauthorized:true}:undefined,database:db.name};
}
export async function runFirstInstallCli(argv=process.argv.slice(2),env=process.env,output=console) {
  let pool;
  try {
    const options=optionsFrom(argv);
    const plan=validateFirstInstallPlan(JSON.parse(await readFile(options['--plan'],'utf8')));
    if(plan.environment!=='production')throw refused('S1_PRODUCTION_ONLY');
    const runtime=validateRuntimeConfig(await readExternalSecret(options['--config-file']),env);
    const db=databaseFrom(await readExternalSecret(runtime.secretsFile));
    const config={environment:'production',database:db.database,storeId:runtime.storeId,
      ledgerId:runtime.ledgerId,applicationCommit:runtime.applicationCommit,timeZone:runtime.timeZone};
    pool=mysql.createPool({uri:db.databaseUrl,ssl:db.ssl,connectionLimit:4,supportBigNumbers:true,bigNumberStrings:true});
    if(options.mode==='--dry-run') {
      if(options['--actor-secrets-file'])throw refused('S1_ARGUMENTS_INVALID');
      output.log(JSON.stringify(await inspectFirstInstall({pool,plan,databaseUrl:db.databaseUrl,config,env})));
      return 0;
    }
    const common={pool,plan,databaseUrl:db.databaseUrl,config,confirmation:options['--confirm-target'],env};
    let result;
    if(plan.kind==='ledger') {
      if(options['--actor-secrets-file'])throw refused('S1_ARGUMENTS_INVALID');
      result=await applyInitialLedger({...common,initiatedBy:options['--initiated-by']});
    } else {
      if(!options['--actor-secrets-file'])throw refused('S1_ARGUMENTS_INVALID');
      const credential=await readExternalSecret(options['--actor-secrets-file']);
      result=await applyOpeningInventory({...common,credential});
    }
    output.log(JSON.stringify(result));
    return result.status==='initialized'||result.status==='already_initialized'||result.status==='committed'?0:1;
  }catch(error){
    output.error(JSON.stringify({code:/^S1_[A-Z_]+$/.test(error?.code??'')?error.code:'S1_FAILED'}));
    return 1;
  }finally{await pool?.end();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runFirstInstallCli();
