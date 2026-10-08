import { execFileSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { acquireMySqlFixtureLock } from './mysql-fixture-lock.js';
import { assertFixtureEnvironment } from './destructive-safety.js';
import { schemaSpec } from '../backup/format.js';
import { serverIdentity,connect } from '../backup/mysql-backup.js';
import { bootstrapIdentities } from '../production/bootstrap.js';
import { createAuthService } from '../auth/service.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createMemoryLoginRateLimiter } from '../auth/rate-limit.js';
import { createMySqlLedgerStore } from '../ledger/mysql-store.js';
import { createTrustedLedgerApplication } from '../ledger/application.js';
import { digestSessionToken } from '../auth/session-token.js';
import { initialState } from '../rules.js';
import { encodeLedgerSnapshot } from '../ledger/mysql-snapshot.js';
import { PERMISSION_IDS } from '../shared/identity.js';
import { POLICY_ATTRIBUTE_IDS } from '../ledger/command-policy.js';
export async function withBackupFixture(work) {
 const raw=process.env.LEDGER_MYSQL_TEST_URL,setup=await connect(raw),created=[],targets=[];let pool,dir;
 try {
  assertFixtureEnvironment();const [[owned]]=await setup.query('SELECT @@port AS port,@@datadir AS datadir');
  assert.equal(Number(owned.port),33313);assert.ok(owned.datadir.includes('ktv-stage4b-mysql-ExY9Do'));
  await acquireMySqlFixtureLock(setup);assert.equal((await setup.query('SHOW TABLES'))[0].length,0);
  for(const sql of (await schemaSpec()).statements){await setup.query(sql);const m=/^CREATE TABLE (\w+)/.exec(sql);if(m)created.push(m[1]);}
  pool=mysql.createPool({uri:raw,connectionLimit:8,supportBigNumbers:true,bigNumberStrings:true});dir=await mkdtemp(join(tmpdir(),'ktv-stage5b-'));
  const identity=await serverIdentity(setup),storeId='synthetic-recovery-store',ledgerId='synthetic-recovery-ledger',secret=randomBytes(32).toString('base64url');
  const people=[1,2].map(n=>({principalId:'30000000-0000-4000-8000-'+String(n).padStart(12,'0'),employeeId:'40000000-0000-4000-8000-'+String(n).padStart(12,'0'),displayName:'Synthetic recovery '+n,loginIdentifier:'synthetic-recovery-'+n,enabled:n===1,template:'NIGHT_OPERATOR',permissions:[...PERMISSION_IDS],policyAttributes:[...POLICY_ATTRIBUTE_IDS]}));
  const plan={configVersion:'synthetic-recovery-v1',environment:'test',database:'jbhh_ktv_test',storeId,ledgerId,approved:true,people};
  await bootstrapIdentities({pool,plan,databaseUrl:raw,confirmation:'jbhh_ktv_test/'+storeId+'/'+ledgerId,initiatedBy:'synthetic-drill',dryRun:false,passwords:Object.fromEntries(people.map(p=>[p.principalId,secret]))});
  const state=initialState();for(const r of state.rooms)r.status=String.fromCodePoint(0x5f85,0x6e05,0x6d01);
  for(const stock of [...Object.values(state.inventory),...Object.values(state.consumables)])stock.count=1000;state.inventory.qd.count=null;
  const encoded=encodeLedgerSnapshot(state);await pool.execute('INSERT INTO ledger_heads(ledger_id,revision,state_schema_version,state_json,state_checksum) VALUES(?,0,?,?,?)',[ledgerId,state.version,encoded.json,encoded.checksum]);
  const authStore=createMySqlAuthStore({pool,database:'jbhh_ktv_test'}),auth=createAuthService({store:authStore,rateLimiter:createMemoryLoginRateLimiter()}),login=await auth.login({loginIdentifier:people[0].loginIdentifier,password:secret});assert.equal(login.ok,true);
  const store=createMySqlLedgerStore({pool,database:'jbhh_ktv_test',ledgerId,bindSessionRevalidation:authStore.bindSessionRevalidation});
  const app=createTrustedLedgerApplication({store,businessTimeZone:'Asia/Shanghai'}),credential={tokenDigest:digestSessionToken(login.token)};
  const backupArgs={databaseUrl:raw,environment:'test',storeId,ledgerId,serverUuid:identity.server_uuid,confirmation:identity.server_uuid+'/jbhh_ktv_test/'+storeId+'/'+ledgerId,applicationCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:new URL('..',import.meta.url),encoding:'utf8'}).trim(),env:process.env};
  const targetArgs=(backup,suffix='main')=>{const database='jbhh_ktv_restore_'+suffix+'_'+Date.now().toString(36);targets.push(database);const url=new URL(raw);url.pathname='/'+database;return {directory:backup.directory,expectedChecksum:backup.checksum,databaseUrl:url.href,serverUuid:identity.server_uuid,environment:'test',storeId,ledgerId,restoreToNewDb:true,initiatedBy:'synthetic-drill',confirmation:identity.server_uuid+'/'+database+'/'+storeId+'/'+ledgerId+'/'+backup.checksum};};
  await work({raw,setup,pool,dir,identity,storeId,ledgerId,secret,people,authStore,auth,login,store,app,credential,backupArgs,targetArgs,created,targets});
 }finally{
  if(pool)await pool.end();assertFixtureEnvironment();
  for(const name of targets){if(!/^jbhh_ktv_restore_[a-z0-9_]+$/.test(name))throw Error('Unsafe test cleanup target');await setup.query('DROP DATABASE IF EXISTS '+name);}
  for(const table of created.reverse()){assertFixtureEnvironment();await setup.query('DROP TABLE '+table);}await setup.end();
  if(dir){const absolute=await import('node:path');if(absolute.dirname(absolute.resolve(dir))!==absolute.resolve(tmpdir())||!absolute.basename(dir).startsWith('ktv-stage5b-'))throw Error('Unsafe artifact cleanup');await rm(dir,{recursive:true,force:true});}
 }
}
