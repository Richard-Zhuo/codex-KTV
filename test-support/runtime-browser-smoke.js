// Test-only manual browser fixture. Never included in a deployment package.
import {createInterface} from 'node:readline';
import {createAuthService} from '../auth/service.js';
import {createMySqlAuthStore} from '../auth/mysql-store.js';
import {createMemoryLoginRateLimiter} from '../auth/rate-limit.js';
import mysql from 'mysql2/promise';
import {withProductionRuntimeFixture} from './production-runtime-fixture.js';
await withProductionRuntimeFixture(async f=>{
 const pool=mysql.createPool({uri:f.target.databaseUrl,connectionLimit:2});
 try{
  const auth=createAuthService({store:createMySqlAuthStore({pool,database:f.database}),rateLimiter:createMemoryLoginRateLimiter()});
  // Deliberately public test-only input; no real account or deployment secret.
  const changed=await auth.changeOwnPassword({loginIdentifier:f.people[0].loginIdentifier,currentPassword:f.secret,newPassword:'Synthetic-browser-only-5C!'});
  if(!changed.ok)throw Error('SYNTHETIC_BROWSER_PASSWORD_SETUP_FAILED');
  f.start();await f.wait();
  console.log(JSON.stringify({event:'synthetic_browser_ready',origin:f.config.publicOrigin,appVersion:f.config.applicationCommit,loginIdentifier:f.people[0].loginIdentifier,liveControl:'OFF'}));
  const input=createInterface({input:process.stdin});
  await new Promise(resolve=>{input.once('line',resolve);input.once('close',resolve);});
  input.close();await f.stop();
 }finally{await pool.end();}
});
