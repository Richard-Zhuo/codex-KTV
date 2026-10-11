import mysql from 'mysql2/promise';
import {randomUUID} from 'node:crypto';
import {dirname,join} from 'node:path';
import {realpath,lstat,readFile,open,rename} from 'node:fs/promises';
import {loadRuntimeConfig,windowsFileAcl,validateFileAcl} from '../production/runtime-config.js';
import {readExternalSecret} from '../production/secret-file.js';
import {windowsDirectoryAcl,validateSmokeAcl,hardenSmokeTemporary} from '../production/wecom-smoke-config.js';
import {externalDirectory,verifyArtifact,canonical,digest} from '../backup/format.js';

const fail=code=>Object.assign(Error(code),{code});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[0-9a-f]{64}$/;
const ACTIVE='active-plan.json',CLAIM='active-plan.claim';
const aclBackupDirectory=async path=>validateSmokeAcl(await windowsDirectoryAcl(path));
const aclJournalDirectory=async path=>validateSmokeAcl(await windowsDirectoryAcl(path),{directory:true});
const aclFile=async path=>validateSmokeAcl(await windowsFileAcl(path));
const candidateName=id=>'jbhh_ktv_recovery_'+id.replaceAll('-','').toLowerCase();
const safeError=e=>/^(BACKUP|PRODUCTION_RESTORE|RUNTIME|SMOKE)_[A-Z_]+$/.test(e?.code??'')?e.code:'PRODUCTION_RESTORE_PREFLIGHT_FAILED';
const safePlan=p=>({eligible:'YES',recoveryOperationId:p.recoveryOperationId,status:p.status,
  backupId:p.backupId,backupCreatedAt:p.backupCreatedAt,backupAgeSeconds:p.backupAgeSeconds,
  backupRevision:p.backupRevision,currentRevision:p.currentRevision,lossWindow:p.lossWindow,
  storeId:p.storeId,ledgerId:p.ledgerId,targetDatabase:p.targetDatabase,
  serverUuidFingerprint:digest(p.targetServerUuid).slice(0,16),
  applicationCommit:p.applicationCommit,schemaMigration:p.schemaMigration,
  planDigest:p.planDigest,CURRENT_PRODUCTION_DB_READABLE:'YES'});
const exactKeys=(obj,keys)=>obj&&typeof obj==='object'&&!Array.isArray(obj)&&
  Object.keys(obj).length===keys.length&&keys.every(k=>Object.hasOwn(obj,k));
const planKeys=['formatVersion','recoveryOperationId','status','createdAt','operatorSid',
  'backupId','backupSha256','backupCreatedAt','backupAgeSeconds','backupRevision',
  'storeId','ledgerId','sourceEnvironment','sourceServerUuid','sourceDatabase',
  'schemaMigration','schemaDigest','applicationCommit','targetServerUuid',
  'targetDatabase','targetHost','targetPort','currentDatabase','currentHost','currentPort',
  'currentRevision','lossWindow','planDigest'];
