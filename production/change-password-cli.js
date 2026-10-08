import mysql from 'mysql2/promise';
import { readExternalSecret } from './secret-file.js';
import { validateSchema } from './schema.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createAuthService } from '../auth/service.js';
import { createMemoryLoginRateLimiter } from '../auth/rate-limit.js';
import { validateTarget, exact, refused } from './plan.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function runPasswordCli(argv=process.argv.slice(2),env=process.env,output=console) {
  let pool;
  try {
    if(argv.length!==4||argv[0]!=='--secrets-file'||argv[2]!=='--confirm-target')throw refused('BOOTSTRAP_INVALID_ARGUMENTS');
    const secret=await readExternalSecret(argv[1]);
    exact(secret,['databaseUrl','database','storeId','ledgerId','environment','loginIdentifier','currentPassword','newPassword']);
    validateTarget(secret,secret.databaseUrl,argv[3],env);
    pool=mysql.createPool({uri:secret.databaseUrl,connectionLimit:1});
    const c=await pool.getConnection();
    try{
      await validateSchema(c,secret.database);
      const [rows]=await c.query('SELECT DISTINCT store_id,ledger_id,environment FROM production_bootstrap_events');
      if(!rows.length||rows.some(r=>r.store_id!==secret.storeId||r.ledger_id!==secret.ledgerId||r.environment!==secret.environment))throw refused('BOOTSTRAP_STORE_MISMATCH');
    }finally{c.release();}
    const auth=createAuthService({store:createMySqlAuthStore({pool,database:secret.database}),rateLimiter:createMemoryLoginRateLimiter()});
    const result=await auth.changeOwnPassword(secret);
    output.log(JSON.stringify(result.ok?{code:'PASSWORD_CHANGED_SESSIONS_REVOKED'}:{code:'INVALID_CREDENTIALS'}));
    return result.ok?0:1;
  }catch{output.error(JSON.stringify({code:'PASSWORD_CHANGE_FAILED'}));return 1;}
  finally{if(pool)await pool.end();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runPasswordCli();

