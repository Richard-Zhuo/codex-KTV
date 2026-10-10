import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { freshEnvironment, uniquePerson } from '../rehearsal/fresh-environment.js';
import { migrateFresh } from '../rehearsal/migration.js';
import { bootstrapIdentities } from './bootstrap.js';
import { inspectFirstInstall, applyInitialLedger, applyOpeningInventory,
  firstInstallConfirmation, validateFirstInstallPlan } from './first-install.js';
import { readProductionReadiness } from './readiness.js';
import { createMySqlLedgerStore } from '../ledger/mysql-store.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createAuthService } from '../auth/service.js';
import { createMemoryLoginRateLimiter } from '../auth/rate-limit.js';
import { digestSessionToken } from '../auth/session-token.js';
import { createTrustedLedgerApplication } from '../ledger/application.js';
import { initialState } from '../rules.js';
import { encodeLedgerSnapshot } from '../ledger/mysql-snapshot.js';
import { runFirstInstallCli } from './first-install-cli.js';

const commit='eb0931196ac797e95b785d2a1ee30ed02f6c8a2b';
const productionEnv={NODE_ENV:'production',KTV_HTTP_ENV:'production',KTV_DEPLOYMENT_ENV:'production'};
const root=new URL('../',import.meta.url);

test('S1 plan and CLI reject malformed targets without opening a database',async()=>{
  const base={version:1,environment:'production',database:'synthetic_live',serverUuid:randomUUID(),
    storeId:'store-1',ledgerId:'ledger-1',applicationCommit:commit,kind:'ledger'};
  const first=validateFirstInstallPlan(base);
  const reordered=validateFirstInstallPlan({kind:'ledger',ledgerId:'ledger-1',applicationCommit:commit,
    storeId:'store-1',serverUuid:base.serverUuid,database:'synthetic_live',environment:'production',version:1});
  assert.equal(firstInstallConfirmation(first),firstInstallConfirmation(reordered));
  for(const bad of [{...base,kind:'other'},{...base,database:'jbhh_ktv_test',extra:true},
    {...base,environment:'demo'},{...base,serverUuid:'wrong'}])
    assert.throws(()=>validateFirstInstallPlan(bad));
  const output=[],code=await runFirstInstallCli(['--apply'],productionEnv,
    {log:v=>output.push(v),error:v=>output.push(v)});
  assert.equal(code,1);assert.deepEqual(JSON.parse(output[0]),{code:'S1_ARGUMENTS_INVALID'});
});

