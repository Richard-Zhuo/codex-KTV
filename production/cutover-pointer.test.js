import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {updateProtectedDatabasePointer} from './cutover-pointer.js';
const sid='S-1-5-21-1-2-3-1001',old='jbhh_ktv_test',candidate='jbhh_ktv_recovery_candidate';
const acl={protected:true,current:sid,owner:sid,rules:[{sid,type:'Allow',rights:1}]};
const options={fileAcl:async()=>acl,harden:async()=>{}};
test('C2 updates only protected database.name and enforces expected old value',async()=>{
 const root=await mkdtemp(join(tmpdir(),'c2-pointer-'));
 try{
  const file=join(root,'secrets.json'),secrets={database:{host:'127.0.0.1',port:33313,
   name:old,user:'synthetic',password:'synthetic-private-password'},
   tls:{privateKey:'synthetic-private-key'},alerting:{wecom:{secret:'synthetic-wecom-secret'}},
   ktvsky:{password:'synthetic-device-secret'}};
  await writeFile(file,JSON.stringify(secrets));
  const loaded={config:{secretsFile:file,serviceAccountSid:sid}},plan={currentDatabase:old,targetDatabase:candidate};
  const result=await updateProtectedDatabasePointer(loaded,plan,options);
  assert.equal(result.after,candidate);
  const current=JSON.parse(await readFile(file,'utf8'));
  assert.deepEqual({...current,database:{...current.database,name:old}},secrets);
  await assert.rejects(updateProtectedDatabasePointer(loaded,plan,options),
   {code:'PRODUCTION_CUTOVER_POINTER_CONFLICT'});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('C2 failed atomic move preserves the original protected secrets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'c2-pointer-'));
 try{
  const file=join(root,'secrets.json'),original=JSON.stringify({database:{name:old},
   tls:{privateKey:'synthetic-private-key'}});
  await writeFile(file,original);
  const loaded={config:{secretsFile:file,serviceAccountSid:sid}};
  await assert.rejects(updateProtectedDatabasePointer(loaded,
   {currentDatabase:old,targetDatabase:candidate},
   {...options,move:async()=>{throw Error('synthetic-move-failure');}}));
  assert.equal(await readFile(file,'utf8'),original);
  assert.deepEqual(await readdir(root),['secrets.json']);
 }finally{await rm(root,{recursive:true,force:true});}
});
