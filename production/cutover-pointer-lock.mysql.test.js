import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import mysql from 'mysql2/promise';
import * as pointerModule from './cutover-pointer.js';
import {issueOwnedCandidateCapability,withOwnedCandidateRead} from '../recovery/production-candidate.js';
import {updateOwnedDatabasePointer} from './cutover-pointer.js';
const enabled=process.env.STAGE5E_RUN==='synthetic-only'&&process.env.STAGE5E_FIXTURE_ROOT&&process.env.LEDGER_MYSQL_TEST_URL;
const sid='S-1-5-21-1-2-3-1001',acl={protected:true,current:sid,owner:sid,rules:[{sid,type:'Allow',rights:1}]};
const options={fileAcl:async()=>acl,harden:async()=>{}};
async function fixture(label){
 const f={root:process.env.STAGE5E_FIXTURE_ROOT,names:{id:process.env.STAGE5E_FIXTURE_ID,database:'jbhh_ktv_test'},identity:{server_uuid:process.env.STAGE5E_FIXTURE_UUID},port:33313,dbUrl:()=>process.env.LEDGER_MYSQL_TEST_URL};
 const capability=await issueOwnedCandidateCapability(f),root=join(f.root,'artifacts',label);await mkdir(root);
 const file=join(root,'secrets.json');await writeFile(file,JSON.stringify({database:{name:f.names.database},tls:{privateKey:'SYNTHETIC_NOT_FOR_OUTPUT'}}));
 return {capability,file,loaded:{config:{secretsFile:file,serviceAccountSid:sid}},plan:{currentDatabase:f.names.database,targetDatabase:'jbhh_ktv_recovery_candidate'}};
}
if(enabled)test('C2 outer-held restore lock permits pointer switch without inner reacquisition',{timeout:20000},async()=>{
 const f=await fixture('nested-lock-regression');
 await withOwnedCandidateRead(f.capability,async(c,heldContext)=>{
  const [[before]]=await c.query('SELECT CONNECTION_ID() AS id, IS_USED_LOCK(?) AS owner',['s3b-production-candidate-restore']);
  assert.equal(Number(before.owner),Number(before.id));
  const result=await updateOwnedDatabasePointer(f.capability,f.loaded,f.plan,{...options,beforeMove:async()=>{
   const [[during]]=await c.query('SELECT CONNECTION_ID() AS id, IS_USED_LOCK(?) AS owner',['s3b-production-candidate-restore']);
   assert.equal(Number(during.owner),Number(before.id));
  }},heldContext);
  assert.equal(result.after,f.plan.targetDatabase);
  const [[after]]=await c.query('SELECT IS_USED_LOCK(?) AS owner',['s3b-production-candidate-restore']);
  assert.equal(Number(after.owner),Number(before.id));
 });
 assert.equal(JSON.parse(await readFile(f.file,'utf8')).database.name,f.plan.targetDatabase);
});

if(enabled)test('standalone owned writer owns restore lock and parallel mutations conflict',{timeout:20000},async()=>{
 const f=await fixture('standalone-lock-concurrency'),observer=await mysql.createConnection({uri:process.env.LEDGER_MYSQL_TEST_URL});
 let enter,release,moves=0;
 const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 const {rename}=await import('node:fs/promises');
 const first=updateOwnedDatabasePointer(f.capability,f.loaded,f.plan,{...options,
  beforeMove:async()=>{enter();await gate;},move:async(a,b)=>{moves++;return rename(a,b);}});
 let second;
 try{
  await entered;
  second=updateOwnedDatabasePointer(f.capability,f.loaded,{...f.plan,targetDatabase:'jbhh_ktv_recovery_other'},
   {...options,move:async(a,b)=>{moves++;return rename(a,b);}});
  // Zero-wait probe from another connection proves the standalone writer still owns the lock.
  const [[probe]]=await observer.execute('SELECT GET_LOCK(?,0) AS acquired',['s3b-production-candidate-restore']);
  assert.equal(Number(probe.acquired),0);
 }finally{release();}
 try{
  const results=await Promise.allSettled([first,second]);
  assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');
  assert.equal(results[1].reason.code,'PRODUCTION_CUTOVER_POINTER_CONFLICT');assert.equal(moves,1);
  assert.equal(JSON.parse(await readFile(f.file,'utf8')).database.name,f.plan.targetDatabase);
  await assert.rejects(()=>updateOwnedDatabasePointer(f.capability,f.loaded,f.plan,options),{code:'PRODUCTION_CUTOVER_POINTER_CONFLICT'});
  assert.equal(moves,1);
 }finally{await observer.end();}
});
if(enabled)test('plain, expired and different-capability held contexts cannot authorize pointer mutation',async()=>{
 const f=await fixture('held-context-refusals');let expired;
 assert.equal(Object.hasOwn(pointerModule,'writePointer'),false);
 for(const forged of [{},Object.freeze({}),true,{alreadyLocked:true}])
  await assert.rejects(()=>updateOwnedDatabasePointer(f.capability,f.loaded,f.plan,options,forged),{code:'RESTORE_OWNED_LOCK_REQUIRED'});
 await assert.rejects(()=>updateOwnedDatabasePointer({},f.loaded,f.plan,options),{code:'RESTORE_PRODUCTION_DISABLED'});
 await withOwnedCandidateRead(f.capability,async(_c,held)=>{
  expired=held;
  await assert.rejects(()=>updateOwnedDatabasePointer({...f.capability},f.loaded,f.plan,options,held),{code:'RESTORE_OWNED_LOCK_REQUIRED'});
 });
 await assert.rejects(()=>updateOwnedDatabasePointer(f.capability,f.loaded,f.plan,options,expired),{code:'RESTORE_OWNED_LOCK_REQUIRED'});
 assert.equal(JSON.parse(await readFile(f.file,'utf8')).database.name,f.plan.currentDatabase);
});
if(enabled)test('released physical lock invalidates held context before pointer mutation',async()=>{
 const f=await fixture('released-lock-refusal');
 await withOwnedCandidateRead(f.capability,async(c,held)=>{
  await c.execute('SELECT RELEASE_LOCK(?)',['s3b-production-candidate-restore']);
  await assert.rejects(()=>updateOwnedDatabasePointer(f.capability,f.loaded,f.plan,options,held),{code:'RESTORE_OWNED_LOCK_REQUIRED'});
 });
 assert.equal(JSON.parse(await readFile(f.file,'utf8')).database.name,f.plan.currentDatabase);
});
if(enabled)test('outer scope drains admitted writer before releasing restore lock',{timeout:20000},async()=>{
 const f=await fixture('held-context-lifetime'),observer=await mysql.createConnection({uri:process.env.LEDGER_MYSQL_TEST_URL});
 let enter,release,writer;
 const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 const outer=withOwnedCandidateRead(f.capability,(_c,held)=>{
  writer=updateOwnedDatabasePointer(f.capability,f.loaded,f.plan,{...options,beforeMove:async()=>{enter();await gate;}},held);
  // Intentionally omit await: admitted work must still remain under the outer lock.
  return 'scope-returned';
 });
 try{
  await entered;
  const [[probe]]=await observer.execute('SELECT GET_LOCK(?,0) AS acquired',['s3b-production-candidate-restore']);
  assert.equal(Number(probe.acquired),0);
 }finally{release();}
 try{assert.equal(await outer,'scope-returned');assert.equal((await writer).after,f.plan.targetDatabase);}
 finally{await observer.end();}
});
