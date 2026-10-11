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
  {sid:operator,type:'Allow',rights:3,inheritance:'ObjectInherit, ContainerInherit'},{sid:'S-1-5-18',type:'Allow',rights:1},
  {sid:'S-1-5-32-544',type:'Allow',rights:1}]};
 assert.doesNotThrow(()=>validateSmokeAcl(valid,{directory:true}));
 for(const acl of [
  {...valid,protected:false},
  {...valid,rules:[...valid.rules,{sid:'S-1-1-0',type:'Allow',rights:1}]},
  {...valid,rules:[...valid.rules,{sid:'S-1-5-11',type:'Allow',rights:1}]},
  {...valid,rules:valid.rules.filter(r=>r.sid!==operator)},
  {...valid,rules:[{sid:operator,type:'Allow',rights:1}]}
 ])assert.throws(()=>validateSmokeAcl(acl,{directory:true}),{code:/SMOKE_ACL_DENIED/});
});
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runWeComSmoke,parseSmokeArgs} from './wecom-smoke-cli.js';
import {loadSmokeConfig,validateSmokeStateDirectory,validateSmokeStateFile} from './wecom-smoke-config.js';

const acl={protected:true,current:'S-1-5-21-1-2-3-1001',owner:'S-1-5-32-544',
  rules:[{sid:'S-1-5-21-1-2-3-1001',type:'Allow',rights:3,inheritance:'ObjectInherit, ContainerInherit'},
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
    const deps={loadConfig:async()=>base,checkDirectory:async()=>dir,fetchImpl,checkStateFile:async()=>{}};
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
    const deps={loadConfig:async()=>base,checkDirectory:async()=>dir,fetchImpl,now:()=>clock,checkStateFile:async()=>{}};
    const run=mode=>runWeComSmoke({configFile:file,mode},deps);
    await assert.rejects(run('--send-open'),{code:'SMOKE_OPEN_NOT_ACCEPTED'});
    const first=JSON.parse(JSON.parse(await readFile(join(dir,'operational-state.json'),'utf8')).data);
    const firstId=first.outbox[0].deliveryId;
    clock+=31000;
    const opened=await run('--send-open');
    assert.equal(opened.deliveryId,firstId);
    await assert.rejects(run('--send-resolved'),{code:'SMOKE_RECOVERY_NOT_ACCEPTED'});
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
        fetchImpl:async()=>{requests++;throw Error('network forbidden');}}),{code:'SMOKE_ACL_DENIED'});
    assert.equal(requests,0);
  }finally{await rm(root,{recursive:true,force:true});}
});