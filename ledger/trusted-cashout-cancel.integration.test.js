// C1-B only: owned, opt-in disposable MySQL. Never consumes a caller's DB URL.
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
import { seedFinancialState, orderId } from '../test-support/financial-adjustments-fixture.js';

test('C1-B owned MySQL cashOut and cancellation integration',
  { skip: process.env.STAGE5E_RUN !== 'synthetic-only' && 'Requires owned synthetic-only MySQL fixture' }, async t => {
  const fixture = await freshEnvironment(fileURLToPath(new URL('../', import.meta.url)), {port:0, packages:false});
  try {
    const database=fixture.names.database, pool=await fixture.createDatabase(database);fixture.pools.add(pool);
    const connection=await pool.getConnection();
    try { await migrateFresh(connection,new URL('../',import.meta.url)); } finally { connection.release(); }
    const q=String.fromCharCode(96), table=name=>q+database+q+'.'+q+name+q;
    const authStore=createMySqlAuthStore({pool,database});
    const auth=createAuthService({store:authStore,rateLimiter:createMemoryLoginRateLimiter()});
    async function account(label,grants) {
      const loginIdentifier='c1b-'+label,password='Synthetic-C1B-only-password!';
      const {principalId}=await auth.createAccount({loginIdentifier,password});
      for(const permissionId of grants)await auth.grantPermission({principalId,permissionId});
      const login=await auth.login({loginIdentifier,password});assert.equal(login.ok,true);
      return {principalId,credential:{tokenDigest:digestSessionToken(login.token)}};
    }
    const owner=await account('direct',['cash.out','financial.direct','financial.approve','order.cancel','handover','payment.collect']);
    const applicant=await account('applicant',['cash.out','financial.approve','review.self']);
    const reviewer=await account('reviewer',['cash.out','financial.approve']);
    const executionContexts = new Map();
    function application(id,connectionPool=pool) {
      const store=createMySqlLedgerStore({pool:connectionPool,ledgerId:id,database,bindSessionRevalidation:authStore.bindSessionRevalidation});
      return createTrustedLedgerApplication({store,businessTimeZone:'Asia/Shanghai',transactCommand:(...args)=>{
        executionContexts.set(id+'/'+args[3],args[4].context);return transact(...args);
      }});
    }
    async function seed(id,count=false) {
      const state=initialState();seedFinancialState(state);state.orders[0].payments=[];
      const snapshot=encodeLedgerSnapshot(state);
      await pool.execute('INSERT INTO '+table('ledger_heads')+' (ledger_id,revision,state_schema_version,state_json,state_checksum) VALUES (?,0,?,?,?)',
        [id,state.version,snapshot.json,snapshot.checksum]);
      if(count)assert.equal((await application(id).execute(command('handover','count',0,{actualCash:10000}),owner.credential)).status,'committed');
    }
    async function inspect(id) {
      const head=await createMySqlLedgerStore({pool,ledgerId:id,database}).read();
      const [operations]=await pool.execute('SELECT operation_key,terminal_status,terminal_result FROM '+table('ledger_operations')+' WHERE ledger_id=? ORDER BY operation_key',[id]);
      const [audit]=await pool.execute('SELECT operation_key,after_revision FROM '+table('ledger_success_audit')+' WHERE ledger_id=? ORDER BY operation_key',[id]);
      return {head,operations:operations.map(r=>({...r,terminal_result:decodeLedgerJson(r.terminal_result)})),audit};
    }
    const command=(action,key,rev,payload)=>({action,operationKey:key,expectedRevision:rev,payload});
    const out=(key,rev,amount)=>command('cashOut',key,rev,{amountCents:amount,reason:'Actual drawer withdrawal'});
    const cancel=(key,rev)=>command('cancelOrder',key,rev,{order:orderId,reason:'Unpaid cancellation'});
    const collect=(key,rev)=>command('collect',key,rev,{order:orderId,charge:'open',payments:[{method:'\u73b0\u91d1',amount:10000}]});
    const decide=(key,rev,requestId)=>command('approveFinancialAdjustment',key,rev,{requestId});
    const consume=(key,rev,requestId)=>command('cashOut',key,rev,{requestId});
    const wrap=(c,execute)=>({beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),
      execute:execute??((...args)=>c.execute(...args)),release:()=>{},destroy:()=>c.destroy()});

    await t.test('cashOut approval, DB actor/time, reconnect replay and new-key consumption protection',async()=>{
      const id='c1b-approval';await seed(id,true);const app=application(id);
      assert.equal((await app.execute(out('request',1,7000),applicant.credential)).status,'committed');
      let actual=await inspect(id),r=actual.head.state.financialRequests[0];
      assert.equal(actual.head.state.cashOutflows,undefined);
      await assert.rejects(app.execute(decide('self',2,r.requestId),applicant.credential),e=>e.code==='AUTHORIZATION_DENIED');
      assert.equal((await app.execute(consume('early',2,r.requestId),applicant.credential)).status,'business-rejected');
      assert.equal((await app.execute(decide('approve',2,r.requestId),reviewer.credential)).status,'committed');
      assert.equal((await inspect(id)).head.state.cashOutflows,undefined);
      const request=consume('execute',3,r.requestId),result=await app.execute(request,applicant.credential);
      assert.equal(result.status,'committed');
      assert.deepEqual(await application(id).execute(request,applicant.credential),result);
      assert.equal((await app.execute(consume('new-key',4,r.requestId),applicant.credential)).status,'business-rejected');
      actual=await inspect(id);const fact=actual.head.state.cashOutflows[0];
      assert.equal(actual.head.state.cashOutflows.length,1);assert.equal(fact.actualActorPrincipalId,applicant.principalId);
      assert.equal(fact.occurredAt,executionContexts.get(id+'/execute').dbNow);assert.equal(actual.head.state.financialRequests[0].executedAdjustmentId,fact.cashOutId);
      assert.equal((await app.execute(out('over',4,4000),owner.credential)).status,'business-rejected');
    });

    async function race(id,firstCommand,secondCommand,verify,count=false) {
      await seed(id,count);
      const a=await pool.getConnection(),b=await pool.getConnection();
      const [[ai]]=await a.query('SELECT CONNECTION_ID() id'),[[bi]]=await b.query('SELECT CONNECTION_ID() id');
      assert.notEqual(ai.id,bi.id);
      let release,locked,attempted;
      const gate=new Promise(r=>release=r),entered=new Promise(r=>locked=r),attempt=new Promise(r=>attempted=r);
      const timer=setTimeout(release,10000),events=[];
      let first,second,finished=false;
      try {
        const pa=wrap(a,async(sql,args)=>{
          const result=await a.execute(sql,args);
          if(sql.includes('ledger_heads')&&sql.endsWith('FOR UPDATE')){events.push('a-head');locked();await gate;}
          return result;
        });
        const pb=wrap(b,async(sql,args)=>{
          if(sql.includes('ledger_heads')&&sql.endsWith('FOR UPDATE'))attempted();
          if(sql.includes('auth_accounts')&&sql.endsWith('FOR UPDATE'))events.push('b-auth');
          return b.execute(sql,args);
        });
        first=application(id,{getConnection:async()=>pa}).execute(firstCommand,owner.credential);
        await entered;
        second=application(id,{getConnection:async()=>pb}).execute(secondCommand,owner.credential).finally(()=>finished=true);
        await attempt;await new Promise(r=>setTimeout(r,25));
        assert.equal(finished,false);assert.equal(events.includes('b-auth'),false);
        release();const results=await Promise.all([first,second]);
        assert.deepEqual(results.map(r=>r.status),['committed','revision-conflict']);
        await verify(await inspect(id),application(id));
        t.diagnostic('Real CONNECTION_ID '+ai.id+'/'+bi.id+': committed/revision-conflict');
      } finally {
        clearTimeout(timer);release();await Promise.allSettled([first,second].filter(Boolean));
        await a.rollback();await b.rollback();a.release();b.release();
      }
    }
    await t.test('two cashOut executions cannot overspend the same locked drawer',async()=>{
      await race('c1b-race-cash',out('first',1,7000),out('second',1,5000),async(actual,app)=>{
        assert.equal(actual.head.state.cashOutflows.length,1);assert.equal(actual.head.state.cashOutflows[0].amountCents,7000);
        assert.equal((await app.execute(out('fresh',2,5000),owner.credential)).status,'business-rejected');
      },true);
    });
    await t.test('cancel wins collect race; fresh collection cannot revive terminal order',async()=>{
      await race('c1b-race-cancel',cancel('first',0),collect('second',0),async(actual,app)=>{
        assert.ok(actual.head.state.orders[0].cancellation);assert.deepEqual(actual.head.state.orders[0].payments,[]);
        assert.equal((await app.execute(collect('fresh',1),owner.credential)).status,'business-rejected');
      });
    });
    await t.test('collect wins cancel race; fresh cancellation cannot erase money',async()=>{
      await race('c1b-race-collect',collect('first',0),cancel('second',0),async(actual,app)=>{
        const payments=actual.head.state.orders[0].payments;assert.equal(payments.length,1);assert.equal(payments[0].amount,10000);
        assert.equal((await app.execute(cancel('fresh',1),owner.credential)).status,'business-rejected');
        assert.deepEqual((await inspect('c1b-race-collect')).head.state.orders[0].payments,payments);
      });
    });

    for(const kind of ['cash-request','cancel'])await t.test(kind+' SQL audit failure rolls back state/result/audit and consumption',async()=>{
      const id='c1b-rollback-'+kind;await seed(id,kind==='cash-request');const app=application(id);
      let request,credential=owner.credential;
      if(kind==='cash-request'){
        await app.execute(out('request',1,3000),applicant.credential);
        const r=(await inspect(id)).head.state.financialRequests[0];
        await app.execute(decide('approve',2,r.requestId),reviewer.credential);
        request=consume('fault',3,r.requestId);credential=applicant.credential;
      } else request=cancel('fault',0);
      const before=await inspect(id),c=await pool.getConnection();
      const port=wrap(c,async(sql,args)=>{
        if(sql.startsWith('INSERT INTO')&&sql.includes('ledger_success_audit'))throw Error('C1B_INJECTED_AUDIT_FAILURE');
        return c.execute(sql,args);
      });
      try {
        await assert.rejects(application(id,{getConnection:async()=>port}).execute(request,credential),/C1B_INJECTED/);
        assert.deepEqual(await inspect(id),before);
      } finally {await c.rollback();c.release();}
      assert.equal((await app.execute(request,credential)).status,'committed');
    });
  } finally {
    const cleanup=await fixture.cleanup();t.diagnostic('C1B cleanup '+JSON.stringify(cleanup));assert.equal(cleanup.sqlCleanup,true);
  }
});
