// Synthetic OS facts only; the production validators remain the admission authority.
import {basename,dirname,resolve,join} from 'node:path';
import {canonicalProtectedPath,validateRecoveryAcl} from '../recovery/production-authorization-context.js';
import {validateRuntimeFileAclStructure} from '../production/runtime-config.js';
const ADMIN='S-1-5-32-544',SYSTEM='S-1-5-18';
const fail=()=>{throw Object.assign(Error('D2_ACL_PATH_UNCLASSIFIED'),{code:'D2_ACL_PATH_UNCLASSIFIED'});};
const UUID='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
export function createD2AclFixture({configPath,secretPath,policyPath,operatorPath,journal,authDir,backupDirectory,backupRoot,runtimeServiceSid,identity}){
 const files=new Map([[resolve(configPath),'STRICT_RUNTIME'],[resolve(secretPath),'STRICT_RUNTIME'],[resolve(policyPath),'POLICY'],[resolve(operatorPath),'PRIVATE_RECOVERY']]);
 const directories=new Map([[resolve(journal),'SHARED_RECOVERY'],[resolve(join(journal,'orchestration')),'SHARED_RECOVERY'],[resolve(authDir),'PRIVATE_RECOVERY'],[resolve(backupRoot),'SHARED_RECOVERY'],[resolve(backupDirectory),'SHARED_RECOVERY']]);
 const seen=new Map();
 function category(path,{directory=false}={}){
  const p=resolve(path),name=basename(p),parent=dirname(p);let kind=(directory?directories:files).get(p);
  if(!directory&&!kind){
   if(parent===resolve(backupDirectory)&&['manifest.json','manifest.sha256','data.json'].includes(name))kind='SHARED_RECOVERY';
   else if(parent===resolve(journal)&&(['active-plan.json','active-plan.claim','execution-state.json','cutover-state.json','c3-resume.json','c1-verification.json'].includes(name)||new RegExp('^(?:plan|execution|cutover|c3|c1)-'+UUID+'\\.tmp$').test(name)))kind='SHARED_RECOVERY';
   else if(parent===resolve(journal)&&new RegExp('^cutover-secret-'+UUID+'\\.tmp$').test(name))kind='STRICT_RUNTIME';
   else if(parent===resolve(join(journal,'orchestration'))&&new RegExp('^d2-attempt-'+UUID+'\\.json$').test(name))kind='SHARED_RECOVERY';
   else if(parent===resolve(authDir)&&(name==='authorization.lock'||/^authorization-event-\d{8}\.json$/.test(name)||new RegExp('^authorization-'+UUID+'\\.tmp$').test(name)))kind='PRIVATE_RECOVERY';
  }
  if(!kind)fail();seen.set(p,kind);return kind;
 }
 function descriptor(kind,{directory=false}={}){
  if(!['STRICT_RUNTIME','SHARED_RECOVERY','PRIVATE_RECOVERY','POLICY'].includes(kind))fail();
  const actor=identity(),rights=directory?197055:1,inheritance=directory?'ObjectInherit, ContainerInherit':'None';
  const rules=[{sid:ADMIN,type:'Allow',rights:2032127,inheritance},{sid:SYSTEM,type:'Allow',rights:2032127,inheritance}];
  if(kind==='STRICT_RUNTIME')rules.push({sid:runtimeServiceSid,type:'Allow',rights:1,inheritance});
  else {rules.push({sid:actor.sid,type:'Allow',rights,inheritance});if(kind==='SHARED_RECOVERY')rules.push({sid:runtimeServiceSid,type:'Allow',rights:1,inheritance});}
  return {protected:true,current:actor.sid,owner:ADMIN,rules};
 }
 const fileFacts=async path=>descriptor(category(path));
 const directoryFacts=async path=>descriptor(category(path,{directory:true}),{directory:true});
 async function check(path,directory){
  const kind=category(path,{directory});await canonicalProtectedPath(path,{directory});
  const facts=descriptor(kind,{directory});
  if(kind==='STRICT_RUNTIME')validateRuntimeFileAclStructure(facts,runtimeServiceSid);
  else validateRecoveryAcl(facts,{identity:identity(),runtimeServiceSid,shared:kind==='SHARED_RECOVERY',policy:kind==='POLICY',directory});
 }
 return Object.freeze({category,descriptor,fileFacts,directoryFacts,checkFile:path=>check(path,false),checkDirectory:path=>check(path,true),observed:()=>[...seen].map(([path,category])=>({path,category}))});
}
