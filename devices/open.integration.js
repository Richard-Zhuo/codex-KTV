import assert from 'node:assert/strict';
import http from 'node:http';
import mysql from 'mysql2/promise';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createMySqlLedgerStore } from '../ledger/mysql-store.js';
import { createTrustedLedgerApplication } from '../ledger/application.js';
import { createHttpApi } from '../http/api.js';
import { createCurrentSessionReader } from '../http/query.js';
import { createRoomControlRuntime } from './runtime.js';
import { FakeKtvRoomControlGateway } from './fake-gateway.js';
import { readDeviceHead } from './mysql-port.js';

export async function testOpenDevice({t,pool,auth,seed,inspect,roster,employeeStore,database,table,poolOptions}) {
 const [[clock]]=await pool.query('SELECT HOUR(UTC_TIMESTAMP()) AS hour');
 let offset=20-Number(clock.hour);if(offset>14)offset-=24;if(offset< -12)offset+=24;
 const businessTimeZone='Etc/GMT'+(offset===0?'':offset>0?'-'+offset:'+'+(-offset));
 let serial=0;
 async function make({online=true,open=false,outcomes={},mapping=true,mode='required'}={}) {
  const ledgerId='stage4c-'+(++serial),loginIdentifier=ledgerId,password='synthetic-stage4c-only';
  const {principalId}=await auth.createAccount({loginIdentifier,password});
  for(const permissionId of ['room.open','staff.record','order.sale','backend.view'])await auth.grantPermission({principalId,permissionId});
  const employee=await roster.createEmployee({displayName:'Synthetic Stage4C'}, {actorPrincipalId:principalId});
  await roster.linkPrincipal({employeeId:employee.employeeId,principalId},{actorPrincipalId:principalId});
  await seed(ledgerId,s=>{s.rooms[0].status='空闲';s.inventory.bw.count=100;});
  if(mapping)await pool.execute('INSERT INTO '+table('room_device_mappings')+' (ledger_id,internal_room_id,provider,external_device_id,enabled) VALUES (?,?,?,?,1)',[ledgerId,'V01','fake','synthetic-'+serial]);
  const gateway=new FakeKtvRoomControlGateway({online,open,outcomes});
  let failCommit=false;
  const watched={getConnection:async()=>{
    const c=await pool.getConnection(),execute=c.execute.bind(c);
    c.execute=async(sql,args)=>{if(failCommit && sql.startsWith('UPDATE')&&sql.includes('ledger_heads')){failCommit=false;throw Error('synthetic failure after workflow insert');}return execute(sql,args);};return c;
  }};
  const authStore=createMySqlAuthStore({pool,database});
  const store=createMySqlLedgerStore({pool:watched,database,ledgerId,deviceControlMode:mode,
    bindSessionRevalidation:authStore.bindSessionRevalidation,bindEmployeeResolver:employeeStore.bindEmployeeResolver});
  const runtimeFor=p=>createRoomControlRuntime({pool:p,database,ledgerId,authStore,gateway,testOnly:true,intervalMs:100});
  let runtime=runtimeFor(pool),api;
  const server=http.createServer((req,res)=>{void api.handle(req,res);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const application=createTrustedLedgerApplication({store,businessTimeZone});
  api=createHttpApi({application,store,authService:auth,employeeStore,businessTimeZone,
    sessionReader:createCurrentSessionReader({pool,authStore}),deviceSnapshot:(c,h)=>readDeviceHead(c,database,h),origin,environment:'development',allowInsecureCookie:true,logger:{error(){}}});
  const request=async(path,{body,cookie,csrf}={})=>{
    const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json',Origin:origin}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},body:body?JSON.stringify(body):undefined});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const signed=await request('/api/v1/auth/login',{body:{loginIdentifier,password}});
  assert.equal(signed.status,200);const session={cookie:signed.cookie,csrf:signed.body.csrfToken};
  const body={operationKey:'open-'+ledgerId,expectedRevision:0,payload:{room:'V01',beer:'bw',creditedEmployeeId:employee.employeeId}};
  return {failNextCommit:()=>{failCommit=true;},ledgerId,gateway,runtimeFor,get runtime(){return runtime;},set runtime(v){runtime=v;},request,session,body,
    open:(b=body)=>request('/api/v1/commands/open',{...session,body:b}),
    snapshot:()=>request('/api/v1/store/snapshot',session),
    mutations:()=>gateway.calls.filter(c=>['openRoom','closeRoom'].includes(c.method)),
    async close(){await runtime.stop();await new Promise(r=>server.close(r));}};
 }
 const facts=async f=>{
  const a=await inspect(f.ledgerId),orders=a.head.state.orders.filter(o=>o.kind==='room');
  const [[count]]=await pool.execute('SELECT COUNT(*) AS n FROM '+table('room_control_workflows')+' WHERE ledger_id=?',[f.ledgerId]);
  return {orders:orders.length,workflows:Number(count.n),stock:a.head.state.inventory.bw.count,
    payments:orders.reduce((n,o)=>n+o.payments.length,0),packageIds:orders.map(o=>o.packageId),operations:a.operations.filter(o=>o.terminal_status==='committed').length,audits:a.audit.length};
 };
 const progress=async f=>(await f.snapshot()).body.view.workspace.rooms.find(r=>r.id==='V01');
 const finish=async f=>{for(let n=0;n<8;n++){await f.runtime.worker.tick();if((await progress(f)).businessState==='ACTIVE')return;}assert.fail('Workflow did not become ACTIVE');};
 for(const [name,options] of [
  ['initial CLOSED skips close',{open:false}],['initial OPEN closes before combined open',{open:true}],
  ['open response lost reconciles without repeating',{outcomes:{openRoom:(i,g,normal)=>{normal();throw Error('synthetic response lost');}}}],
  ['ACK plus query timeout remains verification pending',{outcomes:{openRoom:(i,g,normal)=>{normal();return g.evidence(i,{kind:'ACKNOWLEDGED',acknowledged:true,settled:false,sentAt:new Date().toISOString()});},queryRoomState:[new Error('synthetic query timeout')]}}]
 ]) await t.test('Stage4C HTTP/MySQL: '+name,async()=>{
  const f=await make(options);try{
   const result=await f.open();assert.equal(result.status,200);assert.equal(result.body.result.businessState,'OPENING');
   assert.ok(result.body.result.orderId);assert.ok(result.body.result.deviceWorkflowId);
   assert.equal(f.gateway.calls.length,0,'HTTP only commits local facts');
   assert.equal((await progress(f)).businessState,'OPENING');const once=await facts(f);
   assert.equal(once.orders,1);assert.equal(once.workflows,1);assert.equal(once.payments,0);assert.equal(once.stock<100,true);
   assert.deepEqual((await f.open()).body,result.body,'Lost HTTP response replays original committed intent');
   if(options.outcomes) {
    await f.runtime.worker.tick();await f.runtime.worker.tick();
    if(name.startsWith('ACK')) {
      await f.runtime.worker.tick();const waiting=await progress(f);
      assert.equal(waiting.deviceControl.verificationPending,true);assert.equal(waiting.deviceControl.mutationUnknown,false);
    } else {const unknown=await progress(f);assert.equal(unknown.deviceControl.status,'DEVICE_UNKNOWN');assert.equal(unknown.deviceControl.mutationUnknown,true);}
    assert.equal(f.mutations().filter(c=>c.method==='openRoom').length,1);
   }
   await finish(f);assert.deepEqual(await facts(f),once);
   assert.deepEqual(f.mutations().map(c=>c.method),options.open?['closeRoom','openRoom']:['openRoom']);
   const stale=await f.open({...f.body,operationKey:'other-client'});assert.equal(stale.body.error.code,'revision_conflict');
   const duplicate=await f.open({...f.body,operationKey:'other-current',expectedRevision:1});assert.equal(duplicate.body.error.code,'business_rejection');
   assert.deepEqual(await facts(f),once);
  }finally{await f.close();}
 });
 await t.test('Stage4C offline WAIT survives restart, same order and workflow, server worker needs no employee session',async()=>{
  const f=await make({online:false});const other=mysql.createPool(poolOptions);
  try{await f.open();await f.runtime.worker.tick();assert.equal((await progress(f)).businessState,'WAITING_DEVICE');assert.equal(f.mutations().length,0);
   const once=await facts(f);await f.runtime.stop();f.runtime=f.runtimeFor(other);
   await f.runtime.worker.tick();assert.equal((await progress(f)).businessState,'WAITING_DEVICE');
   const sale=await f.request('/api/v1/commands/sale',{...f.session,body:{operationKey:'sale-before-ready',expectedRevision:1,payload:{order:(await inspect(f.ledgerId)).head.state.orders.at(-1).id,creditedEmployeeId:(await inspect(f.ledgerId)).head.state.orders.at(-1).creditedEmployeeId,items:[]}}});
   assert.equal(sale.body.error.code,'business_rejection');
   f.gateway.room.online=true;f.runtime.start();for(let n=0;n<50&&(await progress(f)).businessState!=='ACTIVE';n++)await new Promise(r=>setTimeout(r,50));
   assert.equal((await progress(f)).businessState,'ACTIVE');assert.deepEqual(await facts(f),once);assert.equal(f.mutations().length,1);
  }finally{await f.close();await other.end();}
 });
 await t.test('Stage4C verification-pending restart is query-only; elapsed remaining seconds confirms without exact target echo',async()=>{
  const f=await make({outcomes:{openRoom:(i,g,normal)=>{normal();return g.evidence(i,{kind:'ACKNOWLEDGED',acknowledged:true,settled:false,sentAt:new Date().toISOString()});},queryRoomState:(i,g)=>g.evidence(i,{room:{online:true,open:true,countdownTargetEndAt:null,remainingCountdownSeconds:i.countdownSeconds,observedAt:new Date().toISOString()}})}});
  const other=mysql.createPool(poolOptions);
  try{await f.open();await f.runtime.worker.tick();await f.runtime.worker.tick();await f.runtime.worker.tick();
   assert.equal((await progress(f)).businessState,'OPENING');const once=await facts(f),opens=f.mutations().length;
   const [rows]=await pool.execute('SELECT state_json FROM '+table('room_control_workflows')+' WHERE ledger_id=?',[f.ledgerId]);
   const record=typeof rows[0].state_json==='string'?JSON.parse(rows[0].state_json):rows[0].state_json;
   f.gateway.outcomes.queryRoomState=(i,g)=>g.evidence(i,{room:{online:true,open:true,countdownTargetEndAt:null,
    remainingCountdownSeconds:record.openDispatch.requestedCountdownSeconds-Math.floor((Date.now()-Date.parse(record.openDispatch.sentAt))/1000),observedAt:new Date().toISOString()}});
   await f.runtime.stop();f.runtime=f.runtimeFor(other);await finish(f);assert.equal(f.mutations().length,opens);assert.deepEqual(await facts(f),once);
  }finally{await f.close();await other.end();}
 });
 await t.test('Stage4C missing mapping fails closed; disabled mode has explicit DISABLED evidence',async()=>{
  const f=await make({mapping:false});try{const r=await f.open();assert.equal(r.body.error.code,'business_rejection');assert.match(r.body.result.reason,/尚未完成系统绑定/);assert.equal(r.body.result.reasonCode,'device_mapping_required');assert.equal((await facts(f)).orders,0);assert.equal(f.mutations().length,0);}finally{await f.close();}
  const g=await make({mode:'disabled',mapping:false});try{const r=await g.open();assert.equal(r.body.result.businessState,'ACTIVE');assert.equal(r.body.result.deviceControl.status,'DISABLED');assert.equal((await facts(g)).workflows,0);}finally{await g.close();}
 });
 await t.test('Stage4C two clients same revision commit at most one opening',async()=>{
  const f=await make();try{const results=await Promise.all([f.open(),f.open({...f.body,operationKey:'concurrent-other'})]);assert.equal(results.filter(r=>r.status===200).length,1);assert.equal((await facts(f)).orders,1);assert.equal((await facts(f)).workflows,1);assert.equal(f.mutations().length,0);}finally{await f.close();}
 });
 await t.test('Stage4C rollback after workflow insert preserves original key and all business facts',async()=>{
  const f=await make();try{f.failNextCommit();assert.equal((await f.open()).status,500);
   const failed=await facts(f);assert.equal(failed.orders,0);assert.equal(failed.workflows,0);assert.equal(failed.stock,100);assert.equal(failed.operations,0);assert.equal(f.mutations().length,0);
   assert.equal((await f.open()).status,200);assert.equal((await facts(f)).orders,1);assert.equal((await facts(f)).workflows,1);
  }finally{await f.close();}
 });
 await t.test('Stage4C provider side effects execute without holding the ledger transaction',async()=>{
  const f=await make();try{f.gateway.outcomes.openRoom=async(i,g,normal)=>{
    const c=await pool.getConnection();try{await c.beginTransaction();await c.query('SELECT revision FROM '+table('ledger_heads')+' WHERE ledger_id=? FOR UPDATE NOWAIT',[f.ledgerId]);}finally{await c.rollback();c.release();}return normal();
   };await f.open();await finish(f);assert.equal(f.mutations().length,1);
  }finally{await f.close();}
 });
 await t.test('Stage4C rejects browser countdown, state and device binding authority',async()=>{
  const f=await make();try{for(const field of ['countdownSeconds','targetEndAt','deviceWorkflowId','businessState','deviceControl']){const r=await f.open({...f.body,payload:{...f.body.payload,[field]:300}});assert.equal(r.body.error.code,'invalid_input');}assert.equal((await facts(f)).orders,0);}finally{await f.close();}
 });
}
