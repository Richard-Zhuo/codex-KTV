import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createBackupScheduler} from './backup-schedule.js';
import {backupSchedulePolicy,backupSlotAt,nextBackupSlot,BACKUP_PERIOD_MS as P} from './backup-schedule-policy.js';
import {validateRuntimeConfig,runtimePublicFacts,runtimeConfigFingerprint} from './runtime-config.js';
import {createServiceBackupExecution} from './backup-execution.js';
import {createSafeLogger} from './runtime-log.js';

const BASE=Date.parse('2026-10-20T00:00:00+08:00');
const flush=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r));};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function harness(t,options={}) {
  let now=options.now??BASE,stored=options.previous,opens=0,calls=0,stops=0,id=0;
  const timers=new Map(),logs=[],saves=[],argumentsSeen=[];
  const clock={now:()=>now,setTimeout(callback,delay){const key=++id;timers.set(key,{callback,at:now+delay});return key;},clearTimeout:key=>timers.delete(key)};
  const observations={async open(){opens++;return options.open?options.open():structuredClone(stored);},async save(s){saves.push(structuredClone(s));await options.save?.(s);stored=structuredClone(s);}};
  const execution={async runOnce(...args){calls++;argumentsSeen.push(args);return options.run?options.run():{code:'BACKUP_VERIFIED'};},async stop(){stops++;await options.stop?.();}};
  const scheduler=createBackupScheduler({config:options.config??{backupSchedule:{enabled:true}},execution,observations,logger:{info:r=>logs.push(r)}},clock);
  t.after(()=>scheduler.stop());
  return {scheduler,execution,observations,clock,timers,logs,saves,argumentsSeen,
    get calls(){return calls;},get stops(){return stops;},get opens(){return opens;},get stored(){return stored;},
    async advance(value){now=value;for(const [key,timer] of [...timers])if(timer.at<=now){timers.delete(key);timer.callback();}await flush();},
    setTime(value){now=value;}};
}
const config={configVersion:1,applicationCommit:'a'.repeat(40),publicOrigin:'https://synthetic.invalid:8443',listenHost:'127.0.0.1',port:8443,
  storeId:'synthetic',ledgerId:'synthetic',timeZone:'Asia/Shanghai',businessDateCutoff:'06:00',sessionRuleVersion:'test',
  deviceControlMode:'disabled',liveControlEnabled:false,secretsFile:'C:/synthetic/secrets.json',logDirectory:'C:/synthetic/logs',
  serviceAccountSid:'S-1-5-21-1',backupPolicyConfigured:false,directoryAclReviewed:true,networkModel:'private-vpn'};
const env={NODE_ENV:'production',KTV_HTTP_ENV:'production',KTV_DEPLOYMENT_ENV:'production'};

