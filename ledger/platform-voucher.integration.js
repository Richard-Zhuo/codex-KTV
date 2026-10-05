import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMySqlVoucherStore } from '../vouchers/mysql-store.js';
import { createPlatformVoucherApplication } from '../vouchers/application.js';
import { FakePlatformVoucherGateway } from '../vouchers/gateways.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';

export async function testPlatformVouchers(f) {
  const { t, pool, setup, provision, seed, inspect, table, database } = f;
  await t.test('voucher migration 007: empty installation, InnoDB and explicit duplicate-run rejection', async () => {
    const sql = await readFile(new URL('../database/migrations/007_mysql_platform_vouchers.sql', import.meta.url), 'utf8');
    const first = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').split(';')[0];
    await assert.rejects(setup.query(first), { code: 'ER_TABLE_EXISTS_ERROR' });
    const [rows] = await setup.query("SELECT table_name,engine FROM information_schema.tables WHERE table_schema=? AND table_name IN ('voucher_redemptions','voucher_operations','provider_events','voucher_exceptions')", [database]);
    assert.equal(rows.length, 4); assert.ok(rows.every(r => r.ENGINE === 'InnoDB' || r.engine === 'InnoDB'));
  });
  await t.test('voucher MySQL: claim/evidence persist without modifying ledger snapshot/revision; raw code absent', async () => {
    const login = await provision(['room.open']); await seed('voucher-first');
    const gateway = new FakePlatformVoucherGateway();
    const authStore = createMySqlAuthStore({ pool, database });
    const store = createMySqlVoucherStore({ pool, database, ledgerId: 'voucher-first', provider: 'meituan',
      storeId: 'synthetic-store', bindSessionRevalidation: authStore.bindSessionRevalidation });
    const app = createPlatformVoucherApplication({allowTestGateway:true, store, gateway, voucherCodeSecret: Buffer.alloc(32, 9) });
    const before = await inspect('voucher-first');
    const c = { operationKey: 'first', expectedRevision: 0, action: 'redeemVoucher', payload: { voucherCode: '0012345678901' } };
    const result = await app.execute(c, login.credential);
    assert.equal(result.status, 'REDEEMED');
    assert.deepEqual(await app.execute(c, login.credential), result);
    assert.equal(gateway.calls.redeemVoucher, 1);
    assert.deepEqual(await inspect('voucher-first'), before);
    const [[row]] = await pool.query('SELECT * FROM ' + table('voucher_redemptions') + ' WHERE id=?', [result.redemptionId]);
    assert.equal(row.requested_by_principal_id, login.principalId);
    assert.equal(row.status, 'REDEEMED'); assert.ok(row.provider_flow_id);
    assert.notEqual(row.provider_flow_id, row.provider_trace_id);
    assert.equal(JSON.stringify(row).includes('0012345678901'), false);
  });
  await testVoucherContracts(f);
}

import mysql from 'mysql2/promise';
import { createTrustedProviderContext } from '../vouchers/application.js';

