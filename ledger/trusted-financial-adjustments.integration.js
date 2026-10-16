import assert from 'node:assert/strict';
import { transact } from '../rules.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { seedFinancialState, financialOrder, financialCommand, orderId, paymentId, actorGrants } from '../test-support/financial-adjustments-fixture.js';
import { orderPaymentCredit, netReceipts, adjustablePaymentBalance } from '../financial-adjustments.js';

// Runs only inside the existing guarded owned MySQL/auth/ledger fixture.
export async function testTrustedFinancialAdjustments({ t, pool, table, provision, seed, inspect, application, wrapConnection, assertUnchanged, auth }) {
  const owner = await provision([...actorGrants,'financial.direct','financial.approve']);
  const applicant = await provision([...actorGrants,'financial.approve','review.self']);
  const reviewer = await provision(['financial.approve',...actorGrants]);
  const pending = id => seed(id,seedFinancialState);
  const cmd = (action,key,revision,changes={}) => financialCommand(action,key,revision,changes);
  const decide = (action,key,revision,requestId) => ({action,operationKey:key,expectedRevision:revision,payload:{requestId,decisionNote:'现场核对'}});
  const execute = (action,key,revision,requestId) => ({action,operationKey:key,expectedRevision:revision,payload:{order:orderId,requestId}});
  const denied = e => e instanceof AuthorizationDenied;

  for(const action of ['refundPayment','reversePayment']) await t.test('C1-A SQL '+action+': atomic facts/result/audit, reconnect replay and original preservation',async()=>{
    const id='c1a-direct-'+action,original=await pending(id),run=application(id,{employeeBind:null}),request=cmd(action,'direct',0);
    const result=await run.app.execute(request,owner.credential),actual=await inspect(id),o=financialOrder(actual.head.state),a=o.financialAdjustments[0];
    assert.equal(result.status,'committed');assert.equal(actual.head.revision,1);
    assert.deepEqual(o.payments,financialOrder(original).payments);assert.deepEqual(actual.head.state.rooms,original.rooms);
    assert.deepEqual(actual.head.state.inventory,original.inventory);assert.deepEqual(actual.head.state.handovers,original.handovers);
    assert.equal(a.actualActorPrincipalId,owner.principalId);assert.equal(a.occurredAt,run.context().dbNow);
    assert.equal(actual.audit.length,1);assert.equal(actual.audit[0].actor_principal_id,owner.principalId);
    assert.deepEqual(actual.operations[0].terminal_result,result);
    assert.deepEqual(await application(id,{employeeBind:null}).app.execute(request,owner.credential),result);
    assert.equal((await inspect(id)).head.revision,1);
    assert.equal(orderPaymentCredit(o),action==='refundPayment'?10000:0);
    assert.equal(netReceipts(o),action==='refundPayment'?7000:0);
    assert.equal((await run.app.execute(cmd(action,'duplicate-new',1,{amount:action==='refundPayment'?8000:10000}),owner.credential)).status,'business-rejected');
  });
  for(const action of ['refundPayment','reversePayment']) await t.test('C1-A SQL '+action+': approval is not execution, original applicant consumes once',async()=>{
    const id='c1a-approval-'+action;await pending(id);const run=application(id,{employeeBind:null});
    await run.app.execute(cmd(action,'submit',0),applicant.credential);
    let actual=await inspect(id),r=actual.head.state.financialRequests[0];
    assert.equal(financialOrder(actual.head.state).financialAdjustments,undefined);
    await assert.rejects(run.app.execute(decide('approveFinancialAdjustment','self',1,r.requestId),applicant.credential),denied);
    assert.equal((await run.app.execute(execute(action,'early',1,r.requestId),applicant.credential)).status,'business-rejected');
    const approved=decide('approveFinancialAdjustment','approve',1,r.requestId);
    const result=await run.app.execute(approved,reviewer.credential);
    assert.equal(result.status,'committed');assert.deepEqual(await run.app.execute(approved,reviewer.credential),result);
    actual=await inspect(id);assert.equal(financialOrder(actual.head.state).financialAdjustments,undefined);
    await assert.rejects(run.app.execute(execute(action,'reviewer-exec',2,r.requestId),reviewer.credential),denied);
    assert.equal((await run.app.execute(execute(action,'execute',2,r.requestId),applicant.credential)).status,'committed');
    actual=await inspect(id);r=actual.head.state.financialRequests[0];
    assert.equal(r.status,'已执行');assert.equal(r.decidedByPrincipalId,reviewer.principalId);
    assert.equal(financialOrder(actual.head.state).financialAdjustments[0].actualActorPrincipalId,applicant.principalId);
    assert.equal((await run.app.execute(execute(action,'new-key',3,r.requestId),applicant.credential)).status,'business-rejected');
    assert.equal(financialOrder((await inspect(id)).head.state).financialAdjustments.length,1);
  });
  await t.test('C1-A SQL reservations block direct operations and rejection releases them',async()=>{
    const id='c1a-reservations';await pending(id);const run=application(id,{employeeBind:null});
    await run.app.execute(cmd('refundPayment','submit',0,{amount:7000}),applicant.credential);
    let actual=await inspect(id),r=actual.head.state.financialRequests[0];
    assert.equal(adjustablePaymentBalance(actual.head.state,orderId,paymentId).available,3000);
    assert.equal((await run.app.execute(cmd('reversePayment','reverse',1),owner.credential)).status,'business-rejected');
    assert.equal((await run.app.execute(cmd('refundPayment','over',1,{amount:4000}),owner.credential)).status,'business-rejected');
    await run.app.execute(decide('rejectFinancialAdjustment','reject',1,r.requestId),reviewer.credential);
    assert.equal((await run.app.execute(cmd('reversePayment','after-reject',2),owner.credential)).status,'committed');
  });
  await t.test('C1-A SQL authorization revocation denies fresh keys but preserves terminal replay',async()=>{
    const id='c1a-revoke',actor=await provision(['payment.refund','financial.direct']);await pending(id);
    const run=application(id,{employeeBind:null}),request=cmd('refundPayment','original',0),result=await run.app.execute(request,actor.credential);
    await auth.revokePermission({principalId:actor.principalId,permissionId:'payment.refund'});
    assert.deepEqual(await run.app.execute(request,actor.credential),result);
    await assert.rejects(run.app.execute(cmd('refundPayment','new',1),actor.credential),denied);
  });
  for(const [index,pair]of [['refundPayment','refundPayment'],['refundPayment','reversePayment'],['reversePayment','refundPayment']].entries()){
    await t.test('C1-A SQL real two-connection race '+pair.join('/'),async()=>{
      const id='c1a-race-'+index,original=await pending(id),a=await pool.getConnection(),b=await pool.getConnection();
      let release,locked;const gate=new Promise(r=>release=r),entered=new Promise(r=>locked=r);
      const timer=setTimeout(release,10000);let firstWork,secondWork,secondFinished=false;
      try{
        const [[ai]]=await a.query('SELECT CONNECTION_ID() id'),[[bi]]=await b.query('SELECT CONNECTION_ID() id');assert.notEqual(ai.id,bi.id);
        const firstPort=wrapConnection(a,[],false),base=firstPort.execute.bind(firstPort);
        firstPort.execute=async(sql,args)=>{const result=await base(sql,args);if(sql.includes('ledger_heads')&&sql.endsWith('FOR UPDATE')){locked();await gate;}return result;};
        const first=application(id,{employeeBind:null,connectionPool:{getConnection:async()=>firstPort}});
        const second=application(id,{employeeBind:null,connectionPool:{getConnection:async()=>wrapConnection(b,[],false)}});
        firstWork=first.app.execute(cmd(pair[0],'first',0,{amount:pair[0]==='refundPayment'?7000:10000}),owner.credential);
        await entered;
        secondWork=second.app.execute(cmd(pair[1],'second',0,{amount:pair[1]==='refundPayment'?7000:10000}),owner.credential).finally(()=>secondFinished=true);
        await new Promise(r=>setTimeout(r,35));assert.equal(secondFinished,false);release();
        const results=await Promise.all([firstWork,secondWork]);assert.deepEqual(results.map(r=>r.status),['committed','revision-conflict']);
        const actual=await inspect(id);assert.equal(actual.head.revision,1);assert.equal(actual.audit.length,1);
        assert.deepEqual(financialOrder(actual.head.state).payments,financialOrder(original).payments);
        assert.equal(financialOrder(actual.head.state).financialAdjustments.length,1);
        assert.equal((await application(id,{employeeBind:null}).app.execute(cmd(pair[1],'fresh',1,{amount:pair[1]==='refundPayment'?7000:10000}),owner.credential)).status,'business-rejected');
        t.diagnostic('Independent CONNECTION_ID '+ai.id+' / '+bi.id+'; one committed adjustment');
      }finally{clearTimeout(timer);release();await Promise.allSettled([firstWork,secondWork].filter(Boolean));try{await a.rollback();await b.rollback();}finally{a.release();b.release();}}
    });
  }
  await t.test('C1-A SQL failure after snapshot UPDATE rolls back fact/result/audit and leaves key retryable',async()=>{
    const id='c1a-sql-fault';await pending(id);const before=await inspect(id),connection=await pool.getConnection(),port=wrapConnection(connection,[],false),base=port.execute.bind(port);
    port.execute=async(sql,args)=>{if(sql.startsWith('INSERT INTO')&&sql.includes('ledger_success_audit'))throw Error('C1A_INJECTED_AUDIT_FAILURE');return base(sql,args);};
    try{
      const run=application(id,{employeeBind:null,connectionPool:{getConnection:async()=>port}});
      await assert.rejects(run.app.execute(cmd('refundPayment','fault',0),owner.credential),/C1A_INJECTED/);
      await assertUnchanged(id,before);
    }finally{await connection.rollback();connection.release();}
    assert.equal((await application(id,{employeeBind:null}).app.execute(cmd('refundPayment','fault',0),owner.credential)).status,'committed');
  });
  await t.test('C1-A SQL consumed request rolls back with financial fact when audit write fails',async()=>{
    const id='c1a-request-fault';await pending(id);const run=application(id,{employeeBind:null});
    await run.app.execute(cmd('refundPayment','submit',0),applicant.credential);
    const r=(await inspect(id)).head.state.financialRequests[0];
    await run.app.execute(decide('approveFinancialAdjustment','approve',1,r.requestId),reviewer.credential);
    const before=await inspect(id),connection=await pool.getConnection(),port=wrapConnection(connection,[],false),base=port.execute.bind(port);
    port.execute=async(sql,args)=>{if(sql.startsWith('INSERT INTO')&&sql.includes('ledger_success_audit'))throw Error('C1A_CONSUMPTION_ROLLBACK');return base(sql,args);};
    try{await assert.rejects(application(id,{employeeBind:null,connectionPool:{getConnection:async()=>port}}).app.execute(execute('refundPayment','execute',2,r.requestId),applicant.credential),/C1A_CONSUMPTION/);await assertUnchanged(id,before);}
    finally{await connection.rollback();connection.release();}
    assert.equal((await run.app.execute(execute('refundPayment','execute',2,r.requestId),applicant.credential)).status,'committed');
  });
}
