// C2-A only; disposable server owned by freshEnvironment, no caller-selected URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { freshEnvironment } from '../rehearsal/fresh-environment.js';
import { migrateFresh } from '../rehearsal/migration.js';
import { initialState, transact } from '../rules.js';
import { createMySqlLedgerStore } from './mysql-store.js';
import { createTrustedLedgerApplication } from './application.js';
import { encodeLedgerSnapshot, decodeLedgerJson } from './mysql-snapshot.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createAuthService } from '../auth/service.js';
import { createMemoryLoginRateLimiter } from '../auth/rate-limit.js';
import { digestSessionToken } from '../auth/session-token.js';
import { seedFinancialState, financialOrder, orderId, paymentId, ownerId } from '../test-support/financial-adjustments-fixture.js';

test('C2-A owned MySQL handover cash integration',
  {skip:process.env.STAGE5E_RUN!=='synthetic-only'&&'Requires owned synthetic-only MySQL fixture'},async t=>{
  const fixture=await freshEnvironment(fileURLToPath(new URL('../',import.meta.url)),{port:33313,packages:false});
  try {
    const database=fixture.names.database,pool=await fixture.createDatabase(database);fixture.pools.add(pool);
    const connection=await pool.getConnection();
    try{await migrateFresh(connection,new URL('../',import.meta.url));}finally{connection.release();}
    const q=String.fromCharCode(96),table=name=>q+database+q+'.'+q+name+q;
    const authStore=createMySqlAuthStore({pool,database}),auth=createAuthService({store:authStore,rateLimiter:createMemoryLoginRateLimiter()});
    async function provision(label,grants){
      const loginIdentifier='c2a-'+label,password='C2A-owned-synthetic-only-password';
      const {principalId}=await auth.createAccount({loginIdentifier,password});
      for(const permissionId of grants)await auth.grantPermission({principalId,permissionId});
      const login=await auth.login({loginIdentifier,password});assert.equal(login.ok,true);
      return {principalId,credential:{tokenDigest:digestSessionToken(login.token)}};
    }
    const direct=await provision('direct',['handover','cash.out','payment.collect','payment.refund','financial.direct','financial.approve']);
    const applicant=await provision('applicant',['cash.out','payment.refund']);
    const reviewer=await provision('reviewer',['financial.approve']);
    const contexts=new Map();
    function application(id,connectionPool=pool){
      const store=createMySqlLedgerStore({pool:connectionPool,ledgerId:id,database,bindSessionRevalidation:authStore.bindSessionRevalidation});
      return createTrustedLedgerApplication({store,businessTimeZone:'Asia/Shanghai',transactCommand:(...args)=>{
        contexts.set(id+'/'+args[3],args[4].context);return transact(...args);
      }});
    }
    const command=(action,key,rev,payload)=>({action,operationKey:key,expectedRevision:rev,payload});
    const h=(key,rev,actualCash=10000)=>command('handover',key,rev,{actualCash});
    const out=(key,rev,amountCents=1000)=>command('cashOut',key,rev,{amountCents,reason:'Verified actual drawer withdrawal'});
    const approve=(key,rev,requestId)=>command('approveFinancialAdjustment',key,rev,{requestId});
    const executeOut=(key,rev,requestId)=>command('cashOut',key,rev,{requestId});
    const collect=(key,rev)=>command('collect',key,rev,{order:orderId,charge:'open',payments:[{method:'\u73b0\u91d1',amount:10000}]});
    async function inspect(id){
      const head=await createMySqlLedgerStore({pool,ledgerId:id,database}).read();
      const [operations]=await pool.execute('SELECT operation_key,terminal_status,terminal_result FROM '+table('ledger_operations')+' WHERE ledger_id=? ORDER BY operation_key',[id]);
      const [audit]=await pool.execute('SELECT operation_key,actor_principal_id,after_revision FROM '+table('ledger_success_audit')+' WHERE ledger_id=? ORDER BY operation_key',[id]);
      return {head,operations:operations.map(r=>({...r,terminal_result:decodeLedgerJson(r.terminal_result)})),audit};
    }
    async function seed(id,unknownRefund=false){
      const s=initialState();seedFinancialState(s);
      if(unknownRefund)financialOrder(s).financialAdjustments=[{
        adjustmentId:'91000000-0000-4000-8000-000000000001',kind:'REFUND',originalPaymentId:paymentId,amount:3000,
        reason:'Legacy refund without trustworthy drawer attribution',actualActorPrincipalId:ownerId,occurredAt:'2026-10-15T12:00:00.000000Z',
        businessDate:'2026-10-15',businessDayRuleVersion:'cutoff-0600-v1',businessTimeZone:'Asia/Shanghai',requestId:null,
        refundChannel:'\u73b0\u91d1',refundFundingSource:'CURRENT_DRAWER',affectsCurrentDrawer:true
      }];
      else financialOrder(s).payments=[];
      const snapshot=encodeLedgerSnapshot(s);
      await pool.execute('INSERT INTO '+table('ledger_heads')+' (ledger_id,revision,state_schema_version,state_json,state_checksum) VALUES (?,0,?,?,?)',[id,s.version,snapshot.json,snapshot.checksum]);
      if(!unknownRefund){
        const app=application(id);
        assert.equal((await app.execute(collect('receipt',0),direct.credential)).status,'committed');
        assert.equal((await app.execute(h('baseline',1),direct.credential)).status,'committed');
      }
    }
    async function refund(id,key,rev,amount=2000){
      const p=financialOrder((await inspect(id)).head.state).payments[0];
      return command('refundPayment',key,rev,{order:orderId,originalPaymentId:p.paymentId,amount,reason:'Verified actual drawer refund',
        refundChannel:'\u73b0\u91d1',refundFundingSource:'CURRENT_DRAWER'});
    }
    const wrap=(c,execute)=>({execute,beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>{},destroy:()=>c.destroy()});
    async function race(id,kind,handoverFirst){
      await seed(id);const before=await inspect(id),baseline=before.head.state.handovers[0],amount=kind==='cashOut'?1000:2000;
      const movement=kind==='cashOut'?out('movement',2):await refund(id,'movement',2);
      const handover=h('handover',2,handoverFirst?10000:10000-amount);
      const firstCommand=handoverFirst?handover:movement,secondCommand=handoverFirst?movement:handover;
      const a=await pool.getConnection(),b=await pool.getConnection();
      let release,locked,attempted;
      const gate=new Promise(r=>release=r),entered=new Promise(r=>locked=r),attempt=new Promise(r=>attempted=r);
      const timer=setTimeout(release,10000);let first,second,secondDone=false,released=false,earlyAuth=false;
      try{
        const [[ai]]=await a.query('SELECT CONNECTION_ID() id'),[[bi]]=await b.query('SELECT CONNECTION_ID() id');assert.notEqual(ai.id,bi.id);
        const pa=wrap(a,async(sql,args)=>{
          const r=await a.execute(sql,args);
          if(sql.includes('ledger_heads')&&sql.endsWith('FOR UPDATE')){locked();await gate;}
          return r;
        });
        const pb=wrap(b,async(sql,args)=>{
          if(sql.includes('ledger_heads')&&sql.endsWith('FOR UPDATE'))attempted();
          if(sql.includes('auth_accounts')&&sql.endsWith('FOR UPDATE')&&!released)earlyAuth=true;
          return b.execute(sql,args);
        });
        first=application(id,{getConnection:async()=>pa}).execute(firstCommand,direct.credential);await entered;
        second=application(id,{getConnection:async()=>pb}).execute(secondCommand,direct.credential).finally(()=>secondDone=true);
        await attempt;await new Promise(r=>setTimeout(r,25));assert.equal(secondDone,false);assert.equal(earlyAuth,false);
        released=true;release();const results=await Promise.all([first,second]);
        assert.deepEqual(results.map(r=>r.status),['committed','revision-conflict']);
        const app=application(id);assert.deepEqual(await app.execute(firstCommand,direct.credential),results[0]);
        if(handoverFirst){
          const fresh={...movement,operationKey:'fresh-movement',expectedRevision:3};
          assert.equal((await app.execute(fresh,direct.credential)).status,'committed');
          const mid=await inspect(id),latest=mid.head.state.handovers.at(-1);
          const fact=kind==='cashOut'?mid.head.state.cashOutflows[0]:financialOrder(mid.head.state).financialAdjustments[0];
          assert.equal(fact.drawerHandoverId,latest.handoverId);
          assert.equal((await app.execute(h('after-movement',4,10000-amount),direct.credential)).status,'committed');
        }else assert.equal((await app.execute(h('fresh-handover',3,10000-amount),direct.credential)).status,'committed');
        const actual=await inspect(id),last=actual.head.state.handovers.at(-1);
        assert.equal(last.expectedCash,10000-amount);assert.equal(last.intervalCashOut,amount);
        assert.equal(last.intervalRefundCashOut,kind==='refundPayment'?amount:0);
        assert.equal(last.intervalIndependentCashOut,kind==='cashOut'?amount:0);
        assert.deepEqual(actual.head.state.handovers[0],baseline);
        assert.deepEqual(financialOrder(actual.head.state).payments,financialOrder(before.head.state).payments);
        const rev=actual.head.revision;
        assert.equal((await app.execute(h('next',rev,10000-amount),direct.credential)).status,'committed');
        assert.equal((await inspect(id)).head.state.handovers.at(-1).intervalCashOut,0);
        t.diagnostic('CONNECTION_ID '+ai.id+'/'+bi.id+' '+firstCommand.action+'/'+secondCommand.action+' committed/revision-conflict; movement counted once');
      }finally{
        clearTimeout(timer);release();await Promise.allSettled([first,second].filter(Boolean));
        await a.rollback();await b.rollback();a.release();b.release();
      }
    }
    for(const kind of ['cashOut','refundPayment'])for(const first of [true,false])
      await t.test('real two-connection '+(first?'handover / '+kind:kind+' / handover'),()=>race('c2a-'+kind+'-'+first,kind,first));
    await t.test('handover audit-write failure rolls back the new boundary and leaves all old facts intact',async()=>{
      const id='c2a-handover-rollback';await seed(id);const app=application(id);
      await app.execute(out('out',2),direct.credential);
      const before=await inspect(id),c=await pool.getConnection();
      const port=wrap(c,async(sql,args)=>{
        if(sql.startsWith('INSERT INTO')&&sql.includes('ledger_success_audit'))throw Error('C2A_HANDOVER_AUDIT_FAILURE');
        return c.execute(sql,args);
      });
      const request=h('failed-handover',3,9000);
      try{
        await assert.rejects(application(id,{getConnection:async()=>port}).execute(request,direct.credential),/C2A_HANDOVER_AUDIT_FAILURE/);
        assert.deepEqual(await inspect(id),before);
      }finally{await c.rollback();c.release();}
      const result=await app.execute(request,direct.credential);assert.equal(result.status,'committed');
      assert.deepEqual(await application(id).execute(request,direct.credential),result);
      const after=await inspect(id);assert.equal(after.head.state.handovers.at(-1).intervalCashOut,1000);
      assert.equal(after.head.state.handovers.length,2);
    });
    await t.test('old approved refund revalidates the new boundary; SQL failure rolls back attribution and consumption',async()=>{
      const id='c2a-refund-rollback';await seed(id);const app=application(id);
      await app.execute(await refund(id,'request',2),applicant.credential);
      const requestId=(await inspect(id)).head.state.financialRequests[0].requestId;
      await app.execute(approve('approve',3,requestId),reviewer.credential);
      await app.execute(h('new-count',4),direct.credential);
      const before=await inspect(id),latestId=before.head.state.handovers.at(-1).handoverId;
      const request=command('refundPayment','execute',5,{order:orderId,requestId}),c=await pool.getConnection();
      const port=wrap(c,async(sql,args)=>{
        if(sql.startsWith('INSERT INTO')&&sql.includes('ledger_success_audit'))throw Error('C2A_REFUND_ATTRIBUTION_ROLLBACK');
        return c.execute(sql,args);
      });
      try{
        await assert.rejects(application(id,{getConnection:async()=>port}).execute(request,applicant.credential),/C2A_REFUND_ATTRIBUTION_ROLLBACK/);
        assert.deepEqual(await inspect(id),before);
      }finally{await c.rollback();c.release();}
      assert.equal((await app.execute(request,applicant.credential)).status,'committed');
      let actual=await inspect(id),fact=financialOrder(actual.head.state).financialAdjustments[0];
      assert.equal(fact.drawerHandoverId,latestId);assert.equal(fact.actualActorPrincipalId,applicant.principalId);
      assert.equal(fact.occurredAt,contexts.get(id+'/execute').dbNow);
      await app.execute(h('close',6,8000),direct.credential);
      actual=await inspect(id);assert.equal(actual.head.state.handovers.at(-1).intervalCashOut,2000);
      assert.deepEqual(actual.head.state.handovers.slice(0,2),before.head.state.handovers);
    });
    await t.test('approved old cashOut is not expenditure and cannot bypass a later smaller actual balance',async()=>{
      const id='c2a-old-intent';await seed(id);const app=application(id);
      await app.execute(out('request',2,7000),applicant.credential);
      const requestId=(await inspect(id)).head.state.financialRequests[0].requestId;
      await app.execute(approve('approve',3,requestId),reviewer.credential);
      await app.execute(h('new-count',4,2000),direct.credential);
      const before=await inspect(id),result=await app.execute(executeOut('execute',5,requestId),applicant.credential);
      assert.equal(result.status,'business-rejected');const actual=await inspect(id);
      assert.deepEqual(actual.head,before.head);assert.deepEqual(actual.audit,before.audit);
      assert.equal(actual.head.state.cashOutflows,undefined);assert.equal(actual.head.state.financialRequests[0].executedAdjustmentId,null);
      assert.equal(actual.head.state.handovers.at(-1).intervalCashOut,0);
      assert.equal(actual.head.state.handovers.at(-1).difference,-8000);
    });
    await t.test('unknown historical CURRENT_DRAWER refund blocks bootstrap without rewriting historical facts',async()=>{
      const id='c2a-unknown-refund';await seed(id,true);const app=application(id),before=await inspect(id);
      assert.equal((await app.execute(h('count',0,7000),direct.credential)).status,'business-rejected');
      assert.equal((await app.execute(out('cash',0,1),direct.credential)).status,'business-rejected');
      const actual=await inspect(id);assert.deepEqual(actual.head,before.head);assert.deepEqual(actual.audit,before.audit);
    });
  }finally{
    const cleanup=await fixture.cleanup();t.diagnostic('C2A cleanup '+JSON.stringify(cleanup));assert.equal(cleanup.sqlCleanup,true);
  }
});
