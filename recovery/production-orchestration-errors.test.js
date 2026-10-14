import test from 'node:test';import assert from 'node:assert/strict';
import {orchestrationError} from './production-orchestration.js';import {requireControl} from './production-c1.js';import {planBinding} from './production-plan.js';import {runProductionRestoreCli} from './production-restore-cli.js';
const generic='PRODUCTION_ORCHESTRATION_FAILED',sentinel='SYNTHETIC_INTERNAL_DETAIL_SENTINEL';
const capture=()=>{let out='',err='';return {stdout:{write:s=>{out+=s;}},stderr:{write:s=>{err+=s;}},publicText:()=>out+err,result:()=>JSON.parse(out||err)};};
const error=code=>Object.assign(Error(sentinel),{code,cause:Error(sentinel)});
test('D2 safe mapper preserves C1 identity, C1 blocked and alpha-only domain codes',()=>{
 for(const code of ['PRODUCTION_RESTORE_C1_IDENTITY_MISMATCH','PRODUCTION_ORCHESTRATION_C1_BLOCKED','AUTHORIZATION_EXPIRED'])assert.equal(orchestrationError(error(code)),code);
});
test('D2 safe mapper contains absent, non-string and unsafe code characters',()=>{
 for(const code of [undefined,null,12,{toString(){assert.fail('no code coercion');}},'production_restore_c1_identity_mismatch','PRODUCTION_RESTORE_HAS SPACE','PRODUCTION_RESTORE_C:/SYNTHETIC_PATH','PRODUCTION_RESTORE_C:\\SYNTHETIC_PATH','PRODUCTION_RESTORE_HAS:COLON','PRODUCTION_RESTORE_CODE\n','PRODUCTION_RESTORE_CODE\r\n','PRODUCTION_RESTORE_HAS\tTAB','PRODUCTION_RESTORE_HAS\u0000CONTROL','PRODUCTION_RESTORE_HAS-DASH','PRODUCTION_RESTORE_HAS.DOT','PRODUCTION_RESTORE_中文'])assert.equal(orchestrationError(error(code)),generic);
 assert.equal(orchestrationError(Error(sentinel)),generic);
});
test('D2 safe mapper retains namespace and nonempty suffix gates',()=>{
 for(const code of ['ARBITRARY_C1_ERROR','C1_IDENTITY_MISMATCH','PRODUCTION_RESTORE_','AUTHORIZATION'])assert.equal(orchestrationError(error(code)),generic);
});
test('D2 mapper preserves existing absence of a length limit while denying oversized unknown codes',()=>{
 const safe='PRODUCTION_RESTORE_'+ 'A'.repeat(4096);assert.equal(orchestrationError(error(safe)),safe);
 assert.equal(orchestrationError(error('UNKNOWN_'+ 'A'.repeat(4096))),generic);
});
test('D2 wrong-operation core error reaches real CLI catch with specific safe JSON only',async()=>{
 const p={recoveryOperationId:'synthetic-plan',planDigest:'a'.repeat(64),backupSha256:'b'.repeat(64),storeId:'synthetic-store',ledgerId:'synthetic-ledger',targetDatabase:'synthetic_candidate'};
 const row={mode:'FROZEN',store_id:p.storeId,ledger_id:p.ledgerId,environment:'production',backup_digest:p.backupSha256,facts:{reason:'plan-bound-recovery-freeze',...planBinding(p),recoveryOperationId:'different-operation'}};
 const c=capture();assert.equal(await runProductionRestoreCli(['inspect','--config-file','synthetic','--artifact-dir','synthetic','--checksum','a'.repeat(64)],{...c,inspect:async()=>requireControl(row,p,'FROZEN','plan-bound-recovery-freeze')}),1);
 assert.deepEqual(c.result(),{eligible:'NO',code:'PRODUCTION_RESTORE_C1_IDENTITY_MISMATCH'});
});
test('D2 CLI preserves C1 blocked without message, stack or cause details',async()=>{
 const c=capture();assert.equal(await runProductionRestoreCli(['inspect','--config-file','synthetic','--artifact-dir','synthetic','--checksum','a'.repeat(64)],{...c,inspect:async()=>{throw error('PRODUCTION_ORCHESTRATION_C1_BLOCKED');}}),1);
 assert.deepEqual(c.result(),{eligible:'NO',code:'PRODUCTION_ORCHESTRATION_C1_BLOCKED'});assert.equal(c.publicText().includes(sentinel),false);
});
test('D2 CLI contains unknown internal exception and sentinel detail',async()=>{
 const c=capture();assert.equal(await runProductionRestoreCli(['inspect','--config-file','synthetic','--artifact-dir','synthetic','--checksum','a'.repeat(64)],{...c,inspect:async()=>{throw Error(sentinel);}}),1);
 assert.deepEqual(c.result(),{eligible:'NO',code:generic});assert.equal(c.publicText().includes(sentinel),false);
});
