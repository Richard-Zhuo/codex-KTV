import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSmokeConfig,validateSmokeAcl} from './wecom-smoke-config.js';

const base={configVersion:1,storeLabel:'Synthetic KTV',corpId:'synthetic-corp',agentId:123,
 secret:'synthetic-secret',criticalRecipients:['owner'],warnRecipients:['owner']};

test('smoke configuration allows exactly one identical user in each route and no token field',()=>{
 assert.equal(validateSmokeConfig(base).warnRecipients[0],'owner');
 for(const patch of [
  {criticalRecipients:[]},{warnRecipients:['owner','staff']},{warnRecipients:['other']},
  {warnRecipients:['@all']},{warnRecipients:['all']},{warnRecipients:['department']},
  {agentId:'123'},{secret:''},{access_token:'synthetic-token'}
 ])assert.throws(()=>validateSmokeConfig({...base,...patch}),{code:/SMOKE_CONFIG_INVALID/});
});

test('smoke ACL accepts only protected operator, SYSTEM and Administrators access',()=>{
 const operator='S-1-5-21-1-2-3-1001';
 const valid={protected:true,current:operator,owner:'S-1-5-32-544',rules:[
  {sid:operator,type:'Allow',rights:197055,inheritance:'ObjectInherit, ContainerInherit'},{sid:'S-1-5-18',type:'Allow',rights:1},
  {sid:'S-1-5-32-544',type:'Allow',rights:1}]};
 assert.doesNotThrow(()=>validateSmokeAcl(valid,{directory:true}));
 for(const acl of [
  {...valid,protected:false},
  {...valid,rules:[...valid.rules,{sid:'S-1-1-0',type:'Allow',rights:1}]},
  {...valid,rules:[...valid.rules,{sid:'S-1-5-11',type:'Allow',rights:1}]},
  {...valid,rules:valid.rules.filter(r=>r.sid!==operator)},
  {...valid,rules:[{sid:operator,type:'Allow',rights:1}]},
  {...valid,rules:[{sid:operator,type:'Allow',rights:3,inheritance:'ObjectInherit'}]}
 ])assert.throws(()=>validateSmokeAcl(acl,{directory:true}),{code:/SMOKE_ACL_DENIED/});
});
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runWeComSmoke,parseSmokeArgs} from './wecom-smoke-cli.js';
import {loadSmokeConfig,validateSmokeStateDirectory,validateSmokeStateFile} from './wecom-smoke-config.js';

const acl={protected:true,current:'S-1-5-21-1-2-3-1001',owner:'S-1-5-32-544',
  rules:[{sid:'S-1-5-21-1-2-3-1001',type:'Allow',rights:197055,inheritance:'ObjectInherit, ContainerInherit'},
    {sid:'S-1-5-18',type:'Allow',rights:1},{sid:'S-1-5-32-544',type:'Allow',rights:1}]};