test('S1 first install on isolated MySQL 8.4.11', {skip:process.env.S1_RUN!=='synthetic-only',timeout:300000},async t=>{
  const f=await freshEnvironment(fileURLToPath(root),{packages:false});
  try {
    const database=f.names.entryDatabase;
    const pool=await f.createDatabase(database);f.pools.add(pool);
    const connection=await pool.getConnection();
    try{await migrateFresh(connection,root);}finally{connection.release();}
    const common={version:1,environment:'production',database,serverUuid:f.identity.server_uuid,
      storeId:f.names.storeId,ledgerId:f.names.ledgerId,applicationCommit:commit};
    const config={environment:'production',database,storeId:f.names.storeId,
      ledgerId:f.names.ledgerId,applicationCommit:commit,timeZone:'Asia/Shanghai',deviceControlMode:'disabled'};
    const databaseUrl=f.dbUrl(database);
    const owner=uniquePerson('opening',['inventory.opening']);
    const approver=uniquePerson('approver',['inventory.approve']);
    const viewer=uniquePerson('viewer');
    const people=[owner,approver,viewer],password=randomBytes(32).toString('base64url');
    f.secretMarkers.add(password);
    const credentials=p=>({loginIdentifier:p.loginIdentifier,password});
    const identityPlan={configVersion:'s1-synthetic',environment:'production',database,
      storeId:f.names.storeId,ledgerId:f.names.ledgerId,approved:true,people};
    const identityArgs={pool,plan:identityPlan,databaseUrl,
      confirmation:database+'/'+f.names.storeId+'/'+f.names.ledgerId,
      initiatedBy:'S1-SYNTHETIC-OPERATOR',env:productionEnv,
      passwords:Object.fromEntries(people.map(p=>[p.principalId,password]))};
    const ledgerPlan={...common,kind:'ledger'};
    const install={pool,plan:ledgerPlan,databaseUrl,config,env:productionEnv};
    const apply=plan=>({pool,plan,databaseUrl,config,env:productionEnv,
      confirmation:firstInstallConfirmation(plan)});
    const snapshot=async()=>{
      const [tables]=await pool.query('SHOW TABLES'),result={};
      for(const row of tables){
        const table=Object.values(row)[0];
        const [rows]=await pool.query('SELECT * FROM '+table);
        result[table]=createHash('sha256').update(JSON.stringify(rows.map(v=>JSON.stringify(v)).sort())).digest('hex');
      }
      return result;
    };
    await t.test('fresh preflight reports ledger and inventory blockers; dry-run writes zero rows',async()=>{
      const before=await snapshot(),report=await readProductionReadiness({pool,config});
      assert.equal(report.ready,false);assert.equal(report.revision,null);
      assert.ok(report.blockers.some(b=>b.code==='LEDGER_NOT_INITIALIZED'));
      assert.ok(report.blockers.some(b=>b.code==='INVENTORY_NOT_INITIALIZED'));
      const dry=await inspectFirstInstall(install);
      assert.equal(dry.ledgerInitialized,false);assert.equal(dry.identity.ready,false);
      assert.ok(dry.inventoryItemsStillNull.length>0);
      assert.deepEqual(await snapshot(),before);
    });
    await bootstrapIdentities({...identityArgs,dryRun:false});
    await t.test('target mismatch and existing business data refuse before ledger write',async()=>{
      for(const patch of [{database:'wrong_db'},{storeId:'wrong-store'},{ledgerId:'wrong-ledger'},
        {serverUuid:randomUUID()}]) {
        const plan={...ledgerPlan,...patch};
        const args={...install,plan,confirmation:firstInstallConfirmation(plan),initiatedBy:'S1-SYNTHETIC-OPERATOR'};
        await assert.rejects(applyInitialLedger(args),e=>e.code?.startsWith('S1_'));
      }
      await assert.rejects(applyInitialLedger({...apply(ledgerPlan),
        confirmation:'S1/wrong',initiatedBy:'S1-SYNTHETIC-OPERATOR'}),{code:'S1_CONFIRMATION_REQUIRED'});
      await assert.rejects(applyInitialLedger({...apply(ledgerPlan),
        env:{...productionEnv,KTV_HTTP_ENV:'test'},initiatedBy:'S1-SYNTHETIC-OPERATOR'}),{code:'S1_ENVIRONMENT_INVALID'});
      await pool.execute("INSERT INTO recovery_events(event_type,initiated_by,reason,facts) VALUES('probe','synthetic','probe','{}')");
      await assert.rejects(applyInitialLedger({...apply(ledgerPlan),initiatedBy:'S1-SYNTHETIC-OPERATOR'}),{code:'S1_EXISTING_BUSINESS_DATA'});
      await pool.execute('DELETE FROM recovery_events WHERE initiated_by=?',['synthetic']);
      const [[count]]=await pool.execute('SELECT COUNT(*) AS n FROM ledger_heads');
      assert.equal(Number(count.n),0);
    });
    await t.test('concurrent first install creates one authority; same plan replays',async()=>{
      const args={...apply(ledgerPlan),initiatedBy:'S1-SYNTHETIC-OPERATOR'};
      const results=await Promise.all([applyInitialLedger(args),applyInitialLedger(args)]);
      assert.deepEqual(results.map(r=>r.status).sort(),['already_initialized','initialized']);
      assert.equal((await applyInitialLedger(args)).status,'already_initialized');
      const [[heads]]=await pool.execute('SELECT COUNT(*) AS n FROM ledger_heads');
      const [[audit]]=await pool.execute("SELECT COUNT(*) AS n FROM production_bootstrap_events WHERE config_version='S1-v1'");
      assert.equal(Number(heads.n),1);assert.equal(Number(audit.n),1);
      const report=await readProductionReadiness({pool,config});
      assert.equal(report.ready,false);assert.equal(report.blockers.some(b=>b.code==='LEDGER_NOT_INITIALIZED'),false);
      assert.ok(report.blockers.some(b=>b.code==='INVENTORY_NOT_INITIALIZED'));
      const other={...ledgerPlan,ledgerId:'other-ledger'};
      await assert.rejects(applyInitialLedger({...apply(other),config:{...config,ledgerId:'other-ledger'},
        initiatedBy:'S1-SYNTHETIC-OPERATOR'}),e=>e.code?.startsWith('S1_'));
    });
    const store=createMySqlLedgerStore({pool,database,ledgerId:f.names.ledgerId});
    const stockPlan={...common,kind:'stock',operationKey:randomUUID(),expectedRevision:0,
      actorPrincipalId:owner.principalId,stockKind:'drink',productId:'bw',count:7,reason:'SYNTHETIC counted opening'};
    let requestId;
    await t.test('stock uses trusted auth, operation key and revision; partial state remains blocked',async()=>{
      const unauthorized={...stockPlan,operationKey:randomUUID(),actorPrincipalId:viewer.principalId,productId:'qd'};
      await assert.rejects(applyOpeningInventory({...apply(unauthorized),credential:credentials(viewer)}),e=>e.code==='S1_FAILED');
      assert.equal((await store.read()).revision,0);
      const result=await applyOpeningInventory({...apply(stockPlan),credential:credentials(owner)});
      assert.equal(result.status,'committed');requestId=result.requestId;assert.ok(Number.isSafeInteger(requestId));
      assert.equal((await store.read()).state.inventory.bw.count,null);
      const partial=await readProductionReadiness({pool,config});assert.equal(partial.ready,false);
      assert.ok(partial.blockers.some(b=>b.code==='INVENTORY_NOT_INITIALIZED'));
      assert.equal((await applyOpeningInventory({...apply(stockPlan),credential:credentials(owner)})).status,'committed');
      const changed={...stockPlan,count:8};
      assert.equal((await applyOpeningInventory({...apply(changed),credential:credentials(owner)})).status,'idempotency-conflict');
      assert.equal((await store.read()).revision,1);
    });
    await t.test('approval applies actual count once and supports replay after restart',async()=>{
      const approval={...common,kind:'approve',operationKey:randomUUID(),expectedRevision:1,
        actorPrincipalId:approver.principalId,requestId,decisionNote:'SYNTHETIC independently checked'};
      assert.equal((await applyOpeningInventory({...apply(approval),credential:credentials(approver)})).status,'committed');
      const head=await store.read();
      assert.equal(head.state.inventory.bw.count,7);
      assert.equal(head.state.inventoryReviews.find(r=>r.id===requestId).decidedByPrincipalId,approver.principalId);
      assert.equal((await applyOpeningInventory({...apply(approval),credential:credentials(approver)})).status,'committed');
      assert.equal((await store.read()).revision,2);
    });
    await t.test('rejected opening followed by identical recount returns the new review ID',async()=>{
      const first={...common,kind:'stock',operationKey:randomUUID(),expectedRevision:(await store.read()).revision,
        actorPrincipalId:owner.principalId,stockKind:'drink',productId:'qd',count:17,reason:'SYNTHETIC repeat count'};
      const submitted=await applyOpeningInventory({...apply(first),credential:credentials(owner)});
      assert.equal(submitted.status,'committed');
      const authStore=createMySqlAuthStore({pool,database});
      const auth=createAuthService({store:authStore,rateLimiter:createMemoryLoginRateLimiter()});
      const session=await auth.login(credentials(approver));assert.equal(session.ok,true);
      try{
        const trusted=createTrustedLedgerApplication({store:createMySqlLedgerStore({pool,database,
          ledgerId:f.names.ledgerId,bindSessionRevalidation:authStore.bindSessionRevalidation}),
          businessTimeZone:'Asia/Shanghai'});
        const rejected=await trusted.execute({operationKey:randomUUID(),expectedRevision:submitted.revision,
          action:'rejectInventory',payload:{request:submitted.requestId,decisionNote:'SYNTHETIC recount required'}},
          {tokenDigest:digestSessionToken(session.token)});
        assert.equal(rejected.status,'committed');
      }finally{await auth.logout(session.token);}
      const second={...first,operationKey:randomUUID(),expectedRevision:(await store.read()).revision};
      const resubmitted=await applyOpeningInventory({...apply(second),credential:credentials(owner)});
      assert.equal(resubmitted.status,'committed');
      assert.notEqual(resubmitted.requestId,submitted.requestId);
      assert.equal((await applyOpeningInventory({...apply(first),credential:credentials(owner)})).requestId,null);
      const approval={...common,kind:'approve',operationKey:randomUUID(),expectedRevision:resubmitted.revision,
        actorPrincipalId:approver.principalId,requestId:resubmitted.requestId,decisionNote:'SYNTHETIC recount approved'};
      assert.equal((await applyOpeningInventory({...apply(approval),credential:credentials(approver)})).status,'committed');
      assert.equal((await store.read()).state.inventory.qd.count,17);
    });
    await t.test('all remaining explicit synthetic counts and approvals clear S1 blockers',async()=>{
      const initial=(await store.read()).state;
      for(const [stockKind,items] of [['drink',initial.inventory],['consumable',initial.consumables]])
        for(const productId of Object.keys(items).filter(id=>!['bw','qd'].includes(id))) {
          const before=await store.read();
          const stock={...common,kind:'stock',operationKey:randomUUID(),expectedRevision:before.revision,
            actorPrincipalId:owner.principalId,stockKind,productId,count:37,reason:'SYNTHETIC counted opening',
            ...(stockKind==='consumable'?{opened:0}:{})};
          const submitted=await applyOpeningInventory({...apply(stock),credential:credentials(owner)});
          assert.equal(submitted.status,'committed');
          const review={...common,kind:'approve',operationKey:randomUUID(),expectedRevision:submitted.revision,
            actorPrincipalId:approver.principalId,requestId:submitted.requestId,decisionNote:'SYNTHETIC independently checked'};
          assert.equal((await applyOpeningInventory({...apply(review),credential:credentials(approver)})).status,'committed');
        }
      const report=await readProductionReadiness({pool,config});
      assert.equal(report.blockers.some(b=>['LEDGER_NOT_INITIALIZED','INVENTORY_NOT_INITIALIZED'].includes(b.code)),false);
      assert.equal(report.ready,true);
    });
    await t.test('production CLI dry-run, ledger and inventory plans use external inputs without exposing secrets',async()=>{
      const cliDb='jbhh_ktv_restore_s5e_cli_'+f.names.id;
      const cliPool=await f.createDatabase(cliDb);f.pools.add(cliPool);
      const c=await cliPool.getConnection();try{await migrateFresh(c,root);}finally{c.release();}
      const cliUrl=f.dbUrl(cliDb),cliIdentity={...identityPlan,database:cliDb};
      await bootstrapIdentities({...identityArgs,pool:cliPool,plan:cliIdentity,databaseUrl:cliUrl,
        confirmation:cliDb+'/'+f.names.storeId+'/'+f.names.ledgerId,dryRun:false});
      const dbUser='s1_'+f.names.id,dbPassword=randomBytes(24).toString('hex');
      await f.setup.query('CREATE USER ?@? IDENTIFIED BY ?',[dbUser,'127.0.0.1',dbPassword]);f.users.add(dbUser);
      await f.setup.query('GRANT ALL PRIVILEGES ON '+cliDb+'.* TO ?@?',[dbUser,'127.0.0.1']);
      const secretFile=join(f.dirs.secrets,'s1-db.json'),configFile=join(f.dirs.secrets,'s1-config.json'),
        planFile=join(f.dirs.secrets,'s1-plan.json'),actorFile=join(f.dirs.secrets,'s1-actor.json');
      await writeFile(secretFile,JSON.stringify({database:{host:'127.0.0.1',port:f.port,name:cliDb,user:dbUser,password:dbPassword}}));
      await writeFile(configFile,JSON.stringify({configVersion:1,applicationCommit:commit,publicOrigin:'https://synthetic.example:4443',
        listenHost:'127.0.0.1',port:4443,storeId:f.names.storeId,ledgerId:f.names.ledgerId,timeZone:'Asia/Shanghai',
        businessDateCutoff:'12:00',sessionRuleVersion:'opening-hours-v1',deviceControlMode:'disabled',
        liveControlEnabled:false,secretsFile:secretFile,logDirectory:f.dirs.logs,serviceAccountSid:'S-1-5-21-123-456-789-1001',
        backupPolicyConfigured:false,directoryAclReviewed:true,networkModel:'private-vpn'}));
      const cliCommon={...common,database:cliDb},cliLedger={...cliCommon,kind:'ledger'};
      const logged=[],output={log:value=>logged.push(value),error:value=>logged.push(value)};
      const run=(plan,mode,actor)=>runFirstInstallCli([mode,'--plan',planFile,'--config-file',configFile,
        ...(mode==='--apply'?['--confirm-target',firstInstallConfirmation(validateFirstInstallPlan(plan)),
          '--initiated-by','S1-SYNTHETIC-OPERATOR']:[]),
        ...(actor?['--actor-secrets-file',actorFile]:[])],productionEnv,output);
      await writeFile(planFile,JSON.stringify(cliLedger));
      const [[before]]=await cliPool.execute('SELECT COUNT(*) AS n FROM ledger_heads');
      assert.equal(await run(cliLedger,'--dry-run'),0);
      assert.equal(JSON.parse(logged.at(-1)).ledgerInitialized,false);
      assert.deepEqual(JSON.parse(logged.at(-1)).plannedAction,{kind:'ledger'});
      const [[still]]=await cliPool.execute('SELECT COUNT(*) AS n FROM ledger_heads');
      assert.equal(still.n,before.n);
      const concurrentApply=()=>new Promise((resolve,reject)=>{
        const args=['production/first-install-cli.js','--apply','--plan',planFile,
          '--config-file',configFile,'--confirm-target',firstInstallConfirmation(cliLedger),
          '--initiated-by','S1-SYNTHETIC-OPERATOR'];
        const child=spawn(process.execPath,args,{cwd:fileURLToPath(root),
          env:{...process.env,...productionEnv},windowsHide:true});
        let stdout='',stderr='';
        child.stdout.on('data',chunk=>{stdout+=chunk;});
        child.stderr.on('data',chunk=>{stderr+=chunk;});
        child.on('error',reject);
        child.on('close',code=>resolve({code,stdout,stderr}));
      });
      const concurrent=await Promise.all([concurrentApply(),concurrentApply()]);
      assert.deepEqual(concurrent.map(result=>result.code),[0,0]);
      assert.deepEqual(concurrent.map(result=>JSON.parse(result.stdout.trim()).status).sort(),
        ['already_initialized','initialized']);
      const [[onlyHead]]=await cliPool.execute('SELECT COUNT(*) AS n FROM ledger_heads');
      const [[onlyReceipt]]=await cliPool.execute("SELECT COUNT(*) AS n FROM production_bootstrap_events WHERE config_version='S1-v1'");
      assert.equal(Number(onlyHead.n),1);
      assert.equal(Number(onlyReceipt.n),1);
      assert.equal(await run(cliLedger,'--apply'),0);
      assert.equal(JSON.parse(logged.at(-1)).status,'already_initialized');
      const cliStock={...cliCommon,kind:'stock',operationKey:randomUUID(),expectedRevision:0,
        actorPrincipalId:owner.principalId,stockKind:'drink',productId:'bw',count:9,reason:'SYNTHETIC CLI count'};
      await writeFile(planFile,JSON.stringify(cliStock));
      assert.equal(await run(cliStock,'--dry-run'),0);
      assert.equal(JSON.parse(logged.at(-1)).plannedAction.count,9);
      assert.equal(JSON.parse(logged.at(-1)).plannedAction.productId,'bw');
      await writeFile(actorFile,JSON.stringify(credentials(owner)));
      assert.equal(await run(cliStock,'--apply',true),0);
      const requestId=JSON.parse(logged.at(-1)).requestId;
      const cliApprove={...cliCommon,kind:'approve',operationKey:randomUUID(),expectedRevision:1,
        actorPrincipalId:approver.principalId,requestId,decisionNote:'SYNTHETIC CLI approval'};
      await writeFile(planFile,JSON.stringify(cliApprove));
      await writeFile(actorFile,JSON.stringify(credentials(approver)));
      assert.equal(await run(cliApprove,'--apply',true),0);
      const [[head]]=await cliPool.execute('SELECT revision FROM ledger_heads');
      assert.equal(Number(head.revision),2);
      assert.equal(JSON.stringify(logged).includes(dbPassword),false);
      assert.equal(JSON.stringify(logged).includes(password),false);
      assert.equal(JSON.stringify(logged).includes('mysql://'),false);
    });
    await t.test('commit acknowledgement loss replays existing first install on separate synthetic database',async()=>{
      const crashDb='jbhh_ktv_restore_s5e_crash_'+f.names.id;
      const crashPool=await f.createDatabase(crashDb);f.pools.add(crashPool);
      const c=await crashPool.getConnection();try{await migrateFresh(c,root);}finally{c.release();}
      const crashUrl=f.dbUrl(crashDb),crashConfig={...config,database:crashDb};
      const crashIdentity={...identityPlan,database:crashDb};
      await bootstrapIdentities({...identityArgs,pool:crashPool,plan:crashIdentity,databaseUrl:crashUrl,
        confirmation:crashDb+'/'+f.names.storeId+'/'+f.names.ledgerId,dryRun:false});
      const crashPlan={...ledgerPlan,database:crashDb};
      const faulty={getConnection:async()=>{
        const inner=await crashPool.getConnection();let inserted=false;
        return new Proxy(inner,{get(target,key){
          if(key==='execute')return async(sql,...rest)=>{
            if(String(sql).startsWith('INSERT INTO ledger_heads'))inserted=true;
            return target.execute(sql,...rest);
          };
          if(key==='commit')return async()=>{await target.commit();if(inserted)throw Error('synthetic lost acknowledgement');};
          const value=target[key];return typeof value==='function'?value.bind(target):value;
        }});
      }};
      const crashArgs={pool:faulty,plan:crashPlan,databaseUrl:crashUrl,config:crashConfig,
        confirmation:firstInstallConfirmation(crashPlan),initiatedBy:'S1-SYNTHETIC-OPERATOR',env:productionEnv};
      await assert.rejects(applyInitialLedger(crashArgs),{code:'S1_COMMIT_OUTCOME_UNKNOWN'});
      assert.equal((await applyInitialLedger({...crashArgs,pool:crashPool})).status,'already_initialized');
      const [[n]]=await crashPool.execute('SELECT COUNT(*) AS n FROM ledger_heads');
      assert.equal(Number(n.n),1);
      const outcomeUnknownPool={getConnection:async()=>{
        const inner=await crashPool.getConnection();let operationWritten=false;
        return new Proxy(inner,{get(target,key){
          if(key==='execute')return async(sql,...args)=>{
            if(String(sql).startsWith('INSERT INTO')&&String(sql).includes('ledger_operations'))operationWritten=true;
            return target.execute(sql,...args);
          };
          if(key==='commit')return async()=>{await target.commit();if(operationWritten)throw Error('synthetic lost operation acknowledgement');};
          const value=target[key];return typeof value==='function'?value.bind(target):value;
        }});
      }};
      const stock={...crashPlan,kind:'stock',operationKey:randomUUID(),expectedRevision:0,
        actorPrincipalId:owner.principalId,stockKind:'drink',productId:'bw',count:11,reason:'SYNTHETIC unknown outcome'};
      const stockArgs={pool:outcomeUnknownPool,plan:stock,databaseUrl:crashUrl,config:crashConfig,
        confirmation:firstInstallConfirmation(stock),credential:credentials(owner),env:productionEnv};
      await assert.rejects(applyOpeningInventory(stockArgs),{code:'S1_COMMIT_OUTCOME_UNKNOWN'});
      const submitted=await applyOpeningInventory({...stockArgs,pool:crashPool});
      assert.equal(submitted.status,'committed');assert.equal(submitted.revision,1);
      const approval={...crashPlan,kind:'approve',operationKey:randomUUID(),expectedRevision:1,
        actorPrincipalId:approver.principalId,requestId:submitted.requestId,decisionNote:'SYNTHETIC unknown outcome approval'};
      const approvalArgs={...stockArgs,plan:approval,confirmation:firstInstallConfirmation(approval),
        credential:credentials(approver)};
      await assert.rejects(applyOpeningInventory(approvalArgs),{code:'S1_COMMIT_OUTCOME_UNKNOWN'});
      const approved=await applyOpeningInventory({...approvalArgs,pool:crashPool});
      assert.equal(approved.status,'committed');assert.equal(approved.revision,2);
      const [[operations]]=await crashPool.execute('SELECT COUNT(*) AS n FROM ledger_operations');
      assert.equal(Number(operations.n),2);
      assert.equal((await createMySqlLedgerStore({pool:crashPool,database:crashDb,ledgerId:f.names.ledgerId}).read()).state.inventory.bw.count,11);
    });
    await t.test('pre-existing ledger without formal receipt refuses without reset',async()=>{
      const conflictDb='jbhh_ktv_restore_s5e_conflict_'+f.names.id;
      const conflictPool=await f.createDatabase(conflictDb);f.pools.add(conflictPool);
      const c=await conflictPool.getConnection();try{await migrateFresh(c,root);}finally{c.release();}
      const conflictUrl=f.dbUrl(conflictDb);
      const state=initialState(),encoded=encodeLedgerSnapshot(state);
      await conflictPool.execute('INSERT INTO ledger_heads(ledger_id,revision,state_schema_version,state_json,state_checksum) VALUES(?,0,?,?,?)',
        [f.names.ledgerId,state.version,encoded.json,encoded.checksum]);
      const conflictPlan={...ledgerPlan,database:conflictDb};
      await assert.rejects(applyInitialLedger({pool:conflictPool,plan:conflictPlan,databaseUrl:conflictUrl,
        config:{...config,database:conflictDb},env:productionEnv,
        confirmation:firstInstallConfirmation(conflictPlan),initiatedBy:'S1-SYNTHETIC-OPERATOR'}),
        {code:'S1_EXISTING_LEDGER_CONFLICT'});
      const [[head]]=await conflictPool.execute('SELECT revision,state_checksum FROM ledger_heads');
      assert.equal(Number(head.revision),0);assert.equal(head.state_checksum,encoded.checksum);
      const [[receipts]]=await conflictPool.execute("SELECT COUNT(*) AS n FROM production_bootstrap_events WHERE config_version='S1-v1'");
      assert.equal(Number(receipts.n),0);
      const [[sourceReceipt]]=await pool.execute("SELECT store_id,ledger_id,environment,initiated_by,config_version,plan_digest,facts FROM production_bootstrap_events WHERE config_version='S1-v1'");
      await conflictPool.execute('INSERT INTO production_bootstrap_events(store_id,ledger_id,environment,initiated_by,config_version,plan_digest,facts) VALUES(?,?,?,?,?,?,?)',
        [sourceReceipt.store_id,sourceReceipt.ledger_id,sourceReceipt.environment,sourceReceipt.initiated_by,
          sourceReceipt.config_version,sourceReceipt.plan_digest,JSON.stringify(sourceReceipt.facts)]);
      const copied=await readProductionReadiness({pool:conflictPool,config:{...config,database:conflictDb}});
      assert.equal(copied.ready,false);
      assert.ok(copied.blockers.some(b=>b.code==='LEDGER_NOT_INITIALIZED'));
    });
  }finally{
    const result=await f.cleanup();
    assert.equal(result.mysqlProcess,'absent');
    assert.equal(result.databases,'absent');
  }
});
