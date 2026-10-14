import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import mysql from 'mysql2/promise';
import {withOwnedRecoveryReader,readRuntimeDeploymentForRecovery} from './runtime-boundary.js';
import {issueOwnedCandidateCapability} from './production-candidate.js';
import {updateOwnedDatabasePointer,updateProtectedDatabasePointer} from '../production/cutover-pointer.js';
import {materializeRuntimeContext,runtimeConfigFingerprint,validateFileAcl} from '../production/runtime-config.js';
import {syntheticTls} from '../test-support/runtime-tls.js';
import {canonical,digest} from '../backup/format.js';
import {requireOwnedBackupFixture,connectOwnedBackupFixture} from '../test-support/owned-mysql-fixture.js';
import {assertRegressionFixture} from '../rehearsal/regression-guard.js';
import {assertOwnedRoot,assertOwnedDatabase,scopeNames} from '../rehearsal/scope.js';
const enabled=process.env.STAGE5E_RUN==='synthetic-only'&&process.env.STAGE5E_FIXTURE_ROOT&&process.env.LEDGER_MYSQL_TEST_URL;
const hash=x=>createHash('sha256').update(typeof x==='string'?x:canonical(x)).digest('hex');
if(enabled)test('Option A owned consumer boundary, pointer and credential isolation',{timeout:120000},async t=>{
 const fixtureEnv=Object.freeze({...process.env}),raw=await requireOwnedBackupFixture(fixtureEnv);
 const f={root:fixtureEnv.STAGE5E_FIXTURE_ROOT,names:{id:fixtureEnv.STAGE5E_FIXTURE_ID,database:'jbhh_ktv_test'},identity:{server_uuid:fixtureEnv.STAGE5E_FIXTURE_UUID},port:33313,dbUrl:()=>raw};
 const capability=await issueOwnedCandidateCapability(f),root=join(capability.root,'artifacts','option-a');
 const source='jbhh_ktv_restore_s5e_boundary_'+f.names.id,target='jbhh_ktv_recovery_12345678123441238123123456789abc';
 const names=scopeNames(f.names.id),ownedDatabases=new Set([source]);assertOwnedDatabase(source,names,ownedDatabases);
 const operatorUser='oab_'+f.names.id,operatorPassword=randomBytes(24).toString('hex'),operatorUrl=new URL(raw);
 operatorUrl.username=operatorUser;operatorUrl.password=operatorPassword;operatorUrl.pathname='/';
 let setup,databaseCreated=false,accountCreated=false,rootCreated=false;
 try{
  setup=await connectOwnedBackupFixture(fixtureEnv);
  const [existing]=await setup.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[source]);assert.equal(existing.length,0);
  await setup.query('CREATE DATABASE '+source+' CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');databaseCreated=true;
  await setup.query('CREATE USER ?@? IDENTIFIED BY ?',[operatorUser,'127.0.0.1',operatorPassword]);accountCreated=true;
  await setup.query('GRANT SELECT ON '+source+'.* TO ?@?',[operatorUser,'127.0.0.1']);
  await mkdir(root);rootCreated=true;
 for(const name of ['journal','logs','backups'])await mkdir(join(root,name));
 const configPath=join(root,'runtime.json'),secretPath=join(root,'runtime-secrets.json'),operatorPath=join(root,'operator.json'),policyPath=join(root,'policy.json');
 const operator='S-1-5-21-101-202-303-1001',service='S-1-5-80-1-2-3-4-5',ADMIN='S-1-5-32-544';
 let actor={sid:operator,elevated:true},broad=false;
 const acl=async path=>({protected:true,current:actor.sid,owner:ADMIN,rules:[{sid:ADMIN,type:'Allow',rights:2032127},
  {sid:path===secretPath||path===configPath||path.includes('cutover-secret-')?service:operator,type:'Allow',rights:1},
  ...(broad?[{sid:operator,type:'Allow',rights:1}]:[])]});
 const directoryAcl=async()=>({protected:true,current:actor.sid,owner:ADMIN,rules:[{sid:operator,type:'Allow',rights:197055,inheritance:'ObjectInherit'}]});
 const env={NODE_ENV:'production',KTV_HTTP_ENV:'production',KTV_DEPLOYMENT_ENV:'production'};
 const config={configVersion:1,applicationCommit:'a'.repeat(40),publicOrigin:'https://ktv.example.invalid:8443',listenHost:'127.0.0.1',port:8443,
 storeId:'synthetic-store',ledgerId:'synthetic-ledger',timeZone:'Asia/Shanghai',businessDateCutoff:'12:00',sessionRuleVersion:'opening-hours-v1',deviceControlMode:'disabled',liveControlEnabled:false,
 secretsFile:secretPath,logDirectory:join(root,'logs'),serviceAccountSid:service,backupPolicyConfigured:false,directoryAclReviewed:true,networkModel:'private-vpn',
 monitoring:{backupDirectory:join(root,'backups')},recovery:{journalDirectory:join(root,'journal'),operatorDbSecretsFile:operatorPath}};
 const tls=await syntheticTls('ktv.example.invalid');
 const sentinels=['RUNTIME_PASSWORD_SENTINEL_DO_NOT_RETURN',tls.privateKey,'PROVIDER_SENTINEL_DO_NOT_RETURN'];
 let bundle={database:{host:'127.0.0.1',port:33313,name:source,user:'runtime_not_recovery',password:sentinels[0]},
 tls:{certificate:tls.certificate,privateKey:tls.privateKey},ktvsky:{telno:'synthetic',password:sentinels[2]}};
 const save=()=>writeFile(secretPath,JSON.stringify(bundle));
 await writeFile(configPath,JSON.stringify(config));await save();
 await writeFile(policyPath,JSON.stringify({policyVersion:1,approvedOperatorSid:operator,runtimeServiceSid:service,runtimeConfigFile:configPath}));
 await writeFile(operatorPath,JSON.stringify({databaseUrl:operatorUrl.href}));
 const options={identity:async()=>actor,fileAcl:acl,directoryAcl,policyPath,env};
 await withOwnedRecoveryReader(capability,options,async r=>{
  await t.test('strict recovery projection shares exact fingerprint with normal materialization',async()=>{
   const d=await r.deployment(configPath),normal=await materializeRuntimeContext(config,bundle);
   assert.equal(d.configFingerprint,normal.configFingerprint);
   assert.equal(d.configFingerprint,runtimeConfigFingerprint(config));
   assert.throws(()=>validateFileAcl(awaitableAcl(),service),{code:'RUNTIME_ACL_DENIED'});
   function awaitableAcl(){return {protected:true,current:operator,owner:ADMIN,rules:[{sid:service,type:'Allow',rights:1},{sid:ADMIN,type:'Allow',rights:1}]};}
  });
  await t.test('pointer returns whitelist only and recovery DB connection uses independent credentials',async()=>{
   bundle.database.ca='SYNTHETIC_PUBLIC_CA';await save();
   const p=await r.pointer(configPath);assert.deepEqual(Object.keys(p).sort(),['ca','host','name','port']);
   delete bundle.database.ca;await save();
   const loaded=await r.load(configPath),url=new URL(loaded.apiEnv.KTV_MYSQL_URL);
   assert.equal(url.username===operatorUser,true,'recovery uses the owned operator identity');
   assert.equal(url.password===operatorPassword,true,'recovery uses the owned operator credential');
   assert.equal(operatorUser!==bundle.database.user,true,'operator and runtime identities differ');
   assert.equal(operatorPassword!==bundle.database.password,true,'operator and runtime credentials differ');
   assert.equal(operatorUrl.protocol,'mysql:');assert.equal(operatorUrl.hostname,bundle.database.host);assert.equal(Number(operatorUrl.port),bundle.database.port);
   assert.equal(operatorUrl.pathname,'/');assert.equal(operatorUrl.search,'');assert.equal(operatorUrl.hash,'');
   assert.equal(url.pathname,'/'+source);
   const c=await mysql.createConnection({uri:url.href});
   try{const [[actual]]=await c.query('SELECT DATABASE() AS db, @@server_uuid AS uuid');assert.equal(actual.db,source);assert.equal(actual.uuid,f.identity.server_uuid);}finally{await c.end();}
   for(const s of sentinels)assert.equal(JSON.stringify({...loaded,apiEnv:undefined,operatorUrl:undefined}).includes(s),false);
  });
  await t.test('wrong/non-elevated identity and extra operator ACE reject without pointer mutation',async()=>{
   for(const bad of [{sid:operator,elevated:false},{sid:service,elevated:true},{sid:'S-1-5-21-999',elevated:true}]){
    actor=bad;await assert.rejects(()=>r.pointer(configPath));
   }
   actor={sid:operator,elevated:true};broad=true;await assert.rejects(()=>r.pointer(configPath),{code:'RUNTIME_ACL_DENIED'});broad=false;
  });
  await t.test('unsafe, oversized and malformed bundle errors contain no secret output',async()=>{
   const bytes=await readFile(secretPath,'utf8'),errors=[];
   for(const text of ['{'+sentinels[0],JSON.stringify({...bundle,database:{...bundle.database,port:0}}),' '.repeat(65537)]){
    await writeFile(secretPath,text);
    try{await r.pointer(configPath);assert.fail('invalid pointer accepted');}catch(e){errors.push({code:e.code,message:e.message,stack:e.stack});assert.match(e.code,/^(AUTHORIZATION|BOOTSTRAP)_/);}
   }
   await writeFile(secretPath,bytes);
   await writeFile(configPath,JSON.stringify({...config,secretsFile:join(process.cwd(),'package.json')}));
   await assert.rejects(()=>r.pointer(configPath),{code:'AUTHORIZATION_PATH_DENIED'});
   await writeFile(configPath,JSON.stringify({...config,secretsFile:join(root,'missing.json')}));
   await assert.rejects(()=>r.pointer(configPath),{code:'AUTHORIZATION_PATH_DENIED'});await writeFile(configPath,JSON.stringify(config));
   for(const s of sentinels){assert.equal(JSON.stringify(errors).includes(s),false);assert.equal(JSON.stringify(errors).includes(JSON.stringify(s).slice(1,-1)),false);}
  });
  const plan={recoveryOperationId:'12345678-1234-4123-8123-123456789abc',planDigest:'a'.repeat(64),backupSha256:'b'.repeat(64),currentDatabase:source,targetDatabase:target,
   currentHost:'127.0.0.1',targetHost:'127.0.0.1',currentPort:33313,targetPort:33313,sourceServerUuid:f.identity.server_uuid,targetServerUuid:f.identity.server_uuid};
  await t.test('fresh stage reads detect pointer drift rather than retaining first source snapshot',async()=>{
   assert.equal((await r.checkStage(configPath,plan)).side,'SOURCE');
   bundle.database.name=target;await save();await assert.rejects(()=>r.checkStage(configPath,plan),{code:'AUTHORIZATION_POINTER_MISMATCH'});
   bundle.database.name=source;await save();
  });
  await t.test('existing atomic writer under owned recovery checks preserves every non-name field',async()=>{
   bundle.database.ca=tls.certificate;await save();
   const before=hash(bundle),check=path=>r.checkStrictFile(configPath,path);
   for(const bad of [{sid:operator,elevated:false},{sid:'S-1-5-21-999',elevated:true}]){
    actor=bad;await assert.rejects(()=>updateOwnedDatabasePointer(capability,{config},plan,{check,harden:async()=>{}}));
   }
   actor={sid:operator,elevated:true};
   await updateOwnedDatabasePointer(capability,{config},plan,{check,harden:async()=>{},beforeMove:async()=>{
    assert.equal((await r.checkStage(configPath,plan)).side,'SOURCE');
   }});
   const current=JSON.parse(await readFile(secretPath,'utf8'));
   assert.equal(current.database.name,target);current.database.name=source;assert.equal(hash(current),before);
   await assert.rejects(()=>updateOwnedDatabasePointer(capability,{config},plan,{check,harden:async()=>{}}),{code:'PRODUCTION_CUTOVER_POINTER_CONFLICT'});
   await save();
  });
  await t.test('actual error and result paths emit no execution-secret sentinels',async()=>{
   const capture=[],oldLog=console.log,oldError=console.error;let error;
   console.log=(...v)=>capture.push(v);console.error=(...v)=>capture.push(v);
   try{await writeFile(secretPath,'{'+sentinels[0]);try{await r.pointer(configPath);}catch(e){error={code:e.code,message:e.message,stack:e.stack};}}
   finally{console.log=oldLog;console.error=oldError;await save();}
   const result=await r.pointer(configPath),observed=JSON.stringify({capture,error,result});
   assert.equal(capture.length,0);for(const s of sentinels)assert.equal(observed.includes(JSON.stringify(s).slice(1,-1)),false);
  });
  await t.test('production writer never accepts owned capability or plain object as ProductionPlanAuthority',async()=>{
   for(const authority of [undefined,{},capability])await assert.rejects(()=>updateProtectedDatabasePointer({config},plan,{authority,runtimeConfigFile:configPath}),{code:'AUTHORIZATION_AUTHORITY_FORGED'});
  });
 });
 await t.test('production reader cannot take injected OS identity or alternate policy via extra arguments',async()=>{
  await assert.rejects(()=>readRuntimeDeploymentForRecovery(configPath,options),{code:'AUTHORIZATION_OPERATOR_DENIED'});
 });
 }finally{
  try{
   if(setup){
    // Reprove ownership before fixture-only deletion; never clean up an unverified server.
    await assertRegressionFixture(setup,fixtureEnv);
    try{if(accountCreated)await setup.query('DROP USER ?@?',[operatorUser,'127.0.0.1']);}
    finally{if(databaseCreated){assertOwnedDatabase(source,names,ownedDatabases);await setup.query('DROP DATABASE '+source);}}
   }
  }finally{
   await setup?.end();
   if(rootCreated){await assertOwnedRoot(f.root,f.names.id);if(await realpath(root)!==join(capability.root,'artifacts','option-a'))throw Error('OPTION_A_CLEANUP_SCOPE_DENIED');await rm(root,{recursive:true});}
  }
 }
});
