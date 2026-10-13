import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,readdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {canonical,digest} from '../backup/format.js';
import {windowsFileAcl,validateFileAcl} from '../production/runtime-config.js';
import {windowsDirectoryAcl} from '../production/wecom-smoke-config.js';
import {protectSyntheticFile} from '../test-support/runtime-tls.js';
import {issueOwnedCandidateCapability,freezePreparedCandidate,restorePreparedCandidate} from './production-candidate.js';
import {switchOwnedCandidatePointer} from './production-c2.js';
import {prepareOwnedCandidateResume,resumeOwnedCandidate} from './production-c3.js';
import {parseProductionRestoreArgs} from './production-restore-cli.js';
import {AUTHORIZATION_TTL_MS,assertAuthorizationActive,createOwnedAuthorizationHarness,assertProductionPlanAuthority,
 authorizationChallenge} from './production-authorization.js';
import {validateRecoveryAcl,validateRecoveryPolicy,windowsRecoveryIdentity,canonicalProtectedPath} from './production-authorization-context.js';

const operator='S-1-5-21-101-202-303-1001',runtime='S-1-5-80-111-222-333';
const identity={sid:operator,elevated:true};
const acl={protected:true,current:operator,owner:operator,rules:[
 {sid:operator,type:'Allow',rights:2032127,inheritance:'ContainerInherit, ObjectInherit'},
 {sid:'S-1-5-18',type:'Allow',rights:2032127},
 {sid:'S-1-5-32-544',type:'Allow',rights:2032127}]};
const blocked=(fn,code)=>assert.rejects(fn,{code});
test('D1 recovery policy binds elevated token SID and never trusts runtime or input identity',()=>{
 const policy={policyVersion:1,approvedOperatorSid:operator,runtimeServiceSid:runtime,runtimeConfigFile:'C:\\private\\runtime.json'};
 validateRecoveryPolicy(policy,identity);
 for(const current of [{sid:runtime,elevated:true},{sid:operator,elevated:false},{sid:'S-1-5-21-9',elevated:true}])
  assert.throws(()=>validateRecoveryPolicy(policy,current),{code:'AUTHORIZATION_OPERATOR_DENIED'});
 assert.throws(()=>validateRecoveryPolicy({...policy,operator:'forged'},identity));
 // The runtime loader continues to reject a different current SID.
 assert.throws(()=>validateFileAcl(acl,runtime),{code:'RUNTIME_ACL_DENIED'});
});
test('D1 private ACL rejects service read, broad ACE, inheritance and unsafe policy owner',()=>{
 const options={identity,runtimeServiceSid:runtime,directory:true};
 validateRecoveryAcl(acl,options);
 for(const bad of [{...acl,protected:false},{...acl,current:runtime},{...acl,owner:'S-1-1-0'},
  ...[runtime,'S-1-1-0','S-1-5-11','S-1-5-32-545'].map(sid=>({...acl,rules:[...acl.rules,{sid,type:'Allow',rights:1}]}))])
  assert.throws(()=>validateRecoveryAcl(bad,options),{code:'AUTHORIZATION_ACL_DENIED'});
 assert.throws(()=>validateRecoveryAcl(acl,{...options,policy:true}));
 validateRecoveryAcl({...acl,owner:'S-1-5-32-544'},{...options,policy:true});
});
test('D1 CLI accepts no SID, target, expiry, policy override or destructive route',()=>{
 for(const action of ['authorize','reauthorize','inspect-authorization','revoke-authorization'])
  assert.equal(parseProductionRestoreArgs([action,'--config-file','C:\\private\\runtime.json']).action,action);
 for(const flag of ['--operator','--target-db','--plan-digest','--server-uuid','--ttl','--policy','--enable','--force'])
  assert.throws(()=>parseProductionRestoreArgs(['authorize','--config-file','x',flag,'forged']));
 for(const action of ['freeze-plan','restore-candidate','verify-candidate','cutover','prepare-resume','resume'])
  assert.throws(()=>parseProductionRestoreArgs([action]),{code:'RESTORE_PRODUCTION_DISABLED'});
});
test('D1 operator SID is read from Windows token without an input override',async()=>{
 const current=await windowsRecoveryIdentity();
 assert.match(current.sid,/^S-1-5-/);assert.equal(typeof current.elevated,'boolean');
});
test('D1 plain-object and test harness forgery fail before callbacks',async()=>{
 await blocked(()=>assertProductionPlanAuthority({kind:'production'}),'AUTHORIZATION_AUTHORITY_FORGED');
 let read=false;
 await blocked(()=>createOwnedAuthorizationHarness({capability:{},facts:async()=>{read=true;}}),'RESTORE_PRODUCTION_DISABLED');
 assert.equal(read,false);
});

