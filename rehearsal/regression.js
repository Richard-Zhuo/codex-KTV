// Runs the unchanged full command with an owned, disposable fixture server on 33313.
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createWriteStream} from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {freshEnvironment} from './fresh-environment.js';
if(process.env.STAGE5E_RUN!=='synthetic-only')throw Error('REHEARSAL_EXPLICIT_SCOPE_REQUIRED');
const f=await freshEnvironment(fileURLToPath(new URL('../',import.meta.url)),{port:33313,packages:false});
try{
 const pool=await f.createDatabase(f.names.database);f.pools.add(pool);
 const log=process.env.STAGE5E_TAP_LOG;if(!log)throw Error('REHEARSAL_EXTERNAL_LOG_REQUIRED');
 const {externalDirectory}=await import('../backup/format.js');const {dirname}=await import('node:path');await externalDirectory(dirname(log));
 const sink=createWriteStream(log,{flags:'wx'}),child=spawn(process.execPath,['--test','--test-isolation=none','--test-reporter=tap'],{cwd:fileURLToPath(new URL('../',import.meta.url)),windowsHide:true,env:{...process.env,NODE_ENV:'test',KTV_HTTP_ENV:'test',KTV_DEPLOYMENT_ENV:'test',LEDGER_MYSQL_TEST_URL:f.dbUrl(f.names.database),STAGE5E_FIXTURE_ID:f.names.id,STAGE5E_FIXTURE_ROOT:f.root,STAGE5E_FIXTURE_UUID:f.identity.server_uuid},stdio:['ignore','pipe','pipe']});f.children.add(child);
 let tail='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{sink.write(chunk);tail=(tail+chunk).slice(-12000);});
 const [code]=await once(child,'exit');await new Promise((resolve,reject)=>{sink.once('error',reject);sink.end(resolve);});process.stdout.write(tail+'\n');process.exitCode=code??1;
}finally{console.log(JSON.stringify({fixtureCleanup:await f.cleanup()}));}
