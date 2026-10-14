// Fixed test scopes; only freshEnvironment supplies connection/identity facts.
import {freshEnvironment} from '../rehearsal/fresh-environment.js';
import {assertRegressionFixture} from '../rehearsal/regression-guard.js';
import {spawn} from 'node:child_process';import {createWriteStream} from 'node:fs';import {readFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
if(process.argv.length!==2)throw Error('D2_FIXED_FOCUSED_SCOPE_REQUIRED');
const repository=fileURLToPath(new URL('../',import.meta.url));let f;
const groups={
 rehearsal:['recovery/production-orchestration.mysql.test.js'],
 stage:['recovery/production-authorization.test.js','recovery/production-plan.test.js','recovery/production-candidate.test.js','recovery/c1-checks.test.js','recovery/production-c2.test.js','recovery/production-c3.test.js','recovery/production-cutover-journal.test.js','recovery/gate.test.js','production/recovery-service.test.js','production/cutover-startup.test.js','production/startup-degraded.test.js','production/readiness.test.js'],
 unit:['recovery/production-orchestration.test.js','recovery/production-orchestration-errors.test.js','test-support/d2-acl-fixture.test.js','test-support/filesystem-digest.test.js'],
 focused:['recovery/production-candidate.mysql.test.js','recovery/production-candidate-restore.mysql.test.js','recovery/production-c1.mysql.test.js','recovery/production-c2.mysql.test.js','recovery/production-c3.mysql.test.js'],
 narrow:['test-support/owned-mysql-fixture.test.js','recovery/gate.test.js']
};
try{
 f=await freshEnvironment(repository,{port:33313,packages:false});const pool=await f.createDatabase(f.names.database);f.pools.add(pool);
 const env={...process.env,NODE_ENV:'test',KTV_HTTP_ENV:'test',KTV_DEPLOYMENT_ENV:'test',STAGE5E_RUN:'synthetic-only',LEDGER_MYSQL_TEST_URL:f.dbUrl(f.names.database),STAGE5E_FIXTURE_ROOT:f.root,STAGE5E_FIXTURE_ID:f.names.id,STAGE5E_FIXTURE_UUID:f.identity.server_uuid};
 const c=await pool.getConnection();try{await assertRegressionFixture(c,env);}finally{c.release();}
 console.log(JSON.stringify({ownedEndpoint:{host:'127.0.0.1',port:f.port},fixtureVerified:true}));
 for(const [group,files] of Object.entries(groups)){
  const log=join(tmpdir(),'s3d-d2-owned-'+group+'-'+Date.now()+'.tap'),out=createWriteStream(log,{flags:'wx'});
  const child=spawn(process.execPath,['--test','--test-isolation=none','--test-reporter=tap',...files],{cwd:repository,windowsHide:true,stdio:['ignore','pipe','pipe'],env});f.children.add(child);
  child.stdout.pipe(out,{end:false});child.stderr.pipe(out,{end:false});
  const exit=await new Promise((r,j)=>{child.once('error',j);child.once('close',r);});await new Promise(r=>out.end(r));
  const tap=await readFile(log,'utf8'),stats=Object.fromEntries(['tests','pass','fail','skipped','duration_ms'].map(k=>[k,tap.match(new RegExp('^# '+k+' (.+)$','m'))?.[1]??null]));
  const historicalEnoent=/ENOENT/.test(tap)&&/stage5e|Stage5E|ktv-stage5e/.test(tap);
  console.log(JSON.stringify({group,log,exit,...stats,historicalEnoent}));
  if(exit!==0||stats.fail!=='0'||stats.skipped!=='0'||historicalEnoent){process.exitCode=1;break;}
 }
}finally{if(f)console.log(JSON.stringify({cleanup:await f.cleanup()}));}
