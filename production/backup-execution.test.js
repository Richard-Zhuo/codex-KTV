import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createServiceBackupExecution} from './backup-execution.js';
import {backupExecutionPolicy} from './backup-execution-policy.js';
import {validateRuntimeConfig,runtimePublicFacts} from './runtime-config.js';
import {canonical,digest,schemaSpec,verifyArtifact} from '../backup/format.js';

const commit='a'.repeat(40),serverUuid='11111111-1111-4111-8111-111111111111';
const tick=()=>new Promise(r=>setImmediate(r));
async function artifact(output,config,patch={}) {
  const spec=await schemaSpec(),tables=Object.fromEntries(spec.tables.map(name=>[name,{columns:['id'],rows:[]}]));
  tables.production_bootstrap_events={columns:['store_id','ledger_id','environment'],rows:[[config.storeId,config.ledgerId,'production']]};
  tables.ledger_heads={columns:['ledger_id','revision','state_checksum'],rows:[[config.ledgerId,1,'b'.repeat(64)]]};
  const data=canonical({backupFormatVersion:1,tables});
  const manifest={backupFormatVersion:1,createdAt:new Date().toISOString(),engine:'InnoDB',mysqlVersion:'8.4.11',
    schema:spec.manifest,migrationVersion:Object.keys(spec.manifest.migrations).at(-1),
    storeId:config.storeId,ledgerId:config.ledgerId,source:{environment:'production',database:'synthetic',serverUuid},
    applicationCommit:commit,ledgerHeads:[{ledgerId:config.ledgerId,revision:1,checksum:'b'.repeat(64)}],
    dataChecksum:digest(data),dataBytes:Buffer.byteLength(data),backupId:randomUUID(),...patch};
  const checksum=digest(canonical(manifest));
  await mkdir(output);await writeFile(join(output,'data.json'),data);await writeFile(join(output,'manifest.json'),canonical(manifest));
  await writeFile(join(output,'manifest.sha256'),checksum+'\n');
  return {code:'BACKUP_VERIFIED',directory:output,checksum,createdAt:manifest.createdAt,
    source:manifest.source,storeId:config.storeId,ledgerId:config.ledgerId};
}
async function fixture(t,{enabled=true,timeoutMs=1000}={}) {
  const root=await mkdtemp(join(tmpdir(),'ktv-b2-unit-')),calls=[],reports=[],logs=[],children=[];
  const config={databaseUrl:'mysql://synthetic:synthetic-secret@127.0.0.1:1/synthetic',environment:'production',
    storeId:'synthetic-store',ledgerId:'synthetic-ledger',serverUuid};
  const runtimeConfigFile=join(root,'runtime.json'),backupFile=join(root,'backup.json');
  await writeFile(backupFile,JSON.stringify(config));
  const loaded={config:{storeId:config.storeId,ledgerId:config.ledgerId,applicationCommit:commit,
    monitoring:{backupDirectory:root},...(enabled===undefined?{}:{backupExecution:{enabled,timeoutMs}})},logDirectory:root};
  const binding={node:process.execPath,entry:fileURLToPath(new URL('./start.js',import.meta.url)),
    host:join(root,'trusted-host.exe'),runtimeConfigFile,backupConfigFile:backupFile};
  const ports={deployment:async()=>binding,report:async(_directory,r)=>reports.push(r),
    launch:(file,args,options)=>{
      calls.push({file,args,options});
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kills=[];
      child.kill=signal=>{child.kills.push(signal);queueMicrotask(()=>child.emit('close',null,signal));return true;};
      children.push(child);return child;
    }};
  const options={loaded,runtimeConfigFile,logger:{info:r=>logs.push(r)},onContainmentFailure:()=>calls.push('containment-fatal')};
  const make=()=>createServiceBackupExecution(options,ports),runner=make();
  t.after(async()=>{
    await runner.stop();
    assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('ktv-b2-unit-'));
    await rm(root,{recursive:true,force:true});
  });
  const started=async()=>{for(let n=0;n<100;n++){if(children.length)return children.at(-1);await new Promise(r=>setTimeout(r,10));}throw Error('NO_CHILD '+JSON.stringify(logs));};
  const finish=async(child,{code=0,signal=null,result,patch}={})=>{
    const output=calls.findLast(x=>x.args)?.args[8];
    const value=result??await artifact(output,config,patch);
    child.stdout.end(JSON.stringify(value));child.emit('close',code,signal);return value;
  };
  return {root,config,loaded,binding,ports,options,runner,make,calls,reports,logs,children,started,finish};
}
test('B2-A absent policy is disabled; malformed policy and arbitrary command fields fail closed',()=>{
  assert.equal(backupExecutionPolicy().enabled,false);
  for(const policy of [null,true,{},[],{enabled:'true'},{enabled:true,node:'evil.exe'},{enabled:true,timeoutMs:0},{enabled:true,timeoutMs:600001}])
    assert.throws(()=>backupExecutionPolicy(policy),{code:'BACKUP_EXECUTION_CONFIG_INVALID'});
  const env={NODE_ENV:'production',KTV_HTTP_ENV:'production',KTV_DEPLOYMENT_ENV:'production'};
  const config={configVersion:1,applicationCommit:commit,publicOrigin:'https://synthetic.invalid:8443',listenHost:'127.0.0.1',port:8443,
    storeId:'synthetic',ledgerId:'synthetic',timeZone:'Asia/Shanghai',businessDateCutoff:'06:00',sessionRuleVersion:'test',
    deviceControlMode:'disabled',liveControlEnabled:false,secretsFile:'C:/synthetic/secret.json',logDirectory:'C:/synthetic/logs',
    serviceAccountSid:'S-1-5-21-1',backupPolicyConfigured:false,directoryAclReviewed:true,networkModel:'private-vpn'};
  validateRuntimeConfig(config,env);
  const enabled=validateRuntimeConfig({...config,backupExecution:{enabled:true,timeoutMs:1000}},env);
  assert.equal(runtimePublicFacts(enabled).backupExecution.enabled,true);
  assert.equal(Object.hasOwn(runtimePublicFacts(config),'backupExecution'),false);
  assert.throws(()=>validateRuntimeConfig({...config,backupExecution:{enabled:true,command:'restore'}},env));
});
test('B2-A default disabled performs no admission, subprocess or report',async t=>{
  const f=await fixture(t,{enabled:false});f.ports.deployment=()=>{throw Error('must not run');};
  assert.deepEqual(await f.runner.runOnce(),{code:'BACKUP_EXECUTION_DISABLED'});
  assert.equal(f.calls.length,0);assert.equal(f.reports.length,0);
  delete f.loaded.config.backupExecution;
  const absent=f.make();assert.equal((await absent.runOnce()).code,'BACKUP_EXECUTION_DISABLED');await absent.stop();
  assert.deepEqual(await f.runner.runOnce({command:'restore'}),{code:'BACKUP_EXECUTION_ARGUMENTS_DENIED'});
});
test('B2-A fixed SCM-bound host/Node/entry/config, backup-only mode, no shell or injected environment',async t=>{
  const f=await fixture(t);const pending=f.runner.runOnce(),child=await f.started();
  const call=f.calls[0];
  assert.equal(call.file,f.binding.host);
  assert.deepEqual(call.args.slice(0,8),['--backup-child','--node',process.execPath,'--entry',f.binding.entry,'--config',f.binding.runtimeConfigFile,'--output-dir']);
  assert.equal(dirname(call.args[8]),f.root);
  assert.deepEqual(call.args.slice(9),['--confirm',serverUuid+'/synthetic/'+f.config.storeId+'/'+f.config.ledgerId]);
  assert.equal(call.options.shell,false);assert.equal(call.options.detached,false);assert.equal(call.options.windowsHide,true);
  assert.equal(call.options.env.NODE_OPTIONS,undefined);assert.equal(call.options.env.LEDGER_MYSQL_TEST_URL,undefined);
  assert.equal(Object.hasOwn(call.options,'uid'),false);assert.equal(Object.hasOwn(call.options,'userName'),false);
  child.stderr.write('synthetic-secret mysql://secret@host/db');
  const result=await f.finish(child);assert.equal((await pending).code,'BACKUP_VERIFIED');
  assert.equal(f.reports.at(-1).success,true);assert.ok(result.checksum);
  const logged=JSON.stringify(f.logs);assert.equal(logged.includes('synthetic-secret'),false);assert.equal(logged.includes(f.root),false);
});
test('B2-A reserves before async admission and excludes a second executor; stop during admission prevents launch',async t=>{
  const f=await fixture(t);let unblock;
  f.ports.deployment=()=>new Promise(r=>{unblock=()=>r(f.binding);});
  const runner=f.make(),other=f.make(),pending=runner.runOnce();await tick();
  assert.equal((await runner.runOnce()).code,'BACKUP_EXECUTION_BUSY');
  assert.equal((await other.runOnce()).code,'BACKUP_EXECUTION_BUSY');
  const stopped=runner.stop();unblock();await stopped;
  assert.equal((await pending).code,'BACKUP_EXECUTION_STOPPED');assert.equal(f.calls.length,0);
  await other.stop();
});
test('B2-A refuses S4 admission failure and registration path drift before spawning',async t=>{
  const f=await fixture(t);
  for(const mutation of [()=>{throw Error('synthetic-secret');},
    async()=>({...f.binding,node:'C:/untrusted/node.exe'}),
    async()=>({...f.binding,entry:'C:/untrusted/start.js'}),
    async()=>({...f.binding,runtimeConfigFile:'C:/untrusted/runtime.json'}),
    async()=>({...f.binding,backupConfigFile:'C:/untrusted/backup.json'})]) {
    const runner=createServiceBackupExecution(f.options,{...f.ports,deployment:mutation});
    assert.equal((await runner.runOnce()).code,'BACKUP_EXECUTION_FAILED');await runner.stop();
  }
  assert.equal(f.calls.length,0);assert.ok(f.reports.every(r=>!r.success));
});
test('B2-A refuses wrong store, source selector and reporting directory without a subprocess',async t=>{
  const f=await fixture(t);
  for(const patch of [{storeId:'other'},{environment:'test'},{operationalDirectory:'C:/other'},{serverUuid:'bad'}]) {
    const runner=createServiceBackupExecution(f.options,{...f.ports,readConfig:async()=>({...f.config,...patch})});
    assert.equal((await runner.runOnce()).code,'BACKUP_EXECUTION_FAILED');await runner.stop();
  }
  assert.equal(f.calls.length,0);
});
test('B2-A nonzero exit, signal, invalid stdout and spawn failure never report success',async t=>{
  for(const mode of ['exit','signal','json','spawn','error']) {
    await t.test(mode,async t=>{
      const f=await fixture(t);
      if(mode==='spawn')f.ports.launch=()=>{throw Error('synthetic-secret');};
      const runner=f.make(),pending=runner.runOnce();
      if(mode!=='spawn'){
        const child=await f.started();child.stderr.write('synthetic-secret');
        if(mode==='error')child.emit('error',Error('synthetic-secret'));
        else {child.stdout.end(mode==='json'?'synthetic-secret':'{}');child.emit('close',mode==='exit'?1:0,mode==='signal'?'SIGKILL':null);}
      }
      assert.equal((await pending).code,'BACKUP_EXECUTION_FAILED');assert.ok(f.reports.every(r=>!r.success));await runner.stop();
    });
  }
});
test('B2-A exit zero with an incomplete artifact is rejected by the original artifact verifier',async t=>{
  const f=await fixture(t),pending=f.runner.runOnce(),child=await f.started();
  const output=f.calls[0].args[8];
  await f.finish(child,{result:{code:'BACKUP_VERIFIED',directory:output,checksum:'a'.repeat(64),
    createdAt:new Date().toISOString(),storeId:f.config.storeId,ledgerId:f.config.ledgerId,
    source:{environment:'production',database:'synthetic',serverUuid}}});
  assert.equal((await pending).code,'BACKUP_EXECUTION_FAILED');assert.ok(f.reports.every(r=>!r.success));
});
test('B2-A rejects a tampered artifact and a complete artifact from a different release',async t=>{
  for(const mode of ['tamper','release'])await t.test(mode,async t=>{
    const f=await fixture(t),pending=f.runner.runOnce(),child=await f.started();
    const output=f.calls[0].args[8],result=await artifact(output,f.config,mode==='release'?{applicationCommit:'c'.repeat(40)}:{});
    if(mode==='tamper')await writeFile(join(output,'data.json'),'synthetic-secret');
    await f.finish(child,{result});
    assert.equal((await pending).code,'BACKUP_EXECUTION_FAILED');assert.ok(f.reports.every(r=>!r.success));
  });
});
test('B2-A timeout kills its supervisor, observes close and never returns verified success',async t=>{
  const f=await fixture(t),pending=f.runner.runOnce(),child=await f.started();
  assert.equal((await pending).code,'BACKUP_EXECUTION_TIMEOUT');
  assert.deepEqual(child.kills,['SIGKILL']);assert.ok(f.reports.every(r=>!r.success));
  assert.equal(f.calls.includes('containment-fatal'),false);
});
test('B2-A stop cancels active child, fences future triggers and waits for close',async t=>{
  const f=await fixture(t),pending=f.runner.runOnce(),child=await f.started();
  await f.runner.stop();assert.equal((await pending).code,'BACKUP_EXECUTION_STOPPED');
  assert.deepEqual(child.kills,['SIGKILL']);assert.equal((await f.runner.runOnce()).code,'BACKUP_EXECUTION_STOPPED');
});
test('B2-A shutdown during post-exit verification keeps the run claimed and cannot report success',async t=>{
  const f=await fixture(t);let release,entered=false;
  const runner=createServiceBackupExecution(f.options,{...f.ports,checkArtifact:async(...args)=>{
    entered=true;await new Promise(r=>{release=r;});return verifyArtifact(...args);
  }});
  const pending=runner.runOnce(),child=await f.started();await f.finish(child);
  while(!entered)await tick();
  assert.equal((await runner.runOnce()).code,'BACKUP_EXECUTION_BUSY');
  const stopping=runner.stop();release();await stopping;
  assert.equal((await pending).code,'BACKUP_EXECUTION_STOPPED');assert.ok(f.reports.every(r=>!r.success));
});
test('B2-A bounded stdout kills overflow and never forwards child text',async t=>{
  const f=await fixture(t),pending=f.runner.runOnce(),child=await f.started();
  child.stdout.write('synthetic-secret'.repeat(2000));
  assert.equal((await pending).code,'BACKUP_EXECUTION_FAILED');assert.deepEqual(child.kills,['SIGKILL']);
  assert.equal(JSON.stringify(f.logs).includes('synthetic-secret'),false);
});
test('B2-A unconfirmed supervisor termination fences executor and invokes service fatal containment',async t=>{
  const f=await fixture(t),pending=f.runner.runOnce(),child=await f.started();child.kill=()=>false;
  assert.equal((await pending).code,'BACKUP_EXECUTION_TIMEOUT');
  assert.equal(f.calls.filter(x=>x==='containment-fatal').length,1);
  assert.equal((await f.runner.runOnce()).code,'BACKUP_EXECUTION_STOPPED');
  child.emit('close',1,null);
});

test('B2-A completed backup reporting cannot race into a false timeout or stopped result',async t=>{
  const f=await fixture(t);let release,entered=false;
  const runner=createServiceBackupExecution(f.options,{...f.ports,report:async(_dir,value)=>{
    f.reports.push(value);if(value.success){entered=true;await new Promise(r=>{release=r;});}
  }});
  const pending=runner.runOnce(),child=await f.started();await f.finish(child);
  while(!entered)await tick();
  const stopping=runner.stop();release();await stopping;
  assert.equal((await pending).code,'BACKUP_VERIFIED');assert.equal(f.reports.length,1);assert.equal(f.reports[0].success,true);
});
