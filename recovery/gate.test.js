import test from 'node:test';import assert from 'node:assert/strict';
import {withBackupFixture} from '../test-support/backup-fixture.js';import {freezeDatabase} from './operator.js';
import {bindRecoveryWriteGuard,withRecoveryDispatch,recoveryApiGate,recoveryMode} from './gate.js';
import {createMySqlAuthStore} from '../auth/mysql-store.js';import {createAuthService} from '../auth/service.js';import {createMemoryLoginRateLimiter} from '../auth/rate-limit.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('recovery HTTP gate fails closed and allows static transport',async()=>{
 const api=recoveryApiGate({handle:()=>true},{pool:{getConnection:async()=>{throw Error('synthetic missing recovery schema');}}});let status,body;
 const res={writeHead:s=>{status=s;},end:b=>{body=JSON.parse(b);}};
 await api.handle({url:'/api/v1/commands/clean'},res);assert.equal(status,503);assert.equal(body.error.code,'recovery_in_progress');assert.match(body.error.requestId,/^[a-f0-9-]{36}$/);assert.equal(await api.handle({url:'/'},res),true);
});
test('MySQL freeze drains guarded writes and active provider dispatch before confirming',{skip:!process.env.LEDGER_MYSQL_TEST_URL},async()=>withBackupFixture(async f=>{
 const c=await f.pool.getConnection();let releaseDispatch;let enteredResolve;const entered=new Promise(r=>{enteredResolve=r;});
 const dispatch=withRecoveryDispatch(f.pool,'jbhh_ktv_test',async()=>{enteredResolve();await new Promise(r=>{releaseDispatch=r;});});await entered;
 await c.beginTransaction();await bindRecoveryWriteGuard(c);let frozen=false;
 const freezing=freezeDatabase({...f.backupArgs,initiatedBy:'synthetic-concurrent-freeze'}).then(r=>{frozen=true;return r;});
 try{await pause(60);assert.equal(frozen,false,'must drain in-flight dispatch');releaseDispatch();await dispatch;await pause(60);assert.equal(frozen,false,'must drain in-flight guarded transaction');await c.commit();await freezing;assert.equal(await recoveryMode(c),'FROZEN');
  await assert.rejects(withRecoveryDispatch(f.pool,'jbhh_ktv_test',()=>assert.fail('no dispatch')),{code:'RECOVERY_WORKER_PAUSED'});
  const auth=createAuthService({store:createMySqlAuthStore({pool:f.pool,database:'jbhh_ktv_test',bindRecoveryGuard:bindRecoveryWriteGuard}),rateLimiter:createMemoryLoginRateLimiter()});
  await assert.rejects(auth.login({loginIdentifier:f.people[0].loginIdentifier,password:f.secret}),{code:'RECOVERY_WRITE_FROZEN'});
  const [[n]]=await f.pool.query('SELECT COUNT(*) AS n FROM auth_sessions');assert.equal(Number(n.n),1);
 }finally{releaseDispatch?.();await c.rollback();c.release();await freezing;}
}));

test('formal room-control runtime enables recovery protection by default',async()=>{
 const {createRoomControlRuntime}=await import('../devices/runtime.js');let calls=0;const gateway={};for(const name of ['ensureSession','getRoomStatus','closeRoom','openRoom','queryRoomState'])gateway[name]=async()=>{calls++;};
 const runtime=createRoomControlRuntime({pool:{getConnection:async()=>({query:async()=>{throw Error('missing recovery schema');},release(){}})},database:'synthetic_formal_db',ledgerId:'synthetic',authStore:{bindSessionRevalidation(){}},gateway});
 await assert.rejects(runtime.start(),/missing recovery schema/);assert.equal(calls,0);await runtime.stop();
});
