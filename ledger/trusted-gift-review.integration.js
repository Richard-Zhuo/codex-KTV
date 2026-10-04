import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact } from '../rules.js';
import { total } from '../sales.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { seedTrustedGift, giftOrder, giftCommand } from '../test-support/trusted-gift-fixture.js';
import { GIFT_REVIEW_ACTIONS, seedGiftReview, giftReview, giftReviewCommand } from '../test-support/trusted-gift-review-fixture.js';

const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
const sqlAt = (run, name, clause) => run.calls.findIndex(call => call.kind === 'sql' && call.sql.includes(name) &&
  (clause.startsWith('FOR ') ? call.sql.endsWith(clause) : call.sql.startsWith(clause + ' ')));
const forged = { requestedBy: 'fake', requestedById: 'administrator', submittedBy: 'fake', submittedByPrincipalId: 'fake',
  applicant: 'fake', selfReview: false, approver: 'fake', actorId: 'administrator', principalId: 'fake', permissions: ['gift.approve','review.self'],
  role: 'administrator', clock: '1900-01-01', decidedByPrincipalId: 'fake', employee: 'fake', product: 'qd', productId: 'qd', halves: 99 };

// No DDL/cleanup ownership: extends only the existing guarded ten-table fixture.
export async function testTrustedGiftReviews({ t, pool, setup, auth, table, provision, seed, inspect, application,
  assertUnchanged, wrapConnection, poolOptions, database }) {
  const runFor = (id, options = {}) => application(id, { employeeBind: null, ...options });
  const seedFor = (id, applicant, prepare = () => {}) => seed(id, state => { seedGiftReview(state, applicant); prepare(state); });

  for (const action of GIFT_REVIEW_ACTIONS) {
    await t.test(action + ': real trusted gift submission and non-applicant decision commit original stock/facts and session decider on one connection', async () => {
      const applicant = await provision(['order.gift']), reviewer = await provision(['gift.approve']), id = 'gift-review-first-' + action;
      await seed(id, state => { seedTrustedGift(state); giftOrder(state).sales[0].totalBaseQuantity = 12; });
      const submit = runFor(id); assert.equal((await submit.app.execute(giftCommand('submit'), applicant.credential)).status, 'committed');
      const before = await inspect(id), pending = giftOrder(before.head.state).giftRequests.at(-1);
      assert.equal(pending.submittedByPrincipalId, applicant.principalId); assert.equal(pending.status, '\u5f85\u786e\u8ba4');
      assert.equal(before.head.state.inventory.bw.count, 50); assert.equal(pending.halves, 2);
      const [[activity]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [reviewer.sessionId]);
      const connection = await pool.getConnection(); let borrows = 0;
      try {
        const run = runFor(id, { connectionPool: { getConnection: async () => { borrows++; return wrapConnection(connection, [], false); } } });
        const result = await run.app.execute(giftReviewCommand(action, 'decision', 1, { ...forged, request: pending.id }), reviewer.credential);
        const actual = await inspect(id), request = giftReview(actual.head.state), order = giftOrder(actual.head.state);
        assert.equal(result.status, 'committed'); assert.equal(result.actorId, reviewer.principalId); assert.equal(actual.head.revision, 2);
        assert.equal(request.submittedByPrincipalId, applicant.principalId); assert.equal(request.decidedByPrincipalId, reviewer.principalId);
        assert.equal(request.decidedBy, null); assert.equal(request.decidedAt, run.context().dbNow); assert.equal(request.selfReviewAuthorized, false);
        assert.equal(request.status, action === 'approveGift' ? '\u5df2\u6279\u51c6' : '\u5df2\u9a73\u56de');
        const unchangedRequest = { ...request }; for (const field of ['status','decidedBy','decidedAt','decisionNote','selfReviewAuthorized','decidedByPrincipalId']) delete unchangedRequest[field];
        const originalRequest = { ...pending }; for (const field of ['status','decidedBy','decidedAt','decisionNote']) delete originalRequest[field];
        assert.deepEqual(unchangedRequest, originalRequest);
        if (action === 'approveGift') {
          const bonus = order.bonusGifts.at(-1), entry = actual.head.state.ledger.at(-1);
          assert.equal(actual.head.state.inventory.bw.count, 38); assert.equal(bonus.halves, 2); assert.equal(bonus.bottles, 12);
          assert.equal(bonus.referenceValueCents, 11800); assert.equal(bonus.source, '\u8001\u677f\uff0f\u5e97\u957f\u786e\u8ba4\u8d60\u9001');
          assert.equal(bonus.actualActorPrincipalId, reviewer.principalId); assert.equal(bonus.person, reviewer.principalId);
          assert.equal(bonus.requestedBy, null); assert.equal(bonus.time, run.context().dbNow);
          assert.equal(entry.delta, -12); assert.equal(entry.baseQuantityDelta, -12); assert.equal(entry.counted, true);
          assert.equal(entry.actualActorPrincipalId, reviewer.principalId); assert.equal(entry.person, reviewer.principalId); assert.equal(entry.time, run.context().dbNow);
          assert.deepEqual(order.bonusGifts.slice(0,-1), giftOrder(before.head.state).bonusGifts);
          assert.deepEqual(actual.head.state.ledger.slice(0,-1), before.head.state.ledger);
        } else { assert.deepEqual(actual.head.state.inventory, before.head.state.inventory); assert.deepEqual(actual.head.state.ledger, before.head.state.ledger);
          assert.deepEqual(order.bonusGifts, giftOrder(before.head.state).bonusGifts); }
        for (const field of ['sales','payments','drinks','resolvedComponents','person','recordedBy','creditedEmployeeId','creditedEmployeeNameSnapshot','otherCharges','extras','credit'])
          assert.deepEqual(order[field], giftOrder(before.head.state)[field]);
        assert.equal(total(order), 52900); assert.deepEqual(actual.head.state.orders[0], before.head.state.orders[0]);
        assert.deepEqual(actual.head.state.rooms, before.head.state.rooms); assert.equal(actual.head.state.inventory.qd.count, null); assert.equal(actual.head.state.inventory.lm.count, 0);
        assert.equal(actual.operations.length, 2); assert.equal(actual.audit.length, 2);
        const operation = actual.operations.find(row => row.operation_key === 'decision'), audit = actual.audit.find(row => row.operation_key === 'decision');
        assert.equal(operation.actor_principal_id, reviewer.principalId); assert.deepEqual(operation.terminal_result, result);
        assert.equal(audit.actor_principal_id, reviewer.principalId); assert.equal(audit.action, action);
        const locks = [run.calls.findIndex(c => c.kind === 'begin'), sqlAt(run,'ledger_heads','FOR UPDATE'), sqlAt(run,'auth_accounts','FOR UPDATE'),
          sqlAt(run,'auth_sessions','FOR UPDATE'), sqlAt(run,'auth_grants','FOR UPDATE'), sqlAt(run,'AS db_now','SELECT'), sqlAt(run,'ledger_operations','SELECT'),
          run.calls.findIndex(c => c.kind === 'transact'), sqlAt(run,'ledger_heads','UPDATE'), sqlAt(run,'ledger_operations','INSERT'), sqlAt(run,'ledger_success_audit','INSERT'), run.calls.findIndex(c => c.kind === 'commit')];
        assert.ok(locks.every(i => i >= 0)); assert.deepEqual(locks, [...locks].sort((a,b) => a-b)); assert.equal(borrows, 1);
        assert.equal(run.calls.filter(c => c.kind === 'begin').length, 1); assert.equal(run.calls.filter(c => c.kind === 'commit').length, 1);
        assert.equal(run.calls.filter(c => c.kind === 'db-now').length, 1); assert.equal(sqlAt(run,'employees','FOR SHARE'), -1);
        assert.equal(run.context().policyAttributesConfigured, false); assert.equal(run.context().policyAttributeIds, null);
        const [[afterActivity]] = await pool.execute('SELECT last_seen_at, idle_expires_at FROM ' + table('auth_sessions') + ' WHERE session_id=?', [reviewer.sessionId]);
        assert.deepEqual(afterActivity, activity);
      } finally { try { await connection.rollback(); } finally { connection.release(); } }
    });

    await t.test(action + ': self-review needs both grants and denial does not consume the key', async () => {
      const login = await provision(['gift.approve']), id = 'gift-review-self-' + action; await seedFor(id, login.principalId);
      const before = await inspect(id), run = runFor(id), cmd = giftReviewCommand(action);
      await assert.rejects(run.app.execute(cmd, login.credential), denied); await assertUnchanged(id, before);
      await auth.grantPermission({ principalId: login.principalId, permissionId: 'review.self' });
      assert.equal((await run.app.execute(cmd, login.credential)).status, 'committed'); const after = await inspect(id);
      assert.equal(giftReview(after.head.state).selfReviewAuthorized, true); assert.equal(giftReview(after.head.state).decidedByPrincipalId, login.principalId);
      assert.equal(after.operations.length, 1); assert.equal(after.audit.length, 1);
    });

    await t.test(action + ': review.self/backend/demo identity never replaces current gift.approve', async () => {
      for (const permissions of [[], ['review.self'], ['backend.view'], ['order.gift'], ['review.self','backend.view']]) {
        const login = await provision(permissions), id = 'gift-review-base-' + action + '-' + permissions.join('-'); await seedFor(id, login.principalId);
        const before = await inspect(id), run = runFor(id); await assert.rejects(run.app.execute(giftReviewCommand(action,'base',0,forged),login.credential),denied);
        assert.equal(run.executions(),0); await assertUnchanged(id,before);
        await auth.grantPermission({ principalId: login.principalId, permissionId: 'gift.approve' });
        if (!permissions.includes('review.self')) await auth.grantPermission({ principalId: login.principalId, permissionId: 'review.self' });
        assert.equal((await run.app.execute(giftReviewCommand(action,'base',0,forged),login.credential)).status,'committed');
      }
    });

    await t.test(action + ': payload applicant/self-review/approver is inert in both directions', async () => {
      const login = await provision(['gift.approve']), other = await provision([]);
      const selfId = 'gift-review-forged-self-' + action; await seedFor(selfId,login.principalId); const before = await inspect(selfId);
      await assert.rejects(runFor(selfId).app.execute(giftReviewCommand(action,'fake',0,{...forged,submittedByPrincipalId:other.principalId,applicant:other.principalId}),login.credential),denied);
      await assertUnchanged(selfId,before);
      const id = 'gift-review-forged-other-' + action; await seedFor(id,other.principalId); const run = runFor(id);
      assert.equal((await run.app.execute(giftReviewCommand(action,'fake',0,{...forged,submittedByPrincipalId:login.principalId,applicant:login.principalId,selfReview:true}),login.credential)).status,'committed');
      const actual = await inspect(id), request = giftReview(actual.head.state); assert.equal(request.submittedByPrincipalId,other.principalId);
      assert.equal(request.selfReviewAuthorized,false); assert.equal(request.decidedByPrincipalId,login.principalId); assert.equal(request.product,'bw'); assert.equal(request.halves,2);
    });

    await t.test(action + ': legacy missing/invalid stable applicant fails closed with no name/demo/employee/payload mapping', async () => {
      const login = await provision(['gift.approve','review.self']); let index = 0;
      for (const applicant of [undefined,null,'',7,' padded ',{},'x'.repeat(192)]) {
        const id = 'gift-review-legacy-' + action + '-' + (++index); await seedFor(id,login.principalId,state => {
          const request = giftReview(state); delete request.submittedByPrincipalId; if(applicant !== undefined)request.submittedByPrincipalId=applicant;
          request.requestedBy=login.principalId; request.requestedById=state.user; request.employeeId=login.principalId;
        });
        const before = await inspect(id); await assert.rejects(runFor(id).app.execute(giftReviewCommand(action,'legacy',0,
          {...forged,submittedByPrincipalId:login.principalId,selfReview:false}),login.credential),e=>denied(e)&&e.reason==='untrusted-gift-applicant'); await assertUnchanged(id,before);
      }
    });

    await t.test(action + ': revoke then reconnect replays exact terminal without any repeated gift, stock or decision; new key denied', async () => {
      const login = await provision(['gift.approve','review.self']), id = 'gift-review-replay-' + action; await seedFor(id,login.principalId);
      const cmd = giftReviewCommand(action), first = await runFor(id).app.execute(cmd,login.credential);
      await auth.revokePermission({principalId:login.principalId,permissionId:'gift.approve'}); await auth.revokePermission({principalId:login.principalId,permissionId:'review.self'});
      const before = await inspect(id), reconnect = mysql.createPool(poolOptions);
      try {
        const again = runFor(id,{connectionPool:reconnect,bind:createMySqlAuthStore({pool:reconnect,database}).bindSessionRevalidation,
          transactCommand:()=>assert.fail('replay must not execute decision or current permission/applicant checks')});
        assert.deepEqual(await again.app.execute(cmd,login.credential),first); assert.equal(again.executions(),0);
        await assert.rejects(again.app.execute({...cmd,operationKey:'new',expectedRevision:1},login.credential),denied); await assertUnchanged(id,before);
      } finally { await reconnect.end(); }
    });

    await t.test(action + ': disabled/revoked/idle/absolute/credential invalidation prevents even saved-result lookup', async () => {
      for (const invalid of ['disabled','revoked','idle','absolute','version']) {
        const login = await provision(['gift.approve']), id = 'gift-review-auth-' + action + '-' + invalid; await seedFor(id);
        const run=runFor(id),cmd=giftReviewCommand(action); await run.app.execute(cmd,login.credential); const before=await inspect(id);
        if(invalid==='disabled')await auth.disableAccount({principalId:login.principalId});
        else if(invalid==='revoked')await auth.logout(login.token);
        else if(invalid==='version')await auth.rotateCredential({principalId:login.principalId,password:'synthetic-gift-review-rotation'});
        else if(invalid==='idle')await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at WHERE session_id=?',[login.sessionId]);
        else await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at,absolute_expires_at=created_at+INTERVAL 1 MICROSECOND WHERE session_id=?',[login.sessionId]);
        run.calls.length=0; await assert.rejects(run.app.execute(cmd,login.credential),e=>e.code==='AUTHENTICATION_REQUIRED');
        assert.equal(sqlAt(run,'ledger_operations','SELECT'),-1); assert.equal(run.executions(),1); await assertUnchanged(id,before);
      }
    });

    await t.test(action + ': actor/action/payload/expectedRevision conflicts retain Stage 1 semantics before current grants', async () => {
      const login=await provision(['gift.approve']),other=await provision([]),id='gift-review-conflict-'+action; await seedFor(id);
      const run=runFor(id),cmd=giftReviewCommand(action); await run.app.execute(cmd,login.credential); const before=await inspect(id);
      await auth.revokePermission({principalId:login.principalId,permissionId:'gift.approve'});
      const actor=await run.app.execute(cmd,other.credential); assert.equal(actor.status,'idempotency-conflict'); assert.equal(actor.reason,'actor-mismatch');
      for(const changed of [{...cmd,expectedRevision:1},{...cmd,action:action==='approveGift'?'rejectGift':'approveGift'},
        {...cmd,payload:{...cmd.payload,decisionNote:'changed'}}]) {
        const result=await run.app.execute(changed,login.credential); assert.equal(result.status,'idempotency-conflict'); assert.equal(result.reason,'request-mismatch');
      }
      assert.equal(run.executions(),1); await assertUnchanged(id,before);
    });

    await t.test(action + ': original business rejection and stale revision stay terminal with no partial state', async () => {
      const login=await provision(['gift.approve']); let index=0;
      const cases=[[{order:'missing'},()=>{}],[{},s=>giftOrder(s).status='\u5df2\u7ed3\u8d26'],[{request:999},()=>{}],[{request:'1001'},()=>{}],
        [{},s=>giftReview(s).status='\u5df2\u6279\u51c6'],...(action==='approveGift' ? [[{},s=>s.inventory.bw.count=11],[{},s=>delete s.inventory.bw],
          [{},s=>giftReview(s).product='unknown'],[{},s=>{const p=s.catalog.products.find(p=>p.id==='bw');p.saleOptions=p.saleOptions.filter(o=>o.id!=='half');}]] : [[{decisionNote:'  '},()=>{}]])];
      for(const [changes,prepare] of cases) {
        const id='gift-review-business-'+action+'-'+(++index),original=await seedFor(id,undefined,prepare),run=runFor(id),cmd=giftReviewCommand(action,'terminal',0,changes);
        const result=await run.app.execute(cmd,login.credential); assert.equal(result.status,'business-rejected'); const before=await inspect(id);
        assert.deepEqual(before.head.state,original); assert.equal(before.head.revision,0); assert.equal(before.operations.length,1); assert.equal(before.audit.length,0);
        await auth.revokePermission({principalId:login.principalId,permissionId:'gift.approve'}); assert.deepEqual(await run.app.execute(cmd,login.credential),result); await assertUnchanged(id,before);
        await auth.grantPermission({principalId:login.principalId,permissionId:'gift.approve'});
      }
      const id='gift-review-stale-'+action; await seedFor(id); const run=runFor(id),cmd=giftReviewCommand(action,'stale',9),first=await run.app.execute(cmd,login.credential);
      assert.equal(first.status,'revision-conflict'); assert.equal(run.executions(),0); await run.app.execute(giftReviewCommand(action,'other'),login.credential); const before=await inspect(id);
      await auth.revokePermission({principalId:login.principalId,permissionId:'gift.approve'}); assert.deepEqual(await run.app.execute(cmd,login.credential),first); await assertUnchanged(id,before);
    });

    await t.test(action + ': unknown and mid-SQL faults roll back request/gift/stock/state/result/audit together, original key retry succeeds', async () => {
      const login=await provision(['gift.approve']);
      for(const type of ['unknown','sql']) {
        const id='gift-review-rollback-'+action+'-'+type; await seedFor(id); const before=await inspect(id); let broken=true;
        const run=runFor(id,{transactCommand:(...args)=>{const state=transact(...args);if(type==='unknown'&&broken)throw Error('synthetic gift review fault');return state;}}),cmd=giftReviewCommand(action);
        if(type==='sql')await setup.query('ALTER TABLE '+table('ledger_success_audit')+" ADD CONSTRAINT chk_gift_review_fault CHECK (ledger_id <> '"+id+"')");
        try {
          await assert.rejects(run.app.execute(cmd,login.credential),e=>type==='unknown'?e.message==='synthetic gift review fault':e.code==='ER_CHECK_CONSTRAINT_VIOLATED');
          assert.ok(run.calls.some(c=>c.kind==='rollback')); if(type==='sql'){assert.ok(sqlAt(run,'ledger_heads','UPDATE')>=0);assert.ok(sqlAt(run,'ledger_operations','INSERT')>=0);}
          await assertUnchanged(id,before);
        } finally { if(type==='sql')await setup.query('ALTER TABLE '+table('ledger_success_audit')+' DROP CHECK chk_gift_review_fault'); }
        broken=false; assert.equal((await run.app.execute(cmd,login.credential)).status,'committed'); const actual=await inspect(id);
        assert.equal(actual.head.revision,1); assert.equal(actual.operations.length,1); assert.equal(actual.audit.length,1);
        assert.equal(actual.head.state.inventory.bw.count,action==='approveGift'?38:50); assert.equal(giftReview(actual.head.state).decidedByPrincipalId,login.principalId);
      }
    });
  }

  await t.test('gift approvals: MySQL JSON preserves null/zero and counted/unmanaged inventory semantics', async () => {
    const login=await provision(['gift.approve']);
    for(const action of GIFT_REVIEW_ACTIONS) for(const count of [null,0,11,12]) {
      const id='gift-review-count-'+action+'-'+count,original=await seedFor(id,undefined,s=>s.inventory.bw.count=count);
      const result=await runFor(id).app.execute(giftReviewCommand(action),login.credential),actual=await inspect(id);
      if(action==='approveGift'&&(count===0||count===11)){assert.equal(result.status,'business-rejected');assert.deepEqual(actual.head.state,original);assert.equal(actual.head.revision,0);}
      else { assert.equal(result.status,'committed'); assert.equal(actual.head.state.inventory.bw.count,action==='approveGift'?(count===null?null:0):count);
        if(action==='approveGift')assert.equal(actual.head.state.ledger.at(-1).counted,count!==null); else assert.deepEqual(actual.head.state.ledger,original.ledger); }
      assert.equal(actual.head.state.inventory.qd.count,null); assert.equal(actual.head.state.inventory.lm.count,0); assert.deepEqual(actual.head.state.orders[0],original.orders[0]);
    }
    const id='gift-review-unmanaged',original=await seedFor(id,undefined,s=>{s.inventory.bw.count=0;s.catalog.products.find(p=>p.id==='bw').inventoryManaged=false;});
    await runFor(id).app.execute(giftReviewCommand('approveGift'),login.credential); const after=await inspect(id);
    assert.equal(after.head.state.inventory.bw.count,0); assert.deepEqual(after.head.state.ledger,original.ledger);
  });

  await t.test('gift approval: original current-catalog snapshot creation leaves request and prior historical unknown facts immutable', async () => {
    const login=await provision(['gift.approve','catalog.manage']),id='gift-review-catalog'; await seedFor(id); const before=await inspect(id),run=runFor(id),p=before.head.state.catalog.products.find(p=>p.id==='bw');
    await run.app.execute({operationKey:'catalog',expectedRevision:0,action:'updateCatalogProduct',payload:{id:'bw',name:'Current Beer',
      saleOptions:p.saleOptions.map(o=>o.id==='half'?{...o,name:'Current Half',priceCents:6900}:o)}},login.credential);
    await run.app.execute(giftReviewCommand('approveGift','decision',1),login.credential); const after=await inspect(id),order=giftOrder(after.head.state),bonus=order.bonusGifts.at(-1);
    assert.equal(bonus.productNameSnapshot,'Current Beer'); assert.equal(bonus.saleOptionNameSnapshot,'Current Half'); assert.equal(bonus.referenceValueCents,13800);
    assert.equal(giftReview(after.head.state).productNameSnapshot,'Request Beer Snapshot'); assert.equal(giftReview(after.head.state).referenceValueCents,11800);
    assert.deepEqual(order.bonusGifts.slice(0,-1),giftOrder(before.head.state).bonusGifts); assert.deepEqual(order.sales,giftOrder(before.head.state).sales);
    assert.deepEqual(after.head.state.orders[0],before.head.state.orders[0]); assert.equal(total(order),52900); assert.equal(after.head.state.inventory.bw.count,38);
  });

  for(const action of GIFT_REVIEW_ACTIONS) await t.test(action + ': two independent connections retry one key without repeated approval/stock/decision', async () => {
    const login=await provision(['gift.approve']),id='gift-review-same-key-'+action; await seedFor(id); const a=await pool.getConnection(),b=await pool.getConnection();
    try {
      const [[aId]]=await a.query('SELECT CONNECTION_ID() AS id'),[[bId]]=await b.query('SELECT CONNECTION_ID() AS id'); assert.notEqual(aId.id,bId.id);
      await a.query('SET SESSION innodb_lock_wait_timeout=5'); await b.query('SET SESSION innodb_lock_wait_timeout=5');
      const first=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(a,[],false)}}),second=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(b,[],false)}}),cmd=giftReviewCommand(action);
      const results=await Promise.all([first.app.execute(cmd,login.credential),second.app.execute(cmd,login.credential)]); assert.deepEqual(results[0],results[1]);
      assert.equal(results[0].status,'committed'); assert.equal(first.executions()+second.executions(),1); const actual=await inspect(id);
      assert.equal(actual.head.revision,1); assert.equal(actual.operations.length,1); assert.equal(actual.audit.length,1);
      assert.equal(actual.head.state.inventory.bw.count,action==='approveGift'?38:50); assert.equal(giftOrder(actual.head.state).bonusGifts.length,action==='approveGift'?2:1);
      t.diagnostic(action+' same-key race verified two independent CONNECTION_ID values');
    } finally { try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); } }
  });

  await t.test('gift approval/rejection: two independent connections at one old revision commit at most one decision', async () => {
    const login=await provision(['gift.approve']),id='gift-review-revision-race'; await seedFor(id); const a=await pool.getConnection(),b=await pool.getConnection();
    try {
      const [[aId]]=await a.query('SELECT CONNECTION_ID() AS id'),[[bId]]=await b.query('SELECT CONNECTION_ID() AS id'); assert.notEqual(aId.id,bId.id);
      await a.query('SET SESSION innodb_lock_wait_timeout=5'); await b.query('SET SESSION innodb_lock_wait_timeout=5');
      const first=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(a,[],false)}}),second=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(b,[],false)}});
      const results=await Promise.all([first.app.execute(giftReviewCommand('approveGift','approve'),login.credential),second.app.execute(giftReviewCommand('rejectGift','reject'),login.credential)]);
      assert.deepEqual(results.map(r=>r.status).sort(),['committed','revision-conflict']); assert.equal(first.executions()+second.executions(),1);
      const actual=await inspect(id),approved=results[0].status==='committed'; assert.equal(actual.head.revision,1); assert.equal(actual.operations.length,2); assert.equal(actual.audit.length,1);
      assert.equal(giftReview(actual.head.state).status,approved?'\u5df2\u6279\u51c6':'\u5df2\u9a73\u56de'); assert.equal(actual.head.state.inventory.bw.count,approved?38:50);
      assert.equal(giftOrder(actual.head.state).bonusGifts.length,approved?2:1); assert.equal(actual.head.state.ledger.length,approved?2:1);
      t.diagnostic('gift approve/reject revision race verified two independent CONNECTION_ID values');
    } finally { try { await a.rollback(); await b.rollback(); } finally { a.release(); b.release(); } }
  });
}
