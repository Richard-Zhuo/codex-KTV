import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { transact } from '../rules.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createPolicyAttributeService } from '../auth/policy-attributes.js';
import { createTrustedLedgerApplication } from './application.js';
import { createMySqlLedgerStore } from './mysql-store.js';
import { settleCommand, roundingCommand, seedPendingRounding, seedTrustedPayments, paymentOrder } from '../test-support/trusted-rounding-fixture.js';
import { outstanding, PAYMENT_METHODS } from '../sales.js';
import { reportPeriodMatch } from '../reporting.js';
const denied = error => error instanceof AuthorizationDenied && error.status === 'authorization-denied';
const sqlAt = (run,name,verb) => run.calls.findIndex(c=>c.kind==='sql'&&c.sql.includes(name)&&(verb.startsWith('FOR ')?c.sql.endsWith(verb):c.sql.startsWith(verb+' ')));
const actions = ['settle','approveRounding','rejectRounding'];
const grants = action => action==='settle'?['payment.settle']:['rounding.approve','review.self'];
const command = (action,key='first',revision=0,changes={}) => action==='settle'?settleCommand(key,revision,1001,changes):roundingCommand(action,key,revision,changes);
// Only the shared, strictly guarded jbhh_ktv_test fixture owns migrations and cleanup.
export async function testTrustedRounding({t,pool,setup,auth,table,provision,seed,inspect,application,assertUnchanged,wrapConnection,poolOptions,database}) {
  const authStore=createMySqlAuthStore({pool,database}),attributes=createPolicyAttributeService({store:authStore});
  const configure=login=>attributes.configurePolicyAttributes({principalId:login.principalId},{actorPrincipalId:login.principalId});
  const attribute=(login,method='grantPolicyAttribute')=>attributes[method]({principalId:login.principalId,attributeId:'rounding.self.excess'},{actorPrincipalId:login.principalId});
  const provisionFor=async action=>{const login=await provision(grants(action));if(action==='approveRounding'){await configure(login);await attribute(login);}return login;};
  const pending=(id,prepare=()=>{})=>seed(id,state=>{seedTrustedPayments(state);prepare(state);});
  const prepared=(action,login)=>action==='settle'?()=>{}:state=>seedPendingRounding(state,login.principalId);
  const runFor=(id,options={})=>application(id,{employeeBind:null,...options});
  const paymentFacts=(actual,original,login,dbNow,difference=1001,special=false)=>{
    const order=paymentOrder(actual.head.state),old=paymentOrder(original);
    assert.equal(actual.head.revision,1);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);
    assert.equal(actual.operations[0].actor_principal_id,login.principalId);assert.equal(actual.audit[0].actor_principal_id,login.principalId);
    const records=order.payments.slice(old.payments.length);assert.equal(records.length,2);
    assert.equal(new Set(records.map(p=>p.paymentId)).size,2);
    for(const p of records){assert.match(p.paymentId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(p.occurredAt,dbNow);assert.equal(p.time,dbNow);assert.equal(p.recordedByPrincipalId,login.principalId);assert.equal(p.person,null);assert.equal(p.chargeId,'settlement');}
    assert.deepEqual(order.payments.slice(0,old.payments.length),old.payments);assert.equal(order.rounding,difference);
    assert.equal(Boolean(order.roundingReview),special||difference>1000);
    if(order.roundingReview){assert.equal(order.roundingReview.status,'待审核');assert.equal(order.roundingReview.submittedByPrincipalId,login.principalId);
      assert.equal(order.roundingReview.submittedAt,dbNow);assert.equal(order.roundingReview.submittedBy,null);assert.equal(order.roundingReview.submittedById,'');}
    assert.equal(order.status,'已结账');assert.equal(order.closedAt,dbNow);assert.equal(actual.head.state.rooms[0].status,'待清洁');assert.equal(actual.head.state.rooms[0].order,null);
    assert.equal(outstanding(order),difference); // K06 stays, including approved waivers; K01 closed/pending stays.
    for(const key of ['inventory','consumables','ledger','catalog','serial','user','clock','permissions','capabilities','administrator','reservations','deposits','expenses','procurements','incidents','handovers'])assert.deepEqual(actual.head.state[key],original[key]);
    for(const key of ['sales','otherCharges','time','createdAt','packageNameSnapshot','packagePriceCents','employeeId'])assert.deepEqual(order[key],old[key]);
    assert.deepEqual(actual.head.state.orders[0],original.orders[0]);assert.equal(actual.head.state.orders[0].room,null);
    assert.equal(actual.head.state.inventory.qd.count,null);assert.equal(actual.head.state.inventory.bw.count,0);return records;
  };
  const decisionFacts=(actual,original,login,dbNow,action)=>{
    const order=paymentOrder(actual.head.state),review=order.roundingReview;
    assert.equal(review.status,action==='approveRounding'?'已批准':'已驳回');assert.equal(review.decidedByPrincipalId,login.principalId);
    assert.equal(review.decidedAt,dbNow);assert.equal(review.decidedBy,null);
    assert.equal(review.selfReviewAuthorized,review.submittedByPrincipalId===login.principalId);
    const withoutReview=state=>{const copy=structuredClone(state);delete paymentOrder(copy).roundingReview;delete copy.processed;return copy;};
    assert.deepEqual(withoutReview(actual.head.state),withoutReview(original));
    assert.deepEqual(actual.head.state.processed.slice(0,original.processed.length),original.processed);
    assert.equal(actual.head.state.processed.length,original.processed.length+1);
    assert.equal(actual.head.revision,1);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);
  };

  await t.test('settle trusted: one borrowed connection freezes DB time and commits payment/review/order/room/revision/result/audit; identity forgery has no effect',async()=>{
    const login=await provisionFor('settle'),id='rounding-settle-first',original=await pending(id),connection=await pool.getConnection();let borrows=0;
    const [[activity]]=await pool.execute('SELECT last_seen_at,idle_expires_at FROM '+table('auth_sessions')+' WHERE session_id=?',[login.sessionId]);
    try{
      const run=runFor(id,{connectionPool:{getConnection:async()=>{borrows++;return wrapConnection(connection,[],false);}}});
      const cmd=settleCommand('first',0,1001,{actorId:'administrator',principalId:'fake',person:'Fake',permissions:['*'],role:'老板',clock:'1900',
        submittedByPrincipalId:'fake',roundingReview:{submittedByPrincipalId:'fake'}});
      cmd.payload.payments=cmd.payload.payments.map(p=>({...p,paymentId:'fake',occurredAt:'1900',recordedByPrincipalId:'fake',time:'1900',person:'Fake'}));
      const result=await run.app.execute(cmd,login.credential),actual=await inspect(id);
      assert.equal(result.status,'committed');paymentFacts(actual,original,login,run.context().dbNow);
      assert.deepEqual(actual.operations[0].terminal_result,result);assert.equal(borrows,1);
      const order=[run.calls.findIndex(c=>c.kind==='begin'),sqlAt(run,'ledger_heads','FOR UPDATE'),sqlAt(run,'auth_accounts','FOR UPDATE'),
        sqlAt(run,'auth_sessions','FOR UPDATE'),sqlAt(run,'auth_grants','FOR UPDATE'),sqlAt(run,'AS db_now','SELECT'),sqlAt(run,'ledger_operations','SELECT'),
        run.calls.findIndex(c=>c.kind==='transact'),sqlAt(run,'ledger_heads','UPDATE'),sqlAt(run,'ledger_operations','INSERT'),sqlAt(run,'ledger_success_audit','INSERT'),run.calls.findIndex(c=>c.kind==='commit')];
      assert.ok(order.every((v,i)=>v>=0&&(!i||v>order[i-1])));assert.equal(run.calls.filter(c=>c.kind==='db-now').length,1);assert.equal(sqlAt(run,'employees','SELECT'),-1);
      const [[after]]=await pool.execute('SELECT last_seen_at,idle_expires_at FROM '+table('auth_sessions')+' WHERE session_id=?',[login.sessionId]);assert.deepEqual(after,activity);
      assert.equal(reportPeriodMatch(paymentOrder(actual.head.state),run.context().dbNow,'day'),false);assert.equal(Object.hasOwn(paymentOrder(actual.head.state),'businessDate'),false);
    }finally{await connection.rollback();connection.release();}
  });
  for(const difference of [0,500,999,1000,1001])await t.test('settle trusted: MySQL ordinary '+difference+' cents boundary, K01/K06 unchanged',async()=>{
    const login=await provisionFor('settle'),id='rounding-boundary-'+difference,original=await pending(id),run=runFor(id);
    await run.app.execute(settleCommand('boundary',0,difference),login.credential);paymentFacts(await inspect(id),original,login,run.context().dbNow,difference);
  });
  for(const difference of [999,1000,1001])await t.test('settle trusted: special '+difference+' cents remains pending with note',async()=>{
    const login=await provisionFor('settle'),id='rounding-special-'+difference,original=await pending(id),run=runFor(id);
    await run.app.execute(settleCommand('special',0,difference,{differenceType:'特殊情况',differenceNote:'Synthetic special note'}),login.credential);
    paymentFacts(await inspect(id),original,login,run.context().dbNow,difference,true);
  });
  await t.test('settle trusted: all original channels, amount/note/gift failures and zero balance retain domain rules',async()=>{
    const login=await provisionFor('settle');
    for(const [index,method]of PAYMENT_METHODS.entries()){
      const id='rounding-channel-'+index;await pending(id);const run=runFor(id);await run.app.execute(settleCommand('channel',0,1000,{payments:[{method,amount:20200}]}),login.credential);
      const order=paymentOrder((await inspect(id)).head.state);assert.equal(order.payments[1].method,method);assert.equal(order.payments[1].amount,20200);assert.equal(order.roundingReview,null);
    }
    const cases=[{payments:[]},{payments:[{method:'现金',amount:21201}]},{payments:[{method:'银行卡',amount:20200}]},{differenceType:'特殊情况',differenceNote:''},{differenceType:'invalid'}];
    for(const [index,changes]of cases.entries()){
      const id='rounding-invalid-'+index,original=await pending(id),run=runFor(id),cmd=settleCommand('invalid',0,1001,changes);
      const result=await run.app.execute(cmd,login.credential),actual=await inspect(id);assert.equal(result.status,'business-rejected');
      assert.deepEqual(actual.head.state,original);assert.equal(actual.head.revision,0);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,0);
      assert.deepEqual(await run.app.execute(cmd,login.credential),result);await assertUnchanged(id,actual);
    }
    for(const [index,mutation]of [s=>paymentOrder(s).giftRequests.push({status:'待确认'}),s=>paymentOrder(s).status='已结账'].entries()){
      const id='rounding-state-'+index,original=await pending(id,mutation),run=runFor(id);
      assert.equal((await run.app.execute(settleCommand(),login.credential)).status,'business-rejected');assert.deepEqual((await inspect(id)).head.state,original);
    }
    const id='rounding-zero',original=await pending(id,s=>paymentOrder(s).payments.push({method:'现金',amount:21200})),run=runFor(id);
    await run.app.execute(settleCommand('zero',0,1001,{payments:[]}),login.credential);const order=paymentOrder((await inspect(id)).head.state);
    assert.deepEqual(order.payments,paymentOrder(original).payments);assert.equal(order.rounding,0);assert.equal(order.roundingReview,null);
  });
  const matrix=[
    ['approveRounding','self without review.self',['rounding.approve'],['rounding.self.excess'],true,1001,false],
    ['approveRounding','attribute without approve',['review.self'],['rounding.self.excess'],true,1001,false],
    ['approveRounding','unconfigured self excess',['rounding.approve','review.self'],null,true,1001,false],
    ['approveRounding','configured empty self excess',['rounding.approve','review.self'],[],true,1001,false],
    ['approveRounding','self three grants',['rounding.approve','review.self'],['rounding.self.excess'],true,1001,true],
    ['approveRounding','foreign excess no attribute',['rounding.approve'],null,false,1001,true],
    ['approveRounding','self special 9.99 no attribute',['rounding.approve','review.self'],null,true,999,true],
    ['approveRounding','self special 10.00 empty attributes',['rounding.approve','review.self'],[],true,1000,true],
    ['rejectRounding','self without review.self',['rounding.approve'],['rounding.self.excess'],true,1001,false],
    ['rejectRounding','review.self without approve',['review.self'],['rounding.self.excess'],true,1001,false],
    ['rejectRounding','self excess no configured attributes',['rounding.approve','review.self'],null,true,1001,true],
    ['rejectRounding','self excess empty attributes',['rounding.approve','review.self'],[],true,1001,true],
    ['rejectRounding','foreign no attributes',['rounding.approve'],null,false,1001,true]
  ];
  for(const [index,[action,label,permissions,attrs,self,amount,allowed]]of matrix.entries())await t.test(action+' trusted: '+label+' from locked state, forged applicant/amount/role/attributes ignored',async()=>{
    const login=await provision(permissions),applicant=self?login:await provision([]),id='rounding-matrix-'+index;
    if(attrs!==null){await configure(login);if(attrs.length)await attribute(login);}
    const original=await pending(id,s=>seedPendingRounding(s,applicant.principalId,amount,amount<=1000?'特殊情况':'免零'));
    const before=await inspect(id),run=runFor(id),cmd=roundingCommand(action,'matrix',0,{submittedByPrincipalId:'fake',submittedBy:'fake',applicant:'fake',selfReview:false,
      actorId:'fake',principalId:'fake',approver:'老板',role:'老板',permissions:['*'],attributes:['rounding.self.excess'],policyAttributes:['rounding.self.excess'],amount:1,rounding:1,clock:'1900'});
    if(!allowed){await assert.rejects(run.app.execute(cmd,login.credential),denied);await assertUnchanged(id,before);return;}
    assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');decisionFacts(await inspect(id),original,login,run.context().dbNow,action);
  });
  for(const action of ['approveRounding','rejectRounding'])await t.test(action+' trusted: legacy applicant and ambiguous waiver fail closed without terminal or audit',async()=>{
    const login=await provisionFor(action);
    const mutations=[r=>delete r.submittedByPrincipalId,r=>r.submittedByPrincipalId='',r=>r.amount=null,r=>r.amount=1.5,r=>r.amount=1000];
    for(const [index,mutation]of mutations.entries()){
      const id='rounding-legacy-'+action+'-'+index;await pending(id,s=>{seedPendingRounding(s,login.principalId);mutation(paymentOrder(s).roundingReview);});
      const before=await inspect(id);await assert.rejects(runFor(id).app.execute(roundingCommand(action),login.credential),denied);await assertUnchanged(id,before);
    }
  });
  await t.test('settle then approve: a real newly submitted principal review is decided with current DB excess attribute; only one payment batch',async()=>{
    const login=await provision(['payment.settle','rounding.approve','review.self']);await configure(login);await attribute(login);
    const id='rounding-vertical';await pending(id);const run=runFor(id);await run.app.execute(settleCommand(),login.credential);
    const paid=await inspect(id);await run.app.execute(roundingCommand('approveRounding','approve',1),login.credential);const actual=await inspect(id),order=paymentOrder(actual.head.state);
    assert.equal(actual.head.revision,2);assert.equal(actual.operations.length,2);assert.equal(actual.audit.length,2);
    assert.equal(order.roundingReview.submittedByPrincipalId,login.principalId);assert.equal(order.roundingReview.decidedByPrincipalId,login.principalId);
    assert.deepEqual(order.payments,paymentOrder(paid.head.state).payments);assert.equal(outstanding(order),1001);assert.deepEqual(actual.head.state.rooms,paid.head.state.rooms);
  });

  for(const action of actions){
    await t.test(action+' trusted: authorization denial leaves key reusable after exact grant/configuration',async()=>{
      const login=await provision(['backend.view']),id='rounding-denied-'+action;await pending(id,prepared(action,login));const before=await inspect(id),run=runFor(id),cmd=command(action);
      await assert.rejects(run.app.execute(cmd,login.credential),denied);await assertUnchanged(id,before);
      for(const permissionId of grants(action))await auth.grantPermission({principalId:login.principalId,permissionId});
      if(action==='approveRounding'){await assert.rejects(run.app.execute(cmd,login.credential),denied);await assertUnchanged(id,before);await configure(login);await attribute(login);}
      assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');assert.equal((await inspect(id)).operations.length,1);
    });
    await t.test(action+' trusted: reconnect after revoke replays original result/IDs without transact; new key denied, actor and fingerprint conflicts unchanged',async()=>{
      const login=await provisionFor(action),other=await provision([]),id='rounding-reconnect-'+action;await pending(id,prepared(action,login));const run=runFor(id),cmd=command(action),first=await run.app.execute(cmd,login.credential);
      if(action==='approveRounding')await attribute(login,'revokePolicyAttribute');else await auth.revokePermission({principalId:login.principalId,permissionId:grants(action)[0]});
      const before=await inspect(id),reconnect=mysql.createPool(poolOptions);
      try{
        const reconnectAuth=createMySqlAuthStore({pool:reconnect,database}),again=runFor(id,{connectionPool:reconnect,bind:reconnectAuth.bindSessionRevalidation,transactCommand:transact});
        assert.deepEqual(await again.app.execute(cmd,login.credential),first);assert.equal(again.executions(),0);await assert.rejects(again.app.execute(command(action,'new',1),login.credential),denied);
        const actor=await again.app.execute(cmd,other.credential);assert.equal(actor.status,'idempotency-conflict');assert.equal(actor.reason,'actor-mismatch');
        for(const changed of [{...cmd,expectedRevision:1},{...cmd,payload:{...cmd.payload,amount:1}},{...cmd,action:action==='settle'?'pay':'settle'}]){
          const conflict=await again.app.execute(changed,login.credential);assert.equal(conflict.status,'idempotency-conflict');assert.equal(conflict.reason,'request-mismatch');
        }
        assert.equal(again.executions(),action==='approveRounding'?1:0);await assertUnchanged(id,before);
      }finally{await reconnect.end();}
    });
    await t.test(action+' trusted: disabled/revoked/idle/absolute/version session cannot access stored terminal',async()=>{
      for(const state of ['disabled','revoked','idle','absolute','version']){
        const login=await provisionFor(action),id='rounding-auth-'+action+'-'+state;await pending(id,prepared(action,login));const run=runFor(id),cmd=command(action);
        await run.app.execute(cmd,login.credential);const before=await inspect(id);
        if(state==='disabled')await auth.disableAccount({principalId:login.principalId});else if(state==='revoked')await auth.logout(login.token);
        else if(state==='version')await auth.rotateCredential({principalId:login.principalId,password:'synthetic-rounding-rotated'});
        else if(state==='idle')await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at WHERE session_id=?',[login.sessionId]);
        else await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at,absolute_expires_at=created_at+INTERVAL 1 MICROSECOND WHERE session_id=?',[login.sessionId]);
        run.calls.length=0;await assert.rejects(run.app.execute(cmd,login.credential),e=>e.code==='AUTHENTICATION_REQUIRED');assert.equal(sqlAt(run,'ledger_operations','SELECT'),-1);await assertUnchanged(id,before);
      }
    });
    await t.test(action+' trusted: stale revision terminal never turns into later payment/decision',async()=>{
      const login=await provisionFor(action),id='rounding-stale-'+action;await pending(id,prepared(action,login));const run=runFor(id),cmd=command(action,'stale',1),terminal=await run.app.execute(cmd,login.credential);
      assert.equal(terminal.status,'revision-conflict');assert.equal(run.executions(),0);await run.app.execute(command(action,'advance'),login.credential);const before=await inspect(id);
      await auth.revokePermission({principalId:login.principalId,permissionId:grants(action)[0]});assert.deepEqual(await run.app.execute(cmd,login.credential),terminal);await assertUnchanged(id,before);
    });
    await t.test(action+' trusted: unknown failure after mutation rolls back all facts and key remains retryable',async()=>{
      const login=await provisionFor(action),id='rounding-unknown-'+action;await pending(id,prepared(action,login));const before=await inspect(id);let broken=true;
      const run=runFor(id,{transactCommand:(...args)=>{const next=transact(...args);if(broken)throw Error('synthetic rounding infrastructure failure');return next;}}),cmd=command(action);
      await assert.rejects(run.app.execute(cmd,login.credential),/synthetic rounding infrastructure failure/);await assertUnchanged(id,before);assert.ok(run.calls.some(c=>c.kind==='rollback'));
      broken=false;assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');assert.equal((await inspect(id)).head.revision,1);
    });
    for(const name of ['ledger_operations','ledger_success_audit'])await t.test(action+' trusted: real '+name+' SQL failure rolls state/revision/result/audit back after state UPDATE',async()=>{
      const login=await provisionFor(action),id='rounding-sql-'+action+'-'+(name==='ledger_operations'?'op':'audit');await pending(id,prepared(action,login));
      const before=await inspect(id),run=runFor(id),constraint='chk_rounding_slice_fault';
      await setup.query('ALTER TABLE '+table(name)+' ADD CONSTRAINT '+constraint+" CHECK (ledger_id <> '"+id+"')");
      try{
        await assert.rejects(run.app.execute(command(action),login.credential),e=>e.code==='ER_CHECK_CONSTRAINT_VIOLATED');
        assert.ok(sqlAt(run,'ledger_heads','UPDATE')>=0);assert.ok(run.calls.some(c=>c.kind==='rollback'));await assertUnchanged(id,before);
        if(name==='ledger_success_audit')assert.ok(sqlAt(run,'ledger_operations','INSERT')>=0);
      }finally{await setup.query('ALTER TABLE '+table(name)+' DROP CHECK '+constraint);}
      assert.equal((await run.app.execute(command(action),login.credential)).status,'committed');assert.equal((await inspect(id)).head.revision,1);
    });
    for(const sameKey of [false,true])await t.test(action+' trusted: two independent MySQL connections '+(sameKey?'replay same key once':'compete old revision once'),async()=>{
      const login=await provisionFor(action),id='rounding-race-'+action+'-'+sameKey,original=await pending(id,prepared(action,login));
      const a=await pool.getConnection(),b=await pool.getConnection();let unlock,signalLocked,timer,firstWork,secondWork;
      const held=new Promise(r=>unlock=r),locked=new Promise(r=>signalLocked=r);
      try{
        const [[aId]]=await a.query('SELECT CONNECTION_ID() AS id'),[[bId]]=await b.query('SELECT CONNECTION_ID() AS id');assert.notEqual(aId.id,bId.id);
        await a.query('SET SESSION innodb_lock_wait_timeout=5');await b.query('SET SESSION innodb_lock_wait_timeout=5');
        const bind=connection=>{const inner=authStore.bindSessionRevalidation(connection);return{async revalidateSessionInTransaction(credential){const context=await inner.revalidateSessionInTransaction(credential);signalLocked();await held;return context;}};};
        const first=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(a,[],false)},bind});
        const second=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(b,[],false)}});
        firstWork=first.app.execute(command(action,'first'),login.credential);
        await Promise.race([locked,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('rounding head lock timeout')),5000))]);clearTimeout(timer);
        let done=false;secondWork=second.app.execute(command(action,sameKey?'first':'second'),login.credential).finally(()=>done=true);
        await new Promise(r=>setTimeout(r,35));assert.equal(done,false);assert.ok(sqlAt(second,'ledger_heads','FOR UPDATE')>=0);assert.equal(sqlAt(second,'auth_accounts','FOR UPDATE'),-1);
        unlock();const results=await Promise.all([firstWork,secondWork]);
        if(sameKey)assert.deepEqual(results[0],results[1]);else assert.deepEqual(results.map(r=>r.status),['committed','revision-conflict']);
        const actual=await inspect(id);assert.equal(actual.head.revision,1);assert.equal(actual.audit.length,1);assert.equal(actual.operations.length,sameKey?1:2);assert.equal(first.executions()+second.executions(),1);
        if(action==='settle'){assert.equal(paymentOrder(actual.head.state).payments.length,paymentOrder(original).payments.length+2);assert.equal(paymentOrder(actual.head.state).roundingReview.status,'待审核');}
        else{assert.deepEqual(paymentOrder(actual.head.state).payments,paymentOrder(original).payments);assert.equal(paymentOrder(actual.head.state).roundingReview.status,action==='approveRounding'?'已批准':'已驳回');}
        t.diagnostic(action+' rounding race: independent CONNECTION_ID '+aId.id+' / '+bId.id+'; one business effect and one revision');
      }finally{clearTimeout(timer);unlock();await Promise.allSettled([firstWork,secondWork].filter(Boolean));try{await a.rollback();await b.rollback();}finally{a.release();b.release();}}
    });
  }
  await t.test('rounding trusted: competing approve/reject cannot create two terminal decisions even after refresh',async()=>{
    const login=await provisionFor('approveRounding'),id='rounding-opposite-decisions';await pending(id,prepared('approveRounding',login));
    const a=await pool.getConnection(),b=await pool.getConnection();
    try{
      const [[aId]]=await a.query('SELECT CONNECTION_ID() AS id'),[[bId]]=await b.query('SELECT CONNECTION_ID() AS id');assert.notEqual(aId.id,bId.id);
      const first=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(a,[],false)}}),second=runFor(id,{connectionPool:{getConnection:async()=>wrapConnection(b,[],false)}});
      const results=await Promise.all([first.app.execute(roundingCommand('approveRounding','approve'),login.credential),second.app.execute(roundingCommand('rejectRounding','reject'),login.credential)]);
      assert.deepEqual(results.map(r=>r.status).sort(),['committed','revision-conflict']);const before=await inspect(id);
      const losingAction=results[0].status==='committed'?'rejectRounding':'approveRounding';
      assert.equal((await second.app.execute(roundingCommand(losingAction,'new-after-refresh',1),login.credential)).status,'business-rejected');
      const actual=await inspect(id);assert.deepEqual(actual.head,before.head);assert.deepEqual(actual.audit,before.audit);
      assert.equal(actual.head.revision,1);assert.equal(actual.audit.length,1);t.diagnostic('opposite decisions: independent CONNECTION_ID '+aId.id+' / '+bId.id);
    }finally{await a.rollback();await b.rollback();a.release();b.release();}
  });
  await t.test('settle trusted: actual release TypeError cannot leave payment/review/closed-order or terminal',async()=>{
    const login=await provisionFor('settle'),id='rounding-release-fault';await pending(id);const before=await inspect(id),run=runFor(id,{transactCommand:(state,...args)=>transact({...state,rooms:{}},...args)});
    await assert.rejects(run.app.execute(settleCommand(),login.credential),TypeError);await assertUnchanged(id,before);assert.equal(sqlAt(run,'ledger_heads','UPDATE'),-1);
  });
  await t.test('rounding trusted: missing port/copied context fail closed, handover and open remain unenabled',async()=>{
    const login=await provision(['payment.settle','rounding.approve','review.self','handover','room.open']),id='rounding-fail-closed';await pending(id);const before=await inspect(id);
    const missing=createTrustedLedgerApplication({store:createMySqlLedgerStore({pool,ledgerId:id,database})});await assert.rejects(missing.execute(settleCommand(),login.credential),/revalidation port/);
    const fake=runFor(id,{bind:c=>{const inner=authStore.bindSessionRevalidation(c);return{revalidateSessionInTransaction:async credential=>({...await inner.revalidateSessionInTransaction(credential)})};}});
    await assert.rejects(fake.app.execute(settleCommand('copy'),login.credential),TypeError);
    for(const action of ['handover','open'])await assert.rejects(runFor(id).app.execute({...settleCommand(action),action},login.credential),e=>denied(e)&&e.reason==='trusted-action-not-enabled');await assertUnchanged(id,before);
  });
}