test('CLI requires explicit mode and confirmation for RESOLVED',()=>{
  assert.deepEqual(parseSmokeArgs(['--config-file','C:\\private\\wecom-smoke.json','--send-resolved',
    '--open-phone-confirmed']).mode,'--send-resolved');
  for(const args of [
    ['--config-file','x','--send-resolved'],
    ['--config-file','x','--send-open','--open-phone-confirmed'],
    ['--config-file','x','--validate-only','--open-phone-confirmed']
  ])assert.throws(()=>parseSmokeArgs(args),{code:'SMOKE_ARGUMENTS_INVALID'});
});
test('file and state ACL gates are independent from production service SID',async()=>{
  const root=await mkdtemp(join(tmpdir(),'wecom-smoke-'));
  try{
    const file=join(root,'wecom-smoke.json');
    await writeFile(file,JSON.stringify(base));
    assert.equal((await loadSmokeConfig(file,{read:async()=>base,fileAcl:async()=>acl})).agentId,123);
    await assert.rejects(loadSmokeConfig(file,{read:async()=>base,
      fileAcl:async()=>({...acl,protected:false})}),{code:'SMOKE_ACL_DENIED'});
    const dir=join(root,'wecom-smoke-state');await mkdir(dir);
    assert.equal(await validateSmokeStateDirectory(dir,{directoryAcl:async()=>acl}),dir);
    await assert.rejects(validateSmokeStateDirectory(dir,{directoryAcl:async()=>({...acl,
      rules:[...acl.rules,{sid:'S-1-1-0',type:'Allow',rights:1}]})}),{code:'SMOKE_ACL_DENIED'});
  }finally{await rm(root,{recursive:true,force:true});}
});
test('validate-only never acquires token, creates state or calls provider',async()=>{
  const root=await mkdtemp(join(tmpdir(),'wecom-smoke-'));
  try{
    const file=join(root,'wecom-smoke.json'),dir=join(root,'wecom-smoke-state');
    await mkdir(dir);
    let calls=0;
    const common={configFile:file,loadConfig:async()=>base,checkDirectory:async()=>dir,
      fetchImpl:async()=>{calls++;throw Error('network forbidden');},checkStateFile:async()=>{}};
    const result=await runWeComSmoke({configFile:file,mode:'--validate-only'},common);
    assert.equal(result.REAL_WECOM_TOKEN,'NO');
    assert.equal(result.REAL_WECOM_SEND,'NO');
    assert.equal(calls,0);
    await assert.rejects(readFile(join(dir,'operational-state.json')),{code:'ENOENT'});
  }finally{await rm(root,{recursive:true,force:true});}
});
test('synthetic OPEN stops; confirmed RESOLVED reuses incident and recipient with higher sequence',async()=>{
  const root=await mkdtemp(join(tmpdir(),'wecom-smoke-'));
  try{
    const file=join(root,'wecom-smoke.json'),dir=join(root,'wecom-smoke-state');
    await mkdir(dir);
    const calls=[];const fetchImpl=async(url,options)=>{
      calls.push({url:String(url),options});
      return new Response(JSON.stringify(String(url).includes('/gettoken')
        ?{errcode:0,access_token:'synthetic-token',expires_in:7200}
        :{errcode:0}),{status:200});
    };
    const deps={loadConfig:async()=>base,checkDirectory:async()=>dir,fetchImpl,checkStateFile:async()=>{},hardenTemp:async()=>{}};
    const run=mode=>runWeComSmoke({configFile:file,mode},deps);
    await assert.rejects(run('--send-resolved'),{code:'SMOKE_RESOLVE_REQUIRES_CONFIRMED_OPEN'});
    const open=await run('--send-open');
    assert.equal(open.NEXT,'WAITING_FOR_HUMAN_PHONE_CONFIRMATION');
    assert.equal(calls.filter(c=>c.url.includes('/message/send')).length,1);
    await assert.rejects(run('--send-open'),{code:'SMOKE_OPEN_ALREADY_ATTEMPTED'});
    const closed=await run('--send-resolved');
    assert.equal(closed.incidentId,open.incidentId);
    assert.ok(closed.sequence>open.sequence);
    const sent=calls.filter(c=>c.url.includes('/message/send')).map(c=>JSON.parse(c.options.body));
    assert.equal(sent.length,2);
    assert.equal(sent[0].touser,'owner');
    assert.equal(sent[1].touser,'owner');
    assert.match(sent[0].text.content,/这是系统告警通道测试，并非真实营业故障/);
    assert.match(sent[1].text.content,/这是系统告警通道测试恢复通知/);
    assert.match(sent[0].text.content,new RegExp(open.incidentId));
    assert.match(sent[1].text.content,new RegExp(open.incidentId));
    assert.doesNotMatch(JSON.stringify({open,closed}),/synthetic-secret|synthetic-token|synthetic-corp|owner/);
    const disk=await readFile(join(dir,'operational-state.json'),'utf8');
    assert.doesNotMatch(disk,/synthetic-secret|synthetic-token|synthetic-corp/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('failed OPEN and recovery retry with stable delivery IDs and no extra incident',async()=>{
  const root=await mkdtemp(join(tmpdir(),'wecom-smoke-'));
  try{
    const file=join(root,'wecom-smoke.json'),dir=join(root,'wecom-smoke-state');
    await mkdir(dir);
    let clock=Date.now(),messages=0;
    const fetchImpl=async url=>new Response(JSON.stringify(String(url).includes('/gettoken')
      ?{errcode:0,access_token:'synthetic-token',expires_in:7200}
      :{errcode:++messages===1||messages===3?45009:0}),{status:200});
    const deps={loadConfig:async()=>base,checkDirectory:async()=>dir,fetchImpl,now:()=>clock,checkStateFile:async()=>{},hardenTemp:async()=>{}};
    const run=mode=>runWeComSmoke({configFile:file,mode},deps);
    assert.equal((await run('--send-open')).OPEN_PROVIDER_RESULT,'REJECTED');
    const first=JSON.parse(JSON.parse(await readFile(join(dir,'operational-state.json'),'utf8')).data);
    const firstId=first.outbox[0].deliveryId;
    clock+=31000;
    const opened=await run('--send-open');
    assert.equal(opened.deliveryId,firstId);
    assert.equal((await run('--send-resolved')).RESOLVED_PROVIDER_RESULT,'REJECTED');
    const second=JSON.parse(JSON.parse(await readFile(join(dir,'operational-state.json'),'utf8')).data);
    const recoveryId=second.outbox.find(e=>e.transition==='RESOLVED').deliveryId;
    clock+=31000;
    const resolved=await run('--send-resolved');
    assert.equal(resolved.deliveryId,recoveryId);
    assert.equal(resolved.incidentId,opened.incidentId);
    const last=JSON.parse(JSON.parse(await readFile(join(dir,'operational-state.json'),'utf8')).data);
    assert.equal(last.incidents.length,1);
    assert.equal(last.outbox.length,2);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('persisted smoke state file must also have a protected operator ACL',async()=>{
  const root=await mkdtemp(join(tmpdir(),'wecom-smoke-'));
  try{
    await writeFile(join(root,'operational-state.json'),'synthetic');
    await validateSmokeStateFile(root,{fileAcl:async()=>acl,required:true});
    await assert.rejects(validateSmokeStateFile(root,{fileAcl:async()=>({...acl,
      rules:[...acl.rules,{sid:'S-1-1-0',type:'Allow',rights:1}]}),required:true}),
      {code:'SMOKE_ACL_DENIED'});
    await assert.rejects(validateSmokeStateFile(join(root,'missing'),{fileAcl:async()=>acl,
      required:true}),{code:'SMOKE_STATE_FILE_UNVERIFIED'});
  }finally{await rm(root,{recursive:true,force:true});}
});
test('ACL denial happens before reading a protected secret or calling WeCom',async()=>{
  const root=await mkdtemp(join(tmpdir(),'wecom-smoke-'));
  try{
    const file=join(root,'wecom-smoke.json');await writeFile(file,JSON.stringify(base));
    let reads=0;
    await assert.rejects(loadSmokeConfig(file,{read:async()=>{reads++;return base;},
      fileAcl:async()=>({...acl,protected:false})}),{code:'SMOKE_ACL_DENIED'});
    assert.equal(reads,0);
    const dir=join(root,'wecom-smoke-state');await mkdir(dir);
    let requests=0;
    await assert.rejects(runWeComSmoke({configFile:file,mode:'--send-open'},
      {loadConfig:async()=>base,checkDirectory:async()=>dir,
        checkStateFile:async()=>{throw Object.assign(Error('denied'),{code:'SMOKE_ACL_DENIED'});},
        fetchImpl:async()=>{requests++;throw Error('network forbidden');},
        hardenTemp:async()=>{}}),{code:'SMOKE_ACL_DENIED'});
    assert.equal(requests,0);
  }finally{await rm(root,{recursive:true,force:true});}
});

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,readdir,stat} from 'node:fs/promises';
import {createOperationalStore} from '../operations/store.js';
import {hardenSmokeTemporary,cleanupSmokeTemps} from './wecom-smoke-config.js';
import {main} from './wecom-smoke-cli.js';
const exec=promisify(execFile);

// This tests the actual Windows ACL APIs and atomic writer, without any provider credentials.
test('Windows smoke state is protected before rename and reloads after a failed write',
  {skip:process.platform!=='win32'},async()=>{
  const root=await mkdtemp(join(tmpdir(),'wecom-smoke-acl-'));
  try{
    const dir=join(root,'wecom-smoke-state');await mkdir(dir);
    const encoded=Buffer.from(dir,'utf8').toString('base64');
    const script="$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encoded+"'));$a=[IO.Directory]::GetAccessControl($p);$a.SetAccessRuleProtection($true,$false);$me=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a.SetOwner($me);$flags=[Security.AccessControl.InheritanceFlags]'ObjectInherit, ContainerInherit';$prop=[Security.AccessControl.PropagationFlags]::None;$allow=[Security.AccessControl.AccessControlType]::Allow;$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($me,[Security.AccessControl.FileSystemRights]::Modify,$flags,$prop,$allow));foreach($sid in @('S-1-5-18','S-1-5-32-544')){$who=[Security.Principal.SecurityIdentifier]::new($sid);$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($who,[Security.AccessControl.FileSystemRights]::FullControl,$flags,$prop,$allow))};[IO.Directory]::SetAccessControl($p,$a)";
    await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:5000});
    assert.equal(await validateSmokeStateDirectory(dir),dir);
    const options={prepareTemporary:async path=>{await hardenSmokeTemporary(path);
      assert.equal((await stat(path)).size,0);},
      verifyState:()=>validateSmokeStateFile(dir,{required:true})};
    const store=await createOperationalStore(dir,'wecom-smoke-v1',options);
    await store.update(s=>{s.observations.synthetic={sequence:1};});
    await validateSmokeStateFile(dir,{required:true});
    await store.update(s=>{s.observations.synthetic={sequence:2};});
    await validateSmokeStateFile(dir,{required:true});
    const final=join(dir,'operational-state.json');
    const realAcl=await import('./runtime-config.js').then(m=>m.windowsFileAcl(final));
    assert.equal(realAcl.protected,true);
    assert.ok(realAcl.rules.every(r=>r.type!=='Allow'||
      [realAcl.current,'S-1-5-18','S-1-5-32-544'].includes(r.sid)));
    assert.deepEqual((await createOperationalStore(dir,'wecom-smoke-v1')).read().observations.synthetic,
      {sequence:2});
    const interrupted=await createOperationalStore(dir,'wecom-smoke-v1',{
      prepareTemporary:async path=>{await hardenSmokeTemporary(path);throw Error('synthetic interruption');}});
    await assert.rejects(interrupted.update(s=>{s.observations.synthetic={sequence:3};}),
      /synthetic interruption/);
    assert.deepEqual((await createOperationalStore(dir,'wecom-smoke-v1')).read().observations.synthetic,
      {sequence:2});
    const orphan=join(dir,'operational-11111111-1111-4111-8111-111111111111.tmp');
    await writeFile(orphan,'synthetic interrupted data');
    await cleanupSmokeTemps(dir);
    await assert.rejects(lstat(orphan),{code:'ENOENT'});
    assert.deepEqual((await readdir(dir)).filter(n=>n.endsWith('.tmp')),[]);
    const file=join(root,'wecom-smoke.json');
    const fetchImpl=async url=>new Response(JSON.stringify(String(url).includes('/gettoken')
      ?{errcode:0,access_token:'synthetic-token',expires_in:7200}:{errcode:0}),{status:200});
    const deps={loadConfig:async()=>base,fetchImpl};
    const opened=await runWeComSmoke({configFile:file,mode:'--send-open'},deps);
    assert.equal(opened.OPEN_PROVIDER_RESULT,'ACCEPTED');
    await validateSmokeStateFile(dir,{required:true});
    const resolved=await runWeComSmoke({configFile:file,mode:'--send-resolved'},deps);
    assert.equal(resolved.RESOLVED_PROVIDER_RESULT,'ACCEPTED');
    assert.equal(resolved.incidentId,opened.incidentId);
    assert.ok(resolved.sequence>opened.sequence);
    await validateSmokeStateFile(dir,{required:true});
    assert.deepEqual((await readdir(dir)).filter(n=>n.endsWith('.tmp')),[]);
  }finally{await rm(root,{recursive:true,force:true});}
});

for(const transition of ['OPEN','RESOLVED'])for(const failure of ['timeout','disconnect'])
  test('smoke '+transition+' '+failure+' remains UNKNOWN across restart without another delivery',async()=>{
    const root=await mkdtemp(join(tmpdir(),'wecom-smoke-unknown-'));
    try{
      const file=join(root,'wecom-smoke.json'),dir=join(root,'wecom-smoke-state');
      await mkdir(dir);
      let sends=0;
      const fetchImpl=async(url,options)=>{
        if(String(url).includes('/gettoken'))return new Response(JSON.stringify({errcode:0,
          access_token:'synthetic-token',expires_in:7200}),{status:200});
        sends++;
        if(transition==='RESOLVED'&&sends===1)
          return new Response(JSON.stringify({errcode:0}),{status:200});
        if(failure==='disconnect')throw Error('synthetic-secret synthetic-token URL');
        return new Promise((_,reject)=>options.signal.addEventListener('abort',
          ()=>reject(Error('synthetic-secret synthetic-token URL')),{once:true}));
      };
      const deps={loadConfig:async()=>base,checkDirectory:async()=>dir,
        checkStateFile:async()=>{},hardenTemp:async()=>{},fetchImpl};
      const run=mode=>runWeComSmoke({configFile:file,mode},deps);
      if(transition==='RESOLVED')assert.equal((await run('--send-open')).OPEN_PROVIDER_RESULT,'ACCEPTED');
      const mode=transition==='OPEN'?'--send-open':'--send-resolved';
      const first=await run(mode);
      assert.equal(first.SMOKE,'INCONCLUSIVE');
      assert.equal(first[transition+'_PROVIDER_RESULT'],'UNKNOWN');
      assert.equal(first.PROVIDER_ACCEPTANCE_UNCERTAIN,'YES');
      assert.equal(Object.hasOwn(first,transition+'_PROVIDER_ACCEPTED'),false);
      assert.match(first.NEXT,new RegExp('DO NOT RESEND '+transition+' AUTOMATICALLY'));
      const count=sends;
      const beforeRestart=await readFile(join(dir,'operational-state.json'),'utf8');
      const restart=await run(mode);
      assert.equal(restart[transition+'_PROVIDER_RESULT'],'UNKNOWN');
      assert.equal(restart.incidentId,first.incidentId);
      assert.equal(restart.deliveryId,first.deliveryId);
      assert.equal(restart.sequence,first.sequence);
      assert.equal(sends,count);
      const afterRestart=await readFile(join(dir,'operational-state.json'),'utf8');
      assert.equal(afterRestart,beforeRestart);
      const disk=JSON.parse(JSON.parse(afterRestart).data);
      const delivery=disk.outbox.find(e=>e.deliveryId===first.deliveryId);
      assert.equal(delivery.uncertain,true);
      assert.deepEqual(delivery.recipients,['owner']);
      assert.equal(disk.incidents.length,1);
      assert.equal(disk.outbox.length,transition==='OPEN'?1:2);
      if(transition==='OPEN'){
        const attemptedRecovery=await run('--send-resolved');
        assert.equal(attemptedRecovery.SMOKE,'INCONCLUSIVE');
        assert.equal(sends,count);
      }
      let stderr='';const previous=process.stderr.write;
      try{
        process.stderr.write=function(chunk){stderr+=chunk;return true;};
        assert.equal(await main(['--config-file',file,mode,...(mode==='--send-resolved'?['--open-phone-confirmed']:[])],async()=>first),2);
      }finally{process.stderr.write=previous;}
      assert.match(stderr,/"SMOKE":"INCONCLUSIVE"/);
      assert.doesNotMatch(stderr,/synthetic-secret|synthetic-token|synthetic-corp|owner|qyapi|message\/send/);
      assert.doesNotMatch(JSON.stringify(first),/synthetic-secret|synthetic-token|synthetic-corp|owner/);
      assert.doesNotMatch(JSON.stringify(disk),/synthetic-secret|synthetic-token|synthetic-corp/);
    }finally{await rm(root,{recursive:true,force:true});}
  });


for(const transition of ['OPEN','RESOLVED'])for(const failure of ['http500','malformed'])
  test('smoke '+transition+' '+failure+' is UNKNOWN, not a claimed rejection',async()=>{
    const root=await mkdtemp(join(tmpdir(),'wecom-smoke-response-'));
    try{
      const file=join(root,'wecom-smoke.json'),dir=join(root,'wecom-smoke-state');
      await mkdir(dir);let sends=0;
      const fetchImpl=async url=>{
        if(String(url).includes('/gettoken'))return new Response(JSON.stringify({errcode:0,
          access_token:'synthetic-token',expires_in:7200}),{status:200});
        sends++;
        if(transition==='RESOLVED'&&sends===1)
          return new Response(JSON.stringify({errcode:0}),{status:200});
        return failure==='http500'
          ?new Response('synthetic-secret synthetic-token',{status:500})
          :new Response('synthetic-secret synthetic-token',{status:200});
      };
      const deps={loadConfig:async()=>base,checkDirectory:async()=>dir,
        checkStateFile:async()=>{},hardenTemp:async()=>{},fetchImpl};
      const run=mode=>runWeComSmoke({configFile:file,mode},deps);
      if(transition==='RESOLVED')assert.equal((await run('--send-open')).OPEN_PROVIDER_RESULT,'ACCEPTED');
      const mode=transition==='OPEN'?'--send-open':'--send-resolved';
      const first=await run(mode);
      assert.equal(first.SMOKE,'INCONCLUSIVE');
      assert.equal(first[transition+'_PROVIDER_RESULT'],'UNKNOWN');
      assert.equal(Object.hasOwn(first,transition+'_PROVIDER_ACCEPTED'),false);
      const before=await readFile(join(dir,'operational-state.json'),'utf8');
      const count=sends;
      const repeated=await run(mode);
      assert.equal(repeated.deliveryId,first.deliveryId);
      assert.equal(repeated.incidentId,first.incidentId);
      assert.equal(sends,count);
      assert.equal(await readFile(join(dir,'operational-state.json'),'utf8'),before);
      const disk=JSON.parse(JSON.parse(before).data);
      assert.equal(disk.outbox.find(e=>e.deliveryId===first.deliveryId).uncertain,true);
      assert.doesNotMatch(JSON.stringify(first),/synthetic-secret|synthetic-token|owner|qyapi/);
    }finally{await rm(root,{recursive:true,force:true});}
  });
