import test from 'node:test';import assert from 'node:assert/strict';import mysql from 'mysql2/promise';
import {connectOwnedBackupFixture} from './owned-mysql-fixture.js';
import {withBackupFixture} from './backup-fixture.js';
const facts=()=>({...process.env});
async function refused(env,code){let connects=0;await assert.rejects(()=>connectOwnedBackupFixture(env,{connectSource:async()=>{connects++;throw Error('UNEXPECTED_TCP');}}),{code});assert.equal(connects,0);}
test('owned backup fixture refuses absent facts before any TCP connection',async()=>{
 for(const key of ['STAGE5E_RUN','STAGE5E_FIXTURE_ROOT','STAGE5E_FIXTURE_ID','STAGE5E_FIXTURE_UUID','LEDGER_MYSQL_TEST_URL']){
  const env=facts();delete env[key];await refused(env,'OWNED_MYSQL_FIXTURE_REQUIRED');
 }
});
test('explicit 3306 and omitted port never fall back to a local MySQL connection',async()=>{
 for(const port of ['3306','']){const env=facts(),u=new URL(env.LEDGER_MYSQL_TEST_URL);u.port=port;env.LEDGER_MYSQL_TEST_URL=u.href;await refused(env,'OWNED_MYSQL_FIXTURE_ENDPOINT_DENIED');}
});
test('wrong owned database, account, host or root is rejected before TCP',async()=>{
 for(const change of [u=>u.pathname='/different_database',u=>u.username='different_account',u=>u.hostname='localhost']){
  const env=facts(),u=new URL(env.LEDGER_MYSQL_TEST_URL);change(u);env.LEDGER_MYSQL_TEST_URL=u.href;await refused(env,'OWNED_MYSQL_FIXTURE_ENDPOINT_DENIED');
 }
 const env=facts();env.STAGE5E_FIXTURE_ROOT=process.cwd();await refused(env,'OWNED_MYSQL_FIXTURE_SCOPE_DENIED');
});
test('owned server UUID disagreement closes the verified endpoint without schema mutation',async()=>{
 const env=facts();env.STAGE5E_FIXTURE_UUID='00000000-0000-4000-8000-000000000000';
 await assert.rejects(()=>connectOwnedBackupFixture(env),{message:'REHEARSAL_FIXTURE_SERVER_MISMATCH'});
});
test('freshEnvironment endpoint, account, marker and server identity admit the owned database',async t=>{
 const c=await connectOwnedBackupFixture();try{
  const [[r]]=await c.query('SELECT @@port AS port,DATABASE() AS databaseName,CURRENT_USER() AS account');
  assert.equal(Number(r.port),33313);assert.equal(r.databaseName,'jbhh_ktv_test');assert.equal(r.account.startsWith('root@'),true);
  t.diagnostic(JSON.stringify({host:'127.0.0.1',port:Number(r.port),ownedFixtureVerified:true,default3306Attempted:false}));
 }finally{await c.end();}
});
test('withBackupFixture itself fails closed before its connector when ownership is missing',async t=>{
 const saved=process.env.STAGE5E_FIXTURE_UUID;let connects=0;
 t.mock.method(mysql,'createConnection',async()=>{connects++;throw Error('UNEXPECTED_TCP');});
 try{delete process.env.STAGE5E_FIXTURE_UUID;await assert.rejects(()=>withBackupFixture(()=>assert.fail('schema must not be created')),{code:'OWNED_MYSQL_FIXTURE_REQUIRED'});assert.equal(connects,0);}
 finally{if(saved===undefined)delete process.env.STAGE5E_FIXTURE_UUID;else process.env.STAGE5E_FIXTURE_UUID=saved;}
});
