import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createOperationalStore} from './store.js';
import {createIncidentLifecycle} from './incidents.js';
import {operationalEvent} from './contract.js';
import {monitoringConfig,observeWorkflow,tlsSummary,directorySummary,boundedProbe} from './monitors.js';
async function fixture(work){const dir=await mkdtemp(join(tmpdir(),'ktv-operations-test-'));try{await work(dir);}finally{await rm(dir,{recursive:true,force:true});}}
test('incident persists, deduplicates and resolves original identity across restart; retention protects active history',()=>fixture(async dir=>{
 let time=Date.now();const logs=[],logger={log:e=>logs.push(e)},options={logger,scope:'synthetic',now:()=>time,retentionMs:1000,maxHistory:1};
 let store=await createOperationalStore(dir,'synthetic'),incidents=createIncidentLifecycle({...options,store});
 const first=await incidents.condition('DATABASE_UNAVAILABLE',true,{component:'database'});
 for(let n=0;n<20;n++)assert.equal((await incidents.condition('DATABASE_UNAVAILABLE',true,{component:'database'})).incidentId,first.incidentId);
 store=await createOperationalStore(dir,'synthetic');incidents=createIncidentLifecycle({...options,store});
 assert.equal((await incidents.condition('DATABASE_UNAVAILABLE',true,{component:'database'})).incidentId,first.incidentId);
 const resolved=await incidents.condition('DATABASE_UNAVAILABLE',false,{component:'database'});assert.equal(resolved.incidentId,first.incidentId);assert.equal(resolved.state,'RESOLVED');assert.equal(store.read().outbox.length,2);
 await incidents.condition('DEVICE_UNKNOWN',true,{workflowId:'synthetic-1'});time+=10000;await incidents.prune();
 assert.ok(store.read().incidents.some(i=>i.incidentId===first.incidentId)); // pending recovery notification retained
 assert.equal(logs.length,3);
 await assert.rejects(createOperationalStore(dir,'wrong-scope'),/OPERATIONAL_STATE_INVALID/);
 await writeFile(join(dir,'operational-state.json'),'corrupt');await assert.rejects(createOperationalStore(dir,'synthetic'),/OPERATIONAL_STATE_INVALID/);
}));
test('operational event never serializes exception body, secrets, arbitrary messages, credentials or SQL URLs',()=>{
 const secrets=['synthetic-password','synthetic-cookie','synthetic-token'],event=operationalEvent('DEVICE_UNKNOWN',{password:secrets[0],Cookie:secrets[1],'X-TOKEN':secrets[2],body:{secret:secrets[0]},message:secrets[0],stack:'mysql://user:password@localhost/db',roomId:secrets[0],operationKey:secrets[1]},Date.now(),secrets);
 const text=JSON.stringify(event);for(const v of [...secrets,'mysql://','body','stack'])assert.equal(text.includes(v),false);assert.equal(event.severity,'ERROR');assert.equal(event.code,'DEVICE_UNKNOWN');
 assert.throws(()=>operationalEvent('arbitrary'));
});
test('device monitors distinguish transient offline, prolonged offline, UNKNOWN, verification and evidence recovery without mutations',()=>fixture(async dir=>{
 let time=Date.now();const store=await createOperationalStore(dir,'synthetic'),lifecycle=createIncidentLifecycle({store,logger:{log(){}},scope:'synthetic',now:()=>time}),c=monitoringConfig({offlineMs:1000,verificationMs:1000});
 const record={id:'wf-1',internalRoomId:'V01',status:'WAITING_DEVICE_ONLINE',roomReadiness:'WAITING_DEVICE',updatedAt:new Date(time).toISOString()};
 await observeWorkflow(lifecycle,record,c,{now:()=>time});assert.equal(store.read().incidents.length,0);
 time+=1001;await observeWorkflow(lifecycle,record,c,{now:()=>time});assert.equal(store.read().incidents[0].type,'DEVICE_OFFLINE');
 await observeWorkflow(lifecycle,{...record,status:'DEVICE_UNKNOWN',roomReadiness:'OPENING',uncertain:true},c,{now:()=>time});
 assert.equal(store.read().incidents.find(i=>i.type==='DEVICE_UNKNOWN').severity,'ERROR');
 await observeWorkflow(lifecycle,{...record,status:'ACTIVE',roomReadiness:'ACTIVE',uncertain:false},c,{now:()=>time});assert.equal(store.read().incidents.filter(i=>i.state==='OPEN').length,0);
}));
test('probe timeout and filesystem capacity are measured; monitoring config bounds are enforced',()=>fixture(async dir=>{
 const result=await directorySummary(dir);assert.equal(result.writable,true);assert.ok(result.freeBytes>0);
 await assert.rejects(boundedProbe(()=>new Promise(()=>{}),10),/MONITOR_PROBE_TIMEOUT/);
 for(const c of [{intervalMs:10},{alertTransport:'email'},{authFailures:0},{logMaxFiles:1000},{tlsErrorDays:31}])assert.throws(()=>monitoringConfig(c));
}));
