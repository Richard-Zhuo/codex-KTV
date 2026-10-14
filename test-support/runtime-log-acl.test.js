import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {provisionSyntheticRuntimeLogDirectory} from './runtime-log-acl.js';
import {windowsDirectoryAcl} from '../production/wecom-smoke-config.js';
import {validateRuntimeFileAclStructure} from '../production/runtime-config.js';
import {validateActivationAcl} from '../production/activation-receipt.js';

test('owned runtime log directory has real protected ACL before child startup',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ktv-stage5b-log-acl-'));
 try{
  const sid=(await windowsDirectoryAcl(root)).current,path=join(root,'logs');
  await provisionSyntheticRuntimeLogDirectory(path,sid);
  const acl=await windowsDirectoryAcl(path);
  assert.equal(acl.owner,sid);assert.equal(acl.protected,true);assert.equal(acl.current,sid);
  assert.deepEqual(acl.rules.map(r=>r.sid).sort(),[sid,'S-1-5-18','S-1-5-32-544'].sort());
  validateRuntimeFileAclStructure(acl,sid);
  validateActivationAcl(acl,sid,{directory:true,producer:true});
  const rights=id=>acl.rules.find(r=>r.sid===id).rights;
  t.diagnostic(JSON.stringify({owner:'runtimeSid',protected:true,unexpectedAllow:false,separateOperatorAce:false,runtimeRights: rights(sid),systemRights:rights('S-1-5-18'),administratorsRights:rights('S-1-5-32-544')}));
 }finally{await rm(root,{recursive:true,force:true});}
});
