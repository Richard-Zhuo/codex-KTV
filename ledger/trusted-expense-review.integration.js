import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact } from '../rules.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createPolicyAttributeService } from '../auth/policy-attributes.js';
import { EXPENSE_REVIEW_ACTIONS, expenseReview, expenseReviewCommand, seedExpenseReview } from '../test-support/trusted-expense-review-fixture.js';

const boss='expense.approval.boss';
const denied=e=>e instanceof AuthorizationDenied&&e.status==='authorization-denied';
const sqlAt=(run,name,clause)=>run.calls.findIndex(c=>c.kind==='sql'&&c.sql.includes(name)&&
  (clause.startsWith('FOR ')?c.sql.endsWith(clause):c.sql.startsWith(clause+' ')));
// Uses only the caller's existing guarded fixture and its eleven owned tables.
export async function testTrustedExpenseReviews({t,pool,setup,auth,table,provision,seed,inspect,application,assertUnchanged,wrapConnection,poolOptions,database}) {
  const attributes=createPolicyAttributeService({store:createMySqlAuthStore({pool,database})});
  const configure=login=>attributes.configurePolicyAttributes({principalId:login.principalId},{actorPrincipalId:login.principalId});
  const grant=(login,attributeId=boss)=>attributes.grantPolicyAttribute({principalId:login.principalId,attributeId},{actorPrincipalId:login.principalId});
  const revoke=login=>attributes.revokePolicyAttribute({principalId:login.principalId,attributeId:boss},{actorPrincipalId:login.principalId});
  const reviewer=async()=>{const login=await provision(['expense.approve']);await configure(login);await grant(login);return login;};
  const runFor=(id,options={})=>application(id,{employeeBind:null,...options});
  const seedFor=(id,applicant,amount=60000,prepare=()=>{})=>seed(id,state=>{seedExpenseReview(state,applicant,amount);prepare(state);});
  const secondPending=state=>state.expenses.push({...expenseReview(state),id:904,description:'Second pending expense'});
  const forged={actorId:'administrator',principalId:'fake',permissions:['expense.approve','review.self'],role:'老板',clock:'1900-01-01',
    applicant:'fake',submittedBy:'fake',submittedByPrincipalId:'fake',approver:'fake',decidedByPrincipalId:'fake',selfReview:false,
    policyAttributesConfigured:true,policyAttributeIds:[boss],attributes:[boss],amount:1};

  for(const action of EXPENSE_REVIEW_ACTIONS){
    await t.test(action+': one connection reads DB boss attribute and records session decider with unchanged expense/procurement facts',async()=>{
      const applicant=await provision([]),login=await reviewer(),id='expense-review-first-'+action,original=await seedFor(id,applicant.principalId);
      const [[activity]]=await pool.execute('SELECT last_seen_at,idle_expires_at FROM '+table('auth_sessions')+' WHERE session_id=?',[login.sessionId]);
      const connection=await pool.getConnection();let borrows=0;
      try{
        const run=runFor(id,{connectionPool:{getConnection:async()=>{borrows++;return wrapConnection(connection,[],false);}}});
        const result=await run.app.execute(expenseReviewCommand(action,'decision',0,forged),login.credential),actual=await inspect(id),row=expenseReview(actual.head.state),linked=actual.head.state.procurements.at(-1);
        assert.equal(result.status,'committed');assert.equal(result.actorId,login.principalId);assert.equal(actual.head.revision,1);
        assert.equal(row.decidedByPrincipalId,login.principalId);assert.equal(row.submittedByPrincipalId,applicant.principalId);assert.equal(row.selfReviewAuthorized,false);
        assert.equal(row.status,action==='approveExpense'?'已审批':'已驳回');assert.equal(row.approver,null);assert.equal(row.approvedAt,run.context().dbNow);
        assert.equal(linked.status,action==='approveExpense'?'已关联支出':'报销已驳回');assert.equal(linked.decisionAt,run.context().dbNow);assert.equal(linked.decisionBy,null);
        for(const field of ['id','date','amount','type','method','nature','description','proof','proofName','submittedById','person','time'])assert.deepEqual(row[field],expenseReview(original)[field]);
        for(const field of ['orders','rooms','inventory','consumables','ledger','user','clock','permissions','capabilities','administrator'])assert.deepEqual(actual.head.state[field],original[field]);
        assert.deepEqual(actual.head.state.expenses[0],original.expenses[0]);assert.deepEqual(actual.head.state.procurements[0],original.procurements[0]);
        assert.equal(actual.head.state.inventory.qd.count,null);assert.equal(actual.head.state.inventory.bw.count,0);assert.equal(actual.head.state.orders[0].room,null);
        assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);assert.equal(actual.operations[0].actor_principal_id,login.principalId);
        assert.deepEqual(actual.operations[0].terminal_result,result);assert.equal(actual.audit[0].actor_principal_id,login.principalId);
        const locks=[run.calls.findIndex(c=>c.kind==='begin'),sqlAt(run,'ledger_heads','FOR UPDATE'),sqlAt(run,'auth_accounts','FOR UPDATE'),
          sqlAt(run,'auth_sessions','FOR UPDATE'),sqlAt(run,'auth_grants','FOR UPDATE'),sqlAt(run,'auth_policy_attributes','FOR UPDATE'),
          sqlAt(run,'AS db_now','SELECT'),sqlAt(run,'ledger_operations','SELECT'),run.calls.findIndex(c=>c.kind==='transact'),
          sqlAt(run,'ledger_heads','UPDATE'),sqlAt(run,'ledger_operations','INSERT'),sqlAt(run,'ledger_success_audit','INSERT'),run.calls.findIndex(c=>c.kind==='commit')];
        assert.ok(locks.every(i=>i>=0));assert.deepEqual(locks,[...locks].sort((a,b)=>a-b));assert.equal(borrows,1);
        assert.equal(run.calls.filter(c=>c.kind==='db-now').length,1);assert.equal(run.calls.filter(c=>c.kind==='begin').length,1);assert.equal(run.calls.filter(c=>c.kind==='commit').length,1);
        assert.equal(run.context().policyAttributesConfigured,true);assert.deepEqual(run.context().policyAttributeIds,[boss]);assert.equal(sqlAt(run,'employees','FOR SHARE'),-1);
        const [[afterActivity]]=await pool.execute('SELECT last_seen_at,idle_expires_at FROM '+table('auth_sessions')+' WHERE session_id=?',[login.sessionId]);assert.deepEqual(afterActivity,activity);
      }finally{try{await connection.rollback();}finally{connection.release();}}
    });

    await t.test(action+': self-review requires both grants and denied key can succeed after review.self',async()=>{
      for(const amount of [50000,50001]){
        const login=await reviewer(),id='expense-review-self-'+action+'-'+amount;await seedFor(id,login.principalId,amount);
        const run=runFor(id),before=await inspect(id),cmd=expenseReviewCommand(action);await assert.rejects(run.app.execute(cmd,login.credential),denied);await assertUnchanged(id,before);
        await auth.grantPermission({principalId:login.principalId,permissionId:'review.self'});assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');
        assert.equal(expenseReview((await inspect(id)).head.state).selfReviewAuthorized,true);
      }
    });

    await t.test(action+': boss attribute, backend and review.self cannot replace expense.approve',async()=>{
      let index=0;for(const permissions of [[],['backend.view','review.self'],['expense.create']]){
        const login=await provision(permissions);await configure(login);await grant(login);const id='expense-review-base-'+action+'-'+(++index);await seedFor(id,login.principalId);
        const before=await inspect(id);await assert.rejects(runFor(id).app.execute(expenseReviewCommand(action,'base',0,forged),login.credential),e=>denied(e)&&e.reason==='missing-permission');await assertUnchanged(id,before);
      }
    });

    await t.test(action+': threshold requires boss only >500; unconfigured, empty and rounding-only deny without consuming key',async()=>{
      for(const kind of ['unconfigured','empty','rounding']){
        const login=await provision(['expense.approve']);if(kind!=='unconfigured')await configure(login);if(kind==='rounding')await grant(login,'rounding.self.excess');
        const id='expense-review-threshold-'+action+'-'+kind;await seedFor(id,'independent-synthetic-applicant',50001);const run=runFor(id),cmd=expenseReviewCommand(action),before=await inspect(id);
        await assert.rejects(run.app.execute(cmd,login.credential),e=>denied(e)&&e.reason===(kind==='unconfigured'?'policy-attributes-unconfigured':'missing-policy-attribute'));await assertUnchanged(id,before);
        if(kind==='unconfigured')await configure(login);await grant(login);assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');
      }
      for(const amount of [49999,50000])for(const configured of [false,true]){
        const login=await provision(['expense.approve']);if(configured)await configure(login);const id='expense-review-low-'+action+'-'+amount+'-'+configured;
        await seedFor(id,'independent-synthetic-applicant',amount);assert.equal((await runFor(id).app.execute(expenseReviewCommand(action),login.credential)).status,'committed');
      }
    });

    await t.test(action+': forged applicant/self-review/role/attributes/amount cannot authorize from payload or demo state',async()=>{
      const login=await provision(['expense.approve']),id='expense-review-forged-'+action;
      await seedFor(id,login.principalId,60000,s=>{s.user='boss';s.clock='1900-01-01';});const run=runFor(id),cmd=expenseReviewCommand(action,'forged',0,forged),before=await inspect(id);
      await assert.rejects(run.app.execute(cmd,login.credential),denied);await assertUnchanged(id,before);
      await auth.grantPermission({principalId:login.principalId,permissionId:'review.self'});
      await assert.rejects(run.app.execute(cmd,login.credential),e=>denied(e)&&e.reason==='policy-attributes-unconfigured');await assertUnchanged(id,before);
      await configure(login);await grant(login);assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');
      const row=expenseReview((await inspect(id)).head.state);assert.equal(row.submittedByPrincipalId,login.principalId);assert.equal(row.decidedByPrincipalId,login.principalId);
      assert.equal(row.selfReviewAuthorized,true);assert.equal(row.amount,60000);assert.equal(row.approver,null);
    });

    await t.test(action+': legacy missing principal including linked procurement expenses fail closed and leave key unused',async()=>{
      const login=await reviewer();let index=0;
      for(const value of [undefined,null,'',' ',123]){
        const id='expense-review-legacy-'+action+'-'+(++index);await seedFor(id,'placeholder',60000,s=>{
          if(value===undefined)delete expenseReview(s).submittedByPrincipalId;else expenseReview(s).submittedByPrincipalId=value;
          s.user='boss';expenseReview(s).submittedById='boss';expenseReview(s).person='老板';
        });const before=await inspect(id);await assert.rejects(runFor(id).app.execute(expenseReviewCommand(action,'legacy',0,{...forged,submittedByPrincipalId:login.principalId}),login.credential),
          e=>denied(e)&&e.reason==='untrusted-expense-applicant');await assertUnchanged(id,before);
      }
      const id='expense-review-procurement-'+action;await seedFor(id,'unrelated-applicant');const before=await inspect(id);
      await assert.rejects(runFor(id).app.execute(expenseReviewCommand(action,'legacy-procurement',0,{id:900,submittedByPrincipalId:login.principalId}),login.credential),
        e=>denied(e)&&e.reason==='untrusted-expense-applicant');await assertUnchanged(id,before);
    });

    await t.test(action+': revoke permission or boss then reconnect replays old terminal; new pending key denied then reusable',async()=>{
      for(const kind of ['permission','attribute']){
        const login=await reviewer(),id='expense-review-replay-'+action+'-'+kind;await seedFor(id,'independent-synthetic-applicant',60000,secondPending);
        const cmd=expenseReviewCommand(action),first=await runFor(id).app.execute(cmd,login.credential);
        if(kind==='permission')await auth.revokePermission({principalId:login.principalId,permissionId:'expense.approve'});else await revoke(login);
        const before=await inspect(id),reconnect=mysql.createPool(poolOptions);
        try{
          const again=runFor(id,{connectionPool:reconnect,bind:createMySqlAuthStore({pool:reconnect,database}).bindSessionRevalidation,
            transactCommand:(...args)=>{if(args[3]==='decision')assert.fail('Saved decision executed again');return transact(...args);}});
          assert.deepEqual(await again.app.execute(cmd,login.credential),first);assert.equal(again.executions(),0);
          const fresh=expenseReviewCommand(action,'new',1,{id:904});await assert.rejects(again.app.execute(fresh,login.credential),denied);await assertUnchanged(id,before);
          if(kind==='permission')await auth.grantPermission({principalId:login.principalId,permissionId:'expense.approve'});else await grant(login);
          assert.equal((await again.app.execute(fresh,login.credential)).status,'committed');const actual=await inspect(id);assert.equal(actual.head.revision,2);assert.equal(actual.operations.length,2);assert.equal(actual.audit.length,2);
        }finally{await reconnect.end();}
      }
    });

    await t.test(action+': invalid session/account cannot access a saved decision before operation lookup',async()=>{
      for(const invalid of ['disabled','revoked','idle','absolute','version']){
        const login=await reviewer(),id='expense-review-auth-'+action+'-'+invalid;await seedFor(id,'independent-synthetic-applicant');const run=runFor(id),cmd=expenseReviewCommand(action);
        await run.app.execute(cmd,login.credential);const before=await inspect(id);
        if(invalid==='disabled')await auth.disableAccount({principalId:login.principalId});else if(invalid==='revoked')await auth.logout(login.token);
        else if(invalid==='version')await auth.rotateCredential({principalId:login.principalId,password:'synthetic-expense-review-rotation'});
        else if(invalid==='idle')await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at WHERE session_id=?',[login.sessionId]);
        else await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at,absolute_expires_at=created_at+INTERVAL 1 MICROSECOND WHERE session_id=?',[login.sessionId]);
        run.calls.length=0;await assert.rejects(run.app.execute(cmd,login.credential),e=>e.code==='AUTHENTICATION_REQUIRED');assert.equal(sqlAt(run,'ledger_operations','SELECT'),-1);await assertUnchanged(id,before);
      }
    });

    await t.test(action+': actor/action/payload/revision conflicts keep Stage 1 semantics after both permission and boss revoke',async()=>{
      const login=await reviewer(),other=await provision([]),id='expense-review-conflicts-'+action;await seedFor(id,'independent-synthetic-applicant');
      const run=runFor(id),cmd=expenseReviewCommand(action);await run.app.execute(cmd,login.credential);const before=await inspect(id);
      await auth.revokePermission({principalId:login.principalId,permissionId:'expense.approve'});await revoke(login);
      const actor=await run.app.execute(cmd,other.credential);assert.equal(actor.status,'idempotency-conflict');assert.equal(actor.reason,'actor-mismatch');
      for(const changed of [{...cmd,expectedRevision:1},{...cmd,action:action==='approveExpense'?'rejectExpense':'approveExpense'},{...cmd,payload:{id:900}}]){
        const result=await run.app.execute(changed,login.credential);assert.equal(result.status,'idempotency-conflict');assert.equal(result.reason,'request-mismatch');
      }assert.equal(run.executions(),1);await assertUnchanged(id,before);
    });

    await t.test(action+': original missing/already-processed states remain business terminal with no partial decision',async()=>{
      const login=await reviewer();let index=0;
      for(const c of [{payload:{id:999}},{status:'已审批'},{status:'已记录'}]){
        const id='expense-review-business-'+action+'-'+(++index),original=await seedFor(id,'independent-synthetic-applicant',60000,s=>{if(c.status)expenseReview(s).status=c.status;});
        const run=runFor(id),cmd=expenseReviewCommand(action,'business',0,c.payload),result=await run.app.execute(cmd,login.credential),actual=await inspect(id);
        assert.equal(result.status,'business-rejected');assert.deepEqual(actual.head.state,original);assert.equal(actual.head.revision,0);assert.equal(actual.audit.length,0);assert.equal(actual.operations.length,1);
        await auth.revokePermission({principalId:login.principalId,permissionId:'expense.approve'});await revoke(login);
        assert.deepEqual(await run.app.execute(cmd,login.credential),result);await assertUnchanged(id,actual);
        await auth.grantPermission({principalId:login.principalId,permissionId:'expense.approve'});await grant(login);
      }
    });

    await t.test(action+': stale revision stays terminal after a real decision and both authorization facts are revoked',async()=>{
      const login=await reviewer(),id='expense-review-stale-'+action;await seedFor(id,'independent-synthetic-applicant');const run=runFor(id),cmd=expenseReviewCommand(action,'stale',9);
      const first=await run.app.execute(cmd,login.credential);assert.equal(first.status,'revision-conflict');assert.equal(run.executions(),0);
      await run.app.execute(expenseReviewCommand(action,'valid'),login.credential);const before=await inspect(id);
      await auth.revokePermission({principalId:login.principalId,permissionId:'expense.approve'});await revoke(login);
      assert.deepEqual(await run.app.execute(cmd,login.credential),first);await assertUnchanged(id,before);
    });

    for(const fault of ['unknown','sql'])await t.test(action+': '+fault+' failure rolls back expense/procurement/state/revision/result/audit; original key retries',async()=>{
      const login=await reviewer(),id='expense-review-fault-'+action+'-'+fault;await seedFor(id,'independent-synthetic-applicant');const before=await inspect(id);let broken=true;
      const run=runFor(id,{transactCommand:(...args)=>{const next=transact(...args);if(fault==='unknown'&&broken)throw Error('synthetic expense review fault');return next;}}),cmd=expenseReviewCommand(action);
      if(fault==='sql')await setup.query('ALTER TABLE '+table('ledger_success_audit')+" ADD CONSTRAINT chk_expense_review_fault CHECK (ledger_id <> '"+id+"')");
      try{
        await assert.rejects(run.app.execute(cmd,login.credential),e=>fault==='unknown'?e.message==='synthetic expense review fault':e.code==='ER_CHECK_CONSTRAINT_VIOLATED');
        assert.ok(run.calls.some(c=>c.kind==='rollback'));if(fault==='sql'){assert.ok(sqlAt(run,'ledger_heads','UPDATE')>=0);assert.ok(sqlAt(run,'ledger_operations','INSERT')>=0);}await assertUnchanged(id,before);
      }finally{if(fault==='sql')await setup.query('ALTER TABLE '+table('ledger_success_audit')+' DROP CHECK chk_expense_review_fault');}
      broken=false;assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');const actual=await inspect(id);
      assert.equal(actual.head.revision,1);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);assert.equal(expenseReview(actual.head.state).decidedByPrincipalId,login.principalId);
    });

    await t.test(action+': two independent connections retry same key with one decision and audit',async()=>{
      const login=await reviewer(),id='expense-review-key-race-'+action;await seedFor(id,'independent-synthetic-applicant');const a=await pool.getConnection(),b=await pool.getConnection();
      try{
        const [[aId]]=await a.query('SELECT CONNECTION_ID() AS id'),[[bId]]=await b.query('SELECT CONNECTION_ID() AS id');assert.notEqual(aId.id,bId.id);
        await a.query('SET SESSION innodb_lock_wait_timeout=5');await b.query('SET SESSION innodb_lock_wait_timeout=5');
        const first=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(a,[],false)}}),second=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(b,[],false)}});
        const cmd=expenseReviewCommand(action),results=await Promise.all([first.app.execute(cmd,login.credential),second.app.execute(cmd,login.credential)]);
        assert.deepEqual(results[0],results[1]);assert.equal(first.executions()+second.executions(),1);const actual=await inspect(id);
        assert.equal(actual.head.revision,1);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);
        t.diagnostic(action+' same-key race verified two independent CONNECTION_ID values');
      }finally{try{await a.rollback();await b.rollback();}finally{a.release();b.release();}}
    });
  }

  await t.test('expense approvals: two independent connections and two principals compete approve/reject at one old revision',async()=>{
    const aLogin=await reviewer(),bLogin=await reviewer(),id='expense-review-revision-race';await seedFor(id,'independent-synthetic-applicant');
    const a=await pool.getConnection(),b=await pool.getConnection();
    try{
      const [[aId]]=await a.query('SELECT CONNECTION_ID() AS id'),[[bId]]=await b.query('SELECT CONNECTION_ID() AS id');assert.notEqual(aId.id,bId.id);
      await a.query('SET SESSION innodb_lock_wait_timeout=5');await b.query('SET SESSION innodb_lock_wait_timeout=5');
      const first=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(a,[],false)}}),second=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(b,[],false)}});
      const results=await Promise.all([first.app.execute(expenseReviewCommand('approveExpense','approve'),aLogin.credential),second.app.execute(expenseReviewCommand('rejectExpense','reject'),bLogin.credential)]);
      assert.deepEqual(results.map(r=>r.status).sort(),['committed','revision-conflict']);assert.equal(first.executions()+second.executions(),1);
      const actual=await inspect(id),approved=results[0].status==='committed';assert.equal(expenseReview(actual.head.state).status,approved?'已审批':'已驳回');
      assert.equal(expenseReview(actual.head.state).decidedByPrincipalId,approved?aLogin.principalId:bLogin.principalId);
      assert.equal(actual.head.revision,1);assert.equal(actual.operations.length,2);assert.equal(actual.audit.length,1);
      t.diagnostic('expense approve/reject race verified two independent CONNECTION_ID values and two session principals');
    }finally{try{await a.rollback();await b.rollback();}finally{a.release();b.release();}}
  });
}
