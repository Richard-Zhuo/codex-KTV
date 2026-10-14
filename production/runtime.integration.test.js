import test from 'node:test';import assert from 'node:assert/strict';
import { once } from 'node:events';import { writeFile } from 'node:fs/promises';
import {readRuntimeLogFiles} from '../test-support/runtime-log-reader.js';
import { withProductionRuntimeFixture } from '../test-support/production-runtime-fixture.js';
import { protectSyntheticFile } from '../test-support/runtime-tls.js';
import { preflight } from './preflight.js';
import { freezeDatabase } from '../recovery/operator.js';
const production={NODE_ENV:'production',KTV_HTTP_ENV:'production',KTV_DEPLOYMENT_ENV:'production'};
test('Stage5C real native service-host / HTTPS / MySQL production-like smoke',{skip:!process.env.LEDGER_MYSQL_TEST_URL,timeout:120000},()=>withProductionRuntimeFixture(async f=>{
 assert.equal((await preflight(f.configPath,production)).ready,true);
 f.start();await f.wait();
 const origin=f.config.publicOrigin;
 const login=await f.request('/api/v1/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:{loginIdentifier:f.people[0].loginIdentifier,password:f.secret}});
 assert.equal(login.status,200);const cookie=login.headers['set-cookie'][0].split(';')[0],csrf=login.json().csrfToken;
 assert.match(login.headers['set-cookie'][0],/HttpOnly/);assert.match(login.headers['set-cookie'][0],/Secure/);assert.match(login.headers['set-cookie'][0],/SameSite=Strict/);
 const headers={Cookie:cookie};
 assert.equal((await f.request('/')).status,200);assert.equal((await f.request('/admin')).status,200);
 const snapshot=(await f.request('/api/v1/store/snapshot',{headers})).json();assert.equal(snapshot.revision,0);
 const command={operationKey:'stage5c-synthetic-clean',expectedRevision:snapshot.revision,payload:{room:'V01'}};
 const execute=()=>f.request('/api/v1/commands/clean',{method:'POST',headers:{...headers,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf},body:command});
 const wrong=await f.request('/api/v1/commands/clean',{method:'POST',headers:{...headers,Origin:'https://foreign.invalid','Content-Type':'application/json','X-CSRF-Token':csrf},body:command});assert.equal(wrong.status,403);
 assert.equal((await execute()).status,200);assert.equal((await f.request('/api/v1/store/snapshot',{headers})).json().revision,1);
 assert.equal((await f.request('/api/v1/admin/snapshot',{headers})).status,200);
 await f.stop();f.start();await f.wait();
 assert.equal((await f.request('/api/v1/auth/session',{headers})).status,200);
 assert.equal((await execute()).status,200);assert.equal((await f.request('/api/v1/store/snapshot',{headers})).json().revision,1);
 await f.connection.query('LOCK TABLES ledger_heads WRITE');
 try{const start=Date.now();assert.equal((await f.request('/health/live')).status,200);assert.equal((await f.request('/health/ready')).status,503);assert.ok(Date.now()-start<6000);}finally{await f.connection.query('UNLOCK TABLES');}
 assert.equal((await f.request('/health/ready')).status,200);
 const child=f.child,exited=once(child,'exit');child.kill('SIGKILL');await exited;
 // Kernel Job kills owned Node descendants, so a fresh host can bind the same port.
 f.start();await f.wait();assert.equal((await f.request('/api/v1/store/snapshot',{headers})).json().revision,1);
 const logout=await f.request('/api/v1/auth/logout',{method:'POST',headers:{...headers,Origin:origin,'X-CSRF-Token':csrf}});assert.equal(logout.status,200);assert.equal((await f.request('/api/v1/auth/session',{headers})).status,401);
 await freezeDatabase({databaseUrl:f.target.databaseUrl,environment:'production',serverUuid:f.identity.server_uuid,storeId:f.storeId,ledgerId:f.ledgerId,initiatedBy:'synthetic-runtime-smoke',confirmation:f.identity.server_uuid+'/'+f.database+'/'+f.storeId+'/'+f.ledgerId,env:production});
 assert.equal((await f.request('/health/live')).status,200);assert.equal((await f.request('/health/ready')).status,503);assert.equal((await f.request('/api/v1/store/snapshot',{headers})).status,503);
 await f.stop();f.start();await f.wait(false);assert.equal((await f.request('/health/ready')).status,503);assert.equal((await f.request('/api/v1/auth/login',{method:'POST'})).status,503);await f.stop();
 const before=JSON.stringify((await f.connection.query('SELECT revision,state_checksum FROM ledger_heads'))[0]);
 const checked=await preflight(f.configPath,production);assert.equal(checked.ready,false);assert.ok(checked.blockers.includes('RECOVERY_PAUSED'));
 assert.equal(JSON.stringify((await f.connection.query('SELECT revision,state_checksum FROM ledger_heads'))[0]),before);
 const secret={...f.runtimeSecrets,database:{...f.runtimeSecrets.database,port:1}};await writeFile(f.secretPath,JSON.stringify(secret));await protectSyntheticFile(f.secretPath,f.tls.sid);
 f.start();await f.wait(false);assert.equal((await f.request('/health/live')).status,200);assert.equal((await f.request('/health/ready')).status,503);assert.equal((await f.request('/api/v1/auth/session')).status,503);await f.stop();
 const logText=await readRuntimeLogFiles(f.logs);
 for(const value of [f.runtimeSecrets.database.password,f.runtimeSecrets.tls.privateKey,f.secretPath,cookie,csrf])assert.equal(logText.includes(value),false);
 assert.ok(logText.includes('runtime_started'));assert.ok(logText.includes('runtime_draining'));assert.ok(logText.includes('runtime_stopped'));assert.ok(logText.includes('readiness_changed'));
}));

test('S2 protected WeCom configuration gates preflight without sending a message',
  {skip:!process.env.LEDGER_MYSQL_TEST_URL,timeout:120000},()=>withProductionRuntimeFixture(async f=>{
  const {loadRuntimeConfig}=await import('./runtime-config.js');
  const configured={...f.config,monitoring:{...f.config.monitoring,
    alertingRequired:true,alertTransport:'wecom-app'}};
  await writeFile(f.configPath,JSON.stringify(configured));
  await protectSyntheticFile(f.configPath,f.tls.sid);
  const missing=await preflight(f.configPath,production);
  assert.equal(missing.ready,false);
  assert.ok(missing.blockers.includes('RUNTIME_CONFIG_INVALID'));
  const protectedSecrets={...f.runtimeSecrets,alerting:{wecom:{
    corpId:'synthetic-corp',agentId:123,secret:'synthetic-wecom-secret',
    storeLabel:'Synthetic KTV',criticalRecipients:['boss'],warnRecipients:['boss']
  }}};
  await writeFile(f.secretPath,JSON.stringify(protectedSecrets));
  await protectSyntheticFile(f.secretPath,f.tls.sid);
  const loaded=await loadRuntimeConfig(f.configPath,production);
  assert.equal(loaded.alertTransportConfig.corpId,'synthetic-corp');
  assert.ok(loaded.redactionSecrets.includes('synthetic-wecom-secret'));
  const checked=await preflight(f.configPath,production);
  assert.equal(checked.ready,true);
  assert.deepEqual(checked.degraded,[]);
  assert.ok(!checked.blockers.includes('ALERT_CHANNEL_REQUIRED'));
  assert.equal(f.child,undefined);
}));
