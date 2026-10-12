import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readC3State,transitionC3State} from './production-c3-journal.js';
import {prepareOwnedCandidateResume,resumeOwnedCandidate} from './production-c3.js';

const plan={recoveryOperationId:'12345678-1234-4123-8123-123456789abc',
 planDigest:'a'.repeat(64),backupSha256:'b'.repeat(64),
 currentDatabase:'jbhh_ktv_test',
 targetDatabase:'jbhh_ktv_recovery_12345678123441238123123456789abc',
 targetServerUuid:'synthetic-server'};
const proof={c1EvidenceDigest:'c'.repeat(64),oldDigest:'d'.repeat(64),
 c1CandidateDigest:'e'.repeat(64),candidateBusinessDigest:'f'.repeat(64),
 alertDigest:'0'.repeat(64)};
const options={checkAcl:async()=>{},harden:async()=>{}};
test('C3 journal allows only identity-bound READY and RESUME order',async()=>{
 const root=await mkdtemp(join(tmpdir(),'c3-journal-'));
 try{
  assert.equal(await readC3State(root,plan,options),null);
  for(const [from,to] of [[null,'READY_INTENT'],
   ['READY_INTENT','READY_FOR_RESUME'],['READY_FOR_RESUME','RESUME_INTENT'],
   ['RESUME_INTENT','RESUMED']]){
   assert.equal(await transitionC3State(root,plan,proof,from,to,options),to);
   assert.equal((await readC3State(root,plan,options)).state,to);
  }
  await assert.rejects(readC3State(root,{...plan,planDigest:'1'.repeat(64)},options),
   {code:'PRODUCTION_C3_JOURNAL_CONFLICT'});
  await assert.rejects(transitionC3State(root,plan,proof,'RESUMED','READY_INTENT',options),
   {code:'PRODUCTION_C3_JOURNAL_CONFLICT'});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('C3 rejects unissued capability before config or database access',async()=>{
 let reads=0;
 const input={capability:{},managedRuntime:{status:()=>({phase:'STOPPED'})},
  readPlan:async()=>{reads++;throw Error('unexpected read');}};
 await assert.rejects(prepareOwnedCandidateResume(input),{code:'RESTORE_PRODUCTION_DISABLED'});
 await assert.rejects(resumeOwnedCandidate(input),{code:'RESTORE_PRODUCTION_DISABLED'});
 assert.equal(reads,0);
});
