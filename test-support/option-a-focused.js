// Explicit owned-fixture focused runner. No production selector or caller URL/path.
import {freshEnvironment} from '../rehearsal/fresh-environment.js';
import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
if(process.argv.length!==2)throw Error('OPTION_A_FIXED_FOCUSED_SCOPE_REQUIRED');
const repository=fileURLToPath(new URL('../',import.meta.url));let f;
const groups={nested:['production/cutover-pointer-lock.mysql.test.js'],boundary:['production/recovery-acl.test.js','recovery/runtime-boundary.test.js','recovery/runtime-boundary.mysql.test.js','production/cutover-pointer.test.js'],
 related:['production/runtime.test.js','production/runtime.integration.test.js','recovery/production-authorization.test.js','recovery/production-plan.test.js','recovery/production-candidate.test.js','recovery/production-c2.test.js','recovery/production-c3.test.js','recovery/production-cutover-journal.test.js','production/cutover-startup.test.js','production/readiness.test.js','recovery/production-c2.mysql.test.js','recovery/production-c3.mysql.test.js']};
try{
 f=await freshEnvironment(repository,{port:33313,packages:false});
 for(const db of [f.names.database,'jbhh_ktv_restore_s5e_entry_'+f.names.id]){const pool=await f.createDatabase(db);f.pools.add(pool);}
 const user='optiona_'+f.names.id,password=randomBytes(24).toString('hex');
 await f.setup.query('CREATE USER ?@? IDENTIFIED BY ?',[user,'127.0.0.1',password]);f.users.add(user);
 await f.setup.query('GRANT SELECT, SHOW DATABASES ON *.* TO ?@?',[user,'127.0.0.1']);
 const operator=new URL('mysql://127.0.0.1:33313/');operator.username=user;operator.password=password;
 for(const [group,files] of Object.entries(groups)){
  const log=join(tmpdir(),'option-a-'+group+'-'+Date.now()+'.tap'),out=createWriteStream(log,{flags:'wx'});
  const child=spawn(process.execPath,['--test','--test-isolation=none','--test-reporter=tap',...files],{cwd:repository,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,
   LEDGER_MYSQL_TEST_URL:f.dbUrl(f.names.database),STAGE5E_FIXTURE_ROOT:f.root,STAGE5E_FIXTURE_ID:f.names.id,STAGE5E_FIXTURE_UUID:f.identity.server_uuid,OPTION_A_OPERATOR_URL:operator.href}});
  child.stdout.pipe(out,{end:false});child.stderr.pipe(out,{end:false});
  const exit=await new Promise((r,j)=>{child.once('error',j);child.once('close',r);});await new Promise(r=>out.end(r));
  const tap=await readFile(log,'utf8'),stats=Object.fromEntries(['tests','pass','fail','skipped','duration_ms'].map(k=>[k,tap.match(new RegExp('^# '+k+' (.+)$','m'))?.[1]??null]));
  console.log(JSON.stringify({group,log,exit,...stats}));
  if(exit!==0||stats.fail!=='0'||stats.skipped!=='0'){process.exitCode=1;break;}
 }
}finally{if(f)console.log(JSON.stringify({cleanup:await f.cleanup()}));}
