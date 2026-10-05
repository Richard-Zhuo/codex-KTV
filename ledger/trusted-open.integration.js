import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { createMySqlVoucherStore } from '../vouchers/mysql-store.js';
import { createPlatformVoucherApplication,createTrustedProviderContext } from '../vouchers/application.js';
import { FakePlatformVoucherGateway } from '../vouchers/gateways.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createMySqlEmployeeStore } from '../employees/mysql-store.js';
import { createMySqlLedgerStore } from './mysql-store.js';
import { createTrustedLedgerApplication } from './application.js';
import { transact } from '../rules.js';
import { quote } from '../rooms.js';
import { total } from '../sales.js';
import { orderBusinessDaySnapshot } from '../shared/business-day.js';

export async function testTrustedOpen({t,pool,setup,auth,table,provision,seed,inspect,roster,database,poolOptions,wrapConnection}){
 const [[clock]]=await pool.query('SELECT HOUR(UTC_TIMESTAMP()) AS hour');
 let offset=20-Number(clock.hour);if(offset>14)offset-=24;if(offset< -12)offset+=24;
 const businessTimeZone='Etc/GMT'+(offset===0?'':offset>0?'-'+offset:'+'+(-offset));
 new Intl.DateTimeFormat('en',{timeZone:businessTimeZone}); // Explicit synthetic store zone, never machine default.
 let serial=0;
 const prepare=s=>{s.rooms[0].status=s.rooms[1].status='空闲';s.inventory.bw.count=100;s.inventory.qd.count=null;s.inventory.lm.count=0;};
 const get=async id=>{const[[r]]=await pool.execute('SELECT * FROM '+table('voucher_redemptions')+' WHERE id=?',[id]);return r;};
 const make=async({redeem=true,setupState=()=>{}}={})=>{
  const id='trusted-open-'+(++serial),login=await provision(['room.open','staff.record']);
  const employee=await roster.createEmployee({displayName:'Synthetic Same Name'},{actorPrincipalId:login.principalId});
  const original=await seed(id,s=>{prepare(s);setupState(s);}),gateway=new FakePlatformVoucherGateway();
  const voucherStoreFor=connectionPool=>createMySqlVoucherStore({pool:connectionPool,database,ledgerId:id,provider:'meituan',storeId:'synthetic-store',
   bindSessionRevalidation:createMySqlAuthStore({pool:connectionPool,database}).bindSessionRevalidation,
   packageMappings:[{productId:'synthetic-product',packageIds:['room.small.day','room.small.night']}]});
  const voucherApp=createPlatformVoucherApplication({allowTestGateway:true,store:voucherStoreFor(pool),gateway,voucherCodeSecret:Buffer.alloc(32,9)});
  const receipt=redeem?await voucherApp.execute({operationKey:'redeem-'+id,expectedRevision:0,action:'redeemVoucher',payload:{voucherCode:String(6000000000000+serial)}},login.credential):null;
  const command=(key='open-'+id,revision=0,changes={})=>({operationKey:key,expectedRevision:revision,action:'open',
   payload:{room:'V01',beer:'bw',creditedEmployeeId:employee.employeeId,...(receipt?{voucherRedemptionId:receipt.redemptionId}:{}),...changes}});
  const appFor=({connectionPool=pool,binding=true,fault=null,afterHead=null,beforeHead=null}={})=>{
   const calls=[];let context,executions=0;
   const watched={getConnection:async()=>{
    const c=wrapConnection(await connectionPool.getConnection(),calls),execute=c.execute.bind(c);
    c.execute=async(sql,values)=>{
     const head=sql.includes('ledger_heads')&&sql.startsWith('SELECT')&&sql.includes('FOR UPDATE');
     if(head&&beforeHead)await beforeHead();
     const result=await execute(sql,values);if(head&&afterHead)await afterHead();
     if(fault==='after-link'&&sql.startsWith('UPDATE')&&sql.includes('voucher_redemptions'))throw Error('synthetic unknown SQL driver failure after link');
     return result;
    };return c;
   }};
   const vs=voucherStoreFor(watched);
   const store=createMySqlLedgerStore({pool:watched,database,ledgerId:id,
    bindSessionRevalidation:createMySqlAuthStore({pool:watched,database}).bindSessionRevalidation,
    bindEmployeeResolver:createMySqlEmployeeStore({pool:watched,database}).bindEmployeeResolver,
    ...(binding?{bindVoucherRedemptions:vs.bindVoucherRedemptions}:{})});
   const app=createTrustedLedgerApplication({store,businessTimeZone,transactCommand:(...args)=>{
    context=args[4].context;executions++;calls.push({kind:'transact'});const result=transact(...args);
    if(fault==='domain')throw Error('synthetic unknown domain failure');return result;
   }});
   return{app,calls,context:()=>context,executions:()=>executions};
  };
  return{id,login,employee,original,gateway,voucherApp,receipt,command,appFor,run:appFor()};
 };
 const unchanged=async(f,before)=>assert.deepEqual(await inspect(f.id),before);
 await t.test('open MySQL: ordinary room/package/inventory/reservation and frozen businessDate commit with independent session/employee',async()=>{
  const f=await make({redeem:false});
  const result=await f.run.app.execute(f.command(undefined,0,{actorId:'forged',principalId:'forged',person:'forged',role:'administrator',permissions:['*'],clock:'1900-01-01'}),f.login.credential);
  const actual=await inspect(f.id),o=actual.head.state.orders.at(-1),context=f.run.context();
  assert.equal(result.status,'committed');assert.match(o.id,/^[0-9a-f-]{36}$/);assert.equal(o.actualActorPrincipalId,f.login.principalId);
  assert.equal(o.recordedBy,f.login.principalId);assert.equal(o.person,f.employee.displayName);assert.equal(o.creditedEmployeeId,f.employee.employeeId);
  assert.equal(f.employee.principalId,null);assert.notEqual(o.creditedEmployeeId,o.actualActorPrincipalId);assert.equal(o.time,context.dbNow);
  assert.deepEqual({businessDate:o.businessDate,businessDayRuleVersion:o.businessDayRuleVersion,businessTimeZone:o.businessTimeZone},orderBusinessDaySnapshot(context.dbNow,{timeZone:businessTimeZone}));
  const q=quote(f.original.rooms[0].type,context.dbNow,'bw','',f.original.catalog,businessTimeZone);
  assert.equal(o.base,q.base);assert.equal(o.gift,q.gift);assert.equal(actual.head.state.inventory.bw.count,100-q.bottles);
  assert.equal(actual.head.state.inventory.qd.count,null);assert.equal(actual.head.state.inventory.lm.count,0);
  assert.deepEqual(actual.head.state.orders[0],f.original.orders[0]);assert.equal(actual.head.state.rooms[0].status,'营业中');
  assert.equal(actual.head.state.ledger.at(-1).actualActorPrincipalId,f.login.principalId);
  assert.equal(actual.audit.length,1);assert.equal(actual.head.revision,1);assert.equal(f.gateway.calls.redeemVoucher,0);
 });
 await t.test('open MySQL: auth before redemption row lock, domain then link/head/operation/audit on exactly one caller connection',async()=>{
  const f=await make(),c=await pool.getConnection();let borrows=0;
  try{
   const run=f.appFor({connectionPool:{getConnection:async()=>{borrows++;return wrapConnection(c,[],false);}}});
   const result=await run.app.execute(f.command(),f.login.credential),actual=await inspect(f.id),o=actual.head.state.orders.at(-1);
   assert.equal(result.status,'committed');assert.equal(borrows,1);assert.equal(total(o),0);assert.equal(o.voucher.status,'REDEEMED');
   assert.equal(o.voucherRedemptionId,f.receipt.redemptionId);assert.equal((await get(f.receipt.redemptionId)).linked_order_id,o.id);
   const at=(name,start,end='')=>run.calls.findIndex(call=>call.kind==='sql'&&call.sql.includes(name)&&call.sql.startsWith(start)&&call.sql.includes(end));
   const sequence=[run.calls.findIndex(c=>c.kind==='begin'),at('ledger_heads','SELECT','FOR UPDATE'),
    at('auth_accounts','SELECT','FOR UPDATE'),at('auth_sessions','SELECT','FOR UPDATE'),at('auth_grants','SELECT','FOR UPDATE'),
    at('voucher_redemptions','SELECT','FOR UPDATE'),run.calls.findIndex(c=>c.kind==='transact'),at('voucher_redemptions','UPDATE'),
    at('ledger_heads','UPDATE'),at('ledger_operations','INSERT'),at('ledger_success_audit','INSERT'),run.calls.findIndex(c=>c.kind==='commit')];
   assert.ok(sequence.every((n,i)=>n>=0&&(!i||n>sequence[i-1])),JSON.stringify(sequence));assert.equal(f.gateway.calls.redeemVoucher,1);
  }finally{c.release();}
 });
 for(const status of ['PENDING','REDEEMING','FAILED','UNKNOWN','REVERSED','REFUNDED'])await t.test('open MySQL: '+status+' never covers fees or creates an order',async()=>{
  const f=await make();await pool.execute('UPDATE '+table('voucher_redemptions')+' SET status=? WHERE id=?',[status,f.receipt.redemptionId]);
  const result=await f.run.app.execute(f.command(),f.login.credential),actual=await inspect(f.id);
  assert.equal(result.status,'business-rejected');assert.deepEqual(actual.head.state,f.original);assert.equal(actual.head.revision,0);assert.equal(actual.audit.length,0);
  assert.equal((await get(f.receipt.redemptionId)).linked_order_id,null);assert.equal(f.gateway.calls.redeemVoucher,1);
 });
 await t.test('open MySQL: different store, missing record and unconfigured product are fail closed',async()=>{
  for(const kind of ['store','missing','product']){
   const f=await make();if(kind==='store')await pool.execute('UPDATE '+table('voucher_redemptions')+' SET store_id=? WHERE id=?',['another-store',f.receipt.redemptionId]);
   if(kind==='product')await pool.execute('UPDATE '+table('voucher_redemptions')+' SET product_id=? WHERE id=?',['unconfigured',f.receipt.redemptionId]);
   const request=f.command(undefined,0,kind==='missing'?{voucherRedemptionId:randomUUID()}:{});
   if(kind==='product')await assert.rejects(f.run.app.execute(request,f.login.credential),{code:'AUTHORIZATION_DENIED'});
   else assert.equal((await f.run.app.execute(request,f.login.credential)).status,'business-rejected');
   const actual=await inspect(f.id);assert.deepEqual(actual.head.state,f.original);assert.equal(actual.head.revision,0);assert.equal(actual.audit.length,0);
   assert.equal((await get(f.receipt.redemptionId)).linked_order_id,null);
  }
 });
 await t.test('open MySQL: missing binding port and browser code/flags/raw JSON never fall back to demo',async()=>{
  const f=await make(),before=await inspect(f.id);
  await assert.rejects(f.appFor({binding:false}).app.execute(f.command(),f.login.credential),TypeError);await unchanged(f,before);
  for(const extras of [{receiptCode:'0012345678901'},{voucherCode:'0012345678901'},{redeemed:true},{verified:true},{status:'REDEEMED'},
   {skillResult:{flowId:'forged'}},{voucher:{status:'REDEEMED'}},{providerEvidence:{providerFlowId:'forged'}}]){
   const request=f.command('forged-'+Object.keys(extras)[0],0,extras);
   assert.equal((await f.run.app.execute(request,f.login.credential)).status,'business-rejected');
   assert.equal((await get(f.receipt.redemptionId)).linked_order_id,null);
  }
  assert.equal((await inspect(f.id)).head.revision,0);assert.equal(f.gateway.calls.redeemVoucher,1);
 });
 await t.test('open MySQL: authorization denial consumes no key; linked employee or browser grants never authorize actor',async()=>{
  for(const revoke of ['room.open','staff.record']){
   const f=await make(),before=await inspect(f.id),request=f.command(undefined,0,{permissions:['*'],role:'administrator',actorId:'forged'});
   await auth.revokePermission({principalId:f.login.principalId,permissionId:revoke});
   await assert.rejects(f.run.app.execute(request,f.login.credential),{code:'AUTHORIZATION_DENIED'});await unchanged(f,before);
   assert.equal((await get(f.receipt.redemptionId)).linked_order_id,null);assert.equal(f.run.executions(),0);
   await auth.grantPermission({principalId:f.login.principalId,permissionId:revoke});assert.equal((await f.run.app.execute(request,f.login.credential)).status,'committed');
  }
 });
 await t.test('open MySQL: unknown/disabled employee rejects without business or voucher partial writes',async()=>{
  for(const kind of ['unknown','disabled']){
   const f=await make();if(kind==='disabled')await roster.disableEmployee({employeeId:f.employee.employeeId},{actorPrincipalId:f.login.principalId});
   const result=await f.run.app.execute(f.command(undefined,0,kind==='unknown'?{creditedEmployeeId:randomUUID()}:{}),f.login.credential),actual=await inspect(f.id);
   assert.equal(result.status,'business-rejected');assert.equal(actual.head.revision,0);assert.deepEqual(actual.head.state,f.original);
   assert.equal((await get(f.receipt.redemptionId)).linked_order_id,null);assert.equal(actual.audit.length,0);
  }
 });
 await t.test('open MySQL: reconnect/revoke replay returns terminal without rebinding; actor/payload/revision conflicts unchanged',async()=>{
  const f=await make(),request=f.command(),result=await f.run.app.execute(request,f.login.credential),before=await inspect(f.id),row=await get(f.receipt.redemptionId);
  await auth.revokePermission({principalId:f.login.principalId,permissionId:'room.open'});
  const reconnect=mysql.createPool(poolOptions);try{assert.deepEqual(await f.appFor({connectionPool:reconnect}).app.execute(request,f.login.credential),result);}finally{await reconnect.end();}
  assert.deepEqual(await get(f.receipt.redemptionId),row);await unchanged(f,before);
  await assert.rejects(f.run.app.execute(f.command('new',1),f.login.credential),{code:'AUTHORIZATION_DENIED'});
  for(const changed of [{...request,expectedRevision:1},{...request,payload:{...request.payload,room:'V02'}}])assert.equal((await f.run.app.execute(changed,f.login.credential)).reason,'request-mismatch');
  const other=await provision(['room.open','staff.record']);assert.equal((await f.run.app.execute(request,other.credential)).reason,'actor-mismatch');
  await unchanged(f,before);assert.equal(f.gateway.calls.redeemVoucher,1);
 });
 for(const change of ['disabled','revoked','idle','absolute'])await t.test('open MySQL: '+change+' auth cannot replay an existing terminal',async()=>{
  const f=await make(),request=f.command();await f.run.app.execute(request,f.login.credential);const before=await inspect(f.id);
  if(change==='disabled')await auth.disableAccount({principalId:f.login.principalId});
  else if(change==='revoked')await auth.logout(f.login.token);
  else await pool.execute('UPDATE '+table('auth_sessions')+' SET '+(change==='idle'?'idle_expires_at=created_at':'idle_expires_at=created_at,absolute_expires_at=created_at+INTERVAL 1 MICROSECOND')+' WHERE session_id=?',[f.login.sessionId]);
  await assert.rejects(f.run.app.execute(request,f.login.credential),{code:'AUTHENTICATION_REQUIRED'});await unchanged(f,before);
 });
 for(const sameKey of [false,true])await t.test('open MySQL: two real independent devices '+(sameKey?'replay one key':'compete at same revision')+' bind one voucher once',async()=>{
  const f=await make(),a=await pool.getConnection(),b=await pool.getConnection();let entered,release,started;
  const firstLocked=new Promise(r=>entered=r),gate=new Promise(r=>release=r),secondStarted=new Promise(r=>started=r);
  try{
   const[[ai]]=await a.query('SELECT CONNECTION_ID() AS id');const[[bi]]=await b.query('SELECT CONNECTION_ID() AS id');assert.notEqual(ai.id,bi.id);
   t.diagnostic('open connections '+ai.id+'/'+bi.id);
   const first=f.appFor({connectionPool:{getConnection:async()=>wrapConnection(a,[],false)},afterHead:async()=>{entered();await gate;}});
   const second=f.appFor({connectionPool:{getConnection:async()=>wrapConnection(b,[],false)},beforeHead:async()=>started()});
   const request=f.command('device-a'),pa=first.app.execute(request,f.login.credential);await firstLocked;
   const pb=second.app.execute(sameKey?request:f.command('device-b',0,{room:'V02'}),f.login.credential);await secondStarted;release();
   const [ra,rb]=await Promise.all([pa,pb]);assert.equal(ra.status,'committed');
   if(sameKey)assert.deepEqual(rb,ra);else assert.equal(rb.status,'revision-conflict');
   const actual=await inspect(f.id);assert.equal(actual.head.revision,1);assert.equal(actual.head.state.orders.length,f.original.orders.length+1);assert.equal(actual.audit.length,1);
   const o=actual.head.state.orders.at(-1);assert.equal((await get(f.receipt.redemptionId)).linked_order_id,o.id);assert.equal(f.gateway.calls.redeemVoucher,1);
   assert.equal((await f.run.app.execute(f.command('already-bound',1,{room:'V02'}),f.login.credential)).status,'business-rejected');
  }finally{release?.();a.release();b.release();}
 });
 for(const target of ['ledger_heads','ledger_operations','ledger_success_audit','voucher_redemptions'])await t.test('open MySQL: mid-SQL '+target+' CHECK failure rolls back state/inventory/reservation/binding/key/audit together',async()=>{
  const f=await make({setupState:s=>{s.reservations.push({id:123,room:'V01',at:new Date().toISOString(),session:'night',status:'已预订',person:'old snapshot'});}}),
   request=f.command('fault-open'),before=await inspect(f.id),row=await get(f.receipt.redemptionId),check='voucher_open_test_fault';
  const predicate=target==='ledger_heads'?"ledger_id <> '"+f.id+"' OR revision=0":target==='voucher_redemptions'?
   "id <> '"+f.receipt.redemptionId+"' OR linked_order_id IS NULL":"ledger_id <> '"+f.id+"' OR operation_key <> 'fault-open'";
  await setup.query('ALTER TABLE '+table(target)+' ADD CONSTRAINT '+check+' CHECK('+predicate+')');
  try{await assert.rejects(f.run.app.execute(request,f.login.credential),{code:'ER_CHECK_CONSTRAINT_VIOLATED'});await unchanged(f,before);assert.deepEqual(await get(f.receipt.redemptionId),row);}
  finally{await setup.query('ALTER TABLE '+table(target)+' DROP CHECK '+check);}
  assert.equal((await f.run.app.execute(request,f.login.credential)).status,'committed');assert.equal(f.gateway.calls.redeemVoucher,1);
 });
 for(const fault of ['domain','after-link'])await t.test('open MySQL: unknown '+fault+' exception fully rolls back and leaves original key reusable',async()=>{
  const f=await make(),before=await inspect(f.id),row=await get(f.receipt.redemptionId),request=f.command();
  await assert.rejects(f.appFor({fault}).app.execute(request,f.login.credential));await unchanged(f,before);assert.deepEqual(await get(f.receipt.redemptionId),row);
  assert.equal((await f.run.app.execute(request,f.login.credential)).status,'committed');assert.equal(f.gateway.calls.redeemVoucher,1);
 });
 await t.test('open MySQL: provider success then room/inventory/revision rejection remains REDEEMED unlinked; next open never consumes again',async()=>{
  for(const kind of ['dirty','inventory','revision']){
   const f=await make({setupState:s=>{if(kind==='dirty')s.rooms[0].status='待清洁';if(kind==='inventory')s.inventory.bw.count=0;}});
   const result=await f.run.app.execute(f.command('bad-open',kind==='revision'?1:0),f.login.credential);
   assert.equal(result.status,kind==='revision'?'revision-conflict':'business-rejected');
   const row=await get(f.receipt.redemptionId);assert.equal(row.status,'REDEEMED');assert.equal(row.linked_order_id,null);assert.equal(f.gateway.calls.redeemVoucher,1);
   if(kind!=='inventory')assert.equal((await f.run.app.execute(f.command('valid-open',0,kind==='dirty'?{acceptDirty:true}:{}),f.login.credential)).status,'committed');
   assert.equal(f.gateway.calls.redeemVoucher,1);
  }
 });
 for(const terminal of ['REVERSED','REFUNDED'])await t.test('open MySQL: linked '+terminal+' event changes provider fact and exception only',async()=>{
  const f=await make();await f.run.app.execute(f.command(),f.login.credential);const before=await inspect(f.id),row=await get(f.receipt.redemptionId);
  const context=createTrustedProviderContext({provider:'meituan',storeId:'synthetic-store'}),event={externalMessageId:'linked-'+f.id,
   providerEnvelopeMessageId:'envelope-'+f.id,eventType:terminal,externalOrderId:row.external_order_id};
  assert.equal((await f.voucherApp.receiveProviderEvent(event,context)).processingStatus,'processed');await unchanged(f,before);
  assert.equal((await get(f.receipt.redemptionId)).status,terminal);
  const[[count]]=await pool.query('SELECT COUNT(*) AS n FROM '+table('voucher_exceptions')+' WHERE redemption_id=?',[f.receipt.redemptionId]);assert.equal(Number(count.n),1);
 });
}
