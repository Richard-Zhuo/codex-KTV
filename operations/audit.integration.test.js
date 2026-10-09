import test from 'node:test';import assert from 'node:assert/strict';
import {withBackupFixture} from '../test-support/backup-fixture.js';import {createMySqlLedgerStore} from '../ledger/mysql-store.js';import {createMySqlEmployeeStore} from '../employees/mysql-store.js';import {createTrustedLedgerApplication} from '../ledger/application.js';
import {createOperationalStore} from './store.js';import {createIncidentLifecycle} from './incidents.js';import {createAlertDispatcher} from './alerts.js';
test('audit real MySQL: committed retail order/payment/inventory survive throw, timeout and negative alert acknowledgement',{skip:!process.env.LEDGER_MYSQL_TEST_URL,timeout:60000},()=>withBackupFixture(async f=>{
 const store=createMySqlLedgerStore({pool:f.pool,database:'jbhh_ktv_test',ledgerId:f.ledgerId,bindSessionRevalidation:f.authStore.bindSessionRevalidation,bindEmployeeResolver:createMySqlEmployeeStore({pool:f.pool,database:'jbhh_ktv_test'}).bindEmployeeResolver});
 const [[clock]]=await f.pool.query('SELECT HOUR(UTC_TIMESTAMP()) AS hour');let offset=20-Number(clock.hour);if(offset>14)offset-=24;if(offset< -12)offset+=24;
 const zone='Etc/GMT'+(offset===0?'':offset>0?'-'+offset:'+'+(-offset)),app=createTrustedLedgerApplication({store,businessTimeZone:zone});
 const operational=await createOperationalStore(f.dir,'audit'),life=createIncidentLifecycle({store:operational,scope:'audit',logger:{log(){}}});
 const outcomes=[async()=>{throw Error('synthetic failure');},()=>new Promise(()=>{}),async()=>({accepted:false})];
 for(let n=0;n<outcomes.length;n++){
  const before=await store.read(),command={action:'retailSale',operationKey:'audit-committed-'+n,expectedRevision:before.revision,payload:{creditedEmployeeId:f.people[0].employeeId,items:[{product:'bw',spec:'dozen',count:1}],payments:[{method:'现金',amount:11800}]}};
  assert.equal((await app.execute(command,f.credential)).status,'committed');const committed=await store.read();
  assert.equal(committed.revision,before.revision+1);assert.equal(committed.state.orders.length,before.state.orders.length+1);assert.equal(committed.state.inventory.bw.count,before.state.inventory.bw.count-12);assert.equal(committed.state.orders.at(-1).payments.reduce((sum,p)=>sum+p.amount,0),11800);
  const incident=await life.condition('DEVICE_UNKNOWN',true,{roomId:'V01',workflowId:'audit-'+n});
  await createAlertDispatcher({store:operational,logger:{log(){}},transport:{send:outcomes[n]},timeoutMs:10,maxAttempts:1}).tick();
  assert.equal(operational.read().outbox.find(e=>e.incidentId===incident.incidentId).state,'EXHAUSTED');assert.deepEqual(await store.read(),committed);
 }
 const before=await store.read();
 for(const code of ['DATABASE_UNAVAILABLE','TLS_EXPIRING','BACKUP_OVERDUE','DEVICE_OFFLINE','DEVICE_UNKNOWN','AUTH_REPEATED_FAILURES']){await life.condition(code,true,{component:'audit',roomId:'V06'});await life.condition(code,false,{component:'audit',roomId:'V06'});}
 assert.deepEqual(await store.read(),before);
}));
