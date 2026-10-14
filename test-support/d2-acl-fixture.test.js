import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';import {join,dirname} from 'node:path';import {tmpdir} from 'node:os';
import {createD2AclFixture} from './d2-acl-fixture.js';
import {checkedPaths,inspectProductionRestore} from '../recovery/production-plan.js';
import {validateRecoveryAcl} from '../recovery/production-authorization-context.js';
import {validateRuntimeFileAclStructure,windowsFileAcl} from '../production/runtime-config.js';
import {validateSmokeAcl} from '../production/wecom-smoke-config.js';
const operator='S-1-5-21-101-202-303-1001',runtime='S-1-5-80-1001',actor={sid:operator,elevated:true};
async function fixture(work){
 const root=await mkdtemp(join(tmpdir(),'ktv-d2-acl-')),journal=join(root,'journal'),authDir=join(root,'authorization'),backupRoot=join(root,'backups'),backupDirectory=join(backupRoot,'backup');
 try{
  for(const p of [journal,authDir,backupRoot,backupDirectory,join(journal,'orchestration')])await mkdir(p);
  const paths={journal,authDir,backupRoot,backupDirectory,configPath:join(journal,'runtime.json'),secretPath:join(journal,'runtime-secrets.json'),policyPath:join(journal,'policy.json'),operatorPath:join(journal,'operator-db.json')};
  const acl=createD2AclFixture({...paths,runtimeServiceSid:runtime,identity:()=>actor});
  for(const p of [paths.configPath,paths.secretPath,paths.policyPath,paths.operatorPath,join(journal,'active-plan.json'),...['manifest.json','manifest.sha256','data.json'].map(n=>join(backupDirectory,n)),join(authDir,'authorization-event-00000001.json')])await writeFile(p,'{}');
  await work({root,...paths,acl});
 }finally{if(await realpath(root)!==root||dirname(root)!==await realpath(tmpdir()))throw Error('D2_ACL_CLEANUP_SCOPE_DENIED');await rm(root,{recursive:true});}
}
test('checkedPaths validates all three backup files and three shared directories',()=>fixture(async f=>{
 const loaded={config:{monitoring:{backupDirectory:f.backupRoot},recovery:{journalDirectory:f.journal}}};
 const seen=[];const paths=await checkedPaths(loaded,f.backupDirectory,{backupAcl:f.acl.checkDirectory,journalAcl:f.acl.checkDirectory,fileAcl:async p=>{seen.push(p);assert.equal(await f.acl.checkFile(p),undefined);}});
 assert.equal(paths.artifact,f.backupDirectory);assert.deepEqual(seen,['manifest.json','manifest.sha256','data.json'].map(n=>join(f.backupDirectory,n)));
 assert.equal(f.acl.observed().length,6);assert.equal(f.acl.observed().every(x=>x.category==='SHARED_RECOVERY'),true);
}));
test('strict runtime, shared plan, private authorization and policy use production validators',()=>fixture(async f=>{
 for(const [p,kind] of [[f.configPath,'STRICT_RUNTIME'],[f.secretPath,'STRICT_RUNTIME'],[join(f.journal,'active-plan.json'),'SHARED_RECOVERY'],[join(f.authDir,'authorization-event-00000001.json'),'PRIVATE_RECOVERY'],[f.operatorPath,'PRIVATE_RECOVERY'],[f.policyPath,'POLICY']]){assert.equal(f.acl.category(p),kind);await f.acl.checkFile(p);}
 for(const p of [f.configPath,f.secretPath]){const a=await f.acl.fileFacts(p);assert.equal(a.rules.some(r=>r.sid===operator),false);validateRuntimeFileAclStructure(a,runtime);}
 assert.equal((await f.acl.fileFacts(f.operatorPath)).rules.some(r=>r.sid===runtime),false);
}));
test('runtime-only strict descriptor cannot authorize shared recovery inspection',()=>fixture(async f=>{
 const a={protected:true,current:operator,owner:runtime,rules:[{sid:runtime,type:'Allow',rights:1}]};validateRuntimeFileAclStructure(a,runtime);
 const fileAcl=async()=>validateRecoveryAcl(a,{identity:actor,runtimeServiceSid:runtime,shared:true});
 await assert.rejects(()=>checkedPaths({config:{monitoring:{backupDirectory:f.backupRoot},recovery:{journalDirectory:f.journal}}},f.backupDirectory,{backupAcl:f.acl.checkDirectory,journalAcl:f.acl.checkDirectory,fileAcl}),{code:'AUTHORIZATION_ACL_DENIED'});
 // Strict + effective Administrators read is intentionally also valid shared ACL; contracts overlap.
 validateRecoveryAcl(f.acl.descriptor('STRICT_RUNTIME'),{identity:actor,runtimeServiceSid:runtime,shared:true});
}));
test('shared/operator ACE descriptor fails strict runtime inspection',()=>fixture(async f=>{
 const a=f.acl.descriptor('SHARED_RECOVERY');assert.throws(()=>validateRuntimeFileAclStructure(a,runtime),{code:'RUNTIME_ACL_DENIED'});
}));
test('unknown paths, names, traversal and private/runtime profile confusion fail closed',()=>fixture(async f=>{
 for(const p of [join(f.root,'unknown.json'),join(f.journal,'unexpected.json'),join(f.backupDirectory,'extra.json'),join(f.authDir,'runtime.json'),join(f.journal,'..','other.json')])assert.throws(()=>f.acl.category(p),{code:'D2_ACL_PATH_UNCLASSIFIED'});
 assert.throws(()=>f.acl.descriptor('UNKNOWN'),{code:'D2_ACL_PATH_UNCLASSIFIED'});
 await assert.rejects(()=>f.acl.checkDirectory(join(f.root,'unknown')),{code:'D2_ACL_PATH_UNCLASSIFIED'});
}));
test('inspectForOperation reaches verifier only after actual checkedPaths admissions',()=>fixture(async f=>{
 let verified=false;const calls=[];
 await assert.rejects(()=>inspectProductionRestore({runtimeConfigFile:f.configPath,artifactDirectory:f.backupDirectory,expectedChecksum:'a'.repeat(64),load:async()=>({config:{monitoring:{backupDirectory:f.backupRoot},recovery:{journalDirectory:f.journal}}}),pathCheck:(l,a)=>checkedPaths(l,a,{backupAcl:f.acl.checkDirectory,journalAcl:f.acl.checkDirectory,fileAcl:async p=>{calls.push(p);await f.acl.checkFile(p);}}),artifactVerifier:async()=>{verified=true;throw Object.assign(Error('D2_VERIFIER_REACHED'),{code:'D2_VERIFIER_REACHED'});},connect:()=>assert.fail('no DB in ACL test')}),{code:'D2_VERIFIER_REACHED'});
 assert.equal(verified,true);assert.equal(calls.length,3);assert.equal(calls[0],join(f.backupDirectory,'manifest.json'));
}));
test('unhardened Windows backup file reproduces original smoke denial safely',()=>fixture(async f=>{
 const path=join(f.backupDirectory,'manifest.json'),a=await windowsFileAcl(path);assert.equal(a.protected,false);assert.throws(()=>validateSmokeAcl(a),{code:'SMOKE_ACL_DENIED'});
}));
test('journal temp and pointer temp classifications are distinct, private authorization stays private',()=>fixture(async f=>{
 const id='00000000-0000-4000-8000-000000000001';
 for(const prefix of ['plan','execution','cutover','c3','c1'])assert.equal(f.acl.category(join(f.journal,prefix+'-'+id+'.tmp')),'SHARED_RECOVERY');
 assert.equal(f.acl.category(join(f.journal,'cutover-secret-'+id+'.tmp')),'STRICT_RUNTIME');
 for(const n of ['authorization.lock','authorization-'+id+'.tmp','authorization-event-00000001.json'])assert.equal(f.acl.category(join(f.authDir,n)),'PRIVATE_RECOVERY');
 assert.equal(f.acl.category(join(f.journal,'orchestration','d2-attempt-'+id+'.json')),'SHARED_RECOVERY');
}));