function validatePlan(plan){
 if(!exactKeys(plan,planKeys)||plan.formatVersion!==1||plan.status!=='PREPARED'||
   !UUID.test(plan.recoveryOperationId)||!HASH.test(plan.backupSha256)||
   !HASH.test(plan.schemaDigest)||!HASH.test(plan.planDigest)||
   plan.targetDatabase!==candidateName(plan.recoveryOperationId)||
   plan.targetDatabase===plan.currentDatabase||
   plan.targetHost!==plan.currentHost||plan.targetPort!==plan.currentPort||
   !Number.isInteger(plan.targetPort)||plan.targetPort<1||plan.targetPort>65535||
   plan.sourceEnvironment!=='production'||plan.sourceServerUuid!==plan.targetServerUuid||
   plan.sourceDatabase!==plan.currentDatabase||
   !Number.isFinite(Date.parse(plan.createdAt))||
   !Number.isFinite(Date.parse(plan.backupCreatedAt))||
   !Number.isSafeInteger(plan.backupAgeSeconds)||plan.backupAgeSeconds<0||
   !Number.isSafeInteger(plan.backupRevision)||plan.backupRevision<0||
   !Number.isSafeInteger(plan.currentRevision)||plan.currentRevision<0||
   !exactKeys(plan.lossWindow,['classification','revisionGap','note'])||
   plan.lossWindow.classification!=='KNOWN'||
   !Number.isSafeInteger(plan.lossWindow.revisionGap)||plan.lossWindow.revisionGap<0||
   plan.lossWindow.revisionGap!==plan.currentRevision-plan.backupRevision||
   plan.lossWindow.note!=='Revision gap only; backup createdAt is not a PITR coordinate')
   throw fail('PRODUCTION_RESTORE_PLAN_INVALID');
 const {planDigest,...body}=plan;
 if(digest(canonical(body))!==planDigest)throw fail('PRODUCTION_RESTORE_PLAN_INVALID');
 return plan;
}
async function checkedPaths(loaded,artifactDirectory,{backupAcl=aclBackupDirectory,journalAcl=aclJournalDirectory,fileAcl=aclFile}={}){
 const backupRoot=loaded.config.monitoring?.backupDirectory;
 const journalRoot=loaded.config.recovery?.journalDirectory;
 if(!backupRoot||!journalRoot)throw fail('PRODUCTION_RESTORE_PATH_POLICY_REQUIRED');
 const [backup,journal]=await Promise.all([externalDirectory(backupRoot),externalDirectory(journalRoot)]);
 await backupAcl(backup);await journalAcl(journal);
 if(!artifactDirectory)return {backup,journal};
 const artifact=await externalDirectory(artifactDirectory);
 if(dirname(artifact)!==backup)throw fail('PRODUCTION_RESTORE_BACKUP_PATH_DENIED');
 await backupAcl(artifact);
 for(const name of ['manifest.json','manifest.sha256','data.json']){
  const file=join(artifact,name),info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||await realpath(file)!==file)
    throw fail('PRODUCTION_RESTORE_BACKUP_PATH_DENIED');
  await fileAcl(file);
 }
 return {backup,journal,artifact};
}
export async function loadOperatorDatabase(loaded,{read=readExternalSecret,fileAcl=windowsFileAcl}={}){
 const path=loaded.config.recovery?.operatorDbSecretsFile;
 if(!path)throw fail('PRODUCTION_RESTORE_OPERATOR_CONFIG_REQUIRED');
 const actual=await realpath(path);
 await externalDirectory(dirname(actual));
 validateFileAcl(await fileAcl(actual),loaded.config.serviceAccountSid);
 const config=await read(actual);
 if(!exactKeys(config,['databaseUrl']))throw fail('PRODUCTION_RESTORE_OPERATOR_CONFIG_INVALID');
 let url,active;try{url=new URL(config.databaseUrl);active=new URL(loaded.apiEnv.KTV_MYSQL_URL);}catch{throw fail('PRODUCTION_RESTORE_OPERATOR_CONFIG_INVALID');}
 if(url.protocol!=='mysql:'||!url.username||!url.password||url.pathname!=='/'||url.search||url.hash||
   url.hostname!==active.hostname||Number(url.port||3306)!==Number(active.port||3306))
   throw fail('PRODUCTION_RESTORE_TARGET_SERVER_MISMATCH');
 return url.href;
}
async function dbConnection(url,ssl){
 return mysql.createConnection({uri:url,ssl,dateStrings:true,jsonStrings:true,
   supportBigNumbers:true,bigNumberStrings:true});
}
export async function inspectProductionRestore({runtimeConfigFile,artifactDirectory,expectedChecksum,
  recoveryOperationId=randomUUID(),now=new Date(),load=loadRuntimeConfig,connect=dbConnection,
  artifactVerifier=verifyArtifact,pathCheck=checkedPaths,operatorLoad=loadOperatorDatabase}){
 if(!UUID.test(recoveryOperationId)||!HASH.test(expectedChecksum??''))
   throw fail('PRODUCTION_RESTORE_ARGUMENTS_INVALID');
 const loaded=await load(runtimeConfigFile);
 const {artifact}=await pathCheck(loaded,artifactDirectory);
 const {manifest,spec}=await artifactVerifier(artifact,{expectedChecksum,
   storeId:loaded.config.storeId,ledgerId:loaded.config.ledgerId});
 if(manifest.source.environment!=='production')throw fail('PRODUCTION_RESTORE_SOURCE_NOT_PRODUCTION');
 if(manifest.applicationCommit!==loaded.config.applicationCommit)
   throw fail('PRODUCTION_RESTORE_APPLICATION_INCOMPATIBLE');
 const activeUrl=new URL(loaded.apiEnv.KTV_MYSQL_URL),activeDb=decodeURIComponent(activeUrl.pathname.slice(1));
 const targetDatabase=candidateName(recoveryOperationId);
 if(!/^[a-z][a-z0-9_]{0,63}$/.test(targetDatabase)||targetDatabase===activeDb)
   throw fail('PRODUCTION_RESTORE_TARGET_INVALID');
 const adminUrl=await operatorLoad(loaded);
 let admin,source;
 try{
  admin=await connect(adminUrl,loaded.mysqlSsl);
  const [grants]=await admin.query('SHOW GRANTS FOR CURRENT_USER()');
  if(!grants.some(row=>Object.values(row).some(value=>typeof value==='string'&&
    /\bSHOW DATABASES\b.*\bON \*\.\*/i.test(value))))
    throw fail('PRODUCTION_RESTORE_METADATA_VISIBILITY_REQUIRED');
  const [[server]]=await admin.query('SELECT @@server_uuid AS server_uuid, VERSION() AS version');
  if(server.server_uuid!==manifest.source.serverUuid||!/^8\.4\./.test(server.version))
   throw fail('PRODUCTION_RESTORE_TARGET_SERVER_MISMATCH');
  const [existing]=await admin.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[targetDatabase]);
  if(existing.length)throw fail('PRODUCTION_RESTORE_TARGET_EXISTS');
  let heads,receipts,control;
  try{
   source=await connect(activeUrl.href,loaded.mysqlSsl);
   const [[current]]=await source.query('SELECT DATABASE() AS db, @@server_uuid AS server_uuid');
   if(current.db!==activeDb||current.server_uuid!==server.server_uuid)
    throw fail('PRODUCTION_RESTORE_TARGET_SERVER_MISMATCH');
   [heads]=await source.query('SELECT ledger_id,revision,state_checksum FROM ledger_heads');
   [receipts]=await source.query('SELECT store_id,ledger_id,environment,facts FROM production_bootstrap_events');
   [[control]]=await source.query('SELECT mode FROM recovery_control WHERE control_id=1');
  }catch(error){
   if(/^PRODUCTION_RESTORE_/.test(error?.code??''))throw error;
   const blocked=fail('PRODUCTION_RESTORE_CURRENT_DB_UNREADABLE');
   blocked.safe={eligible:'NO',code:blocked.code,CURRENT_PRODUCTION_DB_READABLE:'NO',
     CURRENT_LEDGER_HEAD:'UNKNOWN',DATA_LOSS_WINDOW:'UNKNOWN'};
   throw blocked;
  }
  if(manifest.source.database!==activeDb||heads.length!==1||
    heads[0].ledger_id!==loaded.config.ledgerId||
    !receipts.length||receipts.some(r=>r.store_id!==loaded.config.storeId||
      r.ledger_id!==loaded.config.ledgerId||r.environment!=='production')||
    !receipts.some(r=>{try{const f=JSON.parse(r.facts);return f.source==='first-install-ledger'&&
      f.serverUuid===server.server_uuid&&f.database===activeDb;}catch{return false;}}))
   throw fail('PRODUCTION_RESTORE_SOURCE_IDENTITY_MISMATCH');
  if(control&&control.mode!=='NORMAL')throw fail('PRODUCTION_RESTORE_SOURCE_NOT_NORMAL');
  const age=Math.floor((new Date(now).getTime()-Date.parse(manifest.createdAt))/1000);
  if(!Number.isSafeInteger(age)||age<0)throw fail('PRODUCTION_RESTORE_BACKUP_TIME_INVALID');
  const backupHead=manifest.ledgerHeads.find(h=>h.ledgerId===loaded.config.ledgerId);
  const currentRevision=Number(heads[0].revision);
  if(!backupHead||!Number.isSafeInteger(currentRevision)||currentRevision<backupHead.revision)
   throw fail('PRODUCTION_RESTORE_REVISION_MISMATCH');
  const body={formatVersion:1,recoveryOperationId,status:'PREPARED',
   createdAt:new Date(now).toISOString(),operatorSid:loaded.config.serviceAccountSid,
   backupId:manifest.backupId,backupSha256:expectedChecksum,
   backupCreatedAt:manifest.createdAt,backupAgeSeconds:age,backupRevision:backupHead.revision,
   storeId:loaded.config.storeId,ledgerId:loaded.config.ledgerId,
   sourceEnvironment:manifest.source.environment,sourceServerUuid:manifest.source.serverUuid,
   sourceDatabase:manifest.source.database,schemaMigration:manifest.migrationVersion,
   schemaDigest:digest(canonical(spec.manifest)),applicationCommit:manifest.applicationCommit,
   targetServerUuid:server.server_uuid,targetDatabase,
   targetHost:activeUrl.hostname,targetPort:Number(activeUrl.port||3306),
   currentDatabase:activeDb,currentHost:activeUrl.hostname,currentPort:Number(activeUrl.port||3306),
   currentRevision,
   lossWindow:{classification:'KNOWN',revisionGap:currentRevision-backupHead.revision,
     note:'Revision gap only; backup createdAt is not a PITR coordinate'}};
  return Object.freeze({...body,planDigest:digest(canonical(body))});
 }finally{await source?.end();await admin?.end();}
}
export async function createProductionRestorePlan(args,{
 inspect=inspectProductionRestore,pathCheck=checkedPaths,harden=hardenSmokeTemporary,
 fileAcl=aclFile,load=loadRuntimeConfig}={}){
 const plan=validatePlan(await inspect(args));
 const loaded=await load(args.runtimeConfigFile),{journal}=await pathCheck(loaded,args.artifactDirectory);
 const currentUrl=new URL(loaded.apiEnv.KTV_MYSQL_URL);
 if(loaded.config.storeId!==plan.storeId||loaded.config.ledgerId!==plan.ledgerId||
   loaded.config.applicationCommit!==plan.applicationCommit||
   loaded.config.serviceAccountSid!==plan.operatorSid||
   decodeURIComponent(currentUrl.pathname.slice(1))!==plan.currentDatabase||
   currentUrl.hostname!==plan.currentHost||Number(currentUrl.port||3306)!==plan.currentPort)
   throw fail('PRODUCTION_RESTORE_CONFIG_CHANGED');
 const claim=join(journal,CLAIM),target=join(journal,ACTIVE),
   temp=join(journal,'plan-'+plan.recoveryOperationId+'.tmp');
 let reservation;
 try{await lstat(target);throw fail('PRODUCTION_RESTORE_ACTIVE_RECOVERY_EXISTS');}
 catch(error){if(error.code!=='ENOENT')throw error;}
 try{reservation=await open(claim,'wx',0o600);}
 catch(error){if(error.code==='EEXIST')throw fail('PRODUCTION_RESTORE_ACTIVE_RECOVERY_EXISTS');throw error;}
 try{
  await harden(claim);await reservation.sync();await reservation.close();reservation=null;
  // A crash leaves the claim in place. It blocks further plans for manual review.
  const handle=await open(temp,'wx',0o600);
  try{await harden(temp);await handle.writeFile(canonical(plan));await handle.sync();}
  finally{await handle.close();}
  try{await lstat(target);throw fail('PRODUCTION_RESTORE_ACTIVE_RECOVERY_EXISTS');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  await rename(temp,target);
  await fileAcl(target);
  return safePlan(plan);
 }finally{await reservation?.close();}
}
export async function inspectProductionRestorePlan({runtimeConfigFile,load=loadRuntimeConfig,
 pathCheck=checkedPaths,fileAcl=aclFile}){
 const loaded=await load(runtimeConfigFile),{journal}=await pathCheck(loaded);
 const file=join(journal,ACTIVE),info=await lstat(file);
 if(!info.isFile()||info.isSymbolicLink()||info.size>65536||await realpath(file)!==file)
  throw fail('PRODUCTION_RESTORE_PLAN_INVALID');
 await fileAcl(file);
 return safePlan(validatePlan(JSON.parse(await readFile(file,'utf8'))));
}
export {safeError,candidateName,validatePlan,checkedPaths};
