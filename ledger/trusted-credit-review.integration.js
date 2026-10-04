import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact } from '../rules.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createPolicyAttributeService } from '../auth/policy-attributes.js';
import { CREDIT_REVIEW_ACTIONS, creditDecision, creditReviewCommand, seedCreditReview } from '../test-support/trusted-credit-review-fixture.js';
import { creditCommand, creditOrder, seedTrustedCredit } from '../test-support/trusted-credit-fixture.js';

const manager='credit.approval.manager',boss='credit.approval.boss';
const denied=e=>e instanceof AuthorizationDenied&&e.status==='authorization-denied';
const sqlAt=(run,name,clause)=>run.calls.findIndex(c=>c.kind==='sql'&&c.sql.includes(name)&&
  (clause.startsWith('FOR ')?c.sql.endsWith(clause):c.sql.startsWith(clause+' ')));
// Reuses only the existing strictly guarded fixture's eleven owned tables.
export async function testTrustedCreditReviews({t,pool,setup,auth,table,provision,seed,inspect,application,assertUnchanged,wrapConnection,poolOptions,database}) {
  const attributes=createPolicyAttributeService({store:createMySqlAuthStore({pool,database})});
  const configure=login=>attributes.configurePolicyAttributes({principalId:login.principalId},{actorPrincipalId:login.principalId});
  const grant=(login,attributeId=boss)=>attributes.grantPolicyAttribute({principalId:login.principalId,attributeId},{actorPrincipalId:login.principalId});
  const revoke=(login,attributeId=boss)=>attributes.revokePolicyAttribute({principalId:login.principalId,attributeId},{actorPrincipalId:login.principalId});
  const reviewer=async(attributeId=boss)=>{const login=await provision(['credit.approve']);await configure(login);await grant(login,attributeId);return login;};
  const runFor=(id,options={})=>application(id,{employeeBind:null,...options});
  const seedFor=(id,applicant,amount=100001,prepare=()=>{})=>seed(id,state=>{seedCreditReview(state,applicant,amount);prepare(state);});
  const secondPending=state=>state.orders.push({...structuredClone(creditOrder(state)),id:'second-credit-order'});
  const forged={actorId:'administrator',principalId:'fake',permissions:['credit.approve','review.self'],role:'老板',clock:'1900-01-01',
    applicant:'fake',submittedBy:'fake',submittedByPrincipalId:'fake',approver:'店长',decidedByPrincipalId:'fake',selfReview:false,
    attributes:[boss],policyAttributesConfigured:true,policyAttributeIds:[boss],amount:1};

  for(const action of CREDIT_REVIEW_ACTIONS){
    await t.test('credit '+action+': same connection reads current tier attributes, saves session decider and preserves original business facts',async()=>{
      const applicant=await provision([]),login=await reviewer(),id='credit-review-first-'+action,original=await seedFor(id,applicant.principalId);
      const [[activity]]=await pool.execute('SELECT last_seen_at,idle_expires_at FROM '+table('auth_sessions')+' WHERE session_id=?',[login.sessionId]);
      const connection=await pool.getConnection();let borrows=0;
      try{
        const run=runFor(id,{connectionPool:{getConnection:async()=>{borrows++;return wrapConnection(connection,[],false);}}});
        const result=await run.app.execute(creditReviewCommand(action,'decision',0,forged),login.credential),actual=await inspect(id),order=creditOrder(actual.head.state),row=creditDecision(actual.head.state,action);
        assert.equal(result.status,'committed');assert.equal(result.actorId,login.principalId);assert.equal(actual.head.revision,1);
        assert.equal(row.decidedByPrincipalId,login.principalId);assert.equal(row.submittedByPrincipalId,applicant.principalId);assert.equal(row.selfReviewAuthorized,false);
        assert.equal(row.decisionStatus,action==='approve'?'已批准':'已驳回');assert.equal(order.status,action==='approve'?'已挂账':'营业中');
        assert.equal(row.decisionBy,null);assert.equal(row.decisionAt,run.context().dbNow);assert.equal(row.approver,'老板');
        for(const [field,value] of Object.entries(creditOrder(original).credit))assert.deepEqual(row[field],value);
        for(const [field,value] of Object.entries(creditOrder(original)))if(!['credit','creditHistory','status'].includes(field))assert.deepEqual(order[field],value);
        if(action==='reject'){assert.equal(order.credit,null);assert.deepEqual(order.creditHistory.slice(0,-1),creditOrder(original).creditHistory);}else assert.deepEqual(order.creditHistory,creditOrder(original).creditHistory);
        for(const field of ['rooms','inventory','consumables','ledger','user','clock','permissions','capabilities','administrator'])assert.deepEqual(actual.head.state[field],original[field]);
        assert.deepEqual(actual.head.state.orders[0],original.orders[0]);assert.equal(actual.head.state.orders[0].room,null);
        assert.equal(actual.head.state.inventory.qd.count,null);assert.equal(actual.head.state.inventory.bw.count,0);
        assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);assert.equal(actual.operations[0].actor_principal_id,login.principalId);
        assert.deepEqual(actual.operations[0].terminal_result,result);assert.equal(actual.audit[0].actor_principal_id,login.principalId);
        const orderOfCalls=[run.calls.findIndex(c=>c.kind==='begin'),sqlAt(run,'ledger_heads','FOR UPDATE'),sqlAt(run,'auth_accounts','FOR UPDATE'),
          sqlAt(run,'auth_sessions','FOR UPDATE'),sqlAt(run,'auth_grants','FOR UPDATE'),sqlAt(run,'auth_policy_attributes','FOR UPDATE'),
          sqlAt(run,'AS db_now','SELECT'),sqlAt(run,'ledger_operations','SELECT'),run.calls.findIndex(c=>c.kind==='transact'),
          sqlAt(run,'ledger_heads','UPDATE'),sqlAt(run,'ledger_operations','INSERT'),sqlAt(run,'ledger_success_audit','INSERT'),run.calls.findIndex(c=>c.kind==='commit')];
        assert.ok(orderOfCalls.every(i=>i>=0));assert.deepEqual(orderOfCalls,[...orderOfCalls].sort((a,b)=>a-b));assert.equal(borrows,1);
        assert.equal(run.calls.filter(c=>c.kind==='db-now').length,1);assert.equal(run.calls.filter(c=>c.kind==='begin').length,1);assert.equal(run.calls.filter(c=>c.kind==='commit').length,1);
        assert.equal(run.context().policyAttributesConfigured,true);assert.deepEqual(run.context().policyAttributeIds,[boss]);assert.equal(sqlAt(run,'employees','FOR SHARE'),-1);
        const [[after]]=await pool.execute('SELECT last_seen_at,idle_expires_at FROM '+table('auth_sessions')+' WHERE session_id=?',[login.sessionId]);assert.deepEqual(after,activity);
      }finally{try{await connection.rollback();}finally{connection.release();}}
    });

    await t.test('credit '+action+': <=1000 accepts manager OR boss; >1000 manager only denied, boss succeeds',async()=>{
      for(const amount of [99999,100000,100001])for(const attribute of [manager,boss]){
        const login=await reviewer(attribute),id='credit-review-tier-'+action+'-'+amount+'-'+attribute,run=runFor(id);
        await seedFor(id,'independent-synthetic-applicant',amount);const before=await inspect(id),cmd=creditReviewCommand(action);
        if(amount>100000&&attribute===manager){
          await assert.rejects(run.app.execute(cmd,login.credential),e=>denied(e)&&e.reason==='missing-policy-attribute');await assertUnchanged(id,before);
          await grant(login,boss);
        }
        assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');assert.equal(creditDecision((await inspect(id)).head.state,action).approver,amount>100000?'老板':'店长');
      }
    });

    await t.test('credit '+action+': self-review needs credit.approve plus review.self and valid tier; key survives denial',async()=>{
      for(const amount of [100000,100001]){
        const login=await reviewer(),id='credit-review-self-'+action+'-'+amount;await seedFor(id,login.principalId,amount);
        const run=runFor(id),before=await inspect(id),cmd=creditReviewCommand(action);await assert.rejects(run.app.execute(cmd,login.credential),denied);await assertUnchanged(id,before);
        await auth.grantPermission({principalId:login.principalId,permissionId:'review.self'});assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');
        assert.equal(creditDecision((await inspect(id)).head.state,action).selfReviewAuthorized,true);
      }
    });

    await t.test('credit '+action+': review.self, backend or boss cannot replace credit.approve',async()=>{
      let index=0;for(const permissions of [[],['backend.view','review.self'],['credit.apply']]){
        const login=await provision(permissions);await configure(login);await grant(login);const id='credit-review-base-'+action+'-'+(++index);await seedFor(id,login.principalId);
        const before=await inspect(id);await assert.rejects(runFor(id).app.execute(creditReviewCommand(action,'base',0,forged),login.credential),e=>denied(e)&&e.reason==='missing-permission');await assertUnchanged(id,before);
      }
    });

    await t.test('credit '+action+': unconfigured, empty and unrelated attributes deny both tiers and leave key unused',async()=>{
      for(const amount of [100000,100001])for(const kind of ['unconfigured','empty','unrelated']){
        const login=await provision(['credit.approve']);if(kind!=='unconfigured')await configure(login);if(kind==='unrelated')await grant(login,'expense.approval.boss');
        const id='credit-review-config-'+action+'-'+amount+'-'+kind;await seedFor(id,'independent-synthetic-applicant',amount);const run=runFor(id),cmd=creditReviewCommand(action),before=await inspect(id);
        await assert.rejects(run.app.execute(cmd,login.credential),e=>denied(e)&&e.reason===(kind==='unconfigured'?'policy-attributes-unconfigured':'missing-policy-attribute'));await assertUnchanged(id,before);
        if(kind==='unconfigured')await configure(login);await grant(login);assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');
      }
    });

    await t.test('credit '+action+': spoofed applicant, role, selfReview, attributes and amount never authorize from payload/demo state',async()=>{
      const login=await reviewer(manager),id='credit-review-forged-'+action;await seedFor(id,login.principalId,100001,s=>{s.user='boss';s.clock='1900-01-01';});
      const run=runFor(id),cmd=creditReviewCommand(action,'forged',0,forged),before=await inspect(id);
      await assert.rejects(run.app.execute(cmd,login.credential),denied);await assertUnchanged(id,before);
      await auth.grantPermission({principalId:login.principalId,permissionId:'review.self'});
      await assert.rejects(run.app.execute(cmd,login.credential),e=>denied(e)&&e.reason==='missing-policy-attribute');await assertUnchanged(id,before);
      await grant(login,boss);assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');const row=creditDecision((await inspect(id)).head.state,action);
      assert.equal(row.submittedByPrincipalId,login.principalId);assert.equal(row.decidedByPrincipalId,login.principalId);assert.equal(row.selfReviewAuthorized,true);
      assert.equal(row.amount,100001);assert.equal(row.approver,'老板');assert.equal(row.decisionBy,null);
    });

    await t.test('credit '+action+': legacy applicant cannot be inferred from person, demo ID or approver routing level',async()=>{
      const login=await reviewer();let index=0;
      for(const value of [undefined,null,'',' ',123]){
        const id='credit-review-legacy-'+action+'-'+(++index);await seedFor(id,'placeholder',100001,s=>{
          if(value===undefined)delete creditOrder(s).credit.submittedByPrincipalId;else creditOrder(s).credit.submittedByPrincipalId=value;
          s.user='boss';creditOrder(s).credit.submittedById='boss';creditOrder(s).credit.person='老板';
        });const before=await inspect(id);await assert.rejects(runFor(id).app.execute(creditReviewCommand(action,'legacy',0,{...forged,submittedByPrincipalId:login.principalId}),login.credential),
          e=>denied(e)&&e.reason==='untrusted-credit-applicant');await assertUnchanged(id,before);
      }
    });

    await t.test('credit '+action+': revoke permission or manager/boss attribute then reconnect replays old terminal; new pending key denied then reusable',async()=>{
      for(const kind of ['permission','manager','boss']){
        const attribute=kind==='manager'?manager:boss,amount=kind==='manager'?100000:100001,login=await reviewer(attribute),id='credit-review-replay-'+action+'-'+kind;
        await seedFor(id,'independent-synthetic-applicant',amount,secondPending);const cmd=creditReviewCommand(action),first=await runFor(id).app.execute(cmd,login.credential);
        if(kind==='permission')await auth.revokePermission({principalId:login.principalId,permissionId:'credit.approve'});else await revoke(login,attribute);
        const before=await inspect(id),reconnect=mysql.createPool(poolOptions);
        try{
          const again=runFor(id,{connectionPool:reconnect,bind:createMySqlAuthStore({pool:reconnect,database}).bindSessionRevalidation,
            transactCommand:(...args)=>{if(args[3]==='decision')assert.fail('Saved credit decision executed again');return transact(...args);}});
          assert.deepEqual(await again.app.execute(cmd,login.credential),first);assert.equal(again.executions(),0);
          const fresh=creditReviewCommand(action,'new',1,{order:'second-credit-order'});await assert.rejects(again.app.execute(fresh,login.credential),denied);await assertUnchanged(id,before);
          if(kind==='permission')await auth.grantPermission({principalId:login.principalId,permissionId:'credit.approve'});else await grant(login,attribute);
          assert.equal((await again.app.execute(fresh,login.credential)).status,'committed');const actual=await inspect(id);assert.equal(actual.head.revision,2);assert.equal(actual.operations.length,2);assert.equal(actual.audit.length,2);
        }finally{await reconnect.end();}
      }
    });

    await t.test('credit '+action+': disabled/revoked/expired/version-invalid auth rejects saved decision before operation lookup',async()=>{
      for(const invalid of ['disabled','revoked','idle','absolute','version']){
        const login=await reviewer(),id='credit-review-auth-'+action+'-'+invalid;await seedFor(id,'independent-synthetic-applicant');const run=runFor(id),cmd=creditReviewCommand(action);
        await run.app.execute(cmd,login.credential);const before=await inspect(id);
        if(invalid==='disabled')await auth.disableAccount({principalId:login.principalId});else if(invalid==='revoked')await auth.logout(login.token);
        else if(invalid==='version')await auth.rotateCredential({principalId:login.principalId,password:'synthetic-credit-review-rotation'});
        else if(invalid==='idle')await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at WHERE session_id=?',[login.sessionId]);
        else await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at,absolute_expires_at=created_at+INTERVAL 1 MICROSECOND WHERE session_id=?',[login.sessionId]);
        run.calls.length=0;await assert.rejects(run.app.execute(cmd,login.credential),e=>e.code==='AUTHENTICATION_REQUIRED');assert.equal(sqlAt(run,'ledger_operations','SELECT'),-1);await assertUnchanged(id,before);
      }
    });

    await t.test('credit '+action+': actor/action/payload/revision conflicts precede current permission and attribute after revoke',async()=>{
      const login=await reviewer(),other=await provision([]),id='credit-review-conflicts-'+action;await seedFor(id,'independent-synthetic-applicant');
      const run=runFor(id),cmd=creditReviewCommand(action);await run.app.execute(cmd,login.credential);const before=await inspect(id);
      await auth.revokePermission({principalId:login.principalId,permissionId:'credit.approve'});await revoke(login);
      const actor=await run.app.execute(cmd,other.credential);assert.equal(actor.status,'idempotency-conflict');assert.equal(actor.reason,'actor-mismatch');
      for(const changed of [{...cmd,expectedRevision:1},{...cmd,action:action==='approve'?'reject':'approve'},{...cmd,payload:{order:'other-order'}}]){
        const result=await run.app.execute(changed,login.credential);assert.equal(result.status,'idempotency-conflict');assert.equal(result.reason,'request-mismatch');
      }assert.equal(run.executions(),1);await assertUnchanged(id,before);
    });

    await t.test('credit '+action+': missing/processed order stays original business terminal without partial decision',async()=>{
      const login=await reviewer();let index=0;
      for(const c of [{payload:{order:'missing'}},{status:'已挂账'},{status:'营业中'}]){
        const id='credit-review-business-'+action+'-'+(++index),original=await seedFor(id,'independent-synthetic-applicant',100001,s=>{if(c.status)creditOrder(s).status=c.status;});
        const run=runFor(id),cmd=creditReviewCommand(action,'business',0,c.payload),result=await run.app.execute(cmd,login.credential),actual=await inspect(id);
        assert.equal(result.status,'business-rejected');assert.deepEqual(actual.head.state,original);assert.equal(actual.head.revision,0);assert.equal(actual.audit.length,0);assert.equal(actual.operations.length,1);
        await auth.revokePermission({principalId:login.principalId,permissionId:'credit.approve'});await revoke(login);
        assert.deepEqual(await run.app.execute(cmd,login.credential),result);await assertUnchanged(id,actual);
        await auth.grantPermission({principalId:login.principalId,permissionId:'credit.approve'});await grant(login);
      }
    });

    await t.test('credit '+action+': stale revision remains terminal after a decision and permission/attribute revoke',async()=>{
      const login=await reviewer(),id='credit-review-stale-'+action;await seedFor(id,'independent-synthetic-applicant');const run=runFor(id),cmd=creditReviewCommand(action,'stale',9);
      const first=await run.app.execute(cmd,login.credential);assert.equal(first.status,'revision-conflict');assert.equal(run.executions(),0);
      await run.app.execute(creditReviewCommand(action,'valid'),login.credential);const before=await inspect(id);
      await auth.revokePermission({principalId:login.principalId,permissionId:'credit.approve'});await revoke(login);
      assert.deepEqual(await run.app.execute(cmd,login.credential),first);await assertUnchanged(id,before);
    });

    for(const fault of ['unknown','sql'])await t.test('credit '+action+': '+fault+' failure rolls back decision/history/state/revision/result/audit; original key retries',async()=>{
      const login=await reviewer(),id='credit-review-fault-'+action+'-'+fault;await seedFor(id,'independent-synthetic-applicant');const before=await inspect(id);let broken=true;
      const run=runFor(id,{transactCommand:(...args)=>{const next=transact(...args);if(fault==='unknown'&&broken)throw Error('synthetic credit review fault');return next;}}),cmd=creditReviewCommand(action);
      if(fault==='sql')await setup.query('ALTER TABLE '+table('ledger_success_audit')+" ADD CONSTRAINT chk_credit_review_fault CHECK (ledger_id <> '"+id+"')");
      try{
        await assert.rejects(run.app.execute(cmd,login.credential),e=>fault==='unknown'?e.message==='synthetic credit review fault':e.code==='ER_CHECK_CONSTRAINT_VIOLATED');
        assert.ok(run.calls.some(c=>c.kind==='rollback'));if(fault==='sql'){assert.ok(sqlAt(run,'ledger_heads','UPDATE')>=0);assert.ok(sqlAt(run,'ledger_operations','INSERT')>=0);}await assertUnchanged(id,before);
      }finally{if(fault==='sql')await setup.query('ALTER TABLE '+table('ledger_success_audit')+' DROP CHECK chk_credit_review_fault');}
      broken=false;assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');const actual=await inspect(id);
      assert.equal(actual.head.revision,1);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);assert.equal(creditDecision(actual.head.state,action).decidedByPrincipalId,login.principalId);
    });

    await t.test('credit '+action+': two independent connections with same key commit one decision and audit',async()=>{
      const login=await reviewer(),id='credit-review-key-race-'+action;await seedFor(id,'independent-synthetic-applicant');const a=await pool.getConnection(),b=await pool.getConnection();
      try{
        const [[aId]]=await a.query('SELECT CONNECTION_ID() AS id'),[[bId]]=await b.query('SELECT CONNECTION_ID() AS id');assert.notEqual(aId.id,bId.id);
        await a.query('SET SESSION innodb_lock_wait_timeout=5');await b.query('SET SESSION innodb_lock_wait_timeout=5');
        const first=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(a,[],false)}}),second=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(b,[],false)}});
        const cmd=creditReviewCommand(action),results=await Promise.all([first.app.execute(cmd,login.credential),second.app.execute(cmd,login.credential)]);
        assert.deepEqual(results[0],results[1]);assert.equal(first.executions()+second.executions(),1);const actual=await inspect(id);
        assert.equal(actual.head.revision,1);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);
        t.diagnostic('credit '+action+' same-key race verified two independent CONNECTION_ID values');
      }finally{try{await a.rollback();await b.rollback();}finally{a.release();b.release();}}
    });
  }

  await t.test('credit decisions: two real connections and two principals compete approve/reject at the same old revision',async()=>{
    const aLogin=await reviewer(),bLogin=await reviewer(),id='credit-review-revision-race';await seedFor(id,'independent-synthetic-applicant');
    const a=await pool.getConnection(),b=await pool.getConnection();
    try{
      const [[aId]]=await a.query('SELECT CONNECTION_ID() AS id'),[[bId]]=await b.query('SELECT CONNECTION_ID() AS id');assert.notEqual(aId.id,bId.id);
      await a.query('SET SESSION innodb_lock_wait_timeout=5');await b.query('SET SESSION innodb_lock_wait_timeout=5');
      const first=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(a,[],false)}}),second=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(b,[],false)}});
      const results=await Promise.all([first.app.execute(creditReviewCommand('approve','approve'),aLogin.credential),second.app.execute(creditReviewCommand('reject','reject'),bLogin.credential)]);
      assert.deepEqual(results.map(r=>r.status).sort(),['committed','revision-conflict']);assert.equal(first.executions()+second.executions(),1);
      const actual=await inspect(id),approved=results[0].status==='committed',action=approved?'approve':'reject';
      assert.equal(creditOrder(actual.head.state).status,approved?'已挂账':'营业中');assert.equal(creditDecision(actual.head.state,action).decidedByPrincipalId,approved?aLogin.principalId:bLogin.principalId);
      assert.equal(actual.head.revision,1);assert.equal(actual.operations.length,2);assert.equal(actual.audit.length,1);
      t.diagnostic('credit approve/reject race verified two independent CONNECTION_ID values and two session principals');
    }finally{try{await a.rollback();await b.rollback();}finally{a.release();b.release();}}
  });

  await t.test('credit decisions: new trusted credit creation and decision use separate authenticated principals with original amount and routing',async()=>{
    for(const action of CREDIT_REVIEW_ACTIONS){
      const applicant=await provision(['credit.apply']),login=await reviewer(),id='credit-review-created-'+action;await seed(id,state=>seedTrustedCredit(state));
      const create=runFor(id),original=await create.app.execute(creditCommand('apply'),applicant.credential),pending=await inspect(id);
      assert.equal(creditOrder(pending.head.state).credit.submittedByPrincipalId,applicant.principalId);assert.equal(creditOrder(pending.head.state).credit.amount,104500);
      const run=runFor(id),result=await run.app.execute(creditReviewCommand(action,'decision',1),login.credential),actual=await inspect(id),row=creditDecision(actual.head.state,action);
      assert.equal(result.status,'committed');assert.equal(row.decidedByPrincipalId,login.principalId);assert.equal(row.submittedByPrincipalId,applicant.principalId);
      assert.equal(row.amount,104500);assert.equal(row.approver,'老板');assert.equal(row.remaining,104500);assert.deepEqual(actual.head.state.rooms,pending.head.state.rooms);
      assert.deepEqual(creditOrder(actual.head.state).payments,creditOrder(pending.head.state).payments);assert.equal(actual.head.revision,2);assert.equal(actual.operations.length,2);assert.equal(actual.audit.length,2);
      assert.deepEqual(await create.app.execute(creditCommand('apply'),applicant.credential),original);assert.equal((await inspect(id)).head.revision,2);
    }
  });
}