const enabled=process.env.STAGE5E_RUN==='synthetic-only'&&process.env.STAGE5E_FIXTURE_ROOT&&process.env.LEDGER_MYSQL_TEST_URL;
if(enabled)test('D1 owned authorization lifecycle, security and concurrency',{timeout:180000},async t=>{
 const f={root:process.env.STAGE5E_FIXTURE_ROOT,names:{id:process.env.STAGE5E_FIXTURE_ID,database:'jbhh_ktv_test'},
  identity:{server_uuid:process.env.STAGE5E_FIXTURE_UUID},port:33313,dbUrl:()=>process.env.LEDGER_MYSQL_TEST_URL};
 const capability=await issueOwnedCandidateCapability(f);
 let index=0;
 async function fixture(realAcl=false){
  const dir=join(f.root,'artifacts','authorization_'+(++index));await mkdir(dir);
  const actual=await windowsRecoveryIdentity(),actor=realAcl?actual.sid:operator;
  const localIdentity={sid:actor,elevated:true},localAcl={...acl,current:actor,owner:actor,rules:acl.rules.map(r=>r.sid===operator?{...r,sid:actor}:r)};
  let offset=0,unsafe=false;
  const plan={recoveryOperationId:'12345678-1234-4123-8123-123456789abc',planDigest:'a'.repeat(64),
   backupSha256:'b'.repeat(64),storeId:'synthetic-store',ledgerId:'synthetic-ledger',
   currentDatabase:'jbhh_ktv_test',targetDatabase:'jbhh_ktv_recovery_12345678123441238123123456789abc',
   targetHost:'127.0.0.1',targetPort:33313,targetServerUuid:f.identity.server_uuid,
   applicationCommit:'c'.repeat(40),schemaMigration:'011_recovery.sql',schemaDigest:'d'.repeat(64),
   backupCreatedAt:new Date(Date.now()-600000).toISOString(),backupAgeSeconds:10,
   lossWindow:{classification:'KNOWN',revisionGap:0,note:'Revision gap only'}};
  const context={plan,actorSid:actor,runtimeServiceSid:runtime,deploymentConfigFingerprint:'e'.repeat(64),
   environment:'production',authorizationDirectory:dir,
   checkDirectory:async p=>{await canonicalProtectedPath(p,{directory:true});
    validateRecoveryAcl(unsafe?{...localAcl,protected:false}:realAcl?await windowsDirectoryAcl(p):localAcl,
     {identity:localIdentity,runtimeServiceSid:runtime,directory:true});},
   checkFile:async p=>{await canonicalProtectedPath(p);
    validateRecoveryAcl(realAcl?await windowsFileAcl(p):localAcl,{identity:localIdentity,runtimeServiceSid:runtime});}};
  if(realAcl){
   const script="$ErrorActionPreference='Stop';$a=[Security.AccessControl.DirectorySecurity]::new();$a.SetAccessRuleProtection($true,$false);$a.SetOwner([Security.Principal.SecurityIdentifier]::new('"+actor+"'));foreach($s in @('"+actor+"','S-1-5-18','S-1-5-32-544')){$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($s),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))};[IO.Directory]::SetAccessControl([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+Buffer.from(dir).toString('base64')+"')),$a)";
   await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:5000});
  }
  const engine=await createOwnedAuthorizationHarness({capability,facts:async()=>context,
   clock:()=>Date.now()+offset,harden:realAcl?p=>protectSyntheticFile(p,actor):async()=>{}});
  return {engine,context,dir,advance:n=>{offset+=n;},unsafe:()=>{unsafe=true;},
   confirm:async({challenge})=>challenge,
   authorize:()=>engine.authorize({confirm:async({challenge})=>challenge})};
 }
 await t.test('owned injection cannot select a directory outside its own artifact boundary',async()=>{
  let touched=false;
  const engine=await createOwnedAuthorizationHarness({capability,
   facts:async()=>({authorizationDirectory:f.root,checkDirectory:async()=>{touched=true;}}),
   harden:async()=>{}});
  await blocked(()=>engine.inspect(),'AUTHORIZATION_TEST_SCOPE_DENIED');
  assert.equal(touched,false);
 });
 await t.test('missing record blocks issuance and records safe rejection',async()=>{
  const x=await fixture();await blocked(()=>x.engine.issue(),'AUTHORIZATION_MISSING');
  assert.equal((await x.engine.inspect()).active,null);
  const files=await readdir(x.dir);assert.ok(files.some(n=>n.startsWith('authorization-event-')));
 });
 await t.test('authorize response loss and parallel retries return one id without extending expiry',async()=>{
  const x=await fixture();
  const results=await Promise.all([x.authorize(),x.authorize()]);
  assert.equal(results[0].authorizationId,results[1].authorizationId);
  assert.equal(results[0].expiresAt,results[1].expiresAt);
  x.advance(1000);
  const replay=await x.authorize();assert.equal(replay.authorizationId,results[0].authorizationId);
  assert.equal(replay.expiresAt,results[0].expiresAt);
  assert.equal((await x.engine.inspect()).history.length,1);
 });
 await t.test('independent authorize/revoke processes preserve one active id and monotonic history',async()=>{
  const x=await fixture(),file=join(f.root,'artifacts','d1-process-context.json');
  const {checkDirectory,checkFile,...data}=x.context;await writeFile(file,JSON.stringify(data));
  const run=action=>new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,['test-support/s3d-authorization-process.js',file,action],
    {windowsHide:true,env:process.env,stdio:['ignore','pipe','pipe']});
   let text='';child.stdout.on('data',b=>{text+=b;});child.stderr.on('data',()=>{});
   child.on('error',reject);child.on('exit',code=>{
    try{resolve({code,value:JSON.parse(text.trim())});}catch{reject(Error('OWNED_CHILD_RESULT_INVALID'));}
   });
  });
  const [a,b]=await Promise.all([run('authorize'),run('authorize')]);
  assert.equal(a.code,0);assert.equal(b.code,0);
  assert.equal(a.value.authorizationId,b.value.authorizationId);
  assert.equal(a.value.expiresAt,b.value.expiresAt);
  const before=(await x.engine.inspect()).revision;
  const [replay,revoke]=await Promise.all([run('authorize'),run('revoke')]);
  assert.equal(revoke.code,0);
  assert.ok(replay.code===0||replay.value.code==='AUTHORIZATION_REVOKED');
  const both=await Promise.all([run('revoke'),run('revoke')]);assert.ok(both.every(r=>r.code===0));
  const view=await x.engine.inspect();
  assert.equal(view.active.state,'REVOKED');assert.equal(view.history.length,1);
  assert.ok(view.revision>before);
 });
 await t.test('revoke, double revoke and authorize/revoke race cannot resurrect',async()=>{
  const x=await fixture();await x.authorize();
  const [issued,revoked]=await Promise.allSettled([x.engine.issue(),x.engine.revoke()]);
  assert.equal(revoked.status,'fulfilled');
  if(issued.status==='fulfilled')await blocked(()=>x.engine.check(issued.value),'AUTHORIZATION_REVOKED');
  await Promise.all([x.engine.revoke(),x.engine.revoke()]);
  await blocked(()=>x.authorize(),'AUTHORIZATION_REVOKED');
  assert.equal((await x.engine.inspect()).active.state,'REVOKED');
 });
 await t.test('intentional reauthorization preserves original immutable evidence and changes id',async()=>{
  const x=await fixture(),first=await x.authorize();await x.engine.revoke();
  const before=new Map(await Promise.all((await readdir(x.dir)).map(async n=>[n,digest(await readFile(join(x.dir,n)))])));
  const second=await x.engine.authorize({confirm:x.confirm,reauthorize:true});
  assert.notEqual(second.authorizationId,first.authorizationId);
  assert.equal(second.previousAuthorizationId,first.authorizationId);
  for(const [n,hash]of before)assert.equal(digest(await readFile(join(x.dir,n))),hash);
  const view=await x.engine.inspect();assert.equal(view.history.length,2);
  assert.equal(view.history[0].state,'REVOKED');
  const replay=await x.engine.authorize({confirm:x.confirm,reauthorize:true});
  assert.equal(replay.authorizationId,second.authorizationId);
  assert.equal(replay.expiresAt,second.expiresAt);
 });
 await t.test('before expiry is valid and at/after expiry rejects without automatic renewal',async()=>{
  const x=await fixture(),first=await x.authorize();
  assert.equal(first.expiresAt-first.issuedAt,AUTHORIZATION_TTL_MS);
  assertAuthorizationActive({...first,state:'AUTHORIZED'},first.expiresAt-1);
  assert.throws(()=>assertAuthorizationActive({...first,state:'AUTHORIZED'},first.expiresAt),{code:'AUTHORIZATION_EXPIRED'});
  await x.engine.issue();x.advance(AUTHORIZATION_TTL_MS);
  await blocked(()=>x.engine.issue(),'AUTHORIZATION_EXPIRED');
  await blocked(()=>x.authorize(),'AUTHORIZATION_EXPIRED');
  const newRecord=await x.engine.authorize({confirm:x.confirm,reauthorize:true});
  assert.notEqual(first.authorizationId,newRecord.authorizationId);
 });
 await t.test('observed clock rollback fails closed even across a new harness instance',async()=>{
  const x=await fixture();await x.authorize();x.advance(60000);await x.engine.inspect();x.advance(-120000);
  await blocked(()=>x.engine.issue(),'AUTHORIZATION_CLOCK_ROLLBACK');
  const again=await createOwnedAuthorizationHarness({capability,facts:async()=>x.context,
   clock:()=>Date.now()-60000,harden:async()=>{}});
  await blocked(()=>again.issue(),'AUTHORIZATION_CLOCK_ROLLBACK');
 });
 await t.test('confirmation drift refuses record and different operation conflicts',async()=>{
  const x=await fixture();
  await blocked(()=>x.engine.authorize({confirm:async()=>{x.context.plan.planDigest='f'.repeat(64);return 'AUTHORIZE 12345678 '+ 'a'.repeat(12);}}),'AUTHORIZATION_PLAN_CHANGED');
  const summaryCase=await fixture();
  await summaryCase.engine.authorize({confirm:async({challenge,summary})=>{
   assert.ok(summary.backupAgeSeconds>=600);return challenge;
  }});
  const y=await fixture();await blocked(()=>y.engine.authorize({confirm:async({challenge})=>{
   y.context.plan.backupSha256='f'.repeat(64);return challenge;}}),'AUTHORIZATION_PLAN_CHANGED');
  assert.equal((await y.engine.inspect()).active,null);
  const z=await fixture();await z.authorize();z.context.plan.recoveryOperationId='87654321-1234-4123-8123-123456789abc';
  await blocked(()=>z.authorize(),'AUTHORIZATION_OPERATION_CONFLICT');
 });
 await t.test('every authority binding is revalidated, not cached in issued token',async()=>{
  for(const [key,value]of [['planDigest','f'.repeat(64)],['backupSha256','f'.repeat(64)],
   ['storeId','wrong'],['ledgerId','wrong'],['currentDatabase','wrong_db'],['targetDatabase','wrong_target'],
   ['targetServerUuid','wrong'],['targetHost','wrong'],['applicationCommit','f'.repeat(40)],['schemaDigest','f'.repeat(64)]]){
   const x=await fixture();await x.authorize();const token=await x.engine.issue();x.context.plan[key]=value;
   await blocked(()=>x.engine.check(token),'AUTHORIZATION_BINDING_MISMATCH');
  }
  for(const [key,value]of [['environment','test'],['actorSid','S-1-5-21-999'],['runtimeServiceSid',operator],
   ['deploymentConfigFingerprint','f'.repeat(64)]]){
   const x=await fixture();await x.authorize();const token=await x.engine.issue();x.context[key]=value;
   await assert.rejects(()=>x.engine.check(token));
  }
 });
 await t.test('owned token and plain object cannot enter production or existing destructive core',async()=>{
  const x=await fixture();await x.authorize();const token=await x.engine.issue();
  await blocked(()=>assertProductionPlanAuthority(token),'AUTHORIZATION_AUTHORITY_FORGED');
  await blocked(()=>x.engine.check({kind:'owned-test'}),'AUTHORIZATION_AUTHORITY_FORGED');
  for(const core of [freezePreparedCandidate,restorePreparedCandidate,switchOwnedCandidatePointer,prepareOwnedCandidateResume,resumeOwnedCandidate])
   await blocked(()=>core({capability:token}),'RESTORE_PRODUCTION_DISABLED');
 });
 await t.test('revoke serializes against admission and later admission never runs',async()=>{
  const x=await fixture();await x.authorize();const token=await x.engine.issue();
  let enter,finish;const entered=new Promise(r=>{enter=r;}),done=new Promise(r=>{finish=r;});
  const admitted=x.engine.admit(token,async()=>{enter();await done;return 'finished';});
  await entered;const revoked=x.engine.revoke();finish();
  assert.equal(await admitted,'finished');await revoked;
  let mutations=0;await blocked(()=>x.engine.admit(token,async()=>{mutations++;}),'AUTHORIZATION_REVOKED');
  assert.equal(mutations,0);
 });
 await t.test('CONSUMED remains inspectable but cannot issue, revoke or reauthorize',async()=>{
  const x=await fixture();await x.authorize();const token=await x.engine.issue();
  await x.engine.admit(token,async()=>{});await x.engine.consume();
  assert.equal((await x.engine.inspect()).active.state,'CONSUMED');
  for(const fn of [()=>x.engine.issue(),()=>x.engine.revoke(),()=>x.engine.authorize({reauthorize:true,confirm:x.confirm})])
   await blocked(fn,'AUTHORIZATION_CONSUMED');
 });
 await t.test('malformed, truncated history, unsafe path and ACL fail closed',async()=>{
  const x=await fixture();await x.authorize();
  const file=join(x.dir,(await readdir(x.dir)).find(n=>n.startsWith('authorization-event-')));
  await writeFile(file,'{}');await blocked(()=>x.engine.issue(),'AUTHORIZATION_JOURNAL_INVALID');
  const y=await fixture();await y.authorize();y.unsafe();await blocked(()=>y.engine.issue(),'AUTHORIZATION_ACL_DENIED');
  const z=await fixture();const other=join(f.root,'artifacts','authorization_link');await symlink(z.dir,other,'junction');
  await blocked(()=>canonicalProtectedPath(other,{directory:true}),'AUTHORIZATION_PATH_DENIED');
 });
 await t.test('real Windows private ACL and canonical file roundtrip keep runtime excluded',async()=>{
  const x=await fixture(true),record=await x.authorize(),token=await x.engine.issue();
  assert.equal((await x.engine.check(token)).authorizationId,record.authorizationId);
  const directoryAcl=await windowsDirectoryAcl(x.dir);
  assert.equal(directoryAcl.protected,true);
  assert.equal(directoryAcl.rules.some(r=>r.type==='Allow'&&r.sid===runtime),false);
  const text=(await Promise.all((await readdir(x.dir)).map(n=>readFile(join(x.dir,n),'utf8')))).join('');
  for(const secret of ['password','databaseUrl','sessionToken','providerSecret'])assert.equal(text.includes(secret),false);
 });
});
