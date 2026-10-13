import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fixtureId,protectedFixtureCommand} from './protected-windows-fixture.js';
const exec=promisify(execFile),script=fileURLToPath(new URL('./bootstrap-protected-windows-fixture.ps1',import.meta.url));
async function helper(args){
 try{await exec('pwsh.exe',['-NoProfile','-NonInteractive','-File',script,...args],{windowsHide:true,timeout:5000,maxBuffer:8192});assert.fail('unprivileged helper unexpectedly succeeded');}
 catch(e){if(e.code==='ERR_ASSERTION')throw e;return e.stdout;}
}
test('fixture accepts only a lowercase random ID, never an arbitrary or production path',()=>{
 for(const value of ['', 'C:\\ProgramData\\JbhhKtv\\private','..\\outside','a'.repeat(31),'A'.repeat(32)])
  assert.throws(()=>fixtureId(value),{code:'FIXTURE_ID_INVALID'});
 assert.equal(fixtureId('a'.repeat(32)),'a'.repeat(32));
});
test('test helper rejects an arbitrary directory before elevation or filesystem work',async()=>{
 for(const id of ['C:\\ProgramData\\JbhhKtv\\private','..\\outside'])
  assert.equal(JSON.parse(await helper(['-Action','Bootstrap','-FixtureId',id])).CODE,'FIXTURE_ID_INVALID');
});
test('test helper refuses non-elevated bootstrap and cleanup',async()=>{
 for(const action of ['Bootstrap','Cleanup'])
  assert.equal(JSON.parse(await helper(['-Action',action,'-FixtureId','a'.repeat(32)])).CODE,'FIXTURE_ELEVATION_REQUIRED');
});
test('fixture command accepts no root, SID, credential or production enable option',async()=>{
 for(const args of [['prepare','--root','C:\\ProgramData\\JbhhKtv'],['prepare','--operator','forged'],['verify','--enable','true']])
  await assert.rejects(()=>protectedFixtureCommand(args),{code:'FIXTURE_ARGUMENTS_INVALID'});
});

test('helper rejects explicit root parameters, including repo and ProgramData paths',async()=>{
 for(const root of [process.cwd(),'C:\\ProgramData\\JbhhKtv\\private']){
  await assert.rejects(()=>exec('pwsh.exe',['-NoProfile','-NonInteractive','-File',script,'-Action','Bootstrap','-FixtureId','a'.repeat(32),'-Root',root],{windowsHide:true,timeout:5000,maxBuffer:8192}),e=>e.code===1&&e.stderr.includes('Root'));
 }
});
test('helper refuses production environment before filesystem work',async()=>{
 await assert.rejects(()=>exec('pwsh.exe',['-NoProfile','-NonInteractive','-File',script,'-Action','Bootstrap','-FixtureId','a'.repeat(32)],{windowsHide:true,timeout:5000,maxBuffer:8192,env:{...process.env,NODE_ENV:'production'}}),e=>e.code===1&&JSON.parse(e.stdout).CODE==='FIXTURE_PRODUCTION_ENV_DENIED');
});