test('B2-B policy is default off, fixed Shanghai quarter-hour, zero retries and rejects extra command/config fields',()=>{
  assert.deepEqual(backupSchedulePolicy(),{enabled:false,intervalMinutes:15,timeZone:'Asia/Shanghai',retryLimit:0});
  for(const value of [null,[],{},true,{enabled:'true'},{enabled:true,command:'restore'},{enabled:true,path:'evil'},
    {enabled:true,intervalMinutes:60},{enabled:true,timeZone:'UTC'},{enabled:true,retryLimit:1}])
    assert.throws(()=>backupSchedulePolicy(value),{code:'BACKUP_SCHEDULE_CONFIG_INVALID'});
  assert.equal(backupSchedulePolicy({enabled:false}).enabled,false);
});
test('B2-B runtime validates both explicit switches and fingerprints schedule policy without changing old omitted facts',()=>{
  assert.equal(Object.hasOwn(runtimePublicFacts(config),'backupSchedule'),false);
  validateRuntimeConfig(config,env);
  assert.throws(()=>validateRuntimeConfig({...config,backupSchedule:{enabled:true}},env));
  assert.throws(()=>validateRuntimeConfig({...config,backupExecution:{enabled:false},backupSchedule:{enabled:true}},env));
  const c={...config,backupExecution:{enabled:true},backupSchedule:{enabled:true}};
  validateRuntimeConfig(c,env);assert.equal(runtimePublicFacts(c).backupSchedule.retryLimit,0);
  assert.notEqual(runtimeConfigFingerprint(c),runtimeConfigFingerprint({...c,backupSchedule:{enabled:false}}));
  assert.throws(()=>validateRuntimeConfig({...c,backupSchedule:{enabled:true,cli:'evil'}},env));
});
test('B2-B quarter-hour arithmetic is strictly future across Shanghai midnight, independent of host time zone',()=>{
  const old=process.env.TZ;
  try{for(const zone of ['UTC','America/New_York','Asia/Shanghai']){
    process.env.TZ=zone;
    for(const [input,want]of [['2026-10-19T23:59:59.999+08:00','2026-10-20T00:00:00+08:00'],
      ['2026-10-20T00:00:00+08:00','2026-10-20T00:15:00+08:00'],
      ['2026-10-20T00:14:59+08:00','2026-10-20T00:15:00+08:00'],
      ['2026-10-20T09:45:00+08:00','2026-10-20T10:00:00+08:00']])assert.equal(nextBackupSlot(Date.parse(input)),Date.parse(want));
  }}finally{if(old===undefined)delete process.env.TZ;else process.env.TZ=old;}
  for(const bad of [-1,NaN,Infinity,1.5,'0',8640000000000000])assert.throws(()=>nextBackupSlot(bad));
  assert.equal(backupSlotAt(BASE+P+1),BASE+P);
});
test('B2-B absent or false switch never opens store, arms timer or calls executor',async t=>{
  for(const config of [{},{backupSchedule:{enabled:false}}]){
    const h=harness(t,{config});await h.scheduler.start();await h.advance(BASE+20*P);await h.scheduler.stop();
    assert.equal(h.opens,0);assert.equal(h.calls,0);assert.equal(h.stops,0);assert.equal(h.timers.size,0);assert.equal(h.scheduler.snapshot().state,'DISABLED');
  }
});
test('B2-B start is idempotent, waits for next slot and calls only parameterless B2-A once per quarter-hour',async t=>{
  const h=harness(t);await Promise.all([h.scheduler.start(),h.scheduler.start()]);assert.equal(h.opens,1);assert.equal(h.calls,0);
  await h.advance(BASE+P-1);assert.equal(h.calls,0);
  for(let i=1;i<=3;i++){await h.advance(BASE+i*P);assert.equal(h.calls,i);assert.equal(h.scheduler.snapshot().state,'VERIFIED');}
  assert.deepEqual(h.argumentsSeen,[[],[],[]]);assert.equal(h.timers.size,1);
  for(const phase of ['TRIGGERED','RUNNING','VERIFIED'])assert.ok(h.logs.some(r=>r.code==='BACKUP_SCHEDULE_'+phase));
});
for(const [code,want]of [['BACKUP_VERIFIED','VERIFIED'],['BACKUP_EXECUTION_TIMEOUT','TIMED_OUT'],
  ['BACKUP_EXECUTION_FAILED','FAILED'],['BACKUP_EXECUTION_ARGUMENTS_DENIED','FAILED'],['UNKNOWN','FAILED'],
  ['BACKUP_EXECUTION_BUSY','SKIPPED'],['BACKUP_EXECUTION_DISABLED','SKIPPED'],['BACKUP_EXECUTION_STOPPED','SKIPPED'],
  [null,'FAILED'],['THROW','FAILED']])test('B2-B '+code+' => '+want+'; no retry before the next plan',async t=>{
  const h=harness(t,{run:()=>{if(code==='THROW')throw Error('synthetic-secret mysql://credential@host/db');return {code,success:true,secret:'synthetic-secret'};}});
  await h.scheduler.start();await h.advance(BASE+P);assert.equal(h.calls,1);assert.equal(h.scheduler.snapshot().state,want);
  await h.advance(BASE+2*P-1);assert.equal(h.calls,1);await h.advance(BASE+2*P);assert.equal(h.calls,2);
  assert.equal(JSON.stringify(h.logs).includes('synthetic-secret'),false);
});
test('B2-B long execution skips overlapping slots and retains running marker until the same execution finishes',async t=>{
  const done=deferred();const h=harness(t,{run:()=>done.promise,stop:()=>done.resolve({code:'BACKUP_EXECUTION_STOPPED'})});
  await h.scheduler.start();await h.advance(BASE+P);assert.equal(h.scheduler.snapshot().state,'RUNNING');
  await h.advance(BASE+2*P);await h.advance(BASE+3*P);assert.equal(h.calls,1);assert.equal(h.scheduler.snapshot().state,'SKIPPED');assert.equal(h.scheduler.snapshot().running,true);
  done.resolve({code:'BACKUP_VERIFIED'});await flush();assert.equal(h.scheduler.snapshot().state,'VERIFIED');assert.equal(h.scheduler.snapshot().running,false);
  assert.equal(h.stored.nextDueAt,BASE+4*P);assert.equal(h.stored.lastSlotAt,BASE+P);assert.equal(h.scheduler.snapshot().scheduledAt,new Date(BASE+P).toISOString());
});
test('B2-B delayed timer records missed slots and launches at most the latest slot, with no catch-up queue',async t=>{
  const h=harness(t);await h.scheduler.start();await h.advance(BASE+5*P+37);
  assert.equal(h.calls,1);assert.equal(h.stored.missedCount,4);assert.equal(h.stored.missedFrom,BASE+P);assert.equal(h.stored.missedThrough,BASE+4*P);
  assert.equal(h.stored.nextDueAt,BASE+6*P);await h.advance(BASE+5*P+100);assert.equal(h.calls,1);
});
test('B2-B backwards clock does not repeat previously claimed slots',async t=>{
  const h=harness(t);await h.scheduler.start();await h.advance(BASE+P);
  // Invoke an already captured timer early to model a wall-clock rollback.
  const callback=[...h.timers.values()][0].callback;h.setTime(BASE);h.timers.clear();callback();await flush();
  assert.ok(h.logs.some(r=>r.code==='BACKUP_SCHEDULE_CLOCK_BACKWARD'));
  await h.advance(BASE+P);assert.equal(h.calls,1);await h.advance(BASE+2*P);assert.equal(h.calls,2);
});
test('B2-B restart records outage slots and interrupted work, then waits for a strictly future slot',async t=>{
  const previous={version:1,state:'RUNNING',nextDueAt:BASE+2*P,observedAt:BASE+P,lastSlotAt:BASE+P,runningSlotAt:BASE+P,missedCount:0,missedFrom:null,missedThrough:null};
  const h=harness(t,{previous,now:BASE+5*P});await h.scheduler.start();assert.equal(h.calls,0);
  assert.equal(h.stored.nextDueAt,BASE+6*P);assert.equal(h.stored.missedCount,4);assert.equal(h.stored.runningSlotAt,null);
  assert.ok(h.logs.some(r=>r.code==='BACKUP_SCHEDULE_INTERRUPTED'));await h.advance(BASE+6*P);assert.equal(h.calls,1);
});
test('B2-B restart after rollback preserves the persisted future watermark',async t=>{
  const first=harness(t);await first.scheduler.start();await first.advance(BASE+4*P);await first.scheduler.stop();
  const h=harness(t,{previous:first.stored,now:BASE+P});await h.scheduler.start();assert.equal(h.stored.nextDueAt,BASE+5*P);
  await h.advance(BASE+4*P);assert.equal(h.calls,0);await h.advance(BASE+5*P);assert.equal(h.calls,1);
});
test('B2-B stop fences queued timer callbacks and cannot be restarted on the same stopped instance',async t=>{
  const h=harness(t);await h.scheduler.start();const callback=[...h.timers.values()][0].callback;await h.scheduler.stop();
  h.setTime(BASE+P);callback();await flush();await h.scheduler.start();assert.equal(h.calls,0);assert.equal(h.timers.size,0);assert.equal(h.scheduler.snapshot().state,'STOPPED');
});
test('B2-B stop awaits B2-A cleanup and never converts cancelled work into schedule success',async t=>{
  const done=deferred(),clean=deferred();const h=harness(t,{run:()=>done.promise,stop:async()=>{await clean.promise;done.resolve({code:'BACKUP_VERIFIED'});}});
  await h.scheduler.start();await h.advance(BASE+P);let stopped=false;const stopping=h.scheduler.stop().then(()=>{stopped=true;});
  await flush();assert.equal(stopped,false);await h.advance(BASE+4*P);assert.equal(h.calls,1);
  clean.resolve();await stopping;assert.equal(h.scheduler.snapshot().state,'STOPPED');assert.equal(h.logs.some(r=>r.code==='BACKUP_SCHEDULE_VERIFIED'),false);
});
test('B2-B stop during asynchronous startup prevents arming and launching',async t=>{
  const opening=deferred(),h=harness(t,{open:()=>opening.promise});const starting=h.scheduler.start(),stopping=h.scheduler.stop();
  opening.resolve(undefined);await starting;await stopping;assert.equal(h.calls,0);assert.equal(h.timers.size,0);
});
test('B2-B stop while durable trigger claim is pending prevents a late child launch',async t=>{
  const gate=deferred(),h=harness(t,{save:s=>s.state==='TRIGGERED'?gate.promise:undefined});await h.scheduler.start();await h.advance(BASE+P);
  const stopping=h.scheduler.stop();gate.resolve();await stopping;assert.equal(h.calls,0);assert.equal(h.timers.size,0);assert.equal(h.stored.state,'STOPPED');
});
test('B2-B persistence failure before launch fails closed and never retries or leaks the raw error',async t=>{
  const h=harness(t,{save:s=>{if(s.state==='TRIGGERED')throw Error('synthetic-secret C:/private');}});
  await h.scheduler.start();await h.advance(BASE+P);assert.equal(h.calls,0);assert.equal(h.scheduler.snapshot().state,'ERROR');assert.equal(h.stored.state,'ERROR');assert.ok(h.stops>=1);
  await h.advance(BASE+10*P);assert.equal(h.calls,0);assert.equal(h.timers.size,0);assert.equal(JSON.stringify(h.logs).includes('synthetic-secret'),false);
});
test('B2-B invalid persisted cursor or unavailable store cannot start execution',async t=>{
  for(const opts of [{previous:{}},{open:()=>{throw Error('synthetic-secret');}},{previous:{version:1,state:'WAITING',nextDueAt:1,observedAt:0,lastSlotAt:null,runningSlotAt:null,missedCount:0,missedFrom:null,missedThrough:null}}]){
    const h=harness(t,opts);await assert.rejects(h.scheduler.start(),/BACKUP_SCHEDULE_START_FAILED/);await h.advance(BASE+P);assert.equal(h.calls,0);assert.equal(h.timers.size,0);
  }
});
test('B2-B completion racing a persisted overlap skip cannot overwrite the future cursor',async t=>{
  const done=deferred(),gate=deferred();let delay=false;
  const h=harness(t,{run:()=>done.promise,stop:()=>done.resolve({code:'BACKUP_EXECUTION_STOPPED'}),save:s=>delay&&s.state==='SKIPPED'?gate.promise:undefined});
  await h.scheduler.start();await h.advance(BASE+P);delay=true;await h.advance(BASE+2*P);
  done.resolve({code:'BACKUP_VERIFIED'});await flush();gate.resolve();await flush();
  assert.equal(h.stored.state,'VERIFIED');assert.equal(h.stored.nextDueAt,BASE+3*P);assert.equal(h.stored.missedCount,1);assert.equal(h.stored.lastSlotAt,BASE+P);assert.equal(h.scheduler.snapshot().scheduledAt,new Date(BASE+P).toISOString());
});
test('B2-B schedule invokes the real B2-A admission and preserves S4 refusal; never launches around it',async t=>{
  let admissions=0,launches=0;const reports=[];
  const runner=createServiceBackupExecution({loaded:{config:{backupExecution:{enabled:true,timeoutMs:1000}},logDirectory:'synthetic'},runtimeConfigFile:'C:/synthetic/runtime.json'},
    {deployment:async()=>{admissions++;throw Error('S4_DENIED synthetic-secret');},launch:()=>{launches++;throw Error('must not launch');},report:async(_path,r)=>reports.push(r)});
  const h=harness(t,{run:()=>runner.runOnce(),stop:()=>runner.stop()});await h.scheduler.start();await h.advance(BASE+P);
  assert.equal(admissions,1);assert.equal(launches,0);assert.equal(h.stored.state,'FAILED');assert.deepEqual(reports,[{success:false}]);
  await h.advance(BASE+2*P);assert.equal(admissions,2);assert.equal(launches,0);
});
test('B2-B production wiring provides only an internal scheduler and safe monitoring fields',async()=>{
  const [start,runtime]=await Promise.all(['start.js','runtime.js'].map(p=>readFile(new URL(p,import.meta.url),'utf8')));
  assert.match(start,/createBackupScheduler\(\{config:loaded.config,execution:backupExecution,observations:operations.backupSchedule,logger\}\)/);
  assert.match(runtime,/await activate\(true\);await backupScheduler\?\.start\(\)/);
  assert.equal(runtime.includes('backupScheduler.run'),false);assert.equal(start.includes("line==='BACKUP'"),false);
  const lines=[],log=createSafeLogger({write:s=>lines.push(JSON.parse(s)),secrets:['synthetic-secret']});
  log.info({event:'backup_schedule',code:'BACKUP_SCHEDULE_MISSED',scheduledAt:new Date(BASE).toISOString(),nextRunAt:new Date(BASE+P).toISOString(),missedCount:2,timeZone:'Asia/Shanghai',backupContent:'synthetic-secret',path:'C:/private'});
  assert.equal(lines[0].missedCount,2);assert.equal(lines[0].timeZone,'Asia/Shanghai');assert.equal(Object.hasOwn(lines[0],'path'),false);assert.equal(Object.hasOwn(lines[0],'backupContent'),false);
});

test('B2-B completion persistence failure fails closed instead of publishing schedule success',async t=>{
  const h=harness(t,{save:s=>{if(s.state==='VERIFIED')throw Error('synthetic disk full');}});
  await h.scheduler.start();await h.advance(BASE+P);assert.equal(h.calls,1);assert.equal(h.scheduler.snapshot().state,'ERROR');
  assert.equal(h.logs.some(r=>r.code==='BACKUP_SCHEDULE_VERIFIED'),false);assert.equal(h.timers.size,0);
});