export async function testVoucherContracts({t,pool,setup,auth,table,provision,seed,inspect,database,poolOptions,wrapConnection}) {
  let serial=0;
  const make=async(options={})=>{
    const id='voucher-case-'+(++serial), login=await provision(options.permissions ?? ['room.open']);await seed(id);
    const gateway=new FakePlatformVoucherGateway(options.gateway ?? {});
    const storeFor=(connectionPool=pool)=>createMySqlVoucherStore({pool:connectionPool,database,ledgerId:id,
      provider:'meituan',storeId:'synthetic-store',bindSessionRevalidation:createMySqlAuthStore({pool:connectionPool,database}).bindSessionRevalidation});
    const appFor=(connectionPool=pool)=>createPlatformVoucherApplication({allowTestGateway:true,store:storeFor(connectionPool),gateway,voucherCodeSecret:Buffer.alloc(32,9)});
    const c={operationKey:'consume-'+serial,expectedRevision:0,action:'redeemVoucher',payload:{voucherCode:String(serial).padStart(13,'0')}};
    return{id,login,gateway,c,app:appFor(),appFor,storeFor};
  };
  const get=async id=>{const[[r]]=await pool.execute('SELECT * FROM '+table('voucher_redemptions')+' WHERE id=?',[id]);return r;};
  const op=async(id,key)=>{const[[r]]=await pool.execute('SELECT completed,result_json FROM '+table('voucher_operations')+' WHERE ledger_id=? AND operation_key=?',[id,key]);return r;};
  await t.test('voucher MySQL: inspect and consume run after commit/release; independent head/account NOWAIT locks succeed',async()=>{
    const f=await make();let probeCount=0;
    const probe=async()=>{const c=await pool.getConnection();try{
      await c.beginTransaction();
      await c.execute('SELECT ledger_id FROM '+table('ledger_heads')+' WHERE ledger_id=? FOR UPDATE NOWAIT',[f.id]);
      await c.execute('SELECT principal_id FROM '+table('auth_accounts')+' WHERE principal_id=? FOR UPDATE NOWAIT',[f.login.principalId]);
      probeCount++;
    }finally{await c.rollback();c.release();}};
    f.gateway.outcomes.inspectVoucher=async input=>{await probe();return{provider:input.provider,storeId:input.storeId,productId:'synthetic-product',productNameSnapshot:'Synthetic product',externalOrderId:'probe-order'};};
    f.gateway.outcomes.redeemVoucher=async(input,g)=>{await probe();return g.facts.get(input.providerRequestId);};
    assert.equal((await f.app.execute(f.c,f.login.credential)).status,'REDEEMED');assert.equal(probeCount,2);
  });
  for(const failure of ['timeout','disconnect','unparseable','uncorrelated'])await t.test('voucher MySQL: '+failure+' is UNKNOWN; original key never repeats provider; new query reconciles',async()=>{
    const f=await make();
    f.gateway.outcomes.redeemVoucher=async(input)=>{
      if(failure==='unparseable')return null;
      if(failure==='uncorrelated')return{...input,status:'REDEEMED',providerRequestId:'another-attempt',providerFlowId:'unrelated'};
      const e=Error('synthetic provider failure');e.code=failure==='timeout'?'ETIMEDOUT':'ECONNRESET';throw e;
    };
    const original=await f.app.execute(f.c,f.login.credential);assert.equal(original.status,'UNKNOWN');
    const reconnect=mysql.createPool(poolOptions);try{assert.deepEqual(await f.appFor(reconnect).execute(f.c,f.login.credential),original);}finally{await reconnect.end();}
    const query={operationKey:'query-'+f.id,expectedRevision:0,action:'queryRedemption',payload:{redemptionId:original.redemptionId}};
    assert.equal((await f.app.execute(query,f.login.credential)).status,'REDEEMED');
    assert.deepEqual(await f.app.execute(f.c,f.login.credential),original);assert.equal(f.gateway.calls.redeemVoucher,1);
    assert.equal((await get(original.redemptionId)).status,'REDEEMED');
  });
  await t.test('voucher MySQL: definitive FAILED and wrong-store inspection cannot cover fees',async()=>{
    const f=await make({gateway:{outcomes:{redeemVoucher:async input=>({...input,status:'FAILED',definitive:true})}}});
    const result=await f.app.execute(f.c,f.login.credential);assert.equal(result.status,'FAILED');assert.deepEqual(await f.app.execute(f.c,f.login.credential),result);
    const wrong=await make({gateway:{storeId:'another-store'}});
    assert.equal((await wrong.app.execute(wrong.c,wrong.login.credential)).status,'FAILED');assert.equal(wrong.gateway.calls.redeemVoucher,0);
  });
  await t.test('voucher MySQL: denied key has no row/effect, obtains grant later; actor/fingerprint/revision conflicts persist correctly',async()=>{
    const f=await make({permissions:['backend.view']});
    await assert.rejects(f.app.execute({...f.c,payload:{...f.c.payload,permissions:['*'],actorId:'forged'}},f.login.credential),{code:'AUTHORIZATION_DENIED'});
    assert.equal(await op(f.id,f.c.operationKey),undefined);assert.equal(f.gateway.calls.inspectVoucher,0);
    await auth.grantPermission({principalId:f.login.principalId,permissionId:'room.open'});
    const original=await f.app.execute(f.c,f.login.credential);assert.equal(original.actorId,f.login.principalId);
    const other=await provision(['room.open']);
    assert.equal((await f.app.execute(f.c,other.credential)).reason,'actor-mismatch');
    assert.equal((await f.app.execute({...f.c,expectedRevision:1},f.login.credential)).reason,'request-mismatch');
    assert.equal((await f.app.execute({...f.c,payload:{voucherCode:'9999999999999'}},f.login.credential)).reason,'request-mismatch');
    await auth.revokePermission({principalId:f.login.principalId,permissionId:'room.open'});
    assert.deepEqual(await f.app.execute(f.c,f.login.credential),original);
    await assert.rejects(f.app.execute({...f.c,operationKey:'new-'+f.id},f.login.credential),{code:'AUTHORIZATION_DENIED'});
  });
  for(const change of ['disabled','revoked','idle','absolute'])await t.test('voucher MySQL: '+change+' session/account cannot read a saved terminal',async()=>{
    const f=await make();await f.app.execute(f.c,f.login.credential);
    if(change==='disabled')await auth.disableAccount({principalId:f.login.principalId});
    else if(change==='revoked')await auth.logout(f.login.token);
    else await pool.execute('UPDATE '+table('auth_sessions')+' SET '+(change==='idle'?'idle_expires_at = created_at':'idle_expires_at = created_at, absolute_expires_at = created_at + INTERVAL 1 MICROSECOND')+' WHERE session_id=?',[f.login.sessionId]);
    await assert.rejects(f.app.execute(f.c,f.login.credential),{code:'AUTHENTICATION_REQUIRED'});assert.equal(f.gateway.calls.redeemVoucher,1);
  });
  for(const sameKey of [false,true])await t.test('voucher MySQL: two independent connections '+(sameKey?'retry same key':'double-click same voucher')+' consume once',async()=>{
    const f=await make();const a=await pool.getConnection(),b=await pool.getConnection();
    let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
    try{
      const[[aa]]=await a.query('SELECT CONNECTION_ID() AS id');const[[bb]]=await b.query('SELECT CONNECTION_ID() AS id');assert.notEqual(aa.id,bb.id);t.diagnostic('voucher connections '+aa.id+'/'+bb.id);
      const appA=f.appFor({getConnection:async()=>wrapConnection(a,[],false)}),appB=f.appFor({getConnection:async()=>wrapConnection(b,[],false)});
      f.gateway.outcomes.redeemVoucher=async(input,g)=>{enter();await gate;return g.facts.get(input.providerRequestId);};
      const first=appA.execute(f.c,f.login.credential);await entered;
      const second=await appB.execute({...f.c,operationKey:sameKey?f.c.operationKey:'other-'+f.id},f.login.credential);
      assert.equal(second.status,'REDEEMING');release();assert.equal((await first).status,'REDEEMED');
      const[[count]]=await pool.query('SELECT COUNT(*) AS n FROM '+table('voucher_redemptions')+' WHERE ledger_id=?',[f.id]);assert.equal(Number(count.n),1);assert.equal(f.gateway.calls.redeemVoucher,1);
    }finally{release?.();a.release();b.release();}
  });
  await t.test('voucher MySQL: claim SQL failure fully rolls back intent/key and causes no provider call',async()=>{
    const f=await make(),c={...f.c,operationKey:'fault-claim'};
    await setup.query("ALTER TABLE "+table('voucher_operations')+" ADD CONSTRAINT voucher_test_claim_failure CHECK(operation_key <> 'fault-claim')");
    try{
      await assert.rejects(f.app.execute(c,f.login.credential),{code:'ER_CHECK_CONSTRAINT_VIOLATED'});
      assert.equal(await op(f.id,c.operationKey),undefined);
      const[[n]]=await pool.query('SELECT COUNT(*) AS n FROM '+table('voucher_redemptions')+' WHERE ledger_id=?',[f.id]);assert.equal(Number(n.n),0);assert.equal(f.gateway.calls.redeemVoucher,0);
    }finally{await setup.query('ALTER TABLE '+table('voucher_operations')+' DROP CHECK voucher_test_claim_failure');}
    assert.equal((await f.app.execute(c,f.login.credential)).status,'REDEEMED');
  });
  await t.test('voucher MySQL: evidence SQL failure preserves claimed attempt; replay never consumes, new query finishes original key',async()=>{
    const f=await make(),c={...f.c,operationKey:'fault-evidence'};
    await setup.query("ALTER TABLE "+table('voucher_redemptions')+" ADD CONSTRAINT voucher_test_evidence_failure CHECK(NOT(operation_key='fault-evidence' AND status='REDEEMED'))");
    let pending;
    try{
      await assert.rejects(f.app.execute(c,f.login.credential),{code:'ER_CHECK_CONSTRAINT_VIOLATED'});
      pending=await f.app.execute(c,f.login.credential);assert.equal(pending.status,'REDEEMING');assert.equal(f.gateway.calls.redeemVoucher,1);
      assert.equal((await op(f.id,c.operationKey)).completed,0);
      const row=await get(pending.redemptionId);assert.equal(row.status,'REDEEMING');assert.equal(row.provider_flow_id,null);
    }finally{await setup.query('ALTER TABLE '+table('voucher_redemptions')+' DROP CHECK voucher_test_evidence_failure');}
    assert.equal((await f.app.execute({operationKey:'recover-'+f.id,expectedRevision:0,action:'queryRedemption',payload:{redemptionId:pending.redemptionId}},f.login.credential)).status,'REDEEMED');
    assert.equal((await f.app.execute(c,f.login.credential)).status,'REDEEMED');assert.equal(f.gateway.calls.redeemVoucher,1);
  });
  for(const terminal of ['REVERSED','REFUNDED'])await t.test('voucher MySQL: duplicate/out-of-order '+terminal+' events preserve order and produce exception once',async()=>{
    const f=await make(),r=await f.app.execute(f.c,f.login.credential);
    await pool.execute('UPDATE '+table('voucher_redemptions')+' SET linked_order_id=? WHERE id=?',['synthetic-linked-'+f.id,r.redemptionId]);
    const before=await inspect(f.id),row=await get(r.redemptionId);
    const context=createTrustedProviderContext({provider:'meituan',storeId:'synthetic-store'});
    const event={externalMessageId:'event-'+f.id,providerEnvelopeMessageId:'envelope-'+f.id,eventType:terminal,externalOrderId:row.external_order_id};
    const saved=await f.app.receiveProviderEvent(event,context);assert.equal(saved.processingStatus,'processed');
    assert.deepEqual(await f.app.receiveProviderEvent(event,context),saved);assert.deepEqual(await inspect(f.id),before);
    const[[count]]=await pool.query('SELECT COUNT(*) AS n FROM '+table('voucher_exceptions')+' WHERE redemption_id=?',[r.redemptionId]);assert.equal(Number(count.n),1);
    const late=await f.app.receiveProviderEvent({...event,externalMessageId:'late-'+f.id,eventType:'REDEEMED',providerFlowId:row.provider_flow_id},context);
    assert.equal(late.processingStatus,'reconciliation-required');assert.equal((await get(r.redemptionId)).status,terminal);
    await assert.rejects(f.app.receiveProviderEvent({...event,eventType:'REDEEMED'},context),{code:'PROVIDER_EVENT_ID_CONFLICT'});
  });
  await t.test('voucher MySQL: event SQL failure rolls back status, exception and message together',async()=>{
    const f=await make(),r=await f.app.execute(f.c,f.login.credential),row=await get(r.redemptionId);
    const context=createTrustedProviderContext({provider:'meituan',storeId:'synthetic-store'});
    const event={externalMessageId:'fault-event',eventType:'REFUNDED',externalOrderId:row.external_order_id};
    await pool.execute('UPDATE '+table('voucher_redemptions')+' SET linked_order_id=? WHERE id=?',['synthetic-fault-linked',r.redemptionId]);
    await setup.query("ALTER TABLE "+table('provider_events')+" ADD CONSTRAINT voucher_test_event_failure CHECK(external_message_id <> 'fault-event')");
    try{
      await assert.rejects(f.app.receiveProviderEvent(event,context),{code:'ER_CHECK_CONSTRAINT_VIOLATED'});
      assert.equal((await get(r.redemptionId)).status,'REDEEMED');
      const[[n]]=await pool.query('SELECT COUNT(*) AS n FROM '+table('voucher_exceptions')+' WHERE redemption_id=?',[r.redemptionId]);assert.equal(Number(n.n),0);
    }finally{await setup.query('ALTER TABLE '+table('provider_events')+' DROP CHECK voucher_test_event_failure');}
    assert.equal((await f.app.receiveProviderEvent(event,context)).processingStatus,'processed');
  });
}
