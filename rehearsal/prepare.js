import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {freshEnvironment,migrateDatabase,uniquePerson,ACCEPTED} from './fresh-environment.js';
import {migrateFresh} from './migration.js';
import {initialState} from '../rules.js';
import {PERMISSION_IDS} from '../shared/identity.js';
import {POLICY_ATTRIBUTE_IDS} from '../ledger/command-policy.js';
import {bootstrapIdentities} from '../production/bootstrap.js';
import {inspectFirstInstall,applyInitialLedger,applyOpeningInventory,firstInstallConfirmation} from '../production/first-install.js';
import {bootstrapRehearsalMappings} from './mapping.js';
import {readProductionReadiness} from '../production/readiness.js';
import {validateSchema} from '../production/schema.js';
import {createMySqlAuthStore} from '../auth/mysql-store.js';
import {createAuthService} from '../auth/service.js';
import {createMemoryLoginRateLimiter} from '../auth/rate-limit.js';
import {createMySqlEmployeeStore} from '../employees/mysql-store.js';
import {createMySqlLedgerStore} from '../ledger/mysql-store.js';
import {backupDatabase,restoreDatabase,connect} from '../backup/mysql-backup.js';
import {verifyRecovery,resumeRecovery} from '../recovery/operator.js';
import {join} from 'node:path';
export async function initialize(f,database,environment='test',onCheckpoint){
 const {pool,migration}=await migrateDatabase(f,database);
 const state=initialState();
 const config={environment,database,storeId:f.names.storeId,ledgerId:f.names.ledgerId,applicationCommit:ACCEPTED,timeZone:'Asia/Shanghai',deviceControlMode:'disabled'};
 const checkpoints=[],check=async step=>{const r=await readProductionReadiness({pool,config});checkpoints.push({step,ready:r.ready,revision:r.revision,blockers:r.blockers.map(b=>b.code)});await onCheckpoint?.(step);return r;};
 process.stdout.write(JSON.stringify({event:'initializing',database,environment})+'\n');
 const before=await check('after migration');assert.equal(before.ready,false);assert.ok(before.blockers.some(b=>b.code==='OPENING_INVENTORY_REQUIRED'));
 const people=[uniquePerson('owner',PERMISSION_IDS,POLICY_ATTRIBUTE_IDS),uniquePerson('manager',['backend.view','credit.approve','rounding.approve'],['credit.approval.manager']),uniquePerson('operator'),uniquePerson('limited'),uniquePerson('viewer',['backend.view']),uniquePerson('booking')];
 const password=randomBytes(32).toString('base64url'),passwords=Object.fromEntries(people.map(p=>[p.principalId,password]));
 f.secretMarkers.add(password);
 const plan={configVersion:'rehearsal-'+f.names.id,environment,database,storeId:f.names.storeId,ledgerId:f.names.ledgerId,approved:true,people};
 const databaseUrl=f.dbUrl(database),env=environment==='test'?{LEDGER_MYSQL_TEST_URL:databaseUrl}:{NODE_ENV:'production',KTV_HTTP_ENV:'production',KTV_DEPLOYMENT_ENV:'production'},confirmation=database+'/'+f.names.storeId+'/'+f.names.ledgerId;
 const args={pool,plan,databaseUrl,confirmation,initiatedBy:'REHEARSAL-OPERATOR-'+f.names.id,env,passwords};
 assert.equal((await bootstrapIdentities(args)).status,'planned');
 assert.equal((await bootstrapIdentities({...args,dryRun:false})).accountsCreated,6);
 assert.equal((await bootstrapIdentities({...args,dryRun:false,passwords:{}})).status,'already_satisfied');
 await check('after bootstrap');
 const ledgerPlan={version:1,environment,database,serverUuid:f.identity.server_uuid,storeId:f.names.storeId,ledgerId:f.names.ledgerId,applicationCommit:ACCEPTED,kind:'ledger'};
 const install={pool,plan:ledgerPlan,databaseUrl,config,env};
 assert.equal((await inspectFirstInstall(install)).ledgerInitialized,false);
 assert.equal((await applyInitialLedger({...install,confirmation:firstInstallConfirmation(ledgerPlan),initiatedBy:'REHEARSAL-OPERATOR-'+f.names.id})).status,'initialized');
 assert.equal((await applyInitialLedger({...install,confirmation:firstInstallConfirmation(ledgerPlan),initiatedBy:'REHEARSAL-OPERATOR-'+f.names.id})).status,'already_initialized');
 await check('after ledger');
 const authStore=createMySqlAuthStore({pool,database}),auth=createAuthService({store:authStore,rateLimiter:createMemoryLoginRateLimiter()}),employees=createMySqlEmployeeStore({pool,database});
 const store=createMySqlLedgerStore({pool,database,ledgerId:f.names.ledgerId,bindSessionRevalidation:authStore.bindSessionRevalidation,bindEmployeeResolver:employees.bindEmployeeResolver});
 for(const [stockKind,stocks] of [['drink',state.inventory],['consumable',state.consumables]])for(const productId of Object.keys(stocks)){
  const before=await store.read(),common={version:1,environment,database,serverUuid:f.identity.server_uuid,storeId:f.names.storeId,ledgerId:f.names.ledgerId,applicationCommit:ACCEPTED};
  const stockPlan={...common,kind:'stock',operationKey:randomUUID(),expectedRevision:before.revision,actorPrincipalId:people[0].principalId,
    stockKind,productId,count:1000,reason:'REHEARSAL opening count',...(stockKind==='consumable'?{opened:0}:{})};
  const credential={loginIdentifier:people[0].loginIdentifier,password};
  assert.equal((await applyOpeningInventory({pool,plan:stockPlan,databaseUrl,config,env,confirmation:firstInstallConfirmation(stockPlan),credential})).status,'committed');
  const next=await store.read(),request=next.state.inventoryReviews.at(-1);
  const approvalPlan={...common,kind:'approve',operationKey:randomUUID(),expectedRevision:next.revision,actorPrincipalId:people[0].principalId,
    requestId:request.id,decisionNote:'REHEARSAL counted and reviewed'};
  assert.equal((await applyOpeningInventory({pool,plan:approvalPlan,databaseUrl,config,env,confirmation:firstInstallConfirmation(approvalPlan),credential})).status,'committed');
 }
 const stocked=await check('after inventory');assert.equal(stocked.ready,true);
 // The accepted mapping API requires human-confirmed metadata. Keep it intact;
 // the separate rehearsal envelope records the simulator provenance explicitly.
 const mappings=state.rooms.filter(r=>r.id!=='V06').map(r=>({internalRoomId:r.id,provider:'ktvsky',externalDeviceId:'REHEARSAL-FAKE-'+f.names.id+'-'+r.id,enabled:true,source:'rehearsal-confirmed',confirmedAt:new Date().toISOString(),confirmedBy:'REHEARSAL-SIMULATOR-'+f.names.id}));
 const mappingPlan={configVersion:'rehearsal-map-'+f.names.id,environment,database,storeId:f.names.storeId,ledgerId:f.names.ledgerId,approved:true,mappings};
 if(environment==='test'){const ma={pool,plan:mappingPlan};assert.equal((await bootstrapRehearsalMappings(f,ma)).status,'planned');await bootstrapRehearsalMappings(f,{...ma,dryRun:false});assert.equal((await bootstrapRehearsalMappings(f,{...ma,dryRun:false})).status,'already_satisfied');const altered=structuredClone(mappingPlan);altered.mappings[0].externalDeviceId+='-conflict';await assert.rejects(bootstrapRehearsalMappings(f,{...ma,plan:altered,dryRun:false}),/REHEARSAL_MAPPING_CONFLICT/);}
 await check('after mapping');
 const c=await pool.getConnection();try{assert.equal((await validateSchema(c,database)).tables,20);await assert.rejects(migrateFresh(c,f.packages.current.applicationRoot),/MIGRATION_TARGET_NOT_EMPTY/);}finally{c.release();}
 return {pool,store,auth,people,password,checkpoints,check,config,migration,provenance:{source:'rehearsal-confirmed',provider:'FakeGateway',mappingApiSource:'rehearsal-confirmed',realMapping:false,excludedRoom:'V06'}};
}
export async function makeBackup(f,outputDirectory){
 return backupDatabase({databaseUrl:f.dbUrl(f.names.database),environment:'test',storeId:f.names.storeId,ledgerId:f.names.ledgerId,serverUuid:f.identity.server_uuid,confirmation:f.identity.server_uuid+'/'+f.names.database+'/'+f.names.storeId+'/'+f.names.ledgerId,outputDirectory,applicationCommit:ACCEPTED,env:{LEDGER_MYSQL_TEST_URL:f.dbUrl(f.names.database)}});
}
export async function restore(f,backup,label){
 const database='jbhh_ktv_restore_s5e_'+label+'_'+f.names.id;await f.registerRestore(database);
 const args={directory:backup.directory,expectedChecksum:backup.checksum,databaseUrl:f.dbUrl(database),serverUuid:f.identity.server_uuid,environment:'test',storeId:f.names.storeId,ledgerId:f.names.ledgerId,confirmation:f.identity.server_uuid+'/'+database+'/'+f.names.storeId+'/'+f.names.ledgerId+'/'+backup.checksum,restoreToNewDb:true,initiatedBy:'REHEARSAL-RECOVERY-'+f.names.id,env:{}};
 await restoreDatabase(args);const verified=await verifyRecovery(args);assert.equal(verified.mode,'READY_FOR_RESUME');await resumeRecovery({...args,confirmation:args.confirmation+'/RESUME'});
 return {database,args,verified};
}
export async function prepare(repository){
 const f=await freshEnvironment(repository);
 try{
  const failure=await f.createDatabase(f.names.failureDatabase);f.pools.add(failure);const c=await failure.getConnection();
  try{await assert.rejects(migrateFresh(c,f.packages.current.applicationRoot,{failAfterFile:'002_mysql_auth_core.sql'}),/REHEARSAL_MIGRATION_FAILURE/);await assert.rejects(validateSchema(c,f.names.failureDatabase),{code:'BOOTSTRAP_SCHEMA_MISMATCH'});const [tables]=await c.query('SHOW TABLES');assert.ok(tables.length>0);const p=uniquePerson('failure');await assert.rejects(bootstrapIdentities({pool:failure,plan:{configVersion:'rehearsal-failure',environment:'production',database:f.names.failureDatabase,storeId:f.names.storeId,ledgerId:f.names.ledgerId,approved:true,people:[p]},databaseUrl:f.dbUrl(f.names.failureDatabase),confirmation:f.names.failureDatabase+'/'+f.names.storeId+'/'+f.names.ledgerId,initiatedBy:'REHEARSAL-OPERATOR',env:{}}),{code:'BOOTSTRAP_SCHEMA_MISMATCH'});assert.equal((await c.query('SHOW TABLES'))[0].length,tables.length);}
  finally{c.release();}
  f.source=await initialize(f,f.names.database);
  f.firstBackup=await makeBackup(f,join(f.dirs.backups,'C2'));
  f.active=await restore(f,f.firstBackup,'active');
  return f;
 }catch(e){await f.cleanup();throw e;}
}
