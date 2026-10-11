import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {schemaSpec,canonical,digest} from '../backup/format.js';
import {restoreDatabase} from '../backup/mysql-backup.js';
import {inspectProductionRestore,createProductionRestorePlan,
  inspectProductionRestorePlan,checkedPaths,candidateName,loadOperatorDatabase} from './production-plan.js';
import {runProductionRestoreCli} from './production-restore-cli.js';

const SHA='a'.repeat(64),COMMIT='b'.repeat(40),SERVER='synthetic-server-uuid';
const OP='12345678-1234-4234-8234-123456789abc';
const loaded=(root,db='jbhh_ktv_prod')=>({
 config:{storeId:'synthetic-store',ledgerId:'synthetic-ledger',applicationCommit:COMMIT,
  serviceAccountSid:'S-1-5-21-1-2-3-1001',
  monitoring:{backupDirectory:root},recovery:{journalDirectory:root,operatorDbSecretsFile:'synthetic-operator-file'}},
 apiEnv:{KTV_MYSQL_URL:'mysql://synthetic:synthetic-password@127.0.0.1:33313/'+db}
});
async function fixture(work){
 const root=await mkdtemp(join(tmpdir(),'s3a-synthetic-'));
 try{const artifact=join(root,'backup');await mkdir(artifact);
  const spec=await schemaSpec(),tables=Object.fromEntries(spec.tables.map(t=>[t,{columns:['synthetic'],rows:[]}]));
  tables.production_bootstrap_events={columns:['store_id','ledger_id','environment'],
   rows:[['synthetic-store','synthetic-ledger','production']]};
  tables.ledger_heads={columns:['ledger_id','revision','state_checksum'],
   rows:[['synthetic-ledger',3,SHA]]};
  let data=canonical({backupFormatVersion:1,tables});
  const manifest={backupFormatVersion:1,createdAt:'2026-10-10T00:00:00.000000Z',
   engine:'InnoDB',mysqlVersion:'8.4.11',schema:spec.manifest,
   migrationVersion:Object.keys(spec.manifest.migrations).at(-1),
   storeId:'synthetic-store',ledgerId:'synthetic-ledger',
   source:{environment:'production',database:'jbhh_ktv_prod',serverUuid:SERVER},
   applicationCommit:COMMIT,ledgerHeads:[{ledgerId:'synthetic-ledger',revision:3,checksum:SHA}],
   dataChecksum:digest(data),dataBytes:Buffer.byteLength(data),backupId:randomUUID()};
  const persist=async()=>{const bytes=canonical(manifest),checksum=digest(bytes);
   await writeFile(join(artifact,'data.json'),data);await writeFile(join(artifact,'manifest.json'),bytes);
   await writeFile(join(artifact,'manifest.sha256'),checksum+'\n');return checksum;};
  let checksum=await persist();await work({root,artifact,manifest,persist,setData:value=>{data=value;},get checksum(){return checksum;},
   set checksum(value){checksum=value;}});
 }finally{await rm(root,{recursive:true,force:true});}
}
function fakeDb({server=SERVER,targetExists=false,sourceReadable=true,mode='NORMAL',revision=5,metadataGrant=true}={}){
 const statements=[];
 const connect=async url=>{
  const admin=new URL(url).pathname==='/';
  if(!admin&&!sourceReadable)throw Error('synthetic source unavailable');
  return {query:async sql=>{statements.push(sql);
    if(admin&&sql.startsWith('SHOW GRANTS'))return [[{grant:metadataGrant?
      'GRANT SHOW DATABASES ON *.* TO synthetic_operator':'GRANT USAGE ON *.* TO synthetic_operator'}]];
    if(admin)return [[{server_uuid:server,version:'8.4.11'}]];
    if(sql.startsWith('SELECT DATABASE()'))return [[{db:'jbhh_ktv_prod',server_uuid:server}]];
    if(sql.startsWith('SELECT ledger_id'))return [[{ledger_id:'synthetic-ledger',revision,state_checksum:SHA}]];
    if(sql.startsWith('SELECT store_id'))return [[{store_id:'synthetic-store',ledger_id:'synthetic-ledger',
      environment:'production',facts:JSON.stringify({source:'first-install-ledger',
       serverUuid:server,database:'jbhh_ktv_prod'})}]];
    if(sql.startsWith('SELECT mode'))return [[{mode}]];
    throw Error('unexpected SQL');
   },execute:async sql=>{statements.push(sql);if(!admin||!sql.startsWith('SELECT SCHEMA_NAME'))
    throw Error('unexpected SQL');return [targetExists?[{SCHEMA_NAME:'occupied'}]:[]];},
   end:async()=>{}};
 };
 return {connect,statements};
}
const args=(f,db=fakeDb(),extra={})=>({
 runtimeConfigFile:'synthetic-protected-config',
 artifactDirectory:f.artifact,expectedChecksum:f.checksum,recoveryOperationId:OP,
 now:new Date('2026-10-12T00:00:00Z'),load:async()=>loaded(f.root),
 pathCheck:async()=>({artifact:f.artifact,journal:f.root}),connect:db.connect,
 operatorLoad:async()=> 'mysql://synthetic:synthetic-password@127.0.0.1:33313/',...extra});

