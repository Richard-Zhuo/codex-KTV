import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {readProtectedFixture,attemptAclChange} from './protected-windows-fixture.js';
import {windowsFileAcl} from '../production/runtime-config.js';
import {windowsDirectoryAcl} from '../production/wecom-smoke-config.js';
import {validateRecoveryAcl,canonicalProtectedPath,validateRecoveryPolicy} from '../recovery/production-authorization-context.js';
const id=process.env.S3D_PROTECTED_FIXTURE_ID;
// Explicit file list only; absence of a manually bootstrapped fixture fails.
test('actual protected Windows fixture is readable and checked by the non-elevated operator',async t=>{
 const f=await readProtectedFixture(id),options={identity:f.identity,runtimeServiceSid:f.marker.runtimeServiceSid};
 assert.equal(f.identity.elevated,false);
 await t.test('actual policy and authorization owners, ACLs and canonical paths satisfy production ACL validator',async()=>{
  for(const [path,policy] of [[f.policy,true],[f.authorization,false]]){
   await canonicalProtectedPath(path);const acl=await windowsFileAcl(path);
   assert.equal(acl.owner,'S-1-5-32-544');assert.equal(acl.protected,true);
   validateRecoveryAcl(acl,{...options,policy});
  }
  for(const name of ['policy','journal','journal/authorization']){
   const path=join(f.root,name);await canonicalProtectedPath(path,{directory:true});
   validateRecoveryAcl(await windowsDirectoryAcl(path),{...options,directory:true});
  }
 });
 await t.test('real ACL variants fail closed for wrong policy owner, inheritance, runtime access and Users write',async()=>{
  for(const [name,policy] of [['wrong-policy-owner.json',true],['inherited-policy.json',true],
    ['runtime-readable-authorization.json',false],['users-write-authorization.json',false]]){
   const acl=await windowsFileAcl(join(f.root,'negative',name));
   assert.throws(()=>validateRecoveryAcl(acl,{...options,policy}),{code:'AUTHORIZATION_ACL_DENIED'});
  }
 });
 await t.test('real junction aliases are rejected',async()=>{
  await assert.rejects(()=>canonicalProtectedPath(join(f.root,'negative','policy-alias'),{directory:true}),{code:'AUTHORIZATION_PATH_DENIED'});
 });
 await t.test('normal token cannot manufacture accepted Administrators ownership',async()=>{
  assert.equal(await attemptAclChange(id,'owner-attempt','owner'),'DENIED');
 });
 await t.test('normal operator cannot change bootstrap policy or authorization DACL to Users write',async()=>{
  for(const subject of ['policy','authorization']){
   const path=f[subject];
   assert.equal(await attemptAclChange(id,subject,'dacl'),'DENIED');
   validateRecoveryAcl(await windowsFileAcl(path),{...options,policy:path===f.policy});
  }
 });
 await t.test('filesystem bootstrap grants no elevated operator identity or ProductionPlanAuthority',async()=>{
  const policy=JSON.parse(await readFile(f.policy,'utf8'));
  assert.throws(()=>validateRecoveryPolicy(policy,f.identity),{code:'AUTHORIZATION_OPERATOR_DENIED'});
 });
});
