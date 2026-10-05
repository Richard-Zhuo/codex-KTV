import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact } from '../rules.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { seedTrustedSalesState, salesCommand } from '../test-support/trusted-sales-fixture.js';
import { seedRepaymentReview, repaymentReviewCommand, repayOrder } from '../test-support/trusted-repayment-review-fixture.js';
import { handoverCommand, drawerPay, seedHandover } from '../test-support/trusted-handover-fixture.js';

const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
const last = actual => actual.head.state.handovers.at(-1);
const sqlAt = (run, name, verb) => run.calls.findIndex(c => c.kind === 'sql' && c.sql.includes(name) &&
  (verb === 'FOR UPDATE' ? c.sql.includes(verb) : c.sql.startsWith(verb + ' ')));

// Reuses the strictly guarded eleven-table fixture; owns no DDL or cleanup outside its known tables.
export async function testTrustedHandover({ t, pool, setup, auth, table, provision, seed, inspect, application,
  assertUnchanged, wrapConnection, poolOptions, database, roster }) {
  const pending = (id, prepare = () => {}) => seed(id, state => { seedHandover(state); prepare(state); });
  const runFor = (id, options = {}) => application(id, { employeeBind: null, ...options });
  const authStore = createMySqlAuthStore({ pool, database });
  const start = async (id, login) => {
    await pending(id); const run = runFor(id);
    await run.app.execute(handoverCommand('baseline'), login.credential);
    await run.app.execute(drawerPay(), login.credential); return run;
  };

  await t.test('K04 MySQL handover: one connection bootstraps actual cash, ignores demo history/payload and commits session actor/time/result/audit', async () => {
    const login = await provision(['handover']), id = 'handover-bootstrap', original = await pending(id), run = runFor(id);
    const [[activity]] = await pool.execute('SELECT last_seen_at,idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [login.sessionId]);
    const cmd = handoverCommand('baseline', 0, 50000, { principalId: 'fake', actorId: 'administrator', person: 'fake',
      expectedCash: 999999, previousHandoverId: 'fake', role: 'administrator', permissions: ['*'], clock: '1900-01-01', cashBoundary: {} });
    const result = await run.app.execute(cmd, login.credential), actual = await inspect(id), h = last(actual);
    assert.equal(result.status, 'committed'); assert.equal(result.actorId, login.principalId); assert.equal(actual.head.revision, 1);
    assert.equal(h.bootstrap, true); assert.equal(h.previousHandoverId, null); assert.equal(h.actualCash, 50000);
    assert.equal(h.expectedCash, 50000); assert.equal(h.difference, 0); assert.equal(h.intervalCashIn, 0); assert.equal(h.intervalCashOut, 0);
    assert.match(h.handoverId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(h.submittedByPrincipalId, login.principalId); assert.equal(h.occurredAt, run.context().dbNow); assert.equal(h.person, null);
    assert.equal(h.cashBoundary.version, 'payment-set-v1'); assert.deepEqual(actual.head.state.handovers.slice(0,-1), original.handovers);
    assert.deepEqual(actual.head.state.orders, original.orders); assert.equal(actual.head.state.orders[0].room, null);
    assert.equal(actual.head.state.inventory.bw.count, 0); assert.equal(actual.head.state.inventory.qd.count, null);
    for (const field of ['user','clock','permissions','capabilities','administrator','inventory','catalog']) assert.deepEqual(actual.head.state[field], original[field]);
    assert.equal(actual.operations.length, 1); assert.deepEqual(actual.operations[0].terminal_result, result); assert.equal(actual.audit.length, 1);
    assert.equal(actual.audit[0].actor_principal_id, login.principalId);
    const locks = [run.calls.findIndex(c => c.kind === 'begin'), sqlAt(run,'ledger_heads','FOR UPDATE'), sqlAt(run,'auth_accounts','FOR UPDATE'),
      sqlAt(run,'auth_sessions','FOR UPDATE'), sqlAt(run,'auth_grants','FOR UPDATE'), sqlAt(run,'AS db_now','SELECT'),
      sqlAt(run,'ledger_operations','SELECT'), run.calls.findIndex(c => c.kind === 'transact'), sqlAt(run,'ledger_heads','UPDATE'),
      sqlAt(run,'ledger_operations','INSERT'), sqlAt(run,'ledger_success_audit','INSERT'), run.calls.findIndex(c => c.kind === 'commit')];
    assert.ok(locks.every((value,index) => value >= 0 && (!index || value > locks[index-1])));
    assert.equal(run.calls.filter(c => c.kind === 'db-now').length, 1); assert.equal(sqlAt(run,'employees','SELECT'), -1);
    const [[after]] = await pool.execute('SELECT last_seen_at,idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [login.sessionId]);
    assert.deepEqual(after, activity);
  });

  await t.test('K04 MySQL handover: cash-only interval and actual discrepancy become the next real baseline', async () => {
    const login = await provision(['handover','payment.settle']), id = 'handover-continuous', run = await start(id,login);
    await run.app.execute(handoverCommand('second',2,58000),login.credential);
    let actual = await inspect(id), h = last(actual); assert.equal(h.expectedCash,60000); assert.equal(h.difference,-2000);
    assert.equal(h.intervalCashIn,10000); assert.deepEqual(h.intervalByChannel,{'现金':10000});
    await run.app.execute(drawerPay('drawer-2','wechat',3,'微信'),login.credential);
    await run.app.execute(drawerPay('drawer-3','alipay',4,'支付宝'),login.credential);
    await run.app.execute(handoverCommand('third',5,58000),login.credential);
    actual = await inspect(id); h = last(actual); assert.equal(h.expectedCash,58000); assert.equal(h.intervalCashIn,0);
    assert.deepEqual(h.intervalByChannel,{'微信':10000,'支付宝':10000});
    const chain = actual.head.state.handovers.filter(h=>h.trustedHandoverVersion);
    assert.deepEqual(chain.map(h=>h.previousHandoverId),[null,...chain.slice(0,-1).map(h=>h.handoverId)]);
    assert.equal(new Set(chain.map(h=>h.handoverId)).size,3);
    await run.app.execute(handoverCommand('empty',6,58000),login.credential);
    assert.equal(last(await inspect(id)).expectedCash,58000); assert.equal(last(await inspect(id)).intervalCashIn,0);
  });

  await t.test('K04 MySQL handover: equal DB timestamps and crossing noon neither omit nor repeat cash IDs', async () => {
    const login = await provision(['handover','payment.settle']), id = 'handover-clock-boundary'; await pending(id);
    const connection = await pool.getConnection();
    try {
      const run = runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(connection,[],false)}});
      // Test-only DB session clock: all production facts still come from the current connection UTC_TIMESTAMP(6).
      const beforeNoon = Date.parse('2026-10-05T03:59:59Z') / 1000;
      await connection.query('SET timestamp = ?', [beforeNoon]);
      await run.app.execute(handoverCommand('baseline'),login.credential);
      const baseline = last(await inspect(id));
      await run.app.execute(drawerPay(),login.credential);
      const paid = (await inspect(id)).head.state.orders.find(o=>o.id==='drawer-1').payments[0];
      assert.equal(paid.occurredAt,baseline.occurredAt);
      await connection.query('SET timestamp = ?', [beforeNoon+1]);
      assert.equal((await run.app.execute(drawerPay('drawer-2','noon-payment',2,'现金'),login.credential)).status,'committed');
      assert.equal((await run.app.execute(handoverCommand('after-noon',3,70000),login.credential)).status,'committed');
      let actual = await inspect(id); assert.equal(last(actual).expectedCash,70000); assert.equal(last(actual).intervalCashIn,20000);
      assert.equal(last(actual).occurredAt,'2026-10-05T04:00:00.000000Z');
      assert.equal(actual.head.state.orders.find(o=>o.id==='drawer-2').payments[0].occurredAt,last(actual).occurredAt);
      await run.app.execute(handoverCommand('empty',4,70000),login.credential);
      actual = await inspect(id); assert.equal(last(actual).expectedCash,70000); assert.equal(last(actual).intervalCashIn,0);
      assert.equal(Object.hasOwn(last(actual),'businessDate'),false);
    } finally { await connection.query('SET timestamp = 0'); await connection.rollback(); connection.release(); }
  });

  await t.test('K04 MySQL handover: wine custody and cash-method expense/procurement have no proven drawer effect', async () => {
    const login = await provision(['handover','deposit.manage','expense.create','procurement.create']), id = 'handover-excluded'; await pending(id);
    const run = runFor(id); await run.app.execute(handoverCommand('baseline'),login.credential);
    await run.app.execute({operationKey:'deposit',expectedRevision:1,action:'deposit',payload:{name:'Synthetic customer',room:'V01',product:'qd',count:3}},login.credential);
    const deposit = (await inspect(id)).head.state.deposits.at(-1);
    await run.app.execute({operationKey:'withdraw',expectedRevision:2,action:'withdraw',payload:{id:deposit.id,identity:'Synthetic customer',count:1}},login.credential);
    const payload = {date:'2026-10-05',amount:5000,method:'现金',nature:'一次性支出',description:'No drawer funding evidence'};
    await run.app.execute({operationKey:'expense',expectedRevision:3,action:'expense',payload},login.credential);
    await run.app.execute({operationKey:'procurement',expectedRevision:4,action:'procurement',payload:{...payload,item:'Synthetic supplies',quantity:1,unit:'box'}},login.credential);
    assert.equal((await run.app.execute(handoverCommand('next',5),login.credential)).status,'committed');
    const actual = await inspect(id); assert.equal(last(actual).expectedCash,50000); assert.equal(last(actual).intervalCashOut,0);
    assert.equal(actual.head.state.expenses.length,2); assert.equal(actual.head.state.procurements.length,1);
  });

  await t.test('K04 MySQL handover: trusted retail and repayment cash count once, excluding credit mirror',async()=>{
    const login = await provision(['handover','retail.sale','staff.record','credit.repay.approve']), id = 'handover-real-sources';
    const employee = await roster.createEmployee({displayName:'Synthetic handover sales employee'},{actorPrincipalId:login.principalId});
    await pending(id,state=>{seedRepaymentReview(state);seedTrustedSalesState(state);});
    const run = application(id);
    await run.app.execute(handoverCommand('baseline'),login.credential);
    const retail = salesCommand('retailSale',employee.employeeId,'retail',1);
    const repayment = repaymentReviewCommand('approveRepayment','repayment',2);
    const firstRetail = await run.app.execute(retail,login.credential), firstRepayment = await run.app.execute(repayment,login.credential);
    assert.equal(firstRetail.status,'committed');assert.equal(firstRepayment.status,'committed');
    await run.app.execute(handoverCommand('next',3,68300),login.credential);
    const actual = await inspect(id); assert.equal(last(actual).expectedCash,68300);assert.equal(last(actual).intervalCashIn,18300);
    assert.deepEqual(last(actual).intervalByChannel,{'现金':18300,'微信':3000});assert.equal(last(actual).cashBoundary.payments.length,3);
    const paid = repayOrder(actual.head.state).payments.at(-1);
    assert.deepEqual(repayOrder(actual.head.state).credit.repayments.at(-1),paid);
    assert.equal(paid.method,'现金');assert.equal(paid.recordedByPrincipalId,login.principalId);
    assert.deepEqual(await run.app.execute(retail,login.credential),firstRetail);
    assert.deepEqual(await run.app.execute(repayment,login.credential),firstRepayment);
    await assertUnchanged(id,actual);
  });

  await t.test('K04 MySQL handover: denied key remains unused and succeeds after exact grant, forged permission cannot authorize', async () => {
    const login = await provision(['backend.view']), id = 'handover-denied'; await pending(id);
    const before = await inspect(id), run = runFor(id), cmd = handoverCommand('grant-later',0,0,{permissions:['handover'],role:'administrator'});
    await assert.rejects(run.app.execute(cmd,login.credential),denied); await assertUnchanged(id,before); assert.equal(run.executions(),0);
    await auth.grantPermission({principalId:login.principalId,permissionId:'handover'});
    assert.equal((await run.app.execute(cmd,login.credential)).status,'committed'); assert.equal(last(await inspect(id)).difference,0);
  });

  await t.test('K04 MySQL handover: reconnect and revoked permission replay the terminal without advancing boundary; new keys deny', async () => {
    const login = await provision(['handover','payment.settle']), other = await provision([]), id = 'handover-replay';
    const run = await start(id,login), cmd = handoverCommand('second',2,60000), first = await run.app.execute(cmd,login.credential);
    await auth.revokePermission({principalId:login.principalId,permissionId:'handover'});
    const before = await inspect(id), reconnect = mysql.createPool(poolOptions);
    try {
      const again = runFor(id,{connectionPool:reconnect,transactCommand:()=>assert.fail('handover replay executed domain')});
      assert.deepEqual(await again.app.execute(cmd,login.credential),first);
      assert.equal((await again.app.execute(cmd,other.credential)).reason,'actor-mismatch');
      for (const changed of [{...cmd,expectedRevision:3},{...cmd,payload:{actualCash:59999}}]) assert.equal((await again.app.execute(changed,login.credential)).reason,'request-mismatch');
      await assert.rejects(again.app.execute(handoverCommand('new',3,60000),login.credential),denied); await assertUnchanged(id,before);
      assert.equal(again.executions(),0);
    } finally { await reconnect.end(); }
    await auth.grantPermission({principalId:login.principalId,permissionId:'handover'});
    await run.app.execute(handoverCommand('next',3,60000),login.credential);
    assert.equal(last(await inspect(id)).intervalCashIn,0);
  });

  for (const status of ['disabled','revoked','idle','absolute','version']) await t.test('K04 MySQL handover: '+status+' blocks old terminal access',async()=>{
    const login = await provision(['handover']), id = 'handover-auth-'+status; await pending(id);
    const run = runFor(id), cmd = handoverCommand('private'); await run.app.execute(cmd,login.credential); const before = await inspect(id);
    if(status==='disabled')await auth.disableAccount({principalId:login.principalId});
    else if(status==='revoked')await auth.logout(login.token);
    else if(status==='version')await auth.rotateCredential({principalId:login.principalId,password:'Synthetic rotated handover credential'});
    else if(status==='idle')await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at WHERE session_id=?',[login.sessionId]);
    else await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at,absolute_expires_at=created_at+INTERVAL 1 MICROSECOND WHERE session_id=?',[login.sessionId]);
    run.calls.length=0; await assert.rejects(run.app.execute(cmd,login.credential),e=>e.code==='AUTHENTICATION_REQUIRED');
    assert.equal(sqlAt(run,'ledger_operations','SELECT'),-1); await assertUnchanged(id,before);
  });

  for (const bootstrap of [true,false]) for(const sameKey of [false,true]) await t.test('K04 MySQL handover: two independent connections '+(bootstrap?'bootstrap':'advance')+' '+(sameKey?'same key':'old revision')+' produce one next boundary',async()=>{
    const login = await provision(['handover','payment.settle']), id = 'handover-race-'+bootstrap+'-'+sameKey;
    if(bootstrap)await pending(id);else await start(id,login);
    const before = await inspect(id), revision = before.head.revision, a = await pool.getConnection(), b = await pool.getConnection();
    let unlock, signal, firstWork, secondWork, timer;
    const held = new Promise(resolve=>unlock=resolve), locked = new Promise(resolve=>signal=resolve);
    try {
      const [[ai]]=await a.query('SELECT CONNECTION_ID() AS id'),[[bi]]=await b.query('SELECT CONNECTION_ID() AS id'); assert.notEqual(ai.id,bi.id);
      await a.query('SET SESSION innodb_lock_wait_timeout=5'); await b.query('SET SESSION innodb_lock_wait_timeout=5');
      const bind = connection => { const inner = authStore.bindSessionRevalidation(connection); return {async revalidateSessionInTransaction(c){
        const context = await inner.revalidateSessionInTransaction(c); signal(); await held; return context;
      }}; };
      const first = runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(a,[],false)},bind});
      const second = runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(b,[],false)}});
      const cash = bootstrap?50000:60000;
      firstWork = first.app.execute(handoverCommand('a',revision,cash),login.credential);
      await Promise.race([locked,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('handover head lock timeout')),5000))]); clearTimeout(timer);
      let finished = false; secondWork = second.app.execute(handoverCommand(sameKey?'a':'b',revision,cash),login.credential).finally(()=>finished=true);
      await new Promise(resolve=>setTimeout(resolve,35)); assert.equal(finished,false); assert.ok(sqlAt(second,'ledger_heads','FOR UPDATE')>=0);
      assert.equal(sqlAt(second,'auth_accounts','FOR UPDATE'),-1); unlock(); const results = await Promise.all([firstWork,secondWork]);
      if(sameKey)assert.deepEqual(results[0],results[1]);else assert.deepEqual(results.map(r=>r.status),['committed','revision-conflict']);
      const actual = await inspect(id); assert.equal(actual.head.revision,revision+1); assert.equal(first.executions()+second.executions(),1);
      assert.equal(actual.head.state.handovers.length,before.head.state.handovers.length+1); assert.equal(last(actual).expectedCash,cash);
      assert.equal(last(actual).previousHandoverId,bootstrap?null:last(before).handoverId);
      assert.equal(actual.audit.length,before.audit.length+1); assert.equal(actual.operations.length,before.operations.length+(sameKey?1:2));
      t.diagnostic('K04 independently verified CONNECTION_ID '+ai.id+' / '+bi.id+'; one committed handover boundary');
    } finally {
      clearTimeout(timer); unlock(); await Promise.allSettled([firstWork,secondWork].filter(Boolean));
      try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); }
    }
  });

  for (const target of ['ledger_heads','ledger_operations','ledger_success_audit','unknown']) await t.test('K04 MySQL handover: '+target+' failure rolls back state/boundary/revision/result/audit; original key retries',async()=>{
    const login = await provision(['handover','payment.settle']), id = 'handover-fault-'+target; await start(id,login);
    const before = await inspect(id); let broken = true;
    const run = runFor(id,{transactCommand:(...args)=>{const next=transact(...args);if(target==='unknown'&&broken)throw Error('synthetic handover fault');return next;}});
    const cmd = handoverCommand('retry',2,60000), constraint = 'chk_handover_fault';
    if(target!=='unknown'){
      const condition = target==='ledger_heads'?'revision <= 2':"operation_key <> 'retry'";
      await setup.query('ALTER TABLE '+table(target)+' ADD CONSTRAINT '+constraint+" CHECK (ledger_id <> '"+id+"' OR "+condition+')');
    }
    try {
      await assert.rejects(run.app.execute(cmd,login.credential),e=>target==='unknown'?e.message==='synthetic handover fault':e.code==='ER_CHECK_CONSTRAINT_VIOLATED');
      await assertUnchanged(id,before); assert.ok(run.calls.some(c=>c.kind==='rollback')); assert.ok(!run.calls.some(c=>c.kind==='commit'));
      if(target==='ledger_success_audit')assert.ok(sqlAt(run,'ledger_operations','INSERT')>=0);
    } finally { if(target!=='unknown')await setup.query('ALTER TABLE '+table(target)+' DROP CHECK '+constraint); }
    broken=false;assert.equal((await run.app.execute(cmd,login.credential)).status,'committed'); const after = await inspect(id);
    assert.equal(after.head.revision,3);assert.equal(last(after).expectedCash,60000);assert.equal(last(after).intervalCashIn,10000);
    assert.equal(last(after).previousHandoverId,last(before).handoverId);assert.equal(after.operations.length,3);assert.equal(after.audit.length,3);
  });

  await t.test('K04 MySQL handover: new ambiguous receipt after bootstrap rejects without guessing or moving boundary',async()=>{
    const login = await provision(['handover','payment.settle']), id = 'handover-ambiguous'; await pending(id);
    const run = runFor(id,{transactCommand:(...args)=>{const next=transact(...args);if(args[1]==='pay')delete next.orders.find(o=>o.id==='drawer-1').payments[0].paymentId;return next;}});
    await run.app.execute(handoverCommand('baseline'),login.credential);await run.app.execute(drawerPay(),login.credential);
    const before = await inspect(id), cmd = handoverCommand('unsafe',2,60000), terminal = await run.app.execute(cmd,login.credential), after = await inspect(id);
    assert.equal(terminal.status,'business-rejected');assert.equal(after.head.revision,before.head.revision);assert.deepEqual(after.head.state,before.head.state);
    assert.deepEqual(after.audit,before.audit);assert.equal(after.operations.length,before.operations.length+1);
    assert.deepEqual(await run.app.execute(cmd,login.credential),terminal);await assertUnchanged(id,after);
  });
}
