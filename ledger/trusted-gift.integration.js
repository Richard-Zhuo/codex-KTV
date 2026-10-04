import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact } from '../rules.js';
import { total } from '../sales.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { seedTrustedGift, giftOrder, giftCommand } from '../test-support/trusted-gift-fixture.js';

const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
const sqlAt = (run, name, clause) => run.calls.findIndex(call => call.kind === 'sql' && call.sql.includes(name) &&
  (clause.startsWith('FOR ') ? call.sql.endsWith(clause) : call.sql.startsWith(clause + ' ')));

// Reuses the existing guarded fixture. This helper owns no tables or cleanup.
export async function testTrustedGift({ t, pool, setup, auth, table, provision, seed, inspect,
  application, assertUnchanged, wrapConnection, poolOptions, database }) {
  const runFor = (id, options = {}) => application(id, { employeeBind: null, ...options });
  const seedFor = (id, prepare = () => {}) => seed(id, state => { seedTrustedGift(state); prepare(state); });

  await t.test('gift: one caller connection commits earned gift and excess request with session actor, current grant and frozen DB time', async () => {
    const login = await provision(['order.gift']), id = 'gift-first', original = await seedFor(id);
    const [[activity]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [login.sessionId]);
    const connection = await pool.getConnection(); let borrows = 0;
    try {
      const run = runFor(id, { connectionPool: { getConnection: async () => { borrows++; return wrapConnection(connection, [], false); } } });
      const result = await run.app.execute(giftCommand('first', 0, { actorId: 'administrator', principalId: 'fake', user: 'administrator',
        permissions: ['*'], role: 'administrator', clock: '1900-01-01', person: 'fake', requestedBy: 'fake', requestedById: 'administrator',
        submittedByPrincipalId: 'fake', actualActorPrincipalId: 'fake', employee: 'fake-employee' }), login.credential);
      const actual = await inspect(id), order = giftOrder(actual.head.state), direct = order.bonusGifts.at(-1), request = order.giftRequests.at(-1), entry = actual.head.state.ledger.at(-1);
      assert.equal(result.status, 'committed'); assert.equal(result.actorId, login.principalId); assert.equal(actual.head.revision, 1);
      assert.equal(actual.head.state.inventory.bw.count, 44); assert.equal(actual.head.state.inventory.qd.count, null); assert.equal(actual.head.state.inventory.lm.count, 0);
      assert.equal(direct.halves, 1); assert.equal(direct.bottles, 6); assert.equal(direct.referenceValueCents, 5900);
      assert.equal(direct.actualActorPrincipalId, login.principalId); assert.equal(direct.person, login.principalId); assert.equal(direct.requestedBy, null); assert.equal(direct.time, run.context().dbNow);
      assert.equal(entry.delta, -6); assert.equal(entry.baseQuantityDelta, -6); assert.equal(entry.counted, true);
      assert.equal(entry.actualActorPrincipalId, login.principalId); assert.equal(entry.person, login.principalId); assert.equal(entry.time, run.context().dbNow);
      assert.equal(request.status, '待确认'); assert.equal(request.halves, 1); assert.equal(request.totalBaseQuantity, 6); assert.equal(request.referenceValueCents, 5900);
      assert.equal(request.submittedByPrincipalId, login.principalId); assert.equal(request.requestedBy, null); assert.equal(request.requestedById, '');
      assert.equal(request.submittedAt, run.context().dbNow); assert.equal(request.time, run.context().dbNow); assert.equal(request.allowanceAtRequest, 1);
      assert.equal(total(order), 52900); assert.deepEqual(actual.head.state.orders[0], original.orders[0]);
      for (const field of ['sales','payments','drinks','resolvedComponents','person','recordedBy','creditedEmployeeId','creditedEmployeeNameSnapshot','otherCharges','extras','credit'])
        assert.deepEqual(order[field], giftOrder(original)[field]);
      assert.deepEqual(order.bonusGifts.slice(0,-1), giftOrder(original).bonusGifts); assert.deepEqual(order.giftRequests.slice(0,-1), giftOrder(original).giftRequests);
      assert.deepEqual(actual.head.state.ledger.slice(0,-1), original.ledger);
      assert.equal(actual.operations.length, 1); assert.equal(actual.audit.length, 1); assert.equal(actual.operations[0].actor_principal_id, login.principalId);
      assert.deepEqual(actual.operations[0].terminal_result, result); assert.equal(actual.audit[0].actor_principal_id, login.principalId); assert.equal(actual.audit[0].action, 'gift');
      const orderOfLocks = [run.calls.findIndex(c => c.kind === 'begin'), sqlAt(run,'ledger_heads','FOR UPDATE'), sqlAt(run,'auth_accounts','FOR UPDATE'),
        sqlAt(run,'auth_sessions','FOR UPDATE'), sqlAt(run,'auth_grants','FOR UPDATE'), sqlAt(run,'AS db_now','SELECT'), sqlAt(run,'ledger_operations','SELECT'),
        run.calls.findIndex(c => c.kind === 'transact'), sqlAt(run,'ledger_heads','UPDATE'), sqlAt(run,'ledger_operations','INSERT'),
        sqlAt(run,'ledger_success_audit','INSERT'), run.calls.findIndex(c => c.kind === 'commit')];
      assert.ok(orderOfLocks.every(index => index >= 0)); assert.deepEqual(orderOfLocks, [...orderOfLocks].sort((a,b) => a-b)); assert.equal(borrows, 1);
      assert.equal(run.calls.filter(c => c.kind === 'begin').length, 1); assert.equal(run.calls.filter(c => c.kind === 'commit').length, 1);
      assert.equal(run.calls.filter(c => c.kind === 'db-now').length, 1); assert.equal(sqlAt(run,'employees','FOR SHARE'), -1);
      assert.equal(run.context().policyAttributesConfigured, false); assert.equal(Object.hasOwn(request,'creditedEmployeeId'), false);
      const [[afterActivity]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [login.sessionId]);
      assert.deepEqual(afterActivity, activity);
    } finally { try { await connection.rollback(); } finally { connection.release(); } }
  });

  await t.test('gift: direct/pending/mixed/exhausted/already-pending allowance changes only original stock and approval-stage effects', async () => {
    const login = await provision(['order.gift']); let index = 0;
    for (const c of [{ purchased: 24, halves: 1, direct: 1, pending: 0 }, { purchased: 12, halves: 1, direct: 0, pending: 1 },
      { purchased: 48, halves: 3, direct: 2, pending: 1 }, { purchased: 24, halves: 2, direct: 1, pending: 1 },
      { purchased: 24, halves: 1, granted: true, direct: 0, pending: 1 }, { purchased: 24, halves: 1, waiting: true, direct: 0, pending: 1 }]) {
      const id = 'gift-allowance-' + (++index), original = await seedFor(id, s => {
        const o = giftOrder(s); o.sales[0].totalBaseQuantity = c.purchased;
        if (c.granted) o.bonusGifts.push({ id: 730, product: 'bw', halves: 1, source: 'Historical Grant' });
        if (c.waiting) o.giftRequests.push({ id: 731, product: 'bw', halves: 1, status: '待确认', requestedBy: 'Historical Applicant' });
      });
      assert.equal((await runFor(id).app.execute(giftCommand('allowance',0,{ halves: c.halves }),login.credential)).status, 'committed');
      const actual = await inspect(id), order = giftOrder(actual.head.state);
      assert.equal(actual.head.state.inventory.bw.count, c.direct === 2 ? 38 : c.direct === 1 ? 44 : 50);
      assert.equal(actual.head.state.ledger.length - original.ledger.length, c.direct ? 1 : 0);
      assert.equal(order.bonusGifts.length - giftOrder(original).bonusGifts.length, c.direct ? 1 : 0);
      assert.equal(order.giftRequests.length - giftOrder(original).giftRequests.length, c.pending ? 1 : 0);
      if (c.pending) { assert.equal(order.giftRequests.at(-1).halves, c.pending); assert.equal(order.giftRequests.at(-1).status, '待确认'); }
      assert.equal(total(order), 52900); assert.deepEqual(order.payments, giftOrder(original).payments);
    }
  });

  await t.test('gift: JSON null/zero, uncounted/managed/unmanaged and pending-only inventory semantics remain distinct', async () => {
    const login = await provision(['order.gift']); let index = 0;
    for (const c of [{ count: null, pending: false, managed: true }, { count: 6, pending: false, managed: true },
      { count: 0, pending: true, managed: true }, { count: 0, pending: false, managed: false }]) {
      const id = 'gift-stock-' + (++index), original = await seedFor(id, s => { s.inventory.bw.count = c.count;
        s.catalog.products.find(p => p.id === 'bw').inventoryManaged = c.managed; if (c.pending) giftOrder(s).sales[0].totalBaseQuantity = 12; });
      assert.equal((await runFor(id).app.execute(giftCommand(), login.credential)).status, 'committed'); const actual = await inspect(id);
      assert.equal(actual.head.state.inventory.bw.count, c.count === null ? null : 0); assert.equal(actual.head.state.inventory.qd.count, null); assert.equal(actual.head.state.inventory.lm.count, 0);
      if (!c.pending && c.managed) { assert.equal(actual.head.state.ledger.at(-1).delta, -6); assert.equal(actual.head.state.ledger.at(-1).counted, c.count !== null); }
      else assert.deepEqual(actual.head.state.ledger, original.ledger);
      assert.deepEqual(actual.head.state.orders[0], original.orders[0]);
    }
  });

  await t.test('gift: authorization-denied does not consume key; current grant permits the same request later', async () => {
    const login = await provision(['backend.view','gift.approve','review.self','staff.record','order.sale']), id = 'gift-denied';
    await seedFor(id); const before = await inspect(id), run = runFor(id), cmd = giftCommand('denied',0,{ permissions: ['order.gift'], role: 'administrator', actorId: 'administrator' });
    await assert.rejects(run.app.execute(cmd, login.credential), denied); await assertUnchanged(id,before); assert.equal(run.executions(),0);
    await auth.grantPermission({ principalId: login.principalId, permissionId: 'order.gift' });
    assert.equal((await run.app.execute(cmd,login.credential)).status,'committed'); const after = await inspect(id);
    assert.equal(after.head.revision,1); assert.equal(after.operations.length,1); assert.equal(after.audit.length,1);
  });

  await t.test('gift: explicit creditedEmployeeId retains non-delegated Stage 2A rejection without changing actor or attribution', async () => {
    const login = await provision(['order.gift','staff.record']), id = 'gift-attribution'; await seedFor(id); const before = await inspect(id);
    await assert.rejects(runFor(id).app.execute(giftCommand('employee',0,{ creditedEmployeeId: '10000000-0000-4000-8000-000000000001' }),login.credential),
      e => denied(e) && e.reason === 'invalid-attribution'); await assertUnchanged(id,before);
  });

  await t.test('gift: revoke then reconnect returns original terminal, never grants/deducts/submits twice; new key denied', async () => {
    const login = await provision(['order.gift']), id = 'gift-replay'; await seedFor(id); const cmd = giftCommand(), first = await runFor(id).app.execute(cmd,login.credential);
    await auth.revokePermission({ principalId: login.principalId, permissionId: 'order.gift' }); const before = await inspect(id), reconnect = mysql.createPool(poolOptions);
    try {
      const again = runFor(id,{ connectionPool: reconnect, bind: createMySqlAuthStore({ pool: reconnect,database }).bindSessionRevalidation,
        transactCommand: () => assert.fail('replay must not execute gift again') });
      assert.deepEqual(await again.app.execute(cmd,login.credential),first); assert.equal(again.executions(),0);
      await assert.rejects(again.app.execute(giftCommand('new',1),login.credential),denied); await assertUnchanged(id,before);
    } finally { await reconnect.end(); }
  });

  await t.test('gift: disabled/revoked/idle/absolute/version invalidation rejects old terminal before operation lookup', async () => {
    for (const invalid of ['disabled','revoked','idle','absolute','version']) {
      const login = await provision(['order.gift']), id = 'gift-auth-' + invalid; await seedFor(id); const run = runFor(id),cmd = giftCommand();
      await run.app.execute(cmd,login.credential); const before = await inspect(id);
      if (invalid === 'disabled') await auth.disableAccount({ principalId: login.principalId });
      else if (invalid === 'revoked') await auth.logout(login.token);
      else if (invalid === 'version') await auth.rotateCredential({ principalId: login.principalId,password: 'synthetic-gift-rotation' });
      else if (invalid === 'idle') await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at WHERE session_id=?',[login.sessionId]);
      else await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at,absolute_expires_at=created_at+INTERVAL 1 MICROSECOND WHERE session_id=?',[login.sessionId]);
      run.calls.length=0; await assert.rejects(run.app.execute(cmd,login.credential),e=>e.code==='AUTHENTICATION_REQUIRED');
      assert.equal(sqlAt(run,'ledger_operations','SELECT'),-1); assert.equal(run.executions(),1); await assertUnchanged(id,before);
    }
  });

  await t.test('gift: actor/action/payload/revision conflicts precede current action grant after revoke', async () => {
    const login = await provision(['order.gift']),other = await provision([]),id='gift-conflicts'; await seedFor(id); const run=runFor(id),cmd=giftCommand();
    await run.app.execute(cmd,login.credential); const before=await inspect(id); await auth.revokePermission({ principalId:login.principalId,permissionId:'order.gift' });
    const actor=await run.app.execute(cmd,other.credential); assert.equal(actor.status,'idempotency-conflict'); assert.equal(actor.reason,'actor-mismatch');
    for(const changed of [{...cmd,expectedRevision:1},{...cmd,action:'approveGift'},{...cmd,payload:{...cmd.payload,halves:1}}]){
      const result=await run.app.execute(changed,login.credential); assert.equal(result.status,'idempotency-conflict'); assert.equal(result.reason,'request-mismatch');
    }
    assert.equal(run.executions(),1); await assertUnchanged(id,before);
  });

  await t.test('gift: original business failures and stale revision are terminal without partial stock, grant or request', async () => {
    const login=await provision(['order.gift']); let index=0;
    const cases=[[{order:'missing'},()=>{},/账单已变化/],[{},s=>giftOrder(s).status='已结账',/账单已变化/],
      ...[0,-1,1.5,'1',Number.MAX_SAFE_INTEGER+1].map(halves=>[{halves},()=>{},/数量/]),
      [{product:'unknown'},()=>{},/商品/],[{product:'drink'},()=>{},/赠酒水规则/],[{product:'water'},()=>{},/赠酒水规则/],
      [{},s=>giftOrder(s).sales=[],/先增购/],[{},s=>s.inventory.bw.count=5,/库存不足/],[{},s=>delete s.inventory.bw,/库存账/],
      [{},s=>{const p=s.catalog.products.find(p=>p.id==='bw');p.saleOptions=p.saleOptions.filter(o=>o.id!=='half');},/规格/]];
    for(const [changes,prepare,message]of cases){
      const id='gift-business-'+(++index),original=await seedFor(id,prepare),run=runFor(id),cmd=giftCommand('terminal',0,changes),result=await run.app.execute(cmd,login.credential);
      assert.equal(result.status,'business-rejected');assert.match(result.reason,message);const after=await inspect(id);assert.deepEqual(after.head.state,original);
      assert.equal(after.head.revision,0);assert.equal(after.operations.length,1);assert.equal(after.audit.length,0);
      await auth.revokePermission({principalId:login.principalId,permissionId:'order.gift'});assert.deepEqual(await run.app.execute(cmd,login.credential),result);await assertUnchanged(id,after);
      await auth.grantPermission({principalId:login.principalId,permissionId:'order.gift'});
    }
    const id='gift-stale';await seedFor(id);const run=runFor(id),cmd=giftCommand('stale',9),first=await run.app.execute(cmd,login.credential);
    assert.equal(first.status,'revision-conflict');assert.equal(run.executions(),0);await run.app.execute(giftCommand('other'),login.credential);const after=await inspect(id);
    await auth.revokePermission({principalId:login.principalId,permissionId:'order.gift'});assert.deepEqual(await run.app.execute(cmd,login.credential),first);await assertUnchanged(id,after);
  });

  await t.test('gift: current catalog changes create new reference snapshots without rewriting historical unknown values or earlier gifts', async () => {
    const login=await provision(['order.gift','catalog.manage']),id='gift-history';await seedFor(id);const run=runFor(id);await run.app.execute(giftCommand(),login.credential);
    const before=await inspect(id),p=before.head.state.catalog.products.find(p=>p.id==='bw');
    await run.app.execute({operationKey:'catalog',expectedRevision:1,action:'updateCatalogProduct',payload:{id:'bw',name:'Current Beer',
      saleOptions:p.saleOptions.map(o=>o.id==='half'?{...o,name:'Current Half',priceCents:6900}:o)}},login.credential);
    await run.app.execute(giftCommand('next',2,{halves:1}),login.credential);const actual=await inspect(id),o=giftOrder(actual.head.state);
    assert.deepEqual(o.bonusGifts,giftOrder(before.head.state).bonusGifts);assert.deepEqual(o.giftRequests.slice(0,-1),giftOrder(before.head.state).giftRequests);
    assert.deepEqual(o.sales,giftOrder(before.head.state).sales);assert.deepEqual(actual.head.state.orders[0],before.head.state.orders[0]);
    assert.equal(o.giftRequests.at(-1).referenceValueCents,6900);assert.equal(o.giftRequests.at(-1).productNameSnapshot,'Current Beer');
    assert.equal(o.giftRequests.at(-1).saleOptionNameSnapshot,'Current Half');assert.equal(o.bonusGifts.at(-1).referenceValueCents,5900);assert.equal(total(o),52900);
  });

  await t.test('gift: other approvals remain disabled despite gift grants and a new trusted applicant', async () => {
    const login=await provision(['order.gift','gift.approve','review.self']),id='gift-review-blocked';await seedFor(id);const run=runFor(id);await run.app.execute(giftCommand(),login.credential);
    const before=await inspect(id);for(const action of ['approveExpense','rejectExpense','approveIncidentResolution','rejectIncidentResolution','approveCredit','rejectCredit','approveRepay','rejectRepay','approveRounding','rejectRounding']){
      await assert.rejects(run.app.execute({operationKey:action,expectedRevision:1,action,payload:{order:'synthetic-gift-room',request:giftOrder(before.head.state).giftRequests.at(-1).id}},login.credential),
        e=>denied(e)&&e.reason===(['approveExpense','rejectExpense'].includes(action)?'missing-permission':'trusted-action-not-enabled'));await assertUnchanged(id,before);
    }
  });

  await t.test('gift: unknown fault after domain mutations and mid-SQL audit failure fully roll back; original key remains retryable', async () => {
    const login=await provision(['order.gift']);
    for(const type of ['unknown','sql']){
      const id='gift-rollback-'+type;await seedFor(id);const before=await inspect(id);let broken=true;
      const run=runFor(id,{transactCommand:(...args)=>{const state=transact(...args);if(type==='unknown'&&broken)throw Error('synthetic gift fault');return state;}}),cmd=giftCommand();
      if(type==='sql')await setup.query('ALTER TABLE '+table('ledger_success_audit')+" ADD CONSTRAINT chk_gift_fault CHECK (ledger_id <> '"+id+"')");
      try{
        await assert.rejects(run.app.execute(cmd,login.credential),e=>type==='unknown'?e.message==='synthetic gift fault':e.code==='ER_CHECK_CONSTRAINT_VIOLATED');
        assert.ok(run.calls.some(c=>c.kind==='rollback'));if(type==='sql'){assert.ok(sqlAt(run,'ledger_heads','UPDATE')>=0);assert.ok(sqlAt(run,'ledger_operations','INSERT')>=0);}
        await assertUnchanged(id,before);
      }finally{if(type==='sql')await setup.query('ALTER TABLE '+table('ledger_success_audit')+' DROP CHECK chk_gift_fault');}
      broken=false;assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');const after=await inspect(id);
      assert.equal(after.head.revision,1);assert.equal(after.head.state.inventory.bw.count,44);assert.equal(after.operations.length,1);assert.equal(after.audit.length,1);
      assert.equal(giftOrder(after.head.state).giftRequests.length,2);assert.equal(giftOrder(after.head.state).bonusGifts.length,2);
    }
  });

  for(const sameKey of [false,true])await t.test('gift: two independent connections '+(sameKey?'replay one key without duplication':'compete one old revision with at most one success'),async()=>{
    const login=await provision(['order.gift']),id='gift-race-'+sameKey;await seedFor(id);const a=await pool.getConnection(),b=await pool.getConnection();
    try{
      const [[aId]]=await a.query('SELECT CONNECTION_ID() AS id'),[[bId]]=await b.query('SELECT CONNECTION_ID() AS id');assert.notEqual(aId.id,bId.id);
      await a.query('SET SESSION innodb_lock_wait_timeout=5');await b.query('SET SESSION innodb_lock_wait_timeout=5');
      const first=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(a,[],false)}}),second=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(b,[],false)}});
      const results=await Promise.all([first.app.execute(giftCommand('first'),login.credential),second.app.execute(giftCommand(sameKey?'first':'second'),login.credential)]);
      if(sameKey)assert.deepEqual(results[0],results[1]);else assert.deepEqual(results.map(r=>r.status).sort(),['committed','revision-conflict']);
      assert.equal(first.executions()+second.executions(),1);const actual=await inspect(id);assert.equal(actual.head.revision,1);assert.equal(actual.head.state.inventory.bw.count,44);
      assert.equal(actual.operations.length,sameKey?1:2);assert.equal(actual.audit.length,1);assert.equal(giftOrder(actual.head.state).giftRequests.length,2);
      assert.equal(giftOrder(actual.head.state).bonusGifts.length,2);assert.equal(actual.head.state.ledger.length,2);
      t.diagnostic('gift '+(sameKey?'same-key':'revision')+' race verified two independent CONNECTION_ID values');
    }finally{try{await a.rollback();await b.rollback();}finally{a.release();b.release();}}
  });
}
