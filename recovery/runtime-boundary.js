import {basename,dirname,relative,isAbsolute} from 'node:path';
import {validateRuntimeConfig,validateRuntimeFileAclStructure,windowsFileAcl,privateHost,runtimeConfigFingerprint} from '../production/runtime-config.js';
import {readExternalSecret} from '../production/secret-file.js';
import {windowsDirectoryAcl} from '../production/wecom-smoke-config.js';
import {canonicalProtectedPath,validateRecoveryPolicy,validateRecoveryAcl,windowsRecoveryIdentity,RECOVERY_POLICY_FILE,exact} from './production-authorization-context.js';
import {readExecutionState} from './production-journal.js';
import {readCutoverState} from './production-cutover-journal.js';
import {readC3State} from './production-c3-journal.js';
import {withOwnedCandidateRead} from './production-candidate.js';
const fail=code=>Object.assign(Error(code),{code});
const ADMIN='S-1-5-32-544';
const name=value=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(value);
const endpoint=p=>{const u=new URL('mysql://localhost');u.hostname=p.host;u.port=String(p.port);return [u.hostname,Number(u.port||3306)];};
export function parseRecoveryDatabaseCredential(secret,pointer,plan){
 try{
  if(!exact(secret,['databaseUrl']))throw Error();
  const u=new URL(secret.databaseUrl),[host,port]=endpoint(pointer);
  if(u.protocol!=='mysql:'||!u.username||!u.password||u.pathname!=='/'||u.search||u.hash||
   u.hostname!==host||Number(u.port||3306)!==port||plan&&
   (plan.currentHost!==host||plan.targetHost!==host||plan.currentPort!==port||plan.targetPort!==port))throw Error();
  return u.href;
 }catch{throw fail('AUTHORIZATION_CREDENTIAL_INVALID');}
}
export function validateRecoveryPointer(pointer,plan,{execution=null,cutover=null,c3=null}={}){
 const reject=()=>{throw fail('AUTHORIZATION_POINTER_MISMATCH');};
 const [host,port]=endpoint(pointer);
 if(plan.sourceServerUuid!==plan.targetServerUuid||host!==plan.currentHost||host!==plan.targetHost||port!==plan.currentPort||port!==plan.targetPort)reject();
 for(const s of [execution,cutover,c3].filter(Boolean)){
  if(s.recoveryOperationId!==plan.recoveryOperationId||s.planDigest!==plan.planDigest)reject();
 }
 if(execution&&!['FREEZE_INTENT','FROZEN','RESTORING','VERIFYING'].includes(execution.state))reject();
 if(cutover&&(!['CUTOVER_INTENT','CUTOVER_SWITCHED'].includes(cutover.state)||execution?.state!=='VERIFYING'))reject();
 if(c3&&(!['READY_INTENT','READY_FOR_RESUME','RESUME_INTENT','RESUMED'].includes(c3.state)||cutover?.state!=='CUTOVER_SWITCHED'))reject();
 const side=pointer.name===plan.currentDatabase?'SOURCE':pointer.name===plan.targetDatabase?'TARGET':null;
 if(!side||(!cutover&&side!=='SOURCE')||(cutover?.state==='CUTOVER_SWITCHED'&&side!=='TARGET'))reject();
 return Object.freeze({side,stage:c3?.state??cutover?.state??execution?.state??'PREPARED'});
}
// No runtime execution credential/key/provider context escapes this local scope.
function projectPointer(bundle){
 const bad=()=>{throw fail('AUTHORIZATION_POINTER_INVALID');};
 if(!bundle||Array.isArray(bundle)||!bundle.database||Array.isArray(bundle.database)||!bundle.tls||Array.isArray(bundle.tls))bad();
 if(!['database','tls'].every(k=>Object.hasOwn(bundle,k))||Object.keys(bundle).some(k=>!['database','tls','ktvsky','backup','alerting'].includes(k)))bad();
 const db=bundle.database;
 if(!['host','port','name','user','password'].every(k=>Object.hasOwn(db,k))||Object.keys(db).some(k=>!['host','port','name','user','password','ca'].includes(k))||
  !privateHost(db.host)||!Number.isInteger(db.port)||db.port<1||db.port>65535||!name(db.name)||
  typeof db.user!=='string'||!db.user||typeof db.password!=='string'||db.password.length<16||
  !exact(bundle.tls,['certificate','privateKey'])||typeof bundle.tls.certificate!=='string'||typeof bundle.tls.privateKey!=='string'||
  db.ca!==undefined&&typeof db.ca!=='string'||!['localhost','127.0.0.1','::1'].includes(db.host)&&!db.ca)bad();
 return Object.freeze({host:db.host,port:db.port,name:db.name,...(db.ca?{ca:db.ca}:{})});
}
function reader({identity=windowsRecoveryIdentity,fileAcl=windowsFileAcl,directoryAcl=windowsDirectoryAcl,
 policyPath=RECOVERY_POLICY_FILE,env=process.env,scope=async()=>{}}={}){
 const canonical=async(path,options)=>{const p=await canonicalProtectedPath(path,options);await scope(p);return p;};
 async function admit(configPath){
  const actor=await identity();
  if(actor.elevated!==true)throw fail('AUTHORIZATION_OPERATOR_DENIED');
  const policyFile=await canonical(policyPath);
  const policy=validateRecoveryPolicy(await readExternalSecret(policyFile),actor);
  validateRecoveryAcl(await fileAcl(policyFile),{identity:actor,runtimeServiceSid:policy.runtimeServiceSid,policy:true});
  const parent=await canonical(dirname(policyFile),{directory:true});
  validateRecoveryAcl(await directoryAcl(parent),{identity:actor,runtimeServiceSid:policy.runtimeServiceSid,shared:true,directory:true});
  const configured=await canonical(configPath),bound=await canonical(policy.runtimeConfigFile);
  if(configured!==bound)throw fail('AUTHORIZATION_DEPLOYMENT_MISMATCH');
  return {actor,policy,configured};
 }
 async function strict(path,admission){
  const p=await canonical(path),acl=await fileAcl(p);
  validateRuntimeFileAclStructure(acl,admission.policy.runtimeServiceSid);
  if(acl.current!==admission.actor.sid||!acl.rules.some(r=>r.sid===ADMIN&&r.type==='Allow'&&(r.rights&1))||
   acl.rules.some(r=>r.sid===ADMIN&&r.type==='Deny'&&(r.rights&1)))throw fail('AUTHORIZATION_ACL_DENIED');
  return p;
 }
 async function deployment(configPath){
  const a=await admit(configPath);await strict(a.configured,a);
  const c=validateRuntimeConfig(await readExternalSecret(a.configured),env);
  if(c.serviceAccountSid!==a.policy.runtimeServiceSid||a.actor.sid===c.serviceAccountSid||!c.recovery||!c.monitoring?.backupDirectory)
   throw fail('AUTHORIZATION_DEPLOYMENT_MISMATCH');
  const secretsFile=await strict(c.secretsFile,a);
  const config=Object.freeze({...c,secretsFile,recovery:Object.freeze({...c.recovery}),monitoring:Object.freeze({...c.monitoring})});
  return {config,configFingerprint:runtimeConfigFingerprint(c),actor:a.actor,policy:a.policy};
 }
 async function pointer(configPath){
  try{const d=await deployment(configPath);return projectPointer(await readExternalSecret(d.config.secretsFile));}
  catch(e){throw fail(/^(AUTHORIZATION|RUNTIME|BOOTSTRAP)_[A-Z_]+$/.test(e.code??'')?e.code:'AUTHORIZATION_POINTER_INVALID');}
 }
 async function load(configPath){
  const d=await deployment(configPath),p=projectPointer(await readExternalSecret(d.config.secretsFile));
  const secretPath=await canonical(d.config.recovery.operatorDbSecretsFile);
  validateRecoveryAcl(await fileAcl(secretPath),{identity:d.actor,runtimeServiceSid:d.config.serviceAccountSid});
  const operatorUrl=parseRecoveryDatabaseCredential(await readExternalSecret(secretPath),p);
  const url=new URL(operatorUrl);url.pathname='/'+p.name;
  return {...d,pointer:p,apiEnv:{KTV_MYSQL_URL:url.href},operatorUrl,
   mysqlSsl:p.ca?{ca:p.ca,rejectUnauthorized:true}:undefined};
 }
 async function checkStage(configPath,plan){
  const d=await deployment(configPath),p=projectPointer(await readExternalSecret(d.config.secretsFile)),access={identity:d.actor,runtimeServiceSid:d.config.serviceAccountSid,shared:true};
  const checkAcl=async file=>{await canonical(file);validateRecoveryAcl(await fileAcl(file),access);};
  const journal=await canonical(d.config.recovery.journalDirectory,{directory:true});
  validateRecoveryAcl(await directoryAcl(journal),{...access,directory:true});
  const execution=await readExecutionState(journal,plan,{checkAcl}),cutover=await readCutoverState(journal,plan,{checkAcl}),c3=await readC3State(journal,plan,{checkAcl});
  return {deployment:d,pointer:p,execution,cutover,c3,...validateRecoveryPointer(p,plan,{execution,cutover,c3})};
 }
 return Object.freeze({deployment,pointer,load,checkStage,
  async checkStrictFile(configPath,path){
   const d=await deployment(configPath),expected=d.config.secretsFile;
   if(path!==expected&&!(dirname(path)===dirname(expected)&&/^cutover-secret-[a-f0-9-]+\.tmp$/.test(basename(path))))throw fail('AUTHORIZATION_PATH_DENIED');
   return strict(path,{actor:d.actor,policy:d.policy});}});
}
const production=()=>reader();
export const readRuntimeDeploymentForRecovery=path=>production().deployment(path);
export const readRuntimeDatabasePointerForRecovery=path=>production().pointer(path);
export const loadRecoveryDeployment=path=>production().load(path);
export const checkRecoveryRuntimeFile=(configPath,path)=>production().checkStrictFile(configPath,path);
export const checkRecoveryPointerStage=(path,plan)=>production().checkStage(path,plan);
// OS substitution exists only after the existing disposable MySQL capability proves ownership.
export async function withOwnedRecoveryReader(capability,options,work){
 const owned=await withOwnedCandidateRead(capability,async()=>{
  const scope=async path=>{const rel=relative(capability.root,path);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw fail('AUTHORIZATION_TEST_SCOPE_DENIED');};
  return reader({...options,scope});
 });
 return work(owned);
}
