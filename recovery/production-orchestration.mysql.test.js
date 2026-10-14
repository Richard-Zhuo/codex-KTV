import test from 'node:test';import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';import {readFile,writeFile,readdir,rename} from 'node:fs/promises';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {withD2Fixture} from '../test-support/d2-orchestration-fixture.js';
import {AUTHORIZATION_TTL_MS,assertProductionPlanAuthority} from './production-authorization.js';
import {executeProductionRestoreStage} from './production-orchestration.js';
import {canonical,digest,schemaSpec} from '../backup/format.js';
import {readTables} from '../backup/mysql-backup.js';
import {createMySqlAuthStore} from '../auth/mysql-store.js';import {createAuthService} from '../auth/service.js';import {createMemoryLoginRateLimiter} from '../auth/rate-limit.js';
const enabled=process.env.STAGE5E_RUN==='synthetic-only'&&process.env.STAGE5E_FIXTURE_ROOT&&process.env.LEDGER_MYSQL_TEST_URL;
const safeError=()=>Object.assign(Error('synthetic response lost'),{code:'D2_SYNTHETIC_RESPONSE_LOSS'});
import {filesystemDigest} from '../test-support/filesystem-digest.js';
async function patch(path,change,work){const bytes=await readFile(path);try{const value=JSON.parse(bytes);change(value);await writeFile(path,canonical(value));return await work();}finally{await writeFile(path,bytes);}}
async function step(t,name,work){let failure;await t.test(name,async()=>{try{await work();}catch(error){failure=error;throw error;}});if(failure)throw Object.assign(Error('D2_REHEARSAL_STOP_AFTER_FAILURE'),{code:'D2_REHEARSAL_STOP_AFTER_FAILURE'});}
if(enabled)test('D2 owned CLI orchestration rehearsal preserves authority, stage, replay and one-writer contracts',{timeout:480000},async t=>{
 await withD2Fixture(async f=>{
 const outputs=[];
 const call=async(action,options)=>{const r=await f.cli(action,options);outputs.push(r.stdout+r.stderr);return r;};
 const ok=async(action,options)=>{const r=await call(action,options);assert.equal(r.exit,0,action+': '+JSON.stringify(r.result)+' '+JSON.stringify(f.safeLogs.slice(-4)));return r.result;};
 const blocked=async(action,code,options)=>{const r=await call(action,options);assert.equal(r.exit,1,action+' should reject');if(code)assert.equal(r.result.code,code);return r.result;};
 await testStep('read-only inspect has no authority or filesystem mutation',async()=>{
  const before=await filesystemDigest([f.journal,f.authDir]);const r=await ok('inspect-status');assert.equal(r.status,'PREPARED');assert.equal(r.authorization,'MISSING');assert.equal(r.writes,'NO');assert.equal(await filesystemDigest([f.journal,f.authDir]),before);
 });
 await ok('authorize');
 await testStep('owned and plain tokens cannot enter production destructive guard',async()=>{
  const token=await f.authorization.issue();await assert.rejects(()=>assertProductionPlanAuthority(token),{code:'AUTHORIZATION_AUTHORITY_FORGED'});await assert.rejects(()=>executeProductionRestoreStage(token),{code:'AUTHORIZATION_AUTHORITY_FORGED'});
  const r=await f.cli('freeze-plan',{orchestration:{run:()=>assert.fail('forged session')}});assert.equal(r.exit,1);assert.equal(r.result.code,'AUTHORIZATION_AUTHORITY_FORGED');
 });
 await testStep('expiry, revoke and explicit same-plan reauthorization preserve lifecycle',async()=>{
  f.advanceClock(AUTHORIZATION_TTL_MS+1000);await blocked('freeze-plan','AUTHORIZATION_EXPIRED');await ok('reauthorize');await ok('revoke-authorization');await blocked('freeze-plan','AUTHORIZATION_REVOKED');await ok('reauthorize');
 });
 await testStep('wrong operator and non-elevated admission reject before source mutations',async()=>{
  const actor=f.actor();try{f.setActor({...actor,sid:'S-1-5-21-101-202-303-1002'});await blocked('freeze-plan','AUTHORIZATION_OPERATOR_DENIED');f.setActor({...actor,elevated:false});await blocked('freeze-plan','AUTHORIZATION_OPERATOR_DENIED');}finally{f.setActor(actor);}
 });
 await testStep('plan digest, server UUID, backup SHA, fingerprint and source pointer drift reject',async()=>{
  await patch(f.planPath,p=>p.planDigest='0'.repeat(64),()=>blocked('freeze-plan','PRODUCTION_RESTORE_PLAN_INVALID'));
  await patch(f.planPath,p=>{p.sourceServerUuid=p.targetServerUuid='00000000-0000-4000-8000-000000000000';const {planDigest,...body}=p;p.planDigest=digest(canonical(body));},()=>blocked('freeze-plan','PRODUCTION_ORCHESTRATION_BINDING_MISMATCH'));
  const data=join(f.backup.directory,'data.json'),bytes=await readFile(data);try{await writeFile(data,Buffer.concat([bytes,Buffer.from(' ')]));await blocked('freeze-plan');}finally{await writeFile(data,bytes);}
  await patch(f.configPath,c=>c.publicOrigin='https://changed.example.invalid:8443',()=>blocked('freeze-plan','PRODUCTION_ORCHESTRATION_BINDING_MISMATCH'));
  await patch(f.secretPath,c=>c.database.name=f.plan.targetDatabase,()=>blocked('freeze-plan','AUTHORIZATION_POINTER_MISMATCH'));
 });
 await testStep('untrusted service identity rejects before freeze',async()=>{
  const current=await f.system.snapshot();f.overrideScm({...current,serviceSid:'S-1-5-80-999'});try{await blocked('freeze-plan','RECOVERY_SERVICE_IDENTITY_MISMATCH');}finally{f.overrideScm(null);}
 });
 const sourceSpec=await schemaSpec(),businessTables=sourceSpec.tables.filter(name=>!['recovery_control','recovery_events'].includes(name));
 const beforeBusiness=digest(canonical(await readTables(f.b.setup,businessTables)));
 await testStep('freeze stops the managed runtime and preserves exact plan identity',async()=>{
  assert.equal((await ok('freeze-plan')).state,'FROZEN');assert.equal((await ok('freeze-plan')).replay,true);
  const s=await ok('inspect-status');assert.equal(s.source,'FROZEN');assert.equal(s.candidate,'ABSENT');assert.equal(s.service,'STOPPED');
  const [[row]]=await f.b.setup.query('SELECT facts FROM recovery_control WHERE control_id=1');const facts=JSON.parse(row.facts);for(const key of ['recoveryOperationId','planDigest','backupSha256','storeId','ledgerId','targetDatabase'])assert.equal(facts[key],f.plan[key]);
 });
 await testStep('wrong frozen operation cannot restore',async()=>{
  const [[row]]=await f.b.setup.query('SELECT facts FROM recovery_control WHERE control_id=1');const prior=row.facts;try{await f.b.setup.execute('UPDATE recovery_control SET facts=? WHERE control_id=1',[canonical({...JSON.parse(prior),recoveryOperationId:randomUUID()})]);await blocked('restore-candidate','PRODUCTION_RESTORE_C1_IDENTITY_MISMATCH');}finally{await f.b.setup.execute('UPDATE recovery_control SET facts=? WHERE control_id=1',[prior]);}
 });
 await testStep('specific C1 rejection is retained in orchestration audit and unknown errors stay contained',async()=>{
  const auditDir=join(f.journal,'orchestration');
  const records=async()=>Promise.all((await readdir(auditDir)).map(async name=>JSON.parse(await readFile(join(auditDir,name),'utf8'))));
  const prior=await records();assert.equal(prior.some(r=>r.stage==='restore-candidate'&&r.type==='BLOCKED'&&r.code==='PRODUCTION_RESTORE_C1_IDENTITY_MISMATCH'),true);
  const sentinel='D2_UNKNOWN_INTERNAL_SENTINEL',load=f.deps.load;
  try{f.deps.load=async()=>{throw Error(sentinel);};await blocked('restore-candidate','PRODUCTION_ORCHESTRATION_FAILED');}finally{f.deps.load=load;}
  const after=await records();assert.equal(after.some(r=>r.stage==='restore-candidate'&&r.type==='BLOCKED'&&r.code==='PRODUCTION_ORCHESTRATION_FAILED'),true);
  for(const r of after)assert.deepEqual(Object.keys(r).sort(),['at','code','planDigest','recoveryOperationId','stage','type','version']);
  assert.equal(JSON.stringify(after).includes(sentinel),false);assert.equal(outputs.join('').includes(sentinel),false);
 });
 await testStep('restore reaches VERIFYING and response retry never imports twice',async()=>{
  assert.equal((await ok('restore-candidate')).state,'VERIFYING');assert.equal((await ok('restore-candidate')).replay,true);
  const u=new URL(f.deps.load?f.b.raw:f.b.raw);u.pathname='/'+f.plan.targetDatabase;const c=await mysql.createConnection({uri:u.href});try{const [[r]]=await c.query("SELECT COUNT(*) AS n FROM recovery_events WHERE reason='plan-bound-candidate-restore'");assert.equal(Number(r.n),1);}finally{await c.end();}
 });
 await testStep('C1 rejects critical unknown external evidence then verifies without replay',async()=>{
  f.setOutbox([{state:'PENDING',providerResult:'UNKNOWN',severity:'CRITICAL'}]);try{await blocked('verify-candidate','PRODUCTION_ORCHESTRATION_C1_BLOCKED');}finally{f.setOutbox([]);}
  assert.equal((await ok('verify-candidate')).cutoverEligible,true);assert.equal((await ok('verify-candidate')).replay,true);
 });
 await testStep('C2 requires real stopped proof and exact human checkpoint',async()=>{
  const current=await f.system.snapshot();f.overrideScm({...current,processes:[{pid:123,ppid:4,createdAt:'2026-10-13T00:00:00Z',sid:f.serviceExpected.serviceSid}]});try{await blocked('cutover','RECOVERY_SERVICE_PROCESS_CONFLICT');}finally{f.overrideScm(null);}
  await blocked('cutover','PRODUCTION_ORCHESTRATION_CHECKPOINT_REQUIRED',{confirm:async()=>true});
 });
 await testStep('C2 before-pointer interruption preserves intent/source and concurrency conflicts',async()=>{
  let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.hooks.beforePointer=async()=>{entered();await gate;throw safeError();};
  const first=call('cutover');await ready;try{await blocked('cutover','AUTHORIZATION_BUSY');}finally{release();}
  assert.equal((await first).exit,1);delete f.hooks.beforePointer;
  const s=await ok('inspect-status');assert.equal(s.c2,'CUTOVER_INTENT');assert.equal(s.pointer,f.plan.currentDatabase);
 });
 await testStep('C2 lost response after physical pointer write reconciles without second switch',async()=>{
  let first=true;f.hooks.pointerOptions.move=async(a,b)=>{f.counts.pointerMoves++;await rename(a,b);if(first){first=false;throw safeError();}};
  await blocked('cutover');const pending=await ok('inspect-status');assert.equal(pending.c2,'CUTOVER_INTENT');assert.equal(pending.pointer,f.plan.targetDatabase);assert.equal(pending.status,'CUTOVER_INTENT');
  assert.equal((await ok('cutover')).state,'CUTOVER_SWITCHED');assert.equal((await ok('cutover')).replay,true);assert.equal(f.counts.pointerMoves,1);
 });
 await testStep('target pointer drift blocks C3 without changing runtime pointer authority',async()=>{
  await patch(f.secretPath,c=>c.database.name=f.plan.currentDatabase,()=>blocked('prepare-resume','AUTHORIZATION_POINTER_MISMATCH'));
 });
 await testStep('C3 ready commit and resume commit interruptions reconcile same operation',async()=>{
  let ready=true;f.hooks.prepare={afterReadyCommit:async()=>{if(ready){ready=false;throw safeError();}}};await blocked('prepare-resume');assert.equal((await ok('prepare-resume')).state,'READY_FOR_RESUME');
  let resume=true;f.hooks.resume={afterResumeCommit:async()=>{if(resume){resume=false;throw safeError();}}};await blocked('resume');
  const pending=await ok('inspect-status');assert.equal(pending.c3,'RESUME_INTENT');assert.equal(pending.candidate,'NORMAL');assert.equal(pending.service,'STOPPED');
  assert.equal((await ok('resume')).state,'RESUMED');assert.equal((await ok('resume')).replay,true);
 });
 await testStep('terminal proof, old session invalidation, consume and readonly inspection',async()=>{
  const before=await filesystemDigest([f.journal,f.authDir]),s=await ok('inspect-status');assert.equal(s.status,'TERMINAL_SUCCESS');assert.equal(s.authorization,'CONSUMED');assert.equal(s.source,'FROZEN');assert.equal(s.candidate,'NORMAL');assert.equal(s.pointer,f.plan.targetDatabase);assert.equal(s.terminal.totalWriters,1);assert.equal(s.terminal.oldWriters,0);assert.equal(s.terminal.candidateWriters,1);assert.equal(await filesystemDigest([f.journal,f.authDir]),before);
  assert.equal(f.runtime().status().phase,'RUNNING');assert.equal((await f.runtime().readiness()).ready,true);assert.equal(digest(canonical(await readTables(f.b.setup,businessTables))),beforeBusiness);
  const u=new URL(f.b.raw);u.pathname='/'+f.plan.targetDatabase;const pool=mysql.createPool({uri:u.href});try{const auth=createAuthService({store:createMySqlAuthStore({pool,database:f.plan.targetDatabase}),rateLimiter:createMemoryLoginRateLimiter()});assert.equal(await auth.authenticateSession(f.b.login.token),null);}finally{await pool.end();}
  assert.equal(f.counts.providerReplay,0);const text=outputs.join('');for(const secret of [f.bundle.database.password,f.bundle.tls.privateKey,'D2_PROVIDER_SENTINEL'])assert.equal(text.includes(secret),false,'no secret in CLI result');
 });
 function testStep(name,work){return step(t,name,work);}
 });
 await step(t,'freeze intent and restoring intent with absent target retry only after full preflight',()=>withD2Fixture(async f=>{
  const ok=async a=>{const r=await f.cli(a);assert.equal(r.exit,0,JSON.stringify(r.result));return r.result;};
  await ok('authorize');const original=f.deps.executionTransition;let freeze=true,restore=true;
  f.deps.executionTransition=async(...args)=>{const result=await original(...args);if(args[3]==='FREEZE_INTENT'&&freeze){freeze=false;throw safeError();}if(args[3]==='RESTORING'&&restore){restore=false;throw safeError();}return result;};
  assert.equal((await f.cli('freeze-plan')).exit,1);let s=await ok('inspect-status');assert.equal(s.execution,'FREEZE_INTENT');assert.equal(s.source,'NORMAL');assert.equal(s.candidate,'ABSENT');
  assert.equal((await ok('freeze-plan')).state,'FROZEN');assert.equal((await f.cli('restore-candidate')).exit,1);s=await ok('inspect-status');assert.equal(s.execution,'RESTORING');assert.equal(s.candidate,'ABSENT');
  f.hooks.restore={afterCreate:async()=>{throw safeError();}};assert.equal((await f.cli('restore-candidate')).exit,1);
  const [targets]=await f.b.setup.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[f.plan.targetDatabase]);assert.equal(targets.length,1);
  assert.equal((await f.cli('restore-candidate')).exit,1);const [still]=await f.b.setup.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[f.plan.targetDatabase]);assert.equal(still.length,1);
  const status=await f.cli('inspect-status');assert.equal(status.exit,1);assert.equal(status.result.status,'UNKNOWN');
  const [[control]]=await f.b.setup.query('SELECT mode FROM recovery_control WHERE control_id=1');assert.equal(control.mode,'FROZEN');
 }));
 await step(t,'an already existing target and a different plan cannot be adopted or dropped',()=>withD2Fixture(async f=>{
  assert.equal((await f.cli('authorize')).exit,0);assert.equal((await f.cli('freeze-plan')).exit,0);
  await patch(f.planPath,p=>{p.recoveryOperationId=randomUUID();p.targetDatabase='jbhh_ktv_recovery_'+p.recoveryOperationId.replaceAll('-','');const {planDigest,...body}=p;p.planDigest=digest(canonical(body));},async()=>{assert.equal((await f.cli('restore-candidate')).exit,1);});
  await f.b.setup.query('CREATE DATABASE '+f.plan.targetDatabase);
  const r=await f.cli('restore-candidate');assert.equal(r.exit,1);assert.equal(r.result.code,'PRODUCTION_ORCHESTRATION_STATE_CONFLICT');
  const [left]=await f.b.setup.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[f.plan.targetDatabase]);assert.equal(left.length,1);
 }));
});
