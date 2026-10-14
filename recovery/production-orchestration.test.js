import test from 'node:test';import assert from 'node:assert/strict';import mysql from 'mysql2/promise';
import {executeProductionRestoreStage,createOwnedRestoreOrchestration,requireOrchestrationSession,ORCHESTRATION_STAGES} from './production-orchestration.js';
import {parseProductionRestoreArgs,runProductionRestoreCli} from './production-restore-cli.js';
const capture=()=>{let out='',err='';return {stdout:{write:s=>{out+=s;}},stderr:{write:s=>{err+=s;}},result:()=>JSON.parse(out||err)};};
test('D2 direct production stage rejects forged authority before any deployment access',async()=>{
 for(const token of [{},Object.freeze({kind:'production'}),{kind:'owned-test'}])await assert.rejects(()=>executeProductionRestoreStage(token),{code:'AUTHORIZATION_AUTHORITY_FORGED'});
});
test('D2 ordinary production CLI keeps every destructive stage hard disabled without DB or provider access',async t=>{
 t.mock.method(mysql,'createConnection',()=>assert.fail('production guard must precede DB access'));
 for(const action of ORCHESTRATION_STAGES){const c=capture();assert.equal(await runProductionRestoreCli([action,'--config-file','C:\\untrusted\\runtime.json'],c),1);assert.equal(c.result().code,'RESTORE_PRODUCTION_DISABLED');}
});
test('D2 no CLI flag, env selector or plain session enables owned or production authority',async()=>{
 for(const flag of ['--fixture','--root','--policy','--authority','--force','--skip-check','--enable-production','--unsafe'])assert.throws(()=>parseProductionRestoreArgs(['authorize','--config-file','x',flag,'forged']));
 const c=capture();assert.equal(await runProductionRestoreCli(['freeze-plan','--config-file','x'],{...c,orchestration:{run:()=>assert.fail('forged session callback')}}),1);assert.equal(c.result().code,'AUTHORIZATION_AUTHORITY_FORGED');
 assert.throws(()=>requireOrchestrationSession({}),{code:'AUTHORIZATION_AUTHORITY_FORGED'});
});
test('D2 forged owned capability is rejected before context or SCM callbacks',async()=>{
 let touched=false;await assert.rejects(()=>createOwnedRestoreOrchestration({capability:{},authorization:{},deps:{get runtimeConfigFile(){touched=true;return 'x';}},system:{snapshot:()=>{touched=true;}}}),{code:'RESTORE_PRODUCTION_DISABLED'});assert.equal(touched,false);
});
test('D2 production inspect-status is read-only and reports UNKNOWN when actual operator admission fails',async t=>{
 t.mock.method(mysql,'createConnection',()=>assert.fail('non-elevated inspection must not connect DB'));
 const c=capture();assert.equal(await runProductionRestoreCli(['inspect-status','--config-file','C:\\untrusted\\runtime.json'],c),1);
 assert.deepEqual(c.result(),{status:'UNKNOWN',code:'AUTHORIZATION_OPERATOR_DENIED',writes:'NO',authorityIssued:'NO'});
});
