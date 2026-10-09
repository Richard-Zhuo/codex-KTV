import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {prepare} from './prepare.js';
import {scenarios} from './scenarios.js';
import {assertNoSecretMarkers} from './secrets.js';
test('Stage5E fresh MySQL cutover, business, faults, recovery and owned cleanup', {skip:process.env.STAGE5E_RUN!=='synthetic-only',timeout:240000}, async t=>{
 let f;
 try{
  f=await prepare(fileURLToPath(new URL('../',import.meta.url)));
  const evidence=await scenarios(f,name=>t.diagnostic('Stage5E '+name));
  const scan=await assertNoSecretMarkers([f.dirs.artifacts,f.dirs.logs,f.dirs.backups],f.secretMarkers);
  assert.equal(scan.leakage,0);assert.equal(evidence.security.realProviderMutations,0);
  assert.equal(evidence.goNoGo.productionGo,false);
  t.diagnostic(JSON.stringify({stage5e:evidence,secretScan:scan}));
 }catch(error){t.diagnostic(JSON.stringify({failureCode:error.code??error.message}));throw error;}finally{if(f){const cleanup=await f.cleanup();assert.equal(cleanup.root,'absent');assert.equal(cleanup.mysqlProcess,'absent');t.diagnostic(JSON.stringify({cleanup}));}}
});
