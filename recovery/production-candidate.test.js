import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {schemaSpec,canonical,digest} from '../backup/format.js';
import {inspectProductionRestore,preflightPreparedRestore,readProtectedRestorePlan,
 validatePlan,candidateName,planBinding} from './production-plan.js';
import {readExecutionState,transitionExecutionState} from './production-journal.js';
import {runProductionRestoreCli} from './production-restore-cli.js';
import {restorePreparedCandidate} from './production-candidate.js';

const SERVER='synthetic-s3b-server',COMMIT='a'.repeat(40),SHA='b'.repeat(64);
async function fixture(work){
 const root=await mkdtemp(join(tmpdir(),'s3b-phase1-')),artifact=join(root,'backup');
 try{
  await mkdir(artifact);
  const spec=await schemaSpec();
  const tables=Object.fromEntries(spec.tables.map(name=>[name,{columns:['synthetic'],rows:[]}]));
  tables.ledger_heads={columns:['ledger_id','revision','state_checksum'],rows:[['synthetic-ledger',3,SHA]]};
  tables.production_bootstrap_events={columns:['store_id','ledger_id','environment'],rows:[['synthetic-store','synthetic-ledger','production']]};
  const data=canonical({backupFormatVersion:1,tables});
  const manifest={backupFormatVersion:1,createdAt:'2026-10-10T00:00:00.000000Z',
   engine:'InnoDB',mysqlVersion:'8.4.11',schema:spec.manifest,
   migrationVersion:Object.keys(spec.manifest.migrations).at(-1),
   storeId:'synthetic-store',ledgerId:'synthetic-ledger',
   source:{environment:'production',database:'jbhh_ktv_test',serverUuid:SERVER},
   applicationCommit:COMMIT,ledgerHeads:[{ledgerId:'synthetic-ledger',revision:3,checksum:SHA}],
   dataChecksum:digest(data),dataBytes:Buffer.byteLength(data),backupId:randomUUID()};
  const bytes=canonical(manifest),checksum=digest(bytes);
  await writeFile(join(artifact,'data.json'),data);
  await writeFile(join(artifact,'manifest.json'),bytes);
  await writeFile(join(artifact,'manifest.sha256'),checksum+'\n');
  const db={mode:'NORMAL',facts:null,server:SERVER,target:false,revision:5,statements:[]};
  const load=async()=>({config:{storeId:'synthetic-store',ledgerId:'synthetic-ledger',
   applicationCommit:COMMIT,serviceAccountSid:'S-1-5-21-1-2-3-1001',
   monitoring:{backupDirectory:root},recovery:{journalDirectory:root}},
   apiEnv:{KTV_MYSQL_URL:'mysql://fixture:fixture@127.0.0.1:33313/jbhh_ktv_test'}});
  const connect=async url=>{
   const admin=new URL(url).pathname==='/';
   return {query:async sql=>{
    db.statements.push(sql);
    if(admin&&sql.startsWith('SHOW GRANTS'))return [[{grant:'GRANT SHOW DATABASES ON *.* TO fixture'}]];
    if(admin)return [[{server_uuid:db.server,version:'8.4.11'}]];
    if(sql.startsWith('SELECT DATABASE()'))return [[{db:'jbhh_ktv_test',server_uuid:db.server}]];
    if(sql.startsWith('SELECT ledger_id'))return [[{ledger_id:'synthetic-ledger',revision:db.revision,state_checksum:SHA}]];
    if(sql.startsWith('SELECT store_id'))return [[{store_id:'synthetic-store',ledger_id:'synthetic-ledger',
     environment:'production',facts:JSON.stringify({source:'first-install-ledger',serverUuid:db.server,database:'jbhh_ktv_test'})}]];
    if(sql.startsWith('SELECT mode'))return [[{mode:db.mode,store_id:'synthetic-store',
     ledger_id:'synthetic-ledger',environment:'production',facts:JSON.stringify(db.facts)}]];
    throw Error('unexpected SQL '+sql);
   },execute:async sql=>{
    db.statements.push(sql);
    if(sql.startsWith('SELECT SCHEMA_NAME'))return [db.target?[{SCHEMA_NAME:'occupied'}]:[]];
    throw Error('unexpected SQL '+sql);
   },end:async()=>{}};
  };
  const pathCheck=async()=>({backup:root,journal:root,artifact});
  const deps={runtimeConfigFile:'synthetic',load,pathCheck,connect,
   operatorLoad:async()=> 'mysql://fixture:fixture@127.0.0.1:33313/',
   fileAcl:async()=>{}};
  const plan=await inspectProductionRestore({...deps,artifactDirectory:artifact,
   expectedChecksum:checksum,now:new Date('2026-10-12T00:00:00Z')});
  await writeFile(join(root,'active-plan.json'),canonical(plan));
  await work({root,artifact,plan,checksum,db,deps});
 }finally{await rm(root,{recursive:true,force:true});}
}

