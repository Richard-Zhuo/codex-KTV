import {canonical} from '../backup/format.js';
import {createHash} from 'node:crypto';
import {issueOwnedCandidateCapability} from '../recovery/production-candidate.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {updateProtectedDatabasePointer,updateOwnedDatabasePointer} from './cutover-pointer.js';
const sid='S-1-5-21-1-2-3-1001',old='jbhh_ktv_test',candidate='jbhh_ktv_recovery_candidate';
const acl={protected:true,current:sid,owner:sid,rules:[{sid,type:'Allow',rights:1}]};
const hash=x=>createHash('sha256').update(canonical({value:x})).digest('hex');
const options={fileAcl:async()=>acl,harden:async()=>{}};
const enabled=process.env.STAGE5E_RUN==='synthetic-only'&&process.env.STAGE5E_FIXTURE_ROOT&&process.env.LEDGER_MYSQL_TEST_URL;
async function owned(){return issueOwnedCandidateCapability({root:process.env.STAGE5E_FIXTURE_ROOT,names:{id:process.env.STAGE5E_FIXTURE_ID,database:'jbhh_ktv_test'},identity:{server_uuid:process.env.STAGE5E_FIXTURE_UUID},port:33313,dbUrl:()=>process.env.LEDGER_MYSQL_TEST_URL});}
if(enabled)test('C2 updates only protected database.name and enforces expected old value',async()=>{
 const capability=await owned(),root=await mkdtemp(join(capability.root,'artifacts','c2-pointer-'));
 try{
  const file=join(root,'secrets.json'),secrets={database:{host:'127.0.0.1',port:33313,
   name:old,user:'synthetic',password:'synthetic-private-password'},
   tls:{privateKey:'synthetic-private-key'},alerting:{wecom:{secret:'synthetic-wecom-secret'}},
   ktvsky:{password:'synthetic-device-secret'}};
  await writeFile(file,JSON.stringify(secrets));
  const loaded={config:{secretsFile:file,serviceAccountSid:sid}},plan={currentDatabase:old,targetDatabase:candidate};
  const result=await updateOwnedDatabasePointer(capability,loaded,plan,options);
  assert.equal(result.after,candidate);
  const current=JSON.parse(await readFile(file,'utf8'));
  assert.equal(hash({...current,database:{...current.database,name:old}}),hash(secrets));
  await assert.rejects(updateOwnedDatabasePointer(capability,loaded,plan,options),
   {code:'PRODUCTION_CUTOVER_POINTER_CONFLICT'});
 }finally{await rm(root,{recursive:true,force:true});}
});
if(enabled)test('C2 failed atomic move preserves the original protected secrets',async()=>{
 const capability=await owned(),root=await mkdtemp(join(capability.root,'artifacts','c2-pointer-'));
 try{
  const file=join(root,'secrets.json'),original=JSON.stringify({database:{name:old},
   tls:{privateKey:'synthetic-private-key'}});
  await writeFile(file,original);
  const loaded={config:{secretsFile:file,serviceAccountSid:sid}};
  await assert.rejects(updateOwnedDatabasePointer(capability,loaded,
   {currentDatabase:old,targetDatabase:candidate},
   {...options,move:async()=>{throw Error('synthetic-move-failure');}}));
  assert.equal(hash(await readFile(file,'utf8')),hash(original));
  assert.deepEqual(await readdir(root),['secrets.json']);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('public pointer writer rejects absent and forged ProductionPlanAuthority before file access',async()=>{
 for(const authority of [undefined,{}, {kind:'production'}])await assert.rejects(()=>updateProtectedDatabasePointer({config:{}},{},{authority}),{code:'AUTHORIZATION_AUTHORITY_FORGED'});
});
