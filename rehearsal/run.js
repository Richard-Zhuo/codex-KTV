import {fileURLToPath} from 'node:url';import {writeFile} from 'node:fs/promises';import {createInterface} from 'node:readline';import mysql from 'mysql2/promise';
import {prepare} from './prepare.js';import {scenarios} from './scenarios.js';
import {createAuthService} from '../auth/service.js';import {createMySqlAuthStore} from '../auth/mysql-store.js';import {createMemoryLoginRateLimiter} from '../auth/rate-limit.js';
const repository=fileURLToPath(new URL('../',import.meta.url));let f,evidence;
try{
 f=await prepare(repository);evidence=await scenarios(f,name=>process.stdout.write(JSON.stringify({step:name})+'\n'));
 if(process.argv.includes('--browser-hold')){
  const p=f.source.people[0],pool=mysql.createPool({uri:f.dbUrl(f.active.database),connectionLimit:2});f.pools.add(pool);
  const auth=createAuthService({store:createMySqlAuthStore({pool,database:f.active.database}),rateLimiter:createMemoryLoginRateLimiter()});
  const changed=await auth.changeOwnPassword({loginIdentifier:p.loginIdentifier,currentPassword:f.source.password,newPassword:'Stage5E-Synthetic-Only!'});if(!changed.ok)throw Error('REHEARSAL_BROWSER_SETUP_FAILED');
  const caFile=f.dirs.secrets+'/public-test-ca.pem';await writeFile(caFile,f.tls.ca);
  process.stdout.write(JSON.stringify({event:'browser_ready',origin:f.app.config.publicOrigin,loginIdentifier:p.loginIdentifier,root:f.root,id:f.names.id,caFile,caThumbprint:f.tls.thumbprint})+'\n');
  const input=createInterface({input:process.stdin});await new Promise(resolve=>{input.once('line',line=>{if(line.trim()){const data=JSON.parse(line);if(!data||Object.keys(data).some(k=>k!=='browser'))throw Error('REHEARSAL_BROWSER_EVIDENCE_INVALID');evidence.browser=data.browser;}resolve();});input.once('close',resolve);});input.close();
  const h=await f.readHead();evidence.afterBrowser={revision:h.revision,orders:h.state.orders.length,payments:h.state.orders.reduce((n,o)=>n+o.payments.length,0)};
 }
 process.stdout.write(JSON.stringify({evidence})+'\n');
}catch(e){process.stderr.write(JSON.stringify({event:'rehearsal_failed',code:e.code??e.message,message:e.message,frames:e.stack?.split('\n').filter(l=>l.trim().startsWith('at ')).slice(0,4)})+'\n');process.exitCode=1;}
finally{if(f){const cleanup=await f.cleanup();process.stdout.write(JSON.stringify({cleanup})+'\n');}}
