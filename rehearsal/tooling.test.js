import {randomBytes} from 'node:crypto';
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,dirname,resolve} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {packageAccepted,unpackAccepted,sha} from './artifact.js';import {migrateFresh} from './migration.js';import {scopeNames,assertOwnedRoot,removeOwnedRoot} from './scope.js';
const run=promisify(execFile),commit='c1502c0fb0713ef040b210e5ea35f6c31079b7ee';
test('unaccepted release rejected before any artifact file is created',async()=>{
 await assert.rejects(packageAccepted({repository:'unused',commit,acceptedCommits:[],output:'unused'}),/ARTIFACT_COMMIT_NOT_ACCEPTED/);
});
test('dirty source clone cannot be packaged',async()=>{
 const root=await mkdtemp(join(tmpdir(),'s5e-artifact-test-')),source=join(root,'source'),out=join(root,'out');
 try{await mkdir(source);await mkdir(out);await run('git',['init'],{cwd:source,windowsHide:true});await writeFile(join(source,'uncommitted.js'),'not accepted');
 await assert.rejects(packageAccepted({repository:source,commit,acceptedCommits:[commit],output:join(out,'artifact.json')}),/ARTIFACT_DIRTY_TREE/);}
 finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true});}
});
test('artifact checksum, traversal, duplicate and altered-content guards reject before extraction',async()=>{
 const root=await mkdtemp(join(tmpdir(),'s5e-unpack-test-')),path=join(root,'artifact.json');
 try{
  for(const files of [
   [{path:'../secret',bytes:'',sha256:sha('')}],
   [{path:'server.js',bytes:'',sha256:sha('')},{path:'server.js',bytes:'',sha256:sha('')}],
   [{path:'server.js',bytes:Buffer.from('altered').toString('base64'),sha256:sha('different')}]
  ]){const bytes=JSON.stringify({format:1,applicationCommit:commit,files});await writeFile(path,bytes);
   await assert.rejects(unpackAccepted({artifact:path,expectedChecksum:sha(bytes),commit,destination:join(root,'must-not-exist')}),/ARTIFACT_PATH_OR_CONTENT_INVALID/);
  }
  await assert.rejects(unpackAccepted({artifact:path,expectedChecksum:sha('wrong'),commit,destination:join(root,'must-not-exist')}),/ARTIFACT_CHECKSUM_MISMATCH/);
 }finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true});}
});
test('migration uses only checksum-bound official files; partial failure never drops or undoes schema',async()=>{
 const queries=[],c={async query(sql){queries.push(sql);return sql==='SHOW TABLES'?[[]]:[{}];}};
 await assert.rejects(migrateFresh(c,new URL('../',import.meta.url),{failAfterFile:'002_mysql_auth_core.sql'}),/REHEARSAL_MIGRATION_FAILURE/);
 assert.ok(queries.some(s=>s.startsWith('CREATE TABLE ledger_heads')));assert.ok(queries.some(s=>s.startsWith('CREATE TABLE auth_sessions')));assert.ok(queries.every(s=>s==='SHOW TABLES'||s.startsWith('CREATE TABLE ')));assert.ok(!queries.some(s=>s.startsWith('DROP')));
 await assert.rejects(migrateFresh({query:async()=>[[{table:'existing'}]]},new URL('../',import.meta.url)),/MIGRATION_TARGET_NOT_EMPTY/);
});
test('cleanup requires exact root identity and owner marker; mismatch preserves resources',async()=>{
 const names=scopeNames(randomBytes(8).toString('hex')),root=join(tmpdir(),names.rootName);await mkdir(root);
 try{await writeFile(join(root,'rehearsal-owner.json'),JSON.stringify({id:'other',kind:'synthetic-cutover-rehearsal'}));await assert.rejects(removeOwnedRoot(root,names.id),/REHEARSAL_OWNER_REQUIRED/);assert.ok(await readFile(join(root,'rehearsal-owner.json')));
 await writeFile(join(root,'rehearsal-owner.json'),JSON.stringify({id:names.id,kind:'synthetic-cutover-rehearsal'}));assert.equal(await assertOwnedRoot(root,names.id),root);await removeOwnedRoot(root,names.id);}
 finally{await rm(root,{recursive:true,force:true});}
});

test('regression fixture requires opt-in, owned root, exact port, datadir, UUID and test database',async()=>{
 const {assertRegressionFixture}=await import('./regression-guard.js');
 const names=scopeNames(randomBytes(8).toString('hex')),root=join(tmpdir(),names.rootName);await mkdir(root);
 try{
  await writeFile(join(root,'rehearsal-owner.json'),JSON.stringify({id:names.id,kind:'synthetic-cutover-rehearsal'}));
  const env={STAGE5E_RUN:'synthetic-only',STAGE5E_FIXTURE_ID:names.id,STAGE5E_FIXTURE_ROOT:root,STAGE5E_FIXTURE_UUID:'owned-server'};
  const row={port:33313,datadir:join(root,'data'),uuid:'owned-server',databaseName:'jbhh_ktv_test'};
  const connection=value=>({query:async()=>[[value]]});
  await assertRegressionFixture(connection(row),env);
  await assert.rejects(assertRegressionFixture(connection(row),{...env,STAGE5E_RUN:''}),/SCOPE_REQUIRED/);
  for(const change of [{port:3306},{datadir:join(tmpdir(),'other')},{uuid:'other'},{databaseName:'production'}])
   await assert.rejects(assertRegressionFixture(connection({...row,...change}),env),/SERVER_MISMATCH/);
 }finally{await removeOwnedRoot(root,names.id);}
});
