import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact } from '../rules.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMySqlLedgerStore } from './mysql-store.js';
import { paymentCommand, seedTrustedPayments, paymentOrder, paymentPermission } from '../test-support/trusted-payments-fixture.js';
import { nextCollectCharge, outstanding, PAYMENT_METHODS } from '../sales.js';
import { reportPeriodMatch } from '../reporting.js';

const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
const sqlAt = (run, name, verb) => run.calls.findIndex(call => call.kind === 'sql' && call.sql.includes(name) &&
  (verb.startsWith('FOR ') ? call.sql.endsWith(verb) : call.sql.startsWith(verb + ' ')));

// All DDL/cleanup remains with the existing guarded eleven-table fixture.
export async function testTrustedPayments({ t, pool, setup, auth, table, provision, seed, inspect, application,
  assertUnchanged, wrapConnection, poolOptions, database }) {
  const runFor = (id, options = {}) => application(id, { employeeBind: null, ...options });
  const pending = (id, prepare = () => {}) => seed(id, state => { seedTrustedPayments(state); prepare(state); });
  const authStore = createMySqlAuthStore({ pool, database });
  const assertPayments = (actual, original, actor, dbNow, action) => {
    const { state, revision } = actual.head, order = paymentOrder(state), records = order.payments.slice(1);
    assert.equal(revision, 1); assert.equal(records.length, 2); assert.equal(actual.audit.length, 1);
    assert.equal(actual.audit[0].actor_principal_id, actor); assert.equal(actual.audit[0].action, action);
    assert.equal(new Set(records.map(payment => payment.paymentId)).size, 2);
    for (const payment of records) {
      assert.match(payment.paymentId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(payment.occurredAt, dbNow); assert.equal(payment.time, dbNow);
      assert.equal(payment.recordedByPrincipalId, actor); assert.equal(payment.person, null);
      assert.equal(payment.chargeId, action === 'collect' ? 'other:810' : 'settlement');
      assert.deepEqual(Object.keys(payment).sort(), ['method','amount','chargeId','paymentId','occurredAt','recordedByPrincipalId','person','time'].sort());
    }
    assert.deepEqual(order.payments[0], paymentOrder(original).payments[0]);
    assert.deepEqual(state.orders[0], original.orders[0]); assert.equal(state.orders[0].room, null);
    assert.equal(state.inventory.qd.count, null); assert.equal(state.inventory.bw.count, 0);
    for (const key of ['inventory','consumables','ledger','catalog','serial','user','clock','permissions','capabilities','administrator',
      'reservations','deposits','withdrawals','incidents','handovers','expenses','procurements']) assert.deepEqual(state[key], original[key]);
    for (const key of ['sales','otherCharges','packageNameSnapshot','packagePriceCents','time','createdAt','employeeId'])
      assert.deepEqual(order[key], paymentOrder(original)[key]);
    assert.equal(order.rounding, 0); assert.equal(order.roundingReview, null);
    if (action === 'collect') {
      assert.equal(order.status, '营业中'); assert.deepEqual(state.rooms, original.rooms);
      assert.equal(nextCollectCharge(order).id, 'sale:800'); assert.equal(outstanding(order), 18200);
    } else {
      assert.equal(order.status, '已结账'); assert.equal(order.closedAt, dbNow); assert.equal(outstanding(order), 0);
      assert.equal(state.rooms[0].status, '待清洁'); assert.equal(state.rooms[0].order, null);
      assert.deepEqual(state.rooms.slice(1), original.rooms.slice(1));
    }
    return records;
  };

  for (const action of ['collect', 'pay']) {
    await t.test(action + ': one connection commits session-owned payment IDs/time plus unchanged charge semantics, state, revision, result and audit', async () => {
      const login = await provision([paymentPermission(action)]), id = 'payments-first-' + action;
      const original = await pending(id), connection = await pool.getConnection(); let borrows = 0;
      const [[activity]] = await pool.execute('SELECT last_seen_at,idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [login.sessionId]);
      try {
        const run = runFor(id, { connectionPool: { getConnection: async () => { borrows++; return wrapConnection(connection, [], false); } } });
        const cmd = paymentCommand(action, 'first', 0, { actorId: 'administrator', principalId: 'fake', person: 'Fake Collector',
          permissions: ['*'], role: 'administrator', clock: '1900-01-01', user: 'administrator' });
        cmd.payload.payments = cmd.payload.payments.map(payment => ({ ...payment, paymentId: 'fake-id', occurredAt: '1900-01-01',
          recordedByPrincipalId: 'fake', principalId: 'fake', actorId: 'fake', person: 'fake', time: '1900-01-01', permissions: ['*'], role: 'administrator', clock: '1900-01-01' }));
        const result = await run.app.execute(cmd, login.credential), actual = await inspect(id);
        assert.equal(result.status, 'committed'); assert.equal(result.actorId, login.principalId);
        assertPayments(actual, original, login.principalId, run.context().dbNow, action);
        assert.equal(actual.operations.length, 1); assert.deepEqual(actual.operations[0].terminal_result, result);
        assert.equal(actual.operations[0].actor_principal_id, login.principalId);
        const order = [run.calls.findIndex(call => call.kind === 'begin'), sqlAt(run,'ledger_heads','FOR UPDATE'),
          sqlAt(run,'auth_accounts','FOR UPDATE'), sqlAt(run,'auth_sessions','FOR UPDATE'), sqlAt(run,'auth_grants','FOR UPDATE'),
          sqlAt(run,'AS db_now','SELECT'), sqlAt(run,'ledger_operations','SELECT'), run.calls.findIndex(call => call.kind === 'transact'),
          sqlAt(run,'ledger_heads','UPDATE'), sqlAt(run,'ledger_operations','INSERT'), sqlAt(run,'ledger_success_audit','INSERT'),
          run.calls.findIndex(call => call.kind === 'commit')];
        assert.ok(order.every((value,index) => value >= 0 && (!index || value > order[index-1])));
        assert.equal(borrows, 1); assert.equal(run.calls.filter(call => call.kind === 'db-now').length, 1);
        assert.equal(sqlAt(run, 'employees', 'SELECT'), -1);
        const [[after]] = await pool.execute('SELECT last_seen_at,idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [login.sessionId]);
        assert.deepEqual(after, activity);
        // K05 deliberately remains: reporting selects by old order.time, not the new payment.occurredAt.
        assert.equal(reportPeriodMatch(paymentOrder(actual.head.state), run.context().dbNow, 'day'), false);
        assert.equal(Object.hasOwn(paymentOrder(actual.head.state), 'businessDate'), false);
      } finally { await connection.rollback(); connection.release(); }
    });

    await t.test(action + ': denied key is not persisted and becomes usable after the exact grant; payload grants/role cannot authorize', async () => {
      const login = await provision(['backend.view','staff.record']), id = 'payments-denied-' + action;
      await pending(id); const before = await inspect(id), run = runFor(id);
      const cmd = paymentCommand(action, 'denied', 0, { permissions: [paymentPermission(action)], role: 'administrator' });
      await assert.rejects(run.app.execute(cmd, login.credential), denied); await assertUnchanged(id, before);
      assert.equal(run.executions(), 0); assert.ok(run.calls.some(call => call.kind === 'rollback'));
      await auth.grantPermission({ principalId: login.principalId, permissionId: paymentPermission(action) });
      assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed');
      assert.equal((await inspect(id)).operations.length, 1);
    });

    await t.test(action + ': wrong amounts/methods/charge/order and pending gifts keep original terminal business rejection with no money or room changes', async () => {
      const login = await provision([paymentPermission(action)]);
      const cases = [{ changes: { payments: [{ method: '现金', amount: 1 }] } },
        { changes: { payments: [{ method: '现金', amount: action === 'collect' ? 3001 : 21201 }] } },
        { changes: { payments: [{ method: '银行卡', amount: action === 'collect' ? 3000 : 21200 }] } },
        { changes: { payments: [] } }, { prepare: state => paymentOrder(state).status = '已结账' },
        ...(action === 'collect' ? [{ changes: { charge: 'open' } }] : [{ prepare: state => paymentOrder(state).giftRequests.push({ status: '待确认' }) },
          { changes: { differenceType: '免零', payments: [{ method: '现金', amount: 20200 }] } }])];
      for (const [index,c] of cases.entries()) {
        const id = 'payments-business-' + action + '-' + index, original = await pending(id,c.prepare), run = runFor(id), cmd = paymentCommand(action,'bad',0,c.changes);
        const result = await run.app.execute(cmd,login.credential), actual = await inspect(id);
        assert.equal(result.status,'business-rejected'); assert.deepEqual(actual.head.state,original); assert.equal(actual.head.revision,0);
        assert.equal(actual.operations.length,1); assert.equal(actual.audit.length,0);
        await auth.revokePermission({ principalId:login.principalId,permissionId:paymentPermission(action) });
        assert.deepEqual(await run.app.execute(cmd,login.credential),result); await assertUnchanged(id,actual);
        await auth.grantPermission({ principalId:login.principalId,permissionId:paymentPermission(action) });
      }
    });

    await t.test(action + ': all five channels retain original amounts, status and snapshots', async () => {
      const login = await provision([paymentPermission(action)]);
      for (const [index,method] of PAYMENT_METHODS.entries()) {
        const id = 'payments-method-' + action + '-' + index, original = await pending(id), run = runFor(id);
        const cmd = paymentCommand(action,'channel',0,{payments:[{method,amount:action === 'collect' ? 3000 : 21200}]});
        assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');
        const actual = (await inspect(id)).head.state, expected = transact({...original,user:'administrator',clock:run.context().dbNow},action,cmd.payload,cmd.operationKey);
        const {paymentId,occurredAt,recordedByPrincipalId,...legacy} = paymentOrder(actual).payments[1];
        assert.ok(paymentId); assert.equal(occurredAt,run.context().dbNow); assert.equal(recordedByPrincipalId,login.principalId);
        paymentOrder(actual).payments[1] = {...legacy,person:paymentOrder(expected).payments[1].person};
        actual.user=expected.user; actual.clock=expected.clock; assert.deepEqual(actual,expected);
      }
    });

    await t.test(action + ': reconnect after revoke returns original terminal/UUIDs without transact; new key denied and actor/fingerprint conflicts preserved', async () => {
      const login = await provision([paymentPermission(action)]), other = await provision([]), id = 'payments-reconnect-' + action;
      const original = await pending(id), run=runFor(id), cmd=paymentCommand(action), first=await run.app.execute(cmd,login.credential);
      await auth.revokePermission({principalId:login.principalId,permissionId:paymentPermission(action)}); const before=await inspect(id);
      const reconnect=mysql.createPool(poolOptions);
      try {
        const reconnectAuth=createMySqlAuthStore({pool:reconnect,database});
        const again=runFor(id,{connectionPool:reconnect,bind:reconnectAuth.bindSessionRevalidation,
          transactCommand:()=>assert.fail('saved terminal must not create another payment or UUID')});
        assert.deepEqual(await again.app.execute(cmd,login.credential),first);
        await assert.rejects(again.app.execute(paymentCommand(action,'new',1),login.credential),denied);
        const actor=await again.app.execute(cmd,other.credential);assert.equal(actor.status,'idempotency-conflict');assert.equal(actor.reason,'actor-mismatch');
        for(const changed of [{...cmd,expectedRevision:1},{...cmd,payload:{...cmd.payload,person:'changed'}},
          {...cmd,payload:{...cmd.payload,payments:[{method:'现金',amount:1}]}},{...cmd,action:'settle'}]){
          const result=await again.app.execute(changed,login.credential);assert.equal(result.status,'idempotency-conflict');assert.equal(result.reason,'request-mismatch');
        }
        assert.equal(again.executions(),0);await assertUnchanged(id,before);assertPayments(before,original,login.principalId,run.context().dbNow,action);
      }finally{await reconnect.end();}
    });

    await t.test(action + ': disabled/revoked/idle/absolute/version sessions cannot access an existing operation', async () => {
      for(const state of ['disabled','revoked','idle','absolute','version']){
        const login=await provision([paymentPermission(action)]),id='payments-auth-'+action+'-'+state;await pending(id);
        const run=runFor(id),cmd=paymentCommand(action,'private');await run.app.execute(cmd,login.credential);const before=await inspect(id);
        if(state==='disabled')await auth.disableAccount({principalId:login.principalId});
        else if(state==='revoked')await auth.logout(login.token);
        else if(state==='version')await auth.rotateCredential({principalId:login.principalId,password:'synthetic-payment-rotated'});
        else if(state==='idle')await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at WHERE session_id=?',[login.sessionId]);
        else await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at, absolute_expires_at=created_at+INTERVAL 1 MICROSECOND WHERE session_id=?',[login.sessionId]);
        run.calls.length=0;await assert.rejects(run.app.execute(cmd,login.credential),error=>error.code==='AUTHENTICATION_REQUIRED');
        assert.equal(sqlAt(run,'ledger_operations','SELECT'),-1);await assertUnchanged(id,before);
      }
    });

    await t.test(action + ': stale terminal cannot create a payment when the ledger later reaches the requested revision', async () => {
      const login=await provision([paymentPermission(action)]),id='payments-stale-'+action;await pending(id);const run=runFor(id),cmd=paymentCommand(action,'stale',1);
      const terminal=await run.app.execute(cmd,login.credential);assert.equal(terminal.status,'revision-conflict');assert.equal(run.executions(),0);
      await run.app.execute(paymentCommand(action,'advance'),login.credential);const before=await inspect(id);
      await auth.revokePermission({principalId:login.principalId,permissionId:paymentPermission(action)});
      assert.deepEqual(await run.app.execute(cmd,login.credential),terminal);await assertUnchanged(id,before);
    });

    await t.test(action + ': unknown error after payment/order/room mutations rolls everything back and leaves the key retryable', async () => {
      const login=await provision([paymentPermission(action)]),id='payments-unknown-'+action,original=await pending(id);
      const before=await inspect(id);let broken=true,aborted=[];
      const run=runFor(id,{transactCommand:(...args)=>{const next=transact(...args);if(broken){aborted=paymentOrder(next).payments.slice(1).map(item=>item.paymentId);throw Error('synthetic unknown payment failure');}return next;}});
      const cmd=paymentCommand(action,'repair');await assert.rejects(run.app.execute(cmd,login.credential),/synthetic unknown payment failure/);
      await assertUnchanged(id,before);assert.ok(run.calls.some(call=>call.kind==='rollback'));
      broken=false;await run.app.execute(cmd,login.credential);const records=assertPayments(await inspect(id),original,login.principalId,run.context().dbNow,action);
      assert.ok(records.every(payment=>!aborted.includes(payment.paymentId)));
    });

    for(const name of ['ledger_operations','ledger_success_audit']){
      await t.test(action + ': real '+name+' SQL failure rolls back payment, close/release, revision/result/audit; original key retries', async()=>{
        const login=await provision([paymentPermission(action)]),id='payments-sql-'+action+'-'+(name==='ledger_operations'?'operation':'audit');
        const original=await pending(id),before=await inspect(id),run=runFor(id),constraint='chk_payment_slice_fault';
        await setup.query('ALTER TABLE '+table(name)+' ADD CONSTRAINT '+constraint+" CHECK (ledger_id <> '"+id+"')");
        const cmd=paymentCommand(action,'sql-retry');
        try{
          await assert.rejects(run.app.execute(cmd,login.credential),error=>error.code==='ER_CHECK_CONSTRAINT_VIOLATED');
          assert.ok(sqlAt(run,'ledger_heads','UPDATE')>=0);assert.ok(sqlAt(run,'ledger_operations','INSERT')>=0);
          if(name==='ledger_success_audit')assert.ok(sqlAt(run,'ledger_success_audit','INSERT')>=0);
          assert.ok(run.calls.some(call=>call.kind==='rollback'));await assertUnchanged(id,before);
        }finally{await setup.query('ALTER TABLE '+table(name)+' DROP CHECK '+constraint);}
        assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');
        assertPayments(await inspect(id),original,login.principalId,run.context().dbNow,action);
      });
    }

    for(const sameKey of [false,true]){
      await t.test(action + ': two independent connections '+(sameKey?'retry one key':'compete at one revision')+' create exactly one set of payments', {timeout:10000}, async()=>{
        const firstActor=await provision([paymentPermission(action)]),secondActor=sameKey?firstActor:await provision([paymentPermission(action)]);
        const id='payments-race-'+action+'-'+sameKey,original=await pending(id),a=await pool.getConnection(),b=await pool.getConnection();
        let unlock,signalLocked,firstWork,secondWork,timer;
        const held=new Promise(resolve=>unlock=resolve),locked=new Promise(resolve=>signalLocked=resolve);
        try{
          const [[aId]]=await a.query('SELECT CONNECTION_ID() AS id'),[[bId]]=await b.query('SELECT CONNECTION_ID() AS id');
          assert.notEqual(aId.id,bId.id);await a.query('SET SESSION innodb_lock_wait_timeout=5');await b.query('SET SESSION innodb_lock_wait_timeout=5');
          const bind=connection=>{const inner=authStore.bindSessionRevalidation(connection);return{async revalidateSessionInTransaction(credential){
            const context=await inner.revalidateSessionInTransaction(credential);signalLocked();await held;return context;}};};
          const first=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(a,[],false)},bind});
          const second=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(b,[],false)}});
          firstWork=first.app.execute(paymentCommand(action,'first'),firstActor.credential);
          await Promise.race([locked,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('payment head lock timeout')),5000))]);clearTimeout(timer);
          let secondFinished=false;secondWork=second.app.execute(paymentCommand(action,sameKey?'first':'second'),secondActor.credential).finally(()=>secondFinished=true);
          await new Promise(resolve=>setTimeout(resolve,35));assert.equal(secondFinished,false);assert.ok(sqlAt(second,'ledger_heads','FOR UPDATE')>=0);
          assert.equal(sqlAt(second,'auth_accounts','FOR UPDATE'),-1);unlock();const results=await Promise.all([firstWork,secondWork]);
          if(sameKey)assert.deepEqual(results[0],results[1]);else assert.deepEqual(results.map(result=>result.status),['committed','revision-conflict']);
          const actual=await inspect(id);assertPayments(actual,original,firstActor.principalId,first.context().dbNow,action);
          assert.equal(actual.operations.length,sameKey?1:2);assert.equal(first.executions()+second.executions(),1);
          t.diagnostic(action+' race: independent CONNECTION_ID '+aId.id+' / '+bId.id+'; one committed payment batch, one revision only');
        }finally{
          clearTimeout(timer);unlock();await Promise.allSettled([firstWork,secondWork].filter(Boolean));
          try{await a.rollback();await b.rollback();}finally{a.release();b.release();}
        }
      });
    }
  }

  await t.test('pay: actual room-release TypeError rolls back already-created payments and closing without terminal operation',async()=>{
    const login=await provision(['payment.settle']),id='payments-release-fault';await pending(id);
    const before=await inspect(id),run=runFor(id,{transactCommand:(state,...args)=>transact({...state,rooms:{}},...args)});await assert.rejects(run.app.execute(paymentCommand('pay','release-fault'),login.credential),TypeError);
    await assertUnchanged(id,before);assert.equal(sqlAt(run,'ledger_heads','UPDATE'),-1);assert.ok(run.calls.some(call=>call.kind==='rollback'));
  });
  await t.test('payments: missing revalidation or copied context fails closed; remaining high-risk actions remain disabled',async()=>{
    const login=await provision(['payment.collect','payment.settle','rounding.approve','handover','room.open']),id='payments-closed';await pending(id);const before=await inspect(id);
    const missing=createTrustedLedgerApplication({store:createMySqlLedgerStore({pool,ledgerId:id,database})});
    await assert.rejects(missing.execute(paymentCommand('collect','missing'),login.credential),/revalidation port/);
    const fake=runFor(id,{bind:connection=>{const inner=authStore.bindSessionRevalidation(connection);return{
      revalidateSessionInTransaction:async credential=>({...await inner.revalidateSessionInTransaction(credential)})};}});
    await assert.rejects(fake.app.execute(paymentCommand('pay','fake'),login.credential),TypeError);
    const run=runFor(id);for(const action of ['handover', 'open'])
      await assert.rejects(run.app.execute(paymentCommand(action,action),login.credential),error=>denied(error)&&error.reason==='trusted-action-not-enabled');
    await assertUnchanged(id,before);assert.equal(run.executions(),0);
  });
}
