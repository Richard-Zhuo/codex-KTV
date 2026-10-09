import test from 'node:test';import assert from 'node:assert/strict';import {CATEGORIES,cutoverDecision,rollbackDecision} from './gates.js';import {runtimePath} from './artifact.js';import {scopeNames,assertOwnedDatabase} from './scope.js';import {FakeExternalHeartbeatMonitor} from './heartbeat.js';
const checks=()=>Object.fromEntries(CATEGORIES.map(k=>[k,{status:'PASS',synthetic:true,evidence:'synthetic observed checkpoint'}]));
test('cutover requires every evidenced gate and separate human GO; fake evidence cannot make production GO',()=>{
 const c=checks();assert.equal(cutoverDecision({scope:'rehearsal',checks:c}).decision,'NO-GO');assert.equal(cutoverDecision({scope:'rehearsal',checks:c,humanGo:true}).decision,'GO');
 for(const key of CATEGORIES){for(const status of ['BLOCKED','NOT_APPLICABLE'])assert.equal(cutoverDecision({scope:'rehearsal',checks:{...c,[key]:{status,evidence:'not ready'}},humanGo:true}).decision,'NO-GO');}
 assert.equal(cutoverDecision({scope:'production',checks:c,humanGo:true}).decision,'NO-GO');assert.equal(cutoverDecision({scope:'rehearsal',checks:{...c,BACKUP:{status:'PASS',evidence:''}},humanGo:true}).decision,'NO-GO');
});
test('rollback preserves all post-first-write transactions and fails closed for incompatible schema or absent backup',()=>{
 const input={businessWrites:0,backupRevision:0,currentRevision:0,compatible:true,backupVerified:true};
 assert.equal(rollbackDecision(input).allowed,true);assert.equal(rollbackDecision({...input,businessWrites:1}).code,'PRESERVE_NEW_TRANSACTIONS');assert.equal(rollbackDecision({...input,currentRevision:1}).allowed,false);
 assert.equal(rollbackDecision({...input,compatible:false}).allowed,false);assert.equal(rollbackDecision({...input,backupVerified:false}).allowed,false);
});
test('runtime package allowlist excludes fixtures, secrets, backups, traversal and test source',()=>{
 for(const p of ['production/start.js','ui/staff-app.js','database/migrations/011_mysql_recovery_control.sql'])assert.equal(runtimePath(p),true);
 for(const p of ['.env','test-support/runtime-browser-smoke.js','production/runtime.test.js','database/seed.sql','secrets/token.json','ui/../secret.js','backup/data.json'])assert.equal(runtimePath(p),false);
 const n=scopeNames('0123456789abcdef');assert.throws(()=>assertOwnedDatabase('production',n,new Set(['production'])));assert.throws(()=>scopeNames('../'));
});
test('external checker detects independent loss without claiming real heartbeat configured',async()=>{
 let down=false;const monitor=new FakeExternalHeartbeatMonitor(async()=>{if(down)throw Error('offline');return {status:200};});
 assert.equal((await monitor.probe()).ready,true);down=true;const r=await monitor.probe();assert.equal(r.live,false);assert.equal(r.productionConfigured,false);
});
