import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRuntimeFileAclStructure,validateFileAcl,runtimeConfigFingerprint} from './runtime-config.js';
const service='S-1-5-80-1-2-3-4-5',operator='S-1-5-21-1-2-3-1001';
const acl={protected:true,current:operator,owner:'S-1-5-32-544',rules:[
 {sid:service,type:'Allow',rights:1},{sid:'S-1-5-32-544',type:'Allow',rights:2032127}]};
test('strict structure accepts Administrator read without operator ACE but service wrapper rejects human caller',()=>{
 validateRuntimeFileAclStructure(acl,service);
 assert.throws(()=>validateFileAcl(acl,service),{code:'RUNTIME_ACL_DENIED'});
 validateFileAcl({...acl,current:service},service);
 for(const bad of [{...acl,protected:false},{...acl,owner:operator},
  {...acl,rules:[...acl.rules,{sid:operator,type:'Allow',rights:1}]},
  {...acl,rules:[...acl.rules,{sid:'S-1-1-0',type:'Allow',rights:1}]},
  {...acl,rules:acl.rules.filter(r=>r.sid!==service)}])
  assert.throws(()=>validateRuntimeFileAclStructure(bad,service),{code:'RUNTIME_ACL_DENIED'});
});
test('public fingerprint preserves the established field set and ignores secret references',()=>{
 const c={configVersion:1,applicationCommit:'a'.repeat(40),storeId:'fixture',ledgerId:'fixture',monitoring:{intervalMs:1000}};
 assert.equal(runtimeConfigFingerprint(c),runtimeConfigFingerprint({...c,secretsFile:'other',serviceAccountSid:operator,recovery:{journalDirectory:'other'}}));
 assert.notEqual(runtimeConfigFingerprint(c),runtimeConfigFingerprint({...c,storeId:'other'}));
});
