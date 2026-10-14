// TEST SUPPORT ONLY. Admit freshEnvironment's disposable endpoint before TCP.
import {assertFixtureEnvironment} from './destructive-safety.js';
import {assertOwnedRoot} from '../rehearsal/scope.js';
import {assertRegressionFixture} from '../rehearsal/regression-guard.js';
import {connect} from '../backup/mysql-backup.js';
const fail=code=>Object.assign(Error(code),{code});
export async function requireOwnedBackupFixture(env=process.env){
 assertFixtureEnvironment(env);
 if(env.STAGE5E_RUN!=='synthetic-only'||!env.STAGE5E_FIXTURE_ROOT||!env.STAGE5E_FIXTURE_ID||
  typeof env.STAGE5E_FIXTURE_UUID!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(env.STAGE5E_FIXTURE_UUID)||!env.LEDGER_MYSQL_TEST_URL)
  throw fail('OWNED_MYSQL_FIXTURE_REQUIRED');
 let url;try{url=new URL(env.LEDGER_MYSQL_TEST_URL);}catch{throw fail('OWNED_MYSQL_FIXTURE_ENDPOINT_DENIED');}
 // These are the existing freshEnvironment.dbUrl contract, not runtime defaults.
 if(url.protocol!=='mysql:'||url.hostname!=='127.0.0.1'||url.port!=='33313'||url.pathname!=='/jbhh_ktv_test'||
  url.username!=='root'||url.password!==''||url.search||url.hash)throw fail('OWNED_MYSQL_FIXTURE_ENDPOINT_DENIED');
 try{await assertOwnedRoot(env.STAGE5E_FIXTURE_ROOT,env.STAGE5E_FIXTURE_ID);}catch{throw fail('OWNED_MYSQL_FIXTURE_SCOPE_DENIED');}
 return url.href;
}
export async function connectOwnedBackupFixture(env=process.env,{connectSource=connect}={}){
 const facts=Object.freeze({...env}),raw=await requireOwnedBackupFixture(facts);
 const connection=await connectSource(raw);
 try{await assertRegressionFixture(connection,facts);return connection;}
 catch(error){await connection.end();throw error;}
}