test('S3-A eligible production backup is read only and binds same server, schema and exact commit',async()=>fixture(async f=>{
 const db=fakeDb(),plan=await inspectProductionRestore(args(f,db));
 assert.equal(plan.status,'PREPARED');assert.equal(plan.targetDatabase,candidateName(OP));
 assert.equal(plan.lossWindow.revisionGap,2);assert.equal(plan.backupAgeSeconds,172800);
 assert.equal(plan.sourceServerUuid,plan.targetServerUuid);
 assert.equal(plan.applicationCommit,COMMIT);
 assert.ok(db.statements.length>=5&&db.statements.every(s=>s.startsWith('SELECT')||s.startsWith('SHOW GRANTS')));
 assert.equal(JSON.stringify(plan).includes('synthetic-password'),false);
}));
test('S3-A rejects cross-server, occupied target, unreadable source and non-NORMAL source',async()=>fixture(async f=>{
 for(const [settings,code] of [
  [{server:'other-instance'},'PRODUCTION_RESTORE_TARGET_SERVER_MISMATCH'],
  [{targetExists:true},'PRODUCTION_RESTORE_TARGET_EXISTS'],
  [{sourceReadable:false},'PRODUCTION_RESTORE_CURRENT_DB_UNREADABLE'],
  [{mode:'FROZEN'},'PRODUCTION_RESTORE_SOURCE_NOT_NORMAL']
 ])await assert.rejects(inspectProductionRestore(args(f,fakeDb(settings))),{code});
 const unreadable=await inspectProductionRestore(args(f,fakeDb({sourceReadable:false}))).catch(e=>e);
 assert.equal(unreadable.safe.CURRENT_LEDGER_HEAD,'UNKNOWN');
}));
test('S3-A backup eligibility rejects test source, store, ledger, schema, format, checksum and application mismatch',async()=>fixture(async f=>{
 const reject=async code=>assert.rejects(inspectProductionRestore(args(f)),{code});
 f.manifest.source.environment='test';f.manifest.source.database='jbhh_ktv_test';
 // The receipt must match the synthetic TEST source so the S3 gate itself is exercised.
 const bytes=JSON.parse(await readFile(join(f.artifact,'data.json'),'utf8'));
 bytes.tables.production_bootstrap_events.rows[0][2]='test';
 const testData=canonical(bytes);f.manifest.dataChecksum=digest(testData);f.manifest.dataBytes=Buffer.byteLength(testData);
 f.setData(testData);f.checksum=await f.persist();
 await reject('PRODUCTION_RESTORE_SOURCE_NOT_PRODUCTION');
 bytes.tables.production_bootstrap_events.rows[0][2]='production';
 const prodData=canonical(bytes);f.manifest.dataChecksum=digest(prodData);f.manifest.dataBytes=Buffer.byteLength(prodData);
 f.setData(prodData);
 f.manifest.source.environment='production';f.manifest.source.database='jbhh_ktv_prod';
 f.manifest.storeId='wrong';f.checksum=await f.persist();await reject('BACKUP_STORE_MISMATCH');
 f.manifest.storeId='synthetic-store';f.manifest.ledgerId='wrong';f.checksum=await f.persist();
 await reject('BACKUP_STORE_MISMATCH');
 f.manifest.ledgerId='synthetic-ledger';f.manifest.schema.migrations['999_unknown.sql']=SHA;
 f.checksum=await f.persist();await reject('BACKUP_SCHEMA_UNSUPPORTED');
 delete f.manifest.schema.migrations['999_unknown.sql'];
 f.manifest.backupFormatVersion=2;f.checksum=await f.persist();await reject('BACKUP_SCHEMA_UNSUPPORTED');
 f.manifest.backupFormatVersion=1;f.checksum=await f.persist();
 await assert.rejects(inspectProductionRestore(args(f,fakeDb(),{expectedChecksum:'0'.repeat(64)})),
  {code:'BACKUP_CHECKSUM_MISMATCH'});
 f.manifest.applicationCommit='c'.repeat(40);f.checksum=await f.persist();
 await reject('PRODUCTION_RESTORE_APPLICATION_INCOMPATIBLE');
}));
test('S3-A rejects invalid operation id and active database as target',async()=>fixture(async f=>{
 await assert.rejects(inspectProductionRestore(args(f,fakeDb(),{recoveryOperationId:'../evil'})),
  {code:'PRODUCTION_RESTORE_ARGUMENTS_INVALID'});
 const active=candidateName(OP);
 await assert.rejects(inspectProductionRestore(args(f,fakeDb(),{
  load:async()=>loaded(f.root,active)})),{code:'PRODUCTION_RESTORE_TARGET_INVALID'});
}));
test('S3-A path policy rejects arbitrary backup location and ACL failure',async()=>fixture(async f=>{
 const other=join(f.root,'nested');await mkdir(other);
 const nested=join(other,'backup');await mkdir(nested);
 const config=loaded(f.root);
 const allow={backupAcl:async()=>{},journalAcl:async()=>{},fileAcl:async()=>{}};
 await assert.rejects(checkedPaths(config,nested,allow),{code:'PRODUCTION_RESTORE_BACKUP_PATH_DENIED'});
 await assert.rejects(checkedPaths(config,f.artifact,{
  backupAcl:async()=>{throw Error('unsafe ACL');},journalAcl:async()=>{},fileAcl:async()=>{}
 }),/unsafe ACL/);
}));
test('S3-A one active plan, concurrent creators, no secrets and read-only inspect-plan',async()=>fixture(async f=>{
 const options={inspect:()=>inspectProductionRestore(args(f)),load:async()=>loaded(f.root),
  pathCheck:async()=>({journal:f.root}),harden:async()=>{},fileAcl:async()=>{}};
 const results=await Promise.allSettled([createProductionRestorePlan({},options),
  createProductionRestorePlan({},options)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.filter(r=>r.status==='rejected').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.code,'PRODUCTION_RESTORE_ACTIVE_RECOVERY_EXISTS');
 const text=await readFile(join(f.root,'active-plan.json'),'utf8');
 assert.equal(text.includes('synthetic-password'),false);
 const before=await readdir(f.root);
 const inspected=await inspectProductionRestorePlan({runtimeConfigFile:'synthetic',
  load:options.load,pathCheck:options.pathCheck,fileAcl:options.fileAcl});
 assert.equal(inspected.status,'PREPARED');assert.equal(inspected.recoveryOperationId,OP);
 assert.deepEqual(await readdir(f.root),before);
}));
test('S3-A failed ACL hardening leaves a blocking claim and no active plan',async()=>fixture(async f=>{
 const options={inspect:()=>inspectProductionRestore(args(f)),load:async()=>loaded(f.root),
  pathCheck:async()=>({journal:f.root}),harden:async()=>{throw Error('ACL failure');},fileAcl:async()=>{}};
 await assert.rejects(createProductionRestorePlan({},options),/ACL failure/);
 assert.ok((await readdir(f.root)).includes('active-plan.claim'));
 assert.equal((await readdir(f.root)).includes('active-plan.json'),false);
 await assert.rejects(createProductionRestorePlan({},options),
  {code:'PRODUCTION_RESTORE_ACTIVE_RECOVERY_EXISTS'});
}));
test('S3-A CLI has no restore action and inspect emits no writes',async()=>fixture(async f=>{
 let output='',error='';
 const code=await runProductionRestoreCli(['inspect','--config-file','synthetic',
  '--artifact-dir',f.artifact,'--checksum',f.checksum,'--operation-id',OP],{
  inspect:()=>inspectProductionRestore(args(f)),stdout:{write:s=>{output+=s;}},
  stderr:{write:s=>{error+=s;}}});
 assert.equal(code,0);assert.equal(error,'');
 assert.equal(JSON.parse(output).JOURNAL_WRITES,'NO');
 assert.equal(await runProductionRestoreCli(['restore'],{stdout:{write(){}},stderr:{write(){}}}),1);
}));
test('S3-A existing restore still rejects production execution before database connection',async()=>fixture(async f=>{
 const target='jbhh_ktv_restore_s3a_synthetic';
 const base={directory:f.artifact,expectedChecksum:f.checksum,
  databaseUrl:'mysql://synthetic:synthetic@127.0.0.1:33313/'+target,
  serverUuid:SERVER,storeId:'synthetic-store',ledgerId:'synthetic-ledger',
  initiatedBy:'synthetic-operator',restoreToNewDb:true,
  confirmation:SERVER+'/'+target+'/synthetic-store/synthetic-ledger/'+f.checksum};
 await assert.rejects(restoreDatabase({...base,environment:'test',env:{
  NODE_ENV:'test',KTV_HTTP_ENV:'test',KTV_DEPLOYMENT_ENV:'test'}}),
  {code:'RESTORE_PRODUCTION_DISABLED'});
 await assert.rejects(restoreDatabase({...base,environment:'production',env:{
  NODE_ENV:'production',KTV_HTTP_ENV:'production',KTV_DEPLOYMENT_ENV:'production'}}),
  {code:'RESTORE_CONFIRMATION_REQUIRED'});
}));

test('S3-A dedicated metadata account must match runtime host and have direct visibility',async()=>fixture(async f=>{
 const config=loaded(f.root),operatorFile=join(f.root,'synthetic-operator.json');
 await writeFile(operatorFile,'{}');config.config.recovery.operatorDbSecretsFile=operatorFile;
 const read=async()=>({databaseUrl:
  'mysql://metadata:protected-placeholder@127.0.0.1:33313/'});
 assert.ok((await loadOperatorDatabase(config,{read,fileAcl:async()=>({
  protected:true,current:config.config.serviceAccountSid,owner:config.config.serviceAccountSid,
  rules:[{sid:config.config.serviceAccountSid,type:'Allow',rights:1}]})})).includes('metadata'));
 await assert.rejects(loadOperatorDatabase(config,{read:async()=>({databaseUrl:
  'mysql://metadata:protected-placeholder@127.0.0.1:33314/'}),
  fileAcl:async()=>({protected:true,current:config.config.serviceAccountSid,
   owner:config.config.serviceAccountSid,rules:[{sid:config.config.serviceAccountSid,type:'Allow',rights:1}]})}),
  {code:'PRODUCTION_RESTORE_TARGET_SERVER_MISMATCH'});
 const inGit=loaded(f.root);inGit.config.recovery.operatorDbSecretsFile=join(process.cwd(),'package.json');
 await assert.rejects(loadOperatorDatabase(inGit,{read,fileAcl:async()=>{throw Error('ACL should not be checked');}}),
  {code:'BACKUP_PATH_DENIED'});
 await assert.rejects(inspectProductionRestore(args(f,fakeDb({metadataGrant:false}))),
  {code:'PRODUCTION_RESTORE_METADATA_VISIBILITY_REQUIRED'});
}));
test('S3-A journal ACL refusal and corrupted plan remain closed',async()=>fixture(async f=>{
 await assert.rejects(checkedPaths(loaded(f.root),f.artifact,{
  backupAcl:async()=>{},journalAcl:async()=>{throw Error('journal ACL denied');},
  fileAcl:async()=>{}}),/journal ACL denied/);
 await writeFile(join(f.root,'active-plan.json'),'{"status":"PREPARED"}');
 await assert.rejects(inspectProductionRestorePlan({runtimeConfigFile:'synthetic',
  load:async()=>loaded(f.root),pathCheck:async()=>({journal:f.root}),
  fileAcl:async()=>{}}),{code:'PRODUCTION_RESTORE_PLAN_INVALID'});
}));
test('S3-A data corruption is refused by existing verifier',async()=>fixture(async f=>{
 await writeFile(join(f.artifact,'data.json'),'tampered');
 await assert.rejects(inspectProductionRestore(args(f)),
  {code:'BACKUP_CHECKSUM_MISMATCH'});
}));

test('S3-A plan inspection rejects nested extra fields even with a recomputed digest',async()=>fixture(async f=>{
 const plan=await inspectProductionRestore(args(f));
 const {planDigest,...body}=plan;
 body.lossWindow={...body.lossWindow,secret:'must-never-be-output'};
 const forged={...body,planDigest:digest(canonical(body))};
 await writeFile(join(f.root,'active-plan.json'),canonical(forged));
 await assert.rejects(inspectProductionRestorePlan({runtimeConfigFile:'synthetic',
  load:async()=>loaded(f.root),pathCheck:async()=>({journal:f.root}),
  fileAcl:async()=>{}}),{code:'PRODUCTION_RESTORE_PLAN_INVALID'});
}));

test('S3-A create-plan refuses protected config drift before writing a claim',async()=>fixture(async f=>{
 const changed=loaded(f.root,'another_database');
 await assert.rejects(createProductionRestorePlan({artifactDirectory:f.artifact},{
  inspect:()=>inspectProductionRestore(args(f)),
  load:async()=>changed,pathCheck:async()=>({journal:f.root}),
  harden:async()=>{},fileAcl:async()=>{}}),{code:'PRODUCTION_RESTORE_CONFIG_CHANGED'});
 assert.equal((await readdir(f.root)).includes('active-plan.claim'),false);
}));
