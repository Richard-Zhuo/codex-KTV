import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {validateBackupRegistration,validateBackupAnchorAcl} from './backup-deployment.js';
const sid='S-1-5-21-100-200-300-1001';
const config=join(process.cwd(),'private','runtime.json');
const registered={name:'JbhhKtv',startName:'NT SERVICE\\JbhhKtv',serviceSid:sid,
 argv:[join(process.cwd(),'host.exe'),'--node',process.execPath,'--entry',join(process.cwd(),'production','start.js'),'--config',config]};
test('fixed SCM registration derives backup.json; no caller-selected trust path',()=>{
 const binding=validateBackupRegistration(registered);
 assert.equal(binding.runtimeConfigFile,config);assert.equal(binding.serviceSid,sid);
 assert.equal(binding.backupConfigFile,join(process.cwd(),'private','backup.json'));
});
for(const [name,patch] of Object.entries({missing:null,wrongService:{name:'Other'},wrongAccount:{startName:'caller'},
 invalidSid:{serviceSid:'bad'},systemSid:{serviceSid:'S-1-5-18'},extraArguments:{argv:[...registered.argv,'extra']},
 wrongFlag:{argv:registered.argv.map((v,i)=>i===5?'--other':v)},relativeConfig:{argv:registered.argv.map((v,i)=>i===6?'runtime.json':v)}})){
 test('deployment registration rejects '+name,()=>assert.throws(()=>validateBackupRegistration(patch===null?null:{...registered,...patch})));
}
const acl={protected:true,owner:'S-1-5-32-544',current:sid,rules:[{sid,type:'Allow',rights:131241},{sid:'S-1-5-18',type:'Allow',rights:2032127},{sid:'S-1-5-32-544',type:'Allow',rights:2032127}]};
test('administrator-owned anchor allows service read only',()=>validateBackupAnchorAcl(acl,sid));
for(const [name,change] of Object.entries({callerOwner:{owner:sid},inheritance:{protected:false},otherActor:{current:'S-1-5-21-9'},
 unrelatedGrant:{rules:[...acl.rules,{sid:'S-1-1-0',type:'Allow',rights:1}]},noServiceRead:{rules:acl.rules.slice(1)}})){
 test('deployment anchor rejects '+name,()=>assert.throws(()=>validateBackupAnchorAcl({...acl,...change},sid)));
}
for(const right of [2,4,16,64,256,65536,262144,524288,0x40000000,0x10000000]){
 test('deployment anchor rejects service replacement right '+right,()=>assert.throws(()=>validateBackupAnchorAcl({...acl,rules:[...acl.rules,{sid,type:'Allow',rights:right}]},sid)));
}
