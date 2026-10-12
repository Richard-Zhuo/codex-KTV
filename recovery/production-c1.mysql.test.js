import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import {join} from 'node:path';
import {mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import {withBackupFixture} from '../test-support/backup-fixture.js';
import {backupDatabase} from '../backup/mysql-backup.js';
import {canonical} from '../backup/format.js';
import {decodeLedgerSnapshot,encodeLedgerSnapshot} from '../ledger/mysql-snapshot.js';
import {inspectProductionRestore,planBinding} from './production-plan.js';
import {freezePreparedCandidate,restorePreparedCandidate,issueOwnedCandidateCapability} from './production-candidate.js';
import {verifyPreparedCandidate} from './production-c1.js';
import {readExecutionState,transitionExecutionState} from './production-journal.js';
import {writeC1Evidence,readC1Evidence} from './c1-evidence.js';
import {verifyRecovery,resumeRecovery} from './operator.js';

const enabled=process.env.STAGE5E_RUN==='synthetic-only'&&
 process.env.STAGE5E_FIXTURE_ROOT&&process.env.LEDGER_MYSQL_TEST_URL;
if(enabled)test('S3-C C1 owned MySQL verification produces plan-bound evidence without advancing recovery',
 {timeout:240000},async t=>{
 const f={root:process.env.STAGE5E_FIXTURE_ROOT,
  names:{id:process.env.STAGE5E_FIXTURE_ID,database:'jbhh_ktv_test'},
  identity:{server_uuid:process.env.STAGE5E_FIXTURE_UUID},port:33313,
  dbUrl:()=>process.env.LEDGER_MYSQL_TEST_URL};
 const capability=await issueOwnedCandidateCapability(f);
 await withBackupFixture(async b=>{
  await b.setup.query("UPDATE production_bootstrap_events SET environment='production'");
  const [[head]]=await b.setup.query('SELECT state_json,state_checksum FROM ledger_heads');
  const state=decodeLedgerSnapshot(head.state_json,head.state_checksum);
  for(const stock of [...Object.values(state.inventory),...Object.values(state.consumables)])
   stock.count=1000;
  const encoded=encodeLedgerSnapshot(state);
  await b.setup.execute('UPDATE ledger_heads SET state_json=?,state_checksum=?',
   [encoded.json,encoded.checksum]);
  const backup=await backupDatabase({...b.backupArgs,environment:'production',
   outputDirectory:join(f.root,'backups','c1_owned')});
  const journal=join(f.root,'artifacts','c1_owned');await mkdir(journal);
  const active=new URL(b.raw),admin=new URL(b.raw);admin.pathname='/';
  const config={config:{storeId:b.storeId,ledgerId:b.ledgerId,
   applicationCommit:b.backupArgs.applicationCommit,
   serviceAccountSid:'S-1-5-21-1-2-3-1001',
   monitoring:{backupDirectory:join(f.root,'backups')},
   recovery:{journalDirectory:journal}},apiEnv:{KTV_MYSQL_URL:active.href}};
  const connect=async url=>{
   const c=await mysql.createConnection({uri:url,dateStrings:true,jsonStrings:true,
    supportBigNumbers:true,bigNumberStrings:true});
   return {query:(sql,...params)=>sql==='SHOW GRANTS FOR CURRENT_USER()'?
     Promise.resolve([[{grant:'GRANT SHOW DATABASES ON *.* TO synthetic_operator'}]]):
     c.query(sql,...params),execute:(...args)=>c.execute(...args),end:()=>c.end()};
  };
  const load=async()=>config;
  const pathCheck=async(_loaded,artifact)=>({backup:config.config.monitoring.backupDirectory,
   journal,artifact});
  const deps={runtimeConfigFile:'synthetic-owned-fixture',load,pathCheck,connect,
   operatorLoad:async()=>admin.href,fileAcl:async()=>{}};
  const plan=await inspectProductionRestore({...deps,artifactDirectory:backup.directory,
   expectedChecksum:backup.checksum,now:new Date()});
  await writeFile(join(journal,'active-plan.json'),canonical(plan));
  const options={checkAcl:async()=>{},harden:async()=>{}};
  const readState=(dir,p)=>readExecutionState(dir,p,options);
  const transition=(dir,p,from,to)=>transitionExecutionState(dir,p,from,to,options);
  const args={...deps,capability,readState,transition};
  await freezePreparedCandidate(args);
  assert.equal((await restorePreparedCandidate(args)).state,'VERIFYING');
  const readAlerts=async()=>[];
  const persist=(dir,p,result)=>writeC1Evidence(dir,p,result,options);
  const verify=extra=>verifyPreparedCandidate({...args,readAlerts,persist,...extra});
  await t.test('identity drift before PASS persistence never writes PASS',async()=>{
   const evidencePath=join(journal,'c1-verification.json');
   const result=await verify({testHooks:{beforePersist:async()=>{
    await b.setup.execute('UPDATE recovery_control SET facts=? WHERE control_id=1',
     [canonical({...planBinding(plan),recoveryOperationId:'another-operation'})]);
   }}});
   assert.equal(result.cutoverEligible,false);
   await assert.rejects(stat(evidencePath),{code:'ENOENT'});
   await b.setup.execute('UPDATE recovery_control SET facts=? WHERE control_id=1',
    [canonical({reason:'plan-bound-recovery-freeze',...planBinding(plan)})]);
  });
  await t.test('healthy candidate writes eligible evidence and remains paused',async()=>{
   const result=await verify({testHooks:{onError:error=>{throw error;}}});
   assert.equal(result.cutoverEligible,true,JSON.stringify(result.blockingFindings));
   const c=await mysql.createConnection({uri:new URL('/'+plan.targetDatabase,b.raw).href});
   try{
    const [[candidate]]=await c.query('SELECT mode FROM recovery_control WHERE control_id=1');
    const [[old]]=await b.setup.query('SELECT mode FROM recovery_control WHERE control_id=1');
    assert.equal(candidate.mode,'VERIFYING');assert.equal(old.mode,'FROZEN');
   }finally{await c.end();}
   assert.equal((await readState(journal,plan)).state,'VERIFYING');
   const saved=JSON.parse(await readFile(join(journal,'c1-verification.json'),'utf8'));
   const current={candidateDigest:saved.candidateDigest,oldDigest:saved.oldDigest,
    alertDigest:saved.alertDigest,journalState:'VERIFYING'};
   assert.equal((await readC1Evidence(journal,plan,current,options)).cutoverEligible,true);
   assert.equal((await readC1Evidence(journal,plan,
    {...current,candidateDigest:'changed'},options)).cutoverEligible,false);
  });
  await t.test('wrong freeze identity, state or candidate state blocks eligibility',async()=>{
   const original=canonical({reason:'plan-bound-recovery-freeze',...planBinding(plan)});
   await b.setup.execute('UPDATE recovery_control SET facts=? WHERE control_id=1',
    [canonical({...planBinding(plan),reason:'plan-bound-recovery-freeze',planDigest:'other'})]);
   assert.equal((await verify()).cutoverEligible,false);
   await b.setup.execute('UPDATE recovery_control SET facts=? WHERE control_id=1',[original]);
   await b.setup.query("UPDATE recovery_control SET mode='NORMAL' WHERE control_id=1");
   assert.equal((await verify()).cutoverEligible,false);
   await b.setup.query("UPDATE recovery_control SET mode='FROZEN' WHERE control_id=1");
   const target=new URL(b.raw);target.pathname='/'+plan.targetDatabase;
   const c=await mysql.createConnection({uri:target.href});
   try{
    await c.query("UPDATE recovery_control SET mode='READY_FOR_RESUME' WHERE control_id=1");
    assert.equal((await verify()).cutoverEligible,false);
    await c.query("UPDATE recovery_control SET mode='VERIFYING' WHERE control_id=1");
   }finally{await c.end();}
  });
  await t.test('session and critical voucher UNKNOWN block, manual PENDING is recorded',async()=>{
   const target=new URL(b.raw);target.pathname='/'+plan.targetDatabase;
   const c=await mysql.createConnection({uri:target.href});
   try{
    await c.query('UPDATE auth_sessions SET revoked_at=NULL LIMIT 1');
    assert.equal((await verify()).cutoverEligible,false);
    await c.query('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP(6) WHERE revoked_at IS NULL');
    // Synthetic voucher row has no provider call; use a direct fixture row under FK authority.
    await c.execute("INSERT INTO voucher_redemptions(id,ledger_id,provider,store_id,voucher_code_hash,voucher_code_masked,status,version,requested_by_principal_id,operation_key,provider_request_id,requested_at) VALUES(UUID(),?,'synthetic',?,REPEAT('a',64),'masked','UNKNOWN',1,?,'c1-fixture',UUID(),UTC_TIMESTAMP(6))",
     [b.ledgerId,b.storeId,b.people[0].principalId]);
    const unknown=await verify();
    assert.equal(unknown.cutoverEligible,false);
    assert.equal(unknown.external.voucher,'BLOCKING_UNKNOWN');
    await c.query("UPDATE voucher_redemptions SET status='PENDING' WHERE operation_key='c1-fixture'");
    const pending=await verify();
    assert.equal(pending.cutoverEligible,true,JSON.stringify(pending.blockingFindings));
    assert.ok(pending.manualFollowups.some(x=>x.code==='C1_VOUCHER_PENDING'));
   }finally{await c.end();}
  });
  await t.test('critical unknown alerts block while an unsent alert is a recorded followup',async()=>{
   const unknown=await verify({readAlerts:async()=>[{deliveryId:'synthetic-alert',
    state:'PENDING',severity:'CRITICAL',uncertain:true,providerResult:'UNKNOWN'}]});
   assert.equal(unknown.cutoverEligible,false);
   assert.equal(unknown.external.alerts,'BLOCKING_UNKNOWN');
   const pending=await verify({readAlerts:async()=>[{deliveryId:'synthetic-pending',
    state:'PENDING',severity:'WARN',attempts:0}]});
   assert.equal(pending.cutoverEligible,true);
   assert.equal(pending.external.alerts,'NON_BLOCKING_MANUAL_FOLLOWUP');
   assert.ok(pending.manualFollowups.some(x=>x.code==='C1_ALERT_DELIVERY_REVIEW'));
  });
  await t.test('candidate ledger, money and inventory contradictions block eligibility',async()=>{
   const target=new URL(b.raw);target.pathname='/'+plan.targetDatabase;
   const c=await mysql.createConnection({uri:target.href});
   try{
    const [[head]]=await c.query('SELECT revision,state_json,state_checksum FROM ledger_heads WHERE ledger_id=?',[b.ledgerId]);
    await c.execute('UPDATE ledger_heads SET revision=revision+1 WHERE ledger_id=?',[b.ledgerId]);
    const revision=await verify();assert.equal(revision.cutoverEligible,false);
    await c.execute('UPDATE ledger_heads SET revision=? WHERE ledger_id=?',[head.revision,b.ledgerId]);
    const money=decodeLedgerSnapshot(head.state_json,head.state_checksum);
    money.orders.push({id:'c1-money',kind:'retail',room:null,status:'open',payments:[{amount:10}],
     packageBaseCents:0,sales:[],otherCharges:[]});
    let encoded=encodeLedgerSnapshot(money);
    await c.execute('UPDATE ledger_heads SET state_json=?,state_checksum=? WHERE ledger_id=?',
     [encoded.json,encoded.checksum,b.ledgerId]);
    const badMoney=await verify();assert.equal(badMoney.cutoverEligible,false);
    assert.ok(badMoney.blockingFindings.some(x=>x.code==='C1_MONEY_MISMATCH'));
    money.orders=[];money.inventory.qd.count=-1;encoded=encodeLedgerSnapshot(money);
    await c.execute('UPDATE ledger_heads SET state_json=?,state_checksum=? WHERE ledger_id=?',
     [encoded.json,encoded.checksum,b.ledgerId]);
    const badInventory=await verify();assert.equal(badInventory.cutoverEligible,false);
    assert.ok(badInventory.blockingFindings.some(x=>x.code==='RECOVERY_INVENTORY_COUNT'));
    await c.execute('UPDATE ledger_heads SET state_json=?,state_checksum=? WHERE ledger_id=?',
     [head.state_json,head.state_checksum,b.ledgerId]);
   }finally{await c.end();}
  });
  await t.test('unfinished device workflow stays blocking without provider access',async()=>{
   const target=new URL(b.raw);target.pathname='/'+plan.targetDatabase;
   const c=await mysql.createConnection({uri:target.href});
   try{
    const workflow=encodeLedgerSnapshot({status:'DEVICE_OPENING'});
    await c.execute('INSERT INTO room_control_workflows(ledger_id,workflow_id,operation_key,order_id,actor_principal_id,fingerprint,version,state_json,state_checksum) VALUES(?,UUID(),?,?,?,?,1,?,?)',
     [b.ledgerId,'c1-device','c1-order',b.people[0].principalId,'a'.repeat(64),workflow.json,workflow.checksum]);
    const result=await verify();assert.equal(result.cutoverEligible,false);
    assert.equal(result.external.device,'BLOCKING_UNKNOWN');
    await c.execute('DELETE FROM room_control_workflows WHERE ledger_id=? AND operation_key=?',
     [b.ledgerId,'c1-device']);
   }finally{await c.end();}
  });
  await t.test('generic verify and resume still reject plan-bound candidate',async()=>{
   const target=new URL(b.raw);target.pathname='/'+plan.targetDatabase;
   const base={directory:backup.directory,expectedChecksum:backup.checksum,
    databaseUrl:target.href,serverUuid:b.identity.server_uuid,environment:'production',
    storeId:b.storeId,ledgerId:b.ledgerId,initiatedBy:'synthetic-drill'};
   const confirm=base.serverUuid+'/'+plan.targetDatabase+'/'+base.storeId+'/'+base.ledgerId+'/'+base.expectedChecksum;
   await assert.rejects(verifyRecovery({...base,confirmation:confirm}),
    {code:'RECOVERY_PLAN_BOUND_CANDIDATE_BLOCKED'});
   await assert.rejects(resumeRecovery({...base,confirmation:confirm+'/RESUME'}),
    {code:'RECOVERY_PLAN_BOUND_CANDIDATE_BLOCKED'});
   const c=await mysql.createConnection({uri:target.href});
   try{const [[row]]=await c.query('SELECT mode FROM recovery_control WHERE control_id=1');
    assert.equal(row.mode,'VERIFYING');}finally{await c.end();}
   const [[oldHead]]=await b.setup.query('SELECT state_checksum FROM ledger_heads WHERE ledger_id=?',[b.ledgerId]);
   assert.equal(oldHead.state_checksum,encoded.checksum);
  });
 });
});
