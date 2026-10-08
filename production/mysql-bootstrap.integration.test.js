import { runBootstrapCli } from './bootstrap-cli.js';
import { mkdtemp,writeFile,unlink,rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapMappings } from './mapping.js';
import { readProductionReadiness } from './readiness.js';
import { assertFixtureEnvironment } from '../test-support/destructive-safety.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { readFile,readdir } from 'node:fs/promises';
import { randomBytes,createHash } from 'node:crypto';
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
    // Hash every cell in every table, sorted independently of storage order. Never print secret-bearing rows.
    const snapshot=async(connection=pool,omit=[])=>{
      const result={};for(const name of created.filter(name=>!omit.includes(name))){const [rows]=await connection.query('SELECT * FROM '+name);result[name]=createHash('sha256').update(JSON.stringify(rows.map(r=>JSON.stringify(r)).sort())).digest('hex');}return result;
    };
    await t.test('001 through current schema installed and unknown schema refused',async()=>{
      assert.equal((await validateSchema(setup,'jbhh_ktv_test')).tables,20);
      await setup.query('ALTER TABLE employees ADD COLUMN unexpected INT NULL');
      await assert.rejects(validateSchema(setup,'jbhh_ktv_test'),{code:'BOOTSTRAP_SCHEMA_MISMATCH'});
      const before=await snapshot();
      await assert.rejects(bootstrapIdentities({...args,dryRun:false}),{code:'BOOTSTRAP_SCHEMA_MISMATCH'});assert.deepEqual(await snapshot(),before);
      await setup.query('ALTER TABLE employees DROP COLUMN unexpected');
      await setup.query('CREATE TABLE synthetic_future_table(id INT) ENGINE=InnoDB');created.push('synthetic_future_table');
      try{const before=await snapshot();await assert.rejects(bootstrapIdentities({...args,dryRun:false}),{code:'BOOTSTRAP_SCHEMA_MISMATCH'});assert.deepEqual(await snapshot(),before);}
      finally{assertFixtureEnvironment();await setup.query('DROP TABLE synthetic_future_table');created.pop();}
    });
    await t.test('migration 010 upgrade preserves 001-009 rows, repeat refuses, no identity seeds',async()=>{
      assertFixtureEnvironment();await setup.query('DROP TABLE recovery_events');await setup.query('DROP TABLE recovery_control');await setup.query('DROP TABLE production_bootstrap_events');
      await setup.query("INSERT INTO auth_events(event_type,reason_code) VALUES('login-failure','synthetic-migration-probe')");
      const before=await snapshot(pool,['production_bootstrap_events','recovery_control','recovery_events']);
      await assert.rejects(bootstrapIdentities({...args,dryRun:false}),{code:'BOOTSTRAP_SCHEMA_MISMATCH'});
      assert.deepEqual(await snapshot(pool,['production_bootstrap_events','recovery_control','recovery_events']),before);
      const ddl=(await readFile(new URL('../database/migrations/010_mysql_production_bootstrap.sql',import.meta.url),'utf8')).split(/\r?\n/).filter(l=>!l.trim().startsWith('--')).join('\n').trim().replace(/;$/,'');
      await setup.query(ddl);
      const recoveryDdl=await readFile(new URL('../database/migrations/011_mysql_recovery_control.sql',import.meta.url),'utf8');
      for(const sql of recoveryDdl.split(/\r?\n/).filter(l=>!l.trim().startsWith('--')).join('\n').split(';').map(s=>s.trim()).filter(Boolean))await setup.query(sql);
      assert.deepEqual(await snapshot(pool,['production_bootstrap_events','recovery_control','recovery_events']),before);
      const installed=await snapshot();await assert.rejects(setup.query(ddl),{code:'ER_TABLE_EXISTS_ERROR'});
      assert.deepEqual(await snapshot(),installed);assert.equal((await counts()).auth_accounts,'0');assert.equal((await counts()).employees,'0');
    });
    await t.test('dry run makes zero data changes',async()=>{
      const before=await snapshot();const result=await bootstrapIdentities(args);
      assert.equal(result.accountsCreated,1);assert.equal(result.grantsAssigned,3);
      assert.deepEqual(await snapshot(),before);
    });

    await t.test('unknown capabilities and invalid credentials fail without any data change',async()=>{
      const before=await snapshot();
      for(const permission of ['unknown.permission','*','admin.*'])await assert.rejects(bootstrapIdentities({...args,dryRun:false,plan:{...plan,people:[{...person,permissions:[permission]}]}}),{code:'BOOTSTRAP_UNKNOWN_CAPABILITY'});
      await assert.rejects(bootstrapIdentities({...args,dryRun:false,plan:{...plan,people:[{...person,policyAttributes:['arbitrary.attribute']}]}}),{code:'BOOTSTRAP_UNKNOWN_CAPABILITY'});
      await assert.rejects(bootstrapIdentities({...args,dryRun:false,passwords:{[person.principalId]:secret.repeat(30)}}),e=>e.code==='BOOTSTRAP_CREDENTIAL_REQUIRED'&&!String(e.stack).includes(secret));
      assert.deepEqual(await snapshot(),before);
    });
    await t.test('actual CLI dry run from external secret input logs no credentials and writes nothing',async()=>{
      const dir=await mkdtemp(join(tmpdir(),'ktv-bootstrap-secret-')),planFile=join(dir,'plan.json'),secretFile=join(dir,'credentials.json');
      const output=[],logger={log:v=>output.push(v),error:v=>output.push(v)};
      try{
        await writeFile(planFile,JSON.stringify(plan));await writeFile(secretFile,JSON.stringify({databaseUrl:raw,passwords:{[person.principalId]:secret}}));
        const before=await snapshot();
        const exit=await runBootstrapCli(['--plan',planFile,'--secrets-file',secretFile,'--confirm-target',args.confirmation,'--initiated-by','synthetic-cli-operator','--dry-run'],args.env,logger);
        assert.equal(exit,0);assert.deepEqual(await snapshot(),before);
        assert.equal(output.length,1);assert.equal(output[0].includes(secret),false);assert.equal(output[0].includes(raw),false);
        assert.equal(JSON.parse(output[0]).dryRun,true);
      }finally{await unlink(planFile);await unlink(secretFile);await rmdir(dir);}
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
      const facts=typeof audit.facts==='string'?JSON.parse(audit.facts):audit.facts;
      assert.equal(facts.source,'identity-bootstrap');assert.ok(Date.parse(facts.startedAt)<=Date.parse(facts.completedAt));
      assert.equal((await counts()).auth_grants,'3');
      const [[credential]]=await pool.query('SELECT password_params_version,OCTET_LENGTH(salt) AS salt_bytes,OCTET_LENGTH(derived_key) AS key_bytes FROM auth_credentials');
      assert.equal(credential.password_params_version,1);assert.equal(Number(credential.salt_bytes),32);assert.equal(Number(credential.key_bytes),32);
    });
    await t.test('repeated and concurrent applies never duplicate or rotate',async()=>{
      const unchanged=await snapshot(pool,['production_bootstrap_events']);
      const [[before]]=await pool.query('SELECT HEX(derived_key) AS digest FROM auth_credentials');
      const results=await Promise.all([bootstrapIdentities({...args,passwords:{},dryRun:false}),bootstrapIdentities({...args,passwords:{},dryRun:false})]);
      assert.ok(results.every(r=>r.status==='already_satisfied'&&r.accountsCreated===0&&r.employeesCreated===0&&r.grantsAssigned===0&&r.bindingsCreated===0));
      const after=await counts();assert.equal(after.auth_accounts,'1');assert.equal(after.employees,'1');assert.equal(after.auth_grants,'3');
      const [[current]]=await pool.query('SELECT HEX(derived_key) AS digest FROM auth_credentials');
      assert.equal(current.digest,before.digest);assert.deepEqual(await snapshot(pool,['production_bootstrap_events']),unchanged);
    });
    await t.test('conflicting identity or grants rolls back all rows',async()=>{
      const before=await snapshot();
      await assert.rejects(bootstrapIdentities({...args,dryRun:false,plan:{...plan,people:[{...person,displayName:'wrong'}]}}),{code:'BOOTSTRAP_IDENTITY_CONFLICT'});
      await assert.rejects(bootstrapIdentities({...args,dryRun:false,plan:{...plan,people:[{...person,permissions:[]}]}}),{code:'BOOTSTRAP_CAPABILITY_CONFLICT'});
      assert.deepEqual(await snapshot(),before);
    });
    await t.test('a completed identity plan cannot silently add new grants',async()=>{
      const before=await snapshot();
      await assert.rejects(bootstrapIdentities({...args,dryRun:false,plan:{...plan,people:[{...person,permissions:['room.clean','backend.view']}]}}),{code:'BOOTSTRAP_CAPABILITY_CONFLICT'});
      assert.deepEqual(await snapshot(),before);
    });
    await t.test('identity rebinding and wrong-store requests fail before mutation SQL',async()=>{
      const before=await snapshot();
      for(const p of [{...person,principalId:'10000000-0000-4000-8000-000000000009'},{...person,employeeId:'20000000-0000-4000-8000-000000000009'}])await assert.rejects(bootstrapIdentities({...args,dryRun:false,plan:{...plan,people:[p]}}),{code:'BOOTSTRAP_IDENTITY_CONFLICT'});
      let writes=0;const tracked={getConnection:async()=>{const c=await pool.getConnection();return new Proxy(c,{get(target,key){if(key==='execute')return(sql,...rest)=>{if(/^(INSERT|UPDATE|DELETE)/.test(sql))writes++;return target.execute(sql,...rest);};const value=target[key];return typeof value==='function'?value.bind(target):value;}});}};
      await assert.rejects(bootstrapIdentities({...args,pool:tracked,dryRun:false,plan:{...plan,storeId:'wrong-store'},confirmation:'jbhh_ktv_test/wrong-store/synthetic-ledger'}),{code:'BOOTSTRAP_STORE_MISMATCH'});
      assert.equal(writes,0);assert.deepEqual(await snapshot(),before);
    });
    await t.test('injected failure after two employee inserts rolls back every table and redacts diagnostics',async()=>{
      const before=await snapshot();let inserted=0;
      const people=[10,11].map(n=>({...person,principalId:'10000000-0000-4000-8000-'+String(n).padStart(12,'0'),employeeId:'20000000-0000-4000-8000-'+String(n).padStart(12,'0'),loginIdentifier:'synthetic-rollback-'+n}));
      const broken={getConnection:async()=>{const c=await pool.getConnection();return new Proxy(c,{get(target,key){if(key==='execute')return async(sql,...rest)=>{const result=await target.execute(sql,...rest);if(sql.startsWith('INSERT INTO employees')&&++inserted===2)throw Error(secret);return result;};const value=target[key];return typeof value==='function'?value.bind(target):value;}});}};
      await assert.rejects(bootstrapIdentities({...args,pool:broken,dryRun:false,plan:{...plan,people},passwords:Object.fromEntries(people.map(p=>[p.principalId,secret]))}),e=>e.code==='BOOTSTRAP_FAILED'&&!String(e.stack).includes(secret));
      assert.equal(inserted,2);assert.deepEqual(await snapshot(),before);
      await assert.rejects(bootstrapIdentities({...args,pool:{getConnection:async()=>{throw Error(secret);}}}),e=>e.code==='BOOTSTRAP_FAILED'&&!String(e.stack).includes(secret));
    });
    await t.test('populated dry-run preserves all table contents including audits',async()=>{
      const before=await snapshot();const preview=await bootstrapIdentities(args);assert.equal(preview.accountsCreated,0);assert.deepEqual(await snapshot(),before);
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
      const state=initialState();state.rooms[0].status=String.fromCodePoint(0x5f85,0x6e05,0x6d01);const encoded=encodeLedgerSnapshot(state);
      await pool.execute('INSERT INTO ledger_heads(ledger_id,revision,state_schema_version,state_json,state_checksum) VALUES(?,0,?,?,?)',['bootstrap-rotation',state.version,encoded.json,encoded.checksum]);
      const oldCredential=await snapshot(pool,['auth_events','auth_sessions']);
      const invalid=await auth.changeOwnPassword({loginIdentifier:person.loginIdentifier,currentPassword:nextSecret,newPassword:secret});
      assert.equal(invalid.ok,false);assert.deepEqual(await snapshot(pool,['auth_events','auth_sessions']),oldCredential);
      assert.ok(await auth.authenticateSession(login.token));
      const changed=await auth.changeOwnPassword({loginIdentifier:person.loginIdentifier,currentPassword:secret,newPassword:nextSecret});
      assert.equal(changed.ok,true);assert.equal(await auth.authenticateSession(login.token),null);
      const authStore=createMySqlAuthStore({pool,database:plan.database});
      const store=createMySqlLedgerStore({pool,database:plan.database,ledgerId:'bootstrap-rotation',bindSessionRevalidation:authStore.bindSessionRevalidation});
      const app=createTrustedLedgerApplication({store,businessTimeZone:'Asia/Shanghai'});
      await assert.rejects(app.execute({operationKey:'old-credential',expectedRevision:0,action:'clean',payload:{room:'V01'}},{tokenDigest:digestSessionToken(login.token)}),{code:'AUTHENTICATION_REQUIRED'});
      assert.equal((await store.read()).revision,0);
      const [auditRows]=await pool.query("SELECT event_type FROM auth_events WHERE principal_id=? AND event_type='credential-rotated'",[person.principalId]);assert.equal(auditRows.length,1);
      const [allEvents]=await pool.query('SELECT * FROM auth_events');assert.equal(JSON.stringify(allEvents).includes(secret),false);assert.equal(JSON.stringify(allEvents).includes(nextSecret),false);
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

    const mappingPlan={configVersion:'synthetic-mappings-v1',environment:'test',database:'jbhh_ktv_test',storeId:plan.storeId,ledgerId:plan.ledgerId,approved:true,mappings:[{internalRoomId:'V06',provider:'ktvsky',externalDeviceId:'synthetic-device-674B',enabled:false,source:'human-confirmed',confirmedAt:'2026-10-08T00:00:00Z',confirmedBy:'synthetic-operator'}]};
    const mappingArgs={...args,plan:mappingPlan};
    const readyConfig={environment:'test',database:plan.database,storeId:plan.storeId,ledgerId:plan.ledgerId,deviceControlMode:'disabled'};
    await t.test('explicit mapping dry run is read only and first/rerun preserves stable target',async()=>{
      const state=initialState(),encoded=encodeLedgerSnapshot(state);
      await pool.execute('INSERT INTO ledger_heads(ledger_id,revision,state_schema_version,state_json,state_checksum) VALUES(?,0,?,?,?)',[plan.ledgerId,state.version,encoded.json,encoded.checksum]);
      const before=await snapshot();
      const preview=await bootstrapMappings(mappingArgs);assert.equal(preview.mappingsCreated,1);assert.deepEqual(await snapshot(),before);
      const applied=await bootstrapMappings({...mappingArgs,dryRun:false});assert.equal(applied.mappingsCreated,1);
      assert.equal(JSON.stringify(applied).includes('synthetic-device-674B'),false);
      const again=await bootstrapMappings({...mappingArgs,dryRun:false});assert.equal(again.mappingsCreated,0);
      const [[count]]=await pool.query('SELECT COUNT(*) AS n FROM room_device_mappings');assert.equal(String(count.n),'1');
      const [[audit]]=await pool.query("SELECT facts FROM production_bootstrap_events WHERE config_version='synthetic-mappings-v1' LIMIT 1");
      const fact=typeof audit.facts==='string'?JSON.parse(audit.facts):audit.facts;
      assert.equal(fact.source,'mapping-bootstrap');assert.ok(Date.parse(fact.startedAt)<=Date.parse(fact.completedAt));
      assert.equal(fact.mappings[0].source,'human-confirmed');assert.equal(fact.mappings[0].confirmedBy,'synthetic-operator');assert.ok(fact.mappings[0].confirmedAt);
    });
    await t.test('mapping conflicts and unknown room never overwrite existing target or revision',async()=>{
      const before=await snapshot();
      await assert.rejects(bootstrapMappings({...mappingArgs,dryRun:false,plan:{...mappingPlan,mappings:[{...mappingPlan.mappings[0],externalDeviceId:'different'}]}}),{code:'BOOTSTRAP_MAPPING_CONFLICT'});
      await assert.rejects(bootstrapMappings({...mappingArgs,dryRun:false,plan:{...mappingPlan,mappings:[{...mappingPlan.mappings[0],internalRoomId:'unknown'}]}}),{code:'BOOTSTRAP_UNKNOWN_ROOM'});
      assert.deepEqual(await snapshot(),before);
      const [[head]]=await pool.execute('SELECT revision FROM ledger_heads WHERE ledger_id=?',[plan.ledgerId]);assert.equal(String(head.revision),'0');
    });
    await t.test('real MySQL readiness reports null stock and required mappings without writes',async()=>{
      const before=await snapshot(),report=await readProductionReadiness({pool,config:{...readyConfig,deviceControlMode:'required'}});
      assert.equal(report.ready,false);assert.equal(report.revision,0);
      assert.ok(report.blockers.some(b=>b.code==='OPENING_INVENTORY_REQUIRED'));
      assert.ok(report.blockers.some(b=>b.code==='ROOM_MAPPING_REQUIRED'));
      assert.ok(report.blockers.some(b=>b.code==='DEVICE_REQUIRED_PROVIDER_PRODUCTION_DISABLED'));
      assert.equal(report.mapping.checklist.find(r=>r.internalRoomId==='V06').status,'CONFIRMED_DISABLED');
      assert.deepEqual(await snapshot(),before);
    });
    await t.test('initialized zero inventory is accepted in disabled mode; store mismatch denied',async()=>{
      const state=initialState();for(const stock of [...Object.values(state.inventory),...Object.values(state.consumables)])stock.count=0;
      const encoded=encodeLedgerSnapshot(state);
      await pool.execute('UPDATE ledger_heads SET state_json=?,state_checksum=? WHERE ledger_id=?',[encoded.json,encoded.checksum,plan.ledgerId]);
      const report=await readProductionReadiness({pool,config:readyConfig});assert.equal(report.ready,true);assert.equal(report.catalog.blockers.length,0);
      await assert.rejects(readProductionReadiness({pool,config:{...readyConfig,storeId:'wrong'}}),{code:'PRODUCTION_STORE_MISMATCH'});
    });
  }finally{try{if(pool)await pool.end();}finally{try{for(const name of created.reverse()){assertFixtureEnvironment(); await setup.query('DROP TABLE '+name);}}finally{await setup.end();}}}
});
