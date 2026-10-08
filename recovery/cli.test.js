import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRecoveryCli } from './cli.js';
test('recovery CLI rejects inherited actions without exposing private configuration',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ktv-recovery-cli-'));
 try{
  const config=join(directory,'private.json'),secret='synthetic-db-password-never-output';
  await writeFile(config,JSON.stringify({databaseUrl:'mysql://root:'+secret+'@127.0.0.1:1/synthetic',environment:'test'}));
  for(const action of ['constructor','__proto__','toString','hasOwnProperty']){
   const output=[];
   assert.equal(await runRecoveryCli([action,'--config-file',config],{log:v=>output.push(v),error:v=>output.push(v)}),1);
   assert.deepEqual(output,[JSON.stringify({code:'RECOVERY_ARGUMENTS_INVALID'})]);
   assert.equal(output.join('').includes(secret),false);
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});