test('S3-B v2 binds protected backup locator and revalidates without database mutation',()=>fixture(async f=>{
 assert.equal(f.plan.formatVersion,2);
 assert.equal(f.plan.backupLocator,'backup');
 assert.equal((await preflightPreparedRestore(f.deps)).plan.planDigest,f.plan.planDigest);
 assert.ok(f.db.statements.every(sql=>sql.startsWith('SELECT')||sql.startsWith('SHOW GRANTS')));
 assert.equal(f.db.statements.some(sql=>sql.startsWith('CREATE DATABASE')),false);
 const {planDigest,...legacy}=f.plan;delete legacy.backupLocator;legacy.formatVersion=1;
 const v1={...legacy,planDigest:digest(canonical(legacy))};
 validatePlan(v1);
 await writeFile(join(f.root,'active-plan.json'),canonical(v1));
 assert.equal((await readProtectedRestorePlan(f.deps)).plan.formatVersion,1);
 await assert.rejects(preflightPreparedRestore(f.deps),{code:'PRODUCTION_RESTORE_PLAN_VERSION_NOT_EXECUTABLE'});
}));

test('S3-B preflight rejects plan digest, backup, server and target drift before mutation',()=>fixture(async f=>{
 const path=join(f.root,'active-plan.json');
 await writeFile(path,canonical({...f.plan,backupId:randomUUID()}));
 await assert.rejects(preflightPreparedRestore(f.deps),{code:'PRODUCTION_RESTORE_PLAN_INVALID'});
 await writeFile(path,canonical(f.plan));
 await writeFile(join(f.artifact,'manifest.sha256'),'0'.repeat(64)+'\n');
 await assert.rejects(preflightPreparedRestore(f.deps),{code:'PRODUCTION_RESTORE_PLAN_PRECONDITION_CHANGED'});
 await writeFile(join(f.artifact,'manifest.sha256'),f.checksum+'\n');
 f.db.server='different-server';
 await assert.rejects(preflightPreparedRestore(f.deps),{code:'PRODUCTION_RESTORE_PLAN_PRECONDITION_CHANGED'});
 f.db.server=SERVER;f.db.target=true;
 await assert.rejects(preflightPreparedRestore(f.deps),{code:'PRODUCTION_RESTORE_PLAN_PRECONDITION_CHANGED'});
 assert.ok(f.db.statements.every(sql=>sql.startsWith('SELECT')||sql.startsWith('SHOW GRANTS')));
}));

test('S3-B frozen preflight requires exact plan binding',()=>fixture(async f=>{
 f.db.mode='FROZEN';f.db.facts=planBinding(f.plan);
 assert.equal((await preflightPreparedRestore({...f.deps,requiredMode:'FROZEN'})).plan.planDigest,f.plan.planDigest);
 f.db.facts.recoveryOperationId=randomUUID();
 await assert.rejects(preflightPreparedRestore({...f.deps,requiredMode:'FROZEN'}),
  {code:'PRODUCTION_RESTORE_PLAN_PRECONDITION_CHANGED'});
}));

test('S3-B journal preserves same operation through FREEZE_INTENT and FROZEN',()=>fixture(async f=>{
 const options={harden:async()=>{},checkAcl:async()=>{}};
 assert.equal(await readExecutionState(f.root,f.plan,options),null);
 await transitionExecutionState(f.root,f.plan,null,'FREEZE_INTENT',options);
 assert.equal((await readExecutionState(f.root,f.plan,options)).state,'FREEZE_INTENT');
 await assert.rejects(readExecutionState(f.root,{...f.plan,recoveryOperationId:randomUUID()},options),
  {code:'PRODUCTION_RESTORE_JOURNAL_MISMATCH'});
 await transitionExecutionState(f.root,f.plan,'FREEZE_INTENT','FROZEN',options);
 assert.equal((await readExecutionState(f.root,f.plan,options)).state,'FROZEN');
}));

test('S3-B candidate core refuses an unissued capability before database access',async()=>{
 await assert.rejects(restorePreparedCandidate({runtimeConfigFile:'synthetic',capability:{}}),
  {code:'RESTORE_PRODUCTION_DISABLED'});
});

test('real production CLI refuses S3-B execution actions',async()=>{
 for(const action of ['freeze-plan','restore-candidate']){
  let error='';const code=await runProductionRestoreCli([action],{
   stderr:{write:s=>{error+=s;}},stdout:{write:()=>{}}});
  assert.equal(code,1);assert.equal(JSON.parse(error).code,'RESTORE_PRODUCTION_DISABLED');
 }
});
