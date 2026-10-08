import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { readFile,readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { acquireMySqlFixtureLock } from '../test-support/mysql-fixture-lock.js';
import { bootstrapIdentities } from './bootstrap.js';
import { validateSchema } from './schema.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createAuthService } from '../auth/service.js';
import { createMemoryLoginRateLimiter } from '../auth/rate-limit.js';
import { digestSessionToken } from '../auth/session-token.js';
import { createMySqlLedgerStore } from '../ledger/mysql-store.js';
import { createTrustedLedgerApplication } from '../ledger/application.js';
import { encodeLedgerSnapshot } from '../ledger/mysql-snapshot.js';
import { initialState } from '../rules.js';
const raw=process.env.LEDGER_MYSQL_TEST_URL;
test('production bootstrap against fresh migrated isolated MySQL', {skip:!raw},async t=>{
  const url=new URL(raw);
  if(url.protocol!=='mysql:'||url.pathname!=='/jbhh_ktv_test'||raw===process.env.DATABASE_URL)throw Error('Dedicated test target required');
  const setup=await mysql.createConnection(raw), created=[];
  let pool;
  try {
    await acquireMySqlFixtureLock(setup);
    const [tables]=await setup.query('SHOW TABLES');assert.equal(tables.length,0,'Refuse existing tables');
    for(const file of (await readdir(new URL('../database/migrations/',import.meta.url))).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort()) {
      const source=await readFile(new URL('../database/migrations/'+file,import.meta.url),'utf8');
      for(const sql of source.split(/\r?\n/).filter(l=>!l.trim().startsWith('--')).join('\n').split(';').map(s=>s.trim()).filter(Boolean)) {
        await setup.query(sql);const name=/^CREATE TABLE (\w+)/.exec(sql);if(name)created.push(name[1]);
      }
    }
    pool=mysql.createPool({uri:raw,connectionLimit:4,supportBigNumbers:true,bigNumberStrings:true});
    const auth=createAuthService({store:createMySqlAuthStore({pool,database:'jbhh_ktv_test'}),rateLimiter:createMemoryLoginRateLimiter()});
    const secret=randomBytes(32).toString('base64url'), nextSecret=randomBytes(32).toString('base64url');
    const person={principalId:'10000000-0000-4000-8000-000000000001',employeeId:'20000000-0000-4000-8000-000000000001',displayName:'Synthetic bootstrap person',loginIdentifier:'synthetic-bootstrap',enabled:true,template:'BOOKING_STAFF',permissions:['room.clean'],policyAttributes:[]};
    const plan={configVersion:'synthetic-v1',environment:'test',database:'jbhh_ktv_test',storeId:'synthetic-store',ledgerId:'synthetic-ledger',approved:true,people:[person]};
    const args={pool,plan,databaseUrl:raw,confirmation:'jbhh_ktv_test/synthetic-store/synthetic-ledger',initiatedBy:'synthetic-test-operator',env:{LEDGER_MYSQL_TEST_URL:raw},passwords:{[person.principalId]:secret}};
    const counts=async()=>{const result={};for(const name of created){const [[row]]=await pool.query('SELECT COUNT(*) AS n FROM '+name);result[name]=String(row.n);}return result;};
    await t.test('001 through current schema installed and unknown schema refused',async()=>{
      assert.equal((await validateSchema(setup,'jbhh_ktv_test')).tables,18);
      await setup.query('ALTER TABLE employees ADD COLUMN unexpected INT NULL');
      await assert.rejects(validateSchema(setup,'jbhh_ktv_test'),{code:'BOOTSTRAP_SCHEMA_MISMATCH'});
      await setup.query('ALTER TABLE employees DROP COLUMN unexpected');
    });
    await t.test('dry run makes zero data changes',async()=>{
      const before=await counts();const result=await bootstrapIdentities(args);
      assert.equal(result.accountsCreated,1);assert.equal(result.grantsAssigned,3);
      assert.deepEqual(await counts(),before);
    });
    await t.test('first apply hashes credentials and binds stable separate identities',async()=>{
      const result=await bootstrapIdentities({...args,dryRun:false});assert.equal(result.accountsCreated,1);
      const [[row]]=await pool.execute('SELECT a.principal_id,e.employee_id,e.principal_id AS binding,c.password_algorithm,c.salt,c.derived_key FROM auth_accounts a JOIN auth_credentials c USING(principal_id) JOIN employees e USING(principal_id)');
      assert.equal(row.principal_id,person.principalId);assert.equal(row.employee_id,person.employeeId);assert.equal(row.binding,person.principalId);
      assert.equal(row.password_algorithm,'scrypt');assert.equal(row.derived_key.length,32);
      assert.equal(row.derived_key.toString().includes(secret),false);assert.equal(JSON.stringify(result).includes(secret),false);
      const [[audit]]=await pool.query('SELECT initiated_by,config_version,facts,occurred_at FROM production_bootstrap_events');
      assert.equal(audit.initiated_by,'synthetic-test-operator');assert.equal(audit.config_version,'synthetic-v1');assert.ok(audit.occurred_at);
      assert.equal(JSON.stringify(audit).includes(secret),false);
    });
    await t.test('repeated and concurrent applies never duplicate or rotate',async()=>{
      const [[before]]=await pool.query('SELECT HEX(derived_key) AS digest FROM auth_credentials');
      const results=await Promise.all([bootstrapIdentities({...args,passwords:{},dryRun:false}),bootstrapIdentities({...args,passwords:{},dryRun:false})]);
      assert.ok(results.every(r=>r.accountsCreated===0&&r.employeesCreated===0&&r.grantsAssigned===0&&r.bindingsCreated===0));
      const after=await counts();assert.equal(after.auth_accounts,'1');assert.equal(after.employees,'1');assert.equal(after.auth_grants,'3');
      const [[current]]=await pool.query('SELECT HEX(derived_key) AS digest FROM auth_credentials');
      assert.equal(current.digest,before.digest);
    });
    await t.test('conflicting identity or grants rolls back all rows',async()=>{
      const before=await counts();
      await assert.rejects(bootstrapIdentities({...args,dryRun:false,plan:{...plan,people:[{...person,displayName:'wrong'}]}}),{code:'BOOTSTRAP_IDENTITY_CONFLICT'});
      await assert.rejects(bootstrapIdentities({...args,dryRun:false,plan:{...plan,people:[{...person,permissions:[]}]}}),{code:'BOOTSTRAP_CAPABILITY_CONFLICT'});
      assert.deepEqual(await counts(),before);
    });
    await t.test('partial existing account can receive its missing employee and grants',async()=>{
      const {principalId}=await auth.createAccount({loginIdentifier:'synthetic-partial',password:secret});
      const partial={...person,principalId,employeeId:'20000000-0000-4000-8000-000000000002',loginIdentifier:'synthetic-partial'};
      const result=await bootstrapIdentities({...args,dryRun:false,passwords:{},plan:{...plan,people:[partial]}});
      assert.equal(result.accountsCreated,0);assert.equal(result.employeesCreated,1);assert.equal(result.grantsAssigned,3);
      const again=await bootstrapIdentities({...args,dryRun:false,passwords:{},plan:{...plan,people:[partial]}});
      assert.equal(again.grantsAssigned,0);assert.equal(again.employeesCreated,0);
    });
    await t.test('wrong own password refused, correct change increments version and invalidates sessions',async()=>{
      const login=await auth.login({loginIdentifier:person.loginIdentifier,password:secret});assert.equal(login.ok,true);
      const invalid=await auth.changeOwnPassword({loginIdentifier:person.loginIdentifier,currentPassword:nextSecret,newPassword:secret});
      assert.equal(invalid.ok,false);
      assert.ok(await auth.authenticateSession(login.token));
      const changed=await auth.changeOwnPassword({loginIdentifier:person.loginIdentifier,currentPassword:secret,newPassword:nextSecret});
      assert.equal(changed.ok,true);assert.equal(await auth.authenticateSession(login.token),null);
      const [[account]]=await pool.execute('SELECT credential_version FROM auth_accounts WHERE principal_id=?',[person.principalId]);assert.equal(String(account.credential_version),'2');
      assert.equal((await auth.login({loginIdentifier:person.loginIdentifier,password:secret})).ok,false);
      assert.equal((await auth.login({loginIdentifier:person.loginIdentifier,password:nextSecret})).ok,true);
    });
    await t.test('disable after authentication still denies transaction-bound trusted write',async()=>{
      const login=await auth.login({loginIdentifier:person.loginIdentifier,password:nextSecret});assert.equal(login.ok,true);
      assert.ok(await auth.authenticateSession(login.token));
      const state=initialState();state.rooms[0].status='待清洁';const encoded=encodeLedgerSnapshot(state);
      await pool.execute('INSERT INTO ledger_heads(ledger_id,revision,state_schema_version,state_json,state_checksum) VALUES(?,0,?,?,?)',['bootstrap-disable',state.version,encoded.json,encoded.checksum]);
      const authStore=createMySqlAuthStore({pool,database:'jbhh_ktv_test'});
      const store=createMySqlLedgerStore({pool,database:'jbhh_ktv_test',ledgerId:'bootstrap-disable',bindSessionRevalidation:authStore.bindSessionRevalidation});
      const app=createTrustedLedgerApplication({store,businessTimeZone:'Asia/Shanghai'});
      await auth.disableAccount({principalId:person.principalId});
      await assert.rejects(app.execute({operationKey:'disabled',expectedRevision:0,action:'clean',payload:{room:'V01'}},{tokenDigest:digestSessionToken(login.token)}),e=>e.code==='AUTHENTICATION_REQUIRED');
      const head=await store.read();assert.equal(head.revision,0);
    });
    await t.test('explicit disabled bootstrap account cannot log in',async()=>{
      const p={...person,principalId:'10000000-0000-4000-8000-000000000003',employeeId:'20000000-0000-4000-8000-000000000003',loginIdentifier:'synthetic-disabled',enabled:false};
      await bootstrapIdentities({...args,dryRun:false,passwords:{[p.principalId]:secret},plan:{...plan,people:[p]}});
      assert.equal((await auth.login({loginIdentifier:p.loginIdentifier,password:secret})).ok,false);
    });
  }finally{try{if(pool)await pool.end();}finally{try{for(const name of created.reverse())await setup.query('DROP TABLE '+name);}finally{await setup.end();}}}
});

