import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { freshEnvironment, ACCEPTED } from './fresh-environment.js';
import { initialize } from './prepare.js';
import { launcher, productionEnv } from './launcher.js';
import { preflight as currentPreflight } from '../production/preflight.js';
import { validateProductionConfig } from '../production/config.js';
import { BUSINESS_DAY_POLICY } from '../shared/business-day.js';

// Exercise real protected files and a ready database: a config-only load would
// miss the scenario's later accidental call to the current release preflight.
test('Stage5E historical release authority owns preflight, config and date policy',
 {skip:process.env.STAGE5E_RUN!=='synthetic-only',timeout:120000},async t=>{
 let f;
 try{
  f=await freshEnvironment(fileURLToPath(new URL('../',import.meta.url)));
  await initialize(f,f.names.entryDatabase,'production');
  const app=await launcher(f,{database:f.names.entryDatabase,label:'authority',formal:true});
  assert.equal(app.config.applicationCommit,ACCEPTED);
  assert.equal(app.config.businessDateCutoff,'12:00');
  const own=await app.preflight();assert.equal(own.ready,true);assert.equal(own.appVersion,ACCEPTED);
  const loaded=await app.loadRuntimeConfig();
  assert.equal(loaded.productionConfig.businessCutoff,'12:00');
  assert.equal(app.businessDateFor('2026-10-16T03:59:59Z',{timeZone:'Asia/Shanghai'}),'2026-10-15');
  assert.equal(app.businessDateFor('2026-10-16T04:00:00Z',{timeZone:'Asia/Shanghai'}),'2026-10-16');
  // The same historical file MUST fail under the current release, proving the
  // historical success above was not obtained by relaxing current validation.
  const mixed=await currentPreflight(app.configPath,productionEnv);
  assert.equal(mixed.ready,false);assert.deepEqual(mixed.blockers,['RUNTIME_PREFLIGHT_FAILED']);
  assert.throws(()=>validateProductionConfig(loaded.apiEnv),{code:'PRODUCTION_CONFIG_INVALID'});
  assert.deepEqual(BUSINESS_DAY_POLICY,{version:'cutoff-0600-v1',cutoff:'06:00'});
  assert.equal(validateProductionConfig({...loaded.apiEnv,KTV_BUSINESS_DATE_CUTOFF:'06:00'}).businessCutoff,'06:00');
 }finally{if(f){const cleanup=await f.cleanup();assert.equal(cleanup.sqlCleanup,true);assert.equal(cleanup.root,'absent');t.diagnostic(JSON.stringify({cleanup}));}}
});
