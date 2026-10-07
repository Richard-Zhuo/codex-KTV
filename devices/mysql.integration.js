import { createTrustedLedgerApplication } from '../ledger/application.js';
import { createMySqlLedgerStore } from '../ledger/mysql-store.js';
import { createMySqlEmployeeStore } from '../employees/mysql-store.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { businessSessionFor } from '../shared/business-session.js';
import { createMySqlRoomControlStore, DeviceCommitOutcomeUnknown } from './mysql-store.js';
import { createRoomControlApplication } from './application.js';
import { FakeKtvRoomControlGateway } from './fake-gateway.js';

export async function testRoomControl({t,pool,setup,auth,provision,seed,inspect,database,table,poolOptions,roster}) {
 let serial=0;
 const make=async({online=true,outcomes={}}={})=>{
  const ledgerId='device-workflow-'+(++serial),login=await provision(['room.open']);
  const [[clock]]=await setup.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%dT%H:%i:%s.%fZ') AS now,HOUR(UTC_TIMESTAMP()) AS hour");
  let offset=15-Number(clock.hour);if(offset>14)offset-=24;if(offset< -12)offset+=24;
  const timeZone='Etc/GMT'+(offset===0?'':offset>0?'-'+offset:'+'+(-offset));
  await seed(ledgerId,state=>{state.rooms[0].order='device-order';state.rooms[0].status='营业中';state.inventory.bw.count=state.inventory.lm.count=state.inventory.drink0.count=100;
   state.orders.push({id:'device-order',kind:'room',room:'V01',status:'营业中',sales:[],payments:[],otherCharges:[],businessSession:businessSessionFor(clock.now,{timeZone})});});
  const gateway=new FakeKtvRoomControlGateway({online,outcomes});
  const invoke=gateway.invoke.bind(gateway);
  gateway.invoke=async(...args)=>{
   // A second connection must acquire both rows while the external call runs.
   const connection=await pool.getConnection();
   try{await connection.query('SET innodb_lock_wait_timeout=1');await connection.beginTransaction();
    await connection.execute('SELECT ledger_id FROM '+table('ledger_heads')+' WHERE ledger_id=? FOR UPDATE',[ledgerId]);
    await connection.execute('SELECT workflow_id FROM '+table('room_control_workflows')+' WHERE ledger_id=? FOR UPDATE',[ledgerId]);
    await connection.rollback();
   }finally{connection.release();}
   return invoke(...args);
  };
  const mappings=[{internalRoomId:'V01',provider:'fake',externalDeviceId:'synthetic-room-device',enabled:true}];
  const appFor=(connectionPool=pool)=>{
   const store=createMySqlRoomControlStore({pool:connectionPool,database,ledgerId,testOnly:true,
    bindSessionRevalidation:createMySqlAuthStore({pool:connectionPool,database}).bindSessionRevalidation});
   return createRoomControlApplication({store,gateway,mappings,allowTestGateway:true,timeoutMs:5000,leaseMs:10000});
  };
  const command={operationKey:'start-device',expectedRevision:0,payload:{orderId:'device-order'}};
  return {ledgerId,login,command,gateway,app:appFor(),appFor};
 };
 const mutations=f=>f.gateway.calls.filter(c=>['closeRoom','openRoom','setCountdown'].includes(c.method));
 await t.test('Stage 4A MySQL: DAY half/dozen prices persist as frozen line snapshots; replay preserves head',async()=>{
  const f=await make();await auth.grantPermission({principalId:f.login.principalId,permissionId:'staff.record'});
  const employee=await roster.createEmployee({displayName:'Synthetic DAY seller'},{actorPrincipalId:f.login.principalId});
  const authStore=createMySqlAuthStore({pool,database});
  const store=createMySqlLedgerStore({pool,database,ledgerId:f.ledgerId,bindSessionRevalidation:authStore.bindSessionRevalidation,
   bindEmployeeResolver:createMySqlEmployeeStore({pool,database}).bindEmployeeResolver});
  const app=createTrustedLedgerApplication({store});
  const request={operationKey:'day-price',expectedRevision:0,action:'sale',payload:{order:'device-order',creditedEmployeeId:employee.employeeId,
   items:[{product:'bw',spec:'half',count:1},{product:'drink0',spec:'half',count:1},{product:'lm',spec:'half',count:1},
    {product:'bw',spec:'dozen',count:1},{product:'drink0',spec:'dozen',count:1},{product:'lm',spec:'dozen',count:1}]}};
  assert.equal((await app.execute(request,f.login.credential)).status,'committed');
  const actual=await inspect(f.ledgerId),order=actual.head.state.orders.at(-1);
  assert.deepEqual(order.sales.map(l=>l.pricePerSaleUnitCents),[5000,5000,6000,10000,10000,12000]);
  for(const line of order.sales){assert.equal(line.pricePlanId,'day-v1');assert.deepEqual(line.businessSession,order.businessSession);}
  await app.execute(request,f.login.credential);assert.deepEqual(await inspect(f.ledgerId),actual);
 });
 await t.test('device migration 008: InnoDB, unique order/operation identity and duplicate install refusal',async()=>{
  const ddl=await readFile(new URL('../database/migrations/008_mysql_room_control.sql',import.meta.url),'utf8');
  const statement=ddl.split('\n').filter(l=>!l.trim().startsWith('--')).join('\n').split(';')[0];
  await assert.rejects(setup.query(statement),{code:'ER_TABLE_EXISTS_ERROR'});
  const [[row]]=await setup.query("SELECT engine FROM information_schema.tables WHERE table_schema=? AND table_name='room_control_workflows'",[database]);assert.equal(row.ENGINE??row.engine,'InnoDB');
 });
 await t.test('device MySQL: offline persists WAIT, reconnect continues same workflow to ACTIVE; ledger untouched',async()=>{
  const f=await make({online:false}),before=await inspect(f.ledgerId);let r=await f.app.start(f.command,f.login.credential);
  r=await f.app.advance(r.id,f.login.credential);assert.equal(r.status,'DEVICE_OFFLINE_WAIT');assert.equal(r.roomReadiness,'WAITING_DEVICE');assert.equal(mutations(f).length,0);
  const independent=mysql.createPool(poolOptions);
  try{const reconnected=f.appFor(independent);r=await reconnected.get(r.id,f.login.credential);assert.equal(r.status,'DEVICE_OFFLINE_WAIT');
   f.gateway.room.online=true;for(let n=0;n<5;n++)r=await reconnected.advance(r.id,f.login.credential);assert.equal(r.status,'ACTIVE');assert.equal(r.roomReadiness,'ACTIVE');
   const again=await reconnected.start(f.command,f.login.credential);assert.equal(again.id,r.id);
  }finally{await independent.end();}
  assert.deepEqual(mutations(f).map(c=>c.method),['closeRoom','openRoom','setCountdown']);assert.deepEqual(await inspect(f.ledgerId),before);
  const [[count]]=await pool.execute('SELECT COUNT(*) AS count FROM '+table('room_control_workflows')+' WHERE ledger_id=?',[f.ledgerId]);assert.equal(Number(count.count),1);
 });
 await t.test('device MySQL: timeout after close persists UNKNOWN; query after reconnect advances without repeat',async()=>{
  const f=await make({outcomes:{closeRoom:(input,g,normal)=>{normal();throw Error('synthetic response lost');}}});
  let r=await f.app.start(f.command,f.login.credential);r=await f.app.advance(r.id,f.login.credential);r=await f.app.advance(r.id,f.login.credential);assert.equal(r.status,'DEVICE_UNKNOWN');
  const independent=mysql.createPool(poolOptions);try{r=await f.appFor(independent).advance(r.id,f.login.credential);assert.equal(r.status,'DEVICE_OPENING');}finally{await independent.end();}
  assert.equal(mutations(f).length,1);assert.ok(f.gateway.calls.some(c=>c.method==='queryRoomState'));
 });
 await t.test('device MySQL: simultaneous claims dispatch once and persist one workflow',async()=>{
  const f=await make();const [a,b]=await Promise.all([f.app.start(f.command,f.login.credential),f.app.start(f.command,f.login.credential)]);assert.equal(a.id,b.id);
  let release;const wait=new Promise(resolve=>release=resolve);f.gateway.outcomes.getRoomStatus=async(input,g,normal)=>{await wait;return normal();};
  const first=f.app.advance(a.id,f.login.credential);for(let n=0;n<50&&!f.gateway.calls.some(c=>c.method==='getRoomStatus');n++)await new Promise(r=>setTimeout(r,5));
  const second=await f.app.advance(a.id,f.login.credential);assert.ok(second.inFlight);release();await first;
  assert.equal(f.gateway.calls.filter(c=>c.method==='getRoomStatus').length,1);
 });
 await t.test('device MySQL: revoked session blocks saved workflow lookup and subsequent gateway dispatch',async()=>{
  const f=await make(),r=await f.app.start(f.command,f.login.credential);await auth.revokeSession({sessionId:f.login.sessionId});
  await assert.rejects(f.app.advance(r.id,f.login.credential),e=>e.code==='AUTHENTICATION_REQUIRED');assert.equal(f.gateway.calls.length,0);
 });
 await t.test('device MySQL: failed claim SQL rolls back and never calls gateway; same operation key retries',async()=>{
  const f=await make();const faulty={getConnection:async()=>{
   const c=await pool.getConnection();return {beginTransaction:c.beginTransaction.bind(c),commit:c.commit.bind(c),rollback:c.rollback.bind(c),release:c.release.bind(c),execute:(sql,args)=>{
    if(sql.startsWith('INSERT INTO')&&sql.includes('room_control_workflows'))throw Error('synthetic device SQL failure');return c.execute(sql,args);}};
  }};
  await assert.rejects(f.appFor(faulty).start(f.command,f.login.credential),/device SQL/);assert.equal(f.gateway.calls.length,0);
  await f.app.start(f.command,f.login.credential);
 });
 await t.test('device MySQL: commit acknowledgement loss returns UNKNOWN and original key locates committed intent',async()=>{
  const f=await make();const dedicated=mysql.createPool(poolOptions);let once=true;
  const faulty={getConnection:async()=>{
   const c=await dedicated.getConnection(),commit=c.commit.bind(c);c.commit=async()=>{await commit();if(once){once=false;throw Error('synthetic commit acknowledgement lost');}};return c;
  }};
  try{await assert.rejects(f.appFor(faulty).start(f.command,f.login.credential),e=>e instanceof DeviceCommitOutcomeUnknown);
   const r=await f.app.start(f.command,f.login.credential);assert.equal(r.status,'DEVICE_PENDING');assert.equal(f.gateway.calls.length,0);
  }finally{await dedicated.end();}
 });
}
