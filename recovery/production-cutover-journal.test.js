import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readCutoverState,transitionCutoverState,assertNormalStartupAllowed} from './production-cutover-journal.js';
const plan={recoveryOperationId:'12345678-1234-4123-8123-123456789abc',planDigest:'a'.repeat(64),
 backupSha256:'b'.repeat(64),currentDatabase:'jbhh_ktv_test',
 targetDatabase:'jbhh_ktv_recovery_12345678123441238123123456789abc',
 targetServerUuid:'synthetic-server'};
const options={checkAcl:async()=>{},harden:async()=>{}};
test('C2 journal binds intent and switched to one plan, and startup stays blocked',async()=>{
 const root=await mkdtemp(join(tmpdir(),'c2-journal-'));
 try{
  assert.equal(await readCutoverState(root,plan,options),null);
  assert.equal(await transitionCutoverState(root,plan,null,'CUTOVER_INTENT',options),'CUTOVER_INTENT');
  assert.equal((await readCutoverState(root,plan,options)).state,'CUTOVER_INTENT');
  const loaded={config:{recovery:{journalDirectory:root}},apiEnv:{KTV_MYSQL_URL:'mysql://u:p@localhost/jbhh_ktv_test'}};
  await assert.rejects(assertNormalStartupAllowed(loaded,{read:dir=>readCutoverState(dir,null,options)}),
   {code:'PRODUCTION_CUTOVER_STARTUP_BLOCKED'});
  await assert.rejects(transitionCutoverState(root,{...plan,planDigest:'c'.repeat(64)},
   'CUTOVER_INTENT','CUTOVER_SWITCHED',options),{code:'PRODUCTION_CUTOVER_JOURNAL_CONFLICT'});
  assert.equal(await transitionCutoverState(root,plan,'CUTOVER_INTENT','CUTOVER_SWITCHED',options),
   'CUTOVER_SWITCHED');
  assert.equal((await readCutoverState(root,plan,options)).state,'CUTOVER_SWITCHED');
  await assert.rejects(assertNormalStartupAllowed(loaded,{read:dir=>readCutoverState(dir,null,options)}),
   {code:'PRODUCTION_CUTOVER_STARTUP_BLOCKED'});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('C2 journal rejects malformed persisted identity; normal no-journal startup is unchanged',async()=>{
 const root=await mkdtemp(join(tmpdir(),'c2-journal-'));
 try{
  const loaded={config:{recovery:{journalDirectory:root}},apiEnv:{KTV_MYSQL_URL:'mysql://u:p@localhost/jbhh_ktv_test'}};
  assert.equal(await assertNormalStartupAllowed(loaded,{read:dir=>readCutoverState(dir,null,options),
   readControl:async()=>({mode:'NORMAL',facts:{reason:'ordinary'}})}),true);
  await writeFile(join(root,'cutover-state.json'),'{}');
  await assert.rejects(readCutoverState(root,null,options),{code:'PRODUCTION_CUTOVER_JOURNAL_INVALID'});
 }finally{await rm(root,{recursive:true,force:true});}
});

test('C2 startup refuses orphan execution progress without a protected plan',async()=>{
 const root=await mkdtemp(join(tmpdir(),'c2-journal-'));
 try{
  const loaded={config:{recovery:{journalDirectory:root}},
   apiEnv:{KTV_MYSQL_URL:'mysql://u:p@localhost/jbhh_ktv_test'}};
  await writeFile(join(root,'execution-state.json'),'{}');
  await assert.rejects(assertNormalStartupAllowed(loaded,{read:dir=>readCutoverState(dir,null,options)}),
   {code:'PRODUCTION_CUTOVER_STARTUP_BLOCKED'});
 }finally{await rm(root,{recursive:true,force:true});}
});

test('startup without recovery config checks trusted DB facts before allowing ordinary runtime',async()=>{
 const loaded={config:{},apiEnv:{KTV_MYSQL_URL:'mysql://synthetic/owned'}};
 await assert.rejects(assertNormalStartupAllowed(loaded,{readControl:async()=>({
  mode:'NORMAL',facts:{reason:'plan-bound-candidate-restore'}})}),
  {code:'PRODUCTION_C3_STARTUP_BLOCKED'});
 assert.equal(await assertNormalStartupAllowed(loaded,{readControl:async()=>({
  mode:'NORMAL',facts:{reason:'ordinary'}})}),true);
});
