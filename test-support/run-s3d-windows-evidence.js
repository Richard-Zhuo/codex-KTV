// TEST SUPPORT ONLY. Read-only evidence, actual OS identity/ACL; no execution authority.
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixtureId,readProtectedFixture} from './protected-windows-fixture.js';
import {createRuntimeReaderCore} from '../recovery/runtime-reader-core.js';
import {windowsFileAcl,loadRuntimeConfig} from '../production/runtime-config.js';
import {exact} from '../recovery/production-authorization-context.js';
const fail=code=>Object.assign(Error(code),{code});
const schemaEnvironment=Object.freeze({NODE_ENV:'production',KTV_HTTP_ENV:'production',KTV_DEPLOYMENT_ENV:'production'});
const codes=new Set(['FIXTURE_ID_INVALID','FIXTURE_ARGUMENTS_INVALID','FIXTURE_MARKER_INVALID',
 'FIXTURE_PRODUCTION_ENV_DENIED','FIXTURE_PROFILE_UNVERIFIED','FIXTURE_SCOPE_DENIED','FIXTURE_SHAPE_INVALID',
 'AUTHORIZATION_OPERATOR_DENIED','AUTHORIZATION_PATH_DENIED','AUTHORIZATION_ACL_DENIED',
 'RUNTIME_ACL_DENIED','RUNTIME_CONFIG_INVALID','RUNTIME_NODE_UNSUPPORTED','BOOTSTRAP_SECRET_FILE_DENIED']);
export const safeWindowsEvidenceError=error=>codes.has(error?.code)?error.code:'FIXTURE_EVIDENCE_FAILED';
export function evidenceFixtureId(argv){
 if(!Array.isArray(argv)||argv.length!==2||argv[0]!=='--fixture-id')throw fail('FIXTURE_ARGUMENTS_INVALID');
 return fixtureId(argv[1]);
}
export async function runWindowsEvidence(id){
 if(arguments.length!==1)throw fail('FIXTURE_ARGUMENTS_INVALID');
 fixtureId(id);
 const f=await readProtectedFixture(id),configPath=join(f.root,'secrets','runtime.json'),secretPath=join(f.root,'secrets','runtime-secrets.json');
 const allowed=new Set([f.policy,join(f.root,'policy'),configPath,secretPath]);
 const scope=async path=>{if(!allowed.has(path))throw fail('FIXTURE_SCOPE_DENIED');};
 const core=createRuntimeReaderCore({policyPath:f.policy,env:schemaEnvironment,scope});
 const base={FIXTURE_ID:id,SID_MATCH:'YES',ELEVATED:f.identity.elevated?'YES':'NO',
  ADMINISTRATORS_ENABLED:f.identity.elevated?'YES':'NO',PRODUCTION_TOUCHED:'NO',MYSQL:'NOT_USED',AUTHORITY_ISSUED:'NO'};
 try{
  if(!f.identity.elevated){await core.deployment(configPath);throw fail('FIXTURE_EVIDENCE_FAILED');}
  // Read the protected owned policy only, never a caller-provided deployment artifact.
  const policy=JSON.parse(await readFile(f.policy,'utf8'));
  if(!exact(policy,['policyVersion','approvedOperatorSid','runtimeServiceSid','runtimeConfigFile'])||policy.policyVersion!==1||
   policy.approvedOperatorSid!==f.identity.sid||policy.runtimeServiceSid!==f.marker.runtimeServiceSid||policy.runtimeConfigFile!==configPath)
   throw fail('FIXTURE_SHAPE_INVALID');
  // The core itself enforces real elevation before either strict artifact is read.
  const deployment=await core.deployment(configPath),pointer=await core.pointer(configPath);
  if(!f.identity.elevated||deployment.actor.sid!==f.identity.sid)throw fail('FIXTURE_EVIDENCE_FAILED');
  const c=deployment.config;
  if(c.secretsFile!==secretPath||c.logDirectory!==join(f.root,'logs')||c.monitoring.backupDirectory!==join(f.root,'backups')||
   c.recovery.journalDirectory!==join(f.root,'journal')||c.recovery.operatorDbSecretsFile!==join(f.root,'secrets','operator-db.json'))throw fail('FIXTURE_SCOPE_DENIED');
  for(const path of [configPath,secretPath]){
   const acl=await windowsFileAcl(path);
   if(acl.rules.some(r=>r.type!=='Allow'||r.sid===f.identity.sid))throw fail('AUTHORIZATION_ACL_DENIED');
  }
  if(Object.keys(pointer).some(k=>!['host','port','name','ca'].includes(k))||
   /S3D_(?:RUNTIME_PASSWORD|PROVIDER)_SENTINEL|-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(JSON.stringify({deployment,pointer})))throw fail('FIXTURE_EVIDENCE_FAILED');
  let rejected=false;
  try{await loadRuntimeConfig(configPath,schemaEnvironment);}catch(error){rejected=error.code==='RUNTIME_ACL_DENIED';}
  if(!rejected)throw fail('FIXTURE_EVIDENCE_FAILED');
  return {EVIDENCE:'PASS',...base,RUNTIME_CONFIG_READ:'PASS',RUNTIME_SECRET_READ:'PASS',
   POINTER_FIELDS:Object.keys(pointer).sort(),POINTER_HOST:pointer.host,POINTER_PORT:pointer.port,POINTER_DATABASE:pointer.name,
   OPERATOR_SPECIFIC_ACE:'NONE',NORMAL_SERVICE_LOADER:'CALLER_IDENTITY_REJECTED',
   RUNTIME_USER_RETURNED:'NO',RUNTIME_PASSWORD_RETURNED:'NO',PRIVATE_PROVIDER_SECRET_RETURNED:'NO',SENTINEL_LEAK:'NO'};
 }catch(error){return {EVIDENCE:'BLOCKED',...base,CODE:safeWindowsEvidenceError(error)};}
}
export async function windowsEvidenceCommand(argv){return runWindowsEvidence(evidenceFixtureId(argv));}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const result=await windowsEvidenceCommand(process.argv.slice(2));console.log(JSON.stringify(result));if(result.EVIDENCE!=='PASS')process.exitCode=1;}
 catch(error){console.log(JSON.stringify({EVIDENCE:'BLOCKED',CODE:safeWindowsEvidenceError(error)}));process.exitCode=1;}
}
