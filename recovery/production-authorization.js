import {randomUUID} from 'node:crypto';
import {join,dirname} from 'node:path';
import {readdir,readFile,open,rename,unlink,lstat} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {canonical,digest,fail} from '../backup/format.js';
import {hardenSmokeTemporary} from '../production/wecom-smoke-config.js';
import {loadRecoveryContext,exact,canonicalProtectedPath} from './production-authorization-context.js';
import {withOwnedCandidateRead} from './production-candidate.js';

export const AUTHORIZATION_TTL_MS=4*60*60*1000;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const states=new Set(['AUTHORIZED','IN_PROGRESS','CONSUMED','REVOKED']);
const tokens=new WeakMap();
const ownedHarnesses=new WeakMap();
const boundKeys=['recoveryOperationId','planDigest','backupSha256','storeId','ledgerId',
 'sourceDatabase','targetDatabase','serverHost','serverPort','serverUuid','environment',
 'applicationCommit','schemaMigration','schemaDigest','authorizedOperatorSid','runtimeServiceSid','deploymentConfigFingerprint'];
const recordKeys=['recordVersion','authorizationId','previousAuthorizationId',...boundKeys,
 'issuedBySid','issuedAt','expiresAt','state'];
const binding=f=>({recoveryOperationId:f.plan.recoveryOperationId,planDigest:f.plan.planDigest,
 backupSha256:f.plan.backupSha256,storeId:f.plan.storeId,ledgerId:f.plan.ledgerId,
 sourceDatabase:f.plan.currentDatabase,targetDatabase:f.plan.targetDatabase,
 serverHost:f.plan.targetHost,serverPort:f.plan.targetPort,serverUuid:f.plan.targetServerUuid,
 environment:f.environment,applicationCommit:f.plan.applicationCommit,
 schemaMigration:f.plan.schemaMigration,schemaDigest:f.plan.schemaDigest,
 authorizedOperatorSid:f.actorSid,runtimeServiceSid:f.runtimeServiceSid,
 deploymentConfigFingerprint:f.deploymentConfigFingerprint});
export function validateAuthorizationRecord(r){
 if(!exact(r,recordKeys)||r.recordVersion!==1||!UUID.test(r.authorizationId)||
  !(r.previousAuthorizationId===null||UUID.test(r.previousAuthorizationId))||
  !UUID.test(r.recoveryOperationId)||!HASH.test(r.planDigest)||!HASH.test(r.backupSha256)||
  !HASH.test(r.schemaDigest)||!HASH.test(r.deploymentConfigFingerprint)||
  !/^[a-f0-9]{40}$/.test(r.applicationCommit)||r.environment!=='production'||
  !states.has(r.state)||r.authorizedOperatorSid===r.runtimeServiceSid||
  r.issuedBySid!==r.authorizedOperatorSid||
  !Number.isSafeInteger(r.issuedAt)||!Number.isSafeInteger(r.expiresAt)||
  r.expiresAt-r.issuedAt!==AUTHORIZATION_TTL_MS||
  !Number.isInteger(r.serverPort)||r.serverPort<1||r.serverPort>65535||
  ['storeId','ledgerId','sourceDatabase','targetDatabase','serverHost','serverUuid','schemaMigration',
   'authorizedOperatorSid','runtimeServiceSid'].some(k=>typeof r[k]!=='string'||!r[k])||
  r.sourceDatabase===r.targetDatabase||
  !/^[a-z][a-z0-9_]{0,63}$/.test(r.sourceDatabase)||!/^[a-z][a-z0-9_]{0,63}$/.test(r.targetDatabase)||
  !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(r.serverUuid)||
  !/^S-1-5-(?:\d+-)*\d+$/.test(r.authorizedOperatorSid)||
  !/^S-1-5-(?:\d+-)*\d+$/.test(r.runtimeServiceSid))throw fail('AUTHORIZATION_RECORD_INVALID');
 return r;
}
function matches(record,facts){
 const expected=binding(facts);
 if(Object.entries(expected).some(([k,v])=>record[k]!==v))throw fail('AUTHORIZATION_BINDING_MISMATCH');
}
export function assertAuthorizationActive(r,now){
 if(!Number.isSafeInteger(now)||now<r.issuedAt)throw fail('AUTHORIZATION_CLOCK_ROLLBACK');
 if(now>=r.expiresAt)throw fail('AUTHORIZATION_EXPIRED');
 if(r.state==='REVOKED')throw fail('AUTHORIZATION_REVOKED');
 if(r.state==='CONSUMED')throw fail('AUTHORIZATION_CONSUMED');
 if(!['AUTHORIZED','IN_PROGRESS'].includes(r.state))throw fail('AUTHORIZATION_RECORD_INVALID');
 return r;
}
const safeResult=(r,revision,now)=>({authorizationId:r.authorizationId,previousAuthorizationId:r.previousAuthorizationId,
 recoveryOperationId:r.recoveryOperationId,planDigest:r.planDigest,state:
 ['REVOKED','CONSUMED'].includes(r.state)?r.state:now>=r.expiresAt?'EXPIRED':r.state,
 issuedAt:r.issuedAt,expiresAt:r.expiresAt,revision});
export const authorizationChallenge=f=>'AUTHORIZE '+f.plan.recoveryOperationId.slice(0,8)+' '+f.plan.planDigest.slice(-12);

function service({facts,kind,clock=Date.now,harden=hardenSmokeTemporary}){
 const anchorWall=clock(),anchorMono=performance.now();let observedWall=anchorWall;
 const time=last=>{
  const now=clock();
  if(!Number.isSafeInteger(now)||now<anchorWall||now<observedWall||now<last||
   now<anchorWall+Math.floor(performance.now()-anchorMono)-2000)
   throw fail('AUTHORIZATION_CLOCK_ROLLBACK');
  observedWall=now;return now;
 };
 const name=n=>'authorization-event-'+String(n).padStart(8,'0')+'.json';
 async function read(f){
  await f.checkDirectory(f.authorizationDirectory);
  const names=await readdir(f.authorizationDirectory),events=[];
  for(const n of names){
   if(n==='authorization.lock'||/^authorization-[a-f0-9-]+\.tmp$/.test(n))continue;
   if(!/^authorization-event-\d{8}\.json$/.test(n))throw fail('AUTHORIZATION_JOURNAL_INVALID');
   events.push(n);
  }
  events.sort();let previous=null,last=0,active=null;const history=new Map();
  for(let i=0;i<events.length;i++){
   if(events[i]!==name(i+1))throw fail('AUTHORIZATION_JOURNAL_GAP');
   const path=join(f.authorizationDirectory,events[i]);await f.checkFile(path);
   let e;try{e=JSON.parse(await readFile(path,'utf8'));}catch{throw fail('AUTHORIZATION_JOURNAL_INVALID');}
   if(!exact(e,['version','revision','previousDigest','lastObservedAt','active','event'])||
    e.version!==1||e.revision!==i+1||e.previousDigest!==(previous?digest(canonical(previous)):null)||
    !Number.isSafeInteger(e.lastObservedAt)||e.lastObservedAt<last||
    !exact(e.event,['type','actorSid','at','result','reason','authorizationId'])||
    !/^[A-Z_]+$/.test(e.event.type)||!['PASS','BLOCKED'].includes(e.event.result)||
    !/^[A-Z_]+$/.test(e.event.reason)||e.event.actorSid!==f.actorSid||
    e.event.at!==e.lastObservedAt)
    throw fail('AUTHORIZATION_JOURNAL_INVALID');
   if(e.active){
    validateAuthorizationRecord(e.active);
    if(e.active.issuedAt>e.lastObservedAt||e.event.authorizationId!==e.active.authorizationId)
     throw fail('AUTHORIZATION_JOURNAL_INVALID');
    if(active?.authorizationId===e.active.authorizationId){
     const {state:oldState,...oldIdentity}=active,{state:newState,...newIdentity}=e.active;
     if(canonical(oldIdentity)!==canonical(newIdentity)||
      !({AUTHORIZED:['AUTHORIZED','IN_PROGRESS','REVOKED'],IN_PROGRESS:['IN_PROGRESS','CONSUMED','REVOKED'],
       REVOKED:['REVOKED'],CONSUMED:['CONSUMED']}[oldState]?.includes(newState)))
      throw fail('AUTHORIZATION_JOURNAL_INVALID');
    }else if(e.active.state!=='AUTHORIZED'||e.active.previousAuthorizationId!==(active?.authorizationId??null)||
     active&&(active.state==='CONSUMED'||active.state!=='REVOKED'&&e.lastObservedAt<active.expiresAt))
     throw fail('AUTHORIZATION_JOURNAL_INVALID');
    history.set(e.active.authorizationId,e.active);
   }else if(active||e.event.authorizationId!==null)throw fail('AUTHORIZATION_JOURNAL_INVALID');
   previous=e;last=e.lastObservedAt;active=e.active;
  }
  return {revision:events.length,previous,last,active,history:[...history.values()]};
 }
 async function append(f,s,active,type,result='PASS',reason='NONE',now=time(s.last)){
  const revision=s.revision+1;
  if(revision>99999999)throw fail('AUTHORIZATION_JOURNAL_FULL');
  const entry={version:1,revision,previousDigest:s.previous?digest(canonical(s.previous)):null,
   lastObservedAt:now,active,event:{type,actorSid:f.actorSid,at:now,result,reason,
    authorizationId:active?.authorizationId??null}};
  const target=join(f.authorizationDirectory,name(revision));
  try{await lstat(target);throw fail('AUTHORIZATION_JOURNAL_CONFLICT');}catch(e){if(e.code!=='ENOENT')throw e;}
  const temp=join(f.authorizationDirectory,'authorization-'+randomUUID()+'.tmp');
  const handle=await open(temp,'wx',0o600);
  try{await harden(temp);await f.checkFile(temp);await handle.writeFile(canonical(entry));await handle.sync();}
  finally{await handle.close();}
  await rename(temp,target);await f.checkFile(target);
  if(await readFile(target,'utf8')!==canonical(entry))throw fail('AUTHORIZATION_READBACK_FAILED');
  return revision;
 }
 async function locked(work){
  const f=await facts();await f.checkDirectory(f.authorizationDirectory);
  const path=join(f.authorizationDirectory,'authorization.lock');let h;
  for(let n=0;n<750;n++){
   try{h=await open(path,'wx',0o600);break;}
   catch(e){if(e.code!=='EEXIST')throw e;await new Promise(r=>setTimeout(r,20));}
  }
  if(!h)throw fail('AUTHORIZATION_BUSY');
  let safe=false,s;
  try{await harden(path);await f.checkFile(path);await h.writeFile(String(process.pid));await h.sync();safe=true;
   const latest=await facts();
   if(latest.authorizationDirectory!==f.authorizationDirectory||canonical(latest.plan)!==canonical(f.plan)||
    canonical(binding(latest))!==canonical(binding(f)))throw fail('AUTHORIZATION_PLAN_CHANGED');
   s=await read(latest);return await work(latest,s);
  }catch(error){
   if(s&&!error.authorizationAudited)try{await observedError(f,await read(f),error);}catch{error.auditUnavailable=true;}
   throw error;
  }
  finally{await h.close();if(safe){await f.checkFile(path);await unlink(path);}}
 }
 function valid(s,f,now){
  if(!s.active)throw fail('AUTHORIZATION_MISSING');
  matches(s.active,f);
  return assertAuthorizationActive(s.active,now);
 }
 async function observedError(f,s,error,type='AUTHORITY_REJECTED'){
  const code=/^AUTHORIZATION_[A-Z_]+$/.test(error?.code??'')?error.code:'AUTHORIZATION_REJECTED';
  // A backwards observed wall clock cannot advance the durable high-water mark.
  const at=code==='AUTHORIZATION_CLOCK_ROLLBACK'?s.last:time(s.last);
  await append(f,s,s.active,type,'BLOCKED',code,at);
  error.authorizationAudited=true;
 }
 return {
  async authorize({confirm,reauthorize=false}={}){
   return locked(async(f,s)=>{
    const now=time(s.last);
    if(s.active){
     if(s.active.recoveryOperationId!==f.plan.recoveryOperationId)throw fail('AUTHORIZATION_OPERATION_CONFLICT');
     matches(s.active,f);
     if(s.active.state==='CONSUMED')throw fail('AUTHORIZATION_CONSUMED');
     if(!['REVOKED'].includes(s.active.state)&&now<s.active.expiresAt){
      await append(f,s,s.active,'AUTHORIZATION_REPLAY');
      return {...safeResult(s.active,s.revision+1,now),replay:true};
     }
     if(!reauthorize)throw fail(s.active.state==='REVOKED'?'AUTHORIZATION_REVOKED':'AUTHORIZATION_EXPIRED');
    }else if(reauthorize)throw fail('AUTHORIZATION_MISSING');
    const expectedPlan=canonical(f.plan),expectedBinding=canonical(binding(f)),
     expectedDirectory=f.authorizationDirectory,challenge=authorizationChallenge(f);
    const backupAgeSeconds=Math.floor((now-Date.parse(f.plan.backupCreatedAt))/1000);
    if(!Number.isSafeInteger(backupAgeSeconds)||backupAgeSeconds<0)throw fail('AUTHORIZATION_BACKUP_TIME_INVALID');
    if(typeof confirm!=='function'||await confirm({challenge,
     summary:{...binding(f),backupCreatedAt:f.plan.backupCreatedAt,
      backupAgeSeconds,lossWindow:f.plan.lossWindow,
      currentRecoveryStage:'PREPARED'}})!==challenge)
     throw fail('AUTHORIZATION_CONFIRMATION_REQUIRED');
    const latest=await facts();
    if(canonical(binding(latest))!==expectedBinding||canonical(latest.plan)!==expectedPlan||
      latest.authorizationDirectory!==expectedDirectory)
     throw fail('AUTHORIZATION_PLAN_CHANGED');
    const issuedAt=time(s.last),record={recordVersion:1,authorizationId:randomUUID(),
     previousAuthorizationId:s.active?.authorizationId??null,...binding(latest),issuedBySid:latest.actorSid,
     issuedAt,expiresAt:issuedAt+AUTHORIZATION_TTL_MS,state:'AUTHORIZED'};
    validateAuthorizationRecord(record);
    const revision=await append(f,s,record,s.active?'AUTHORIZATION_REISSUED':'AUTHORIZATION_CREATED');
    return {...safeResult(record,revision,issuedAt),replay:false};
   });
  },
  // Read-only D2 observation: no authorization lock, issuance, audit append or consume.
  async peek(){
   const f=await facts(),s=await read(f),now=time(s.last);
   if(s.active)matches(s.active,f);
   return {active:s.active?safeResult(s.active,s.revision,now):null,revision:s.revision};
  },
  async inspect(){
   return locked(async(f,s)=>{
    let now;try{now=time(s.last);}catch(e){await observedError(f,s,e);throw e;}
    const revision=await append(f,s,s.active,'AUTHORIZATION_INSPECTED',
     s.active&&now>=s.active.expiresAt?'BLOCKED':'PASS',s.active&&now>=s.active.expiresAt?'AUTHORIZATION_EXPIRED':'NONE',now);
    return {active:s.active?safeResult(s.active,revision,now):null,
     history:s.history.map(r=>safeResult(r,revision,now)),revision};
   });
  },
  async revoke(){
   return locked(async(f,s)=>{
    const now=time(s.last);
    if(!s.active)throw fail('AUTHORIZATION_MISSING');
    matches(s.active,f);
    if(s.active.state==='CONSUMED')throw fail('AUTHORIZATION_CONSUMED');
    const active={...s.active,state:'REVOKED'},replay=s.active.state==='REVOKED';
    const revision=await append(f,s,active,'AUTHORIZATION_REVOKED','PASS',replay?'REPLAY':'NONE',now);
    return {...safeResult(active,revision,now),replay};
   });
  },
  async issue(){
   return locked(async(f,s)=>{
    let now,record;try{now=time(s.last);record=valid(s,f,now);}
    catch(e){await observedError(f,s,e);throw e;}
    await append(f,s,record,'AUTHORITY_ISSUED');
    const token=Object.freeze({});tokens.set(token,{kind,service:this,id:record.authorizationId});
    return token;
   });
  },
  async check(id){
   return locked(async(f,s)=>{
    try{const now=time(s.last),record=valid(s,f,now);
     if(record.authorizationId!==id)throw fail('AUTHORIZATION_SUPERSEDED');
     await append(f,s,record,'AUTHORITY_REVALIDATED');return safeResult(record,s.revision+1,now);
    }catch(e){await observedError(f,s,e);throw e;}
   });
  },
  // Only the owned test boundary receives lifecycle admission/consume helpers in D1.
  async testAdmission(id,work){
   return locked(async(f,s)=>{
    const now=time(s.last),record=valid(s,f,now);
    if(record.authorizationId!==id)throw fail('AUTHORIZATION_SUPERSEDED');
    await append(f,s,{...record,state:'IN_PROGRESS'},'STAGE_ADMITTED');
    return work(async()=>{
     const current=await facts(),latest=await read(current),now=time(latest.last),active=valid(latest,current,now);
     if(active.authorizationId!==id)throw fail('AUTHORIZATION_SUPERSEDED');
     if(canonical(binding(current))!==canonical(binding(f)))throw fail('AUTHORIZATION_BINDING_MISMATCH');
     return safeResult(active,latest.revision,now);
    });
   });
  },
  async testConsume(){
   return locked(async(f,s)=>{
    const now=time(s.last),record=valid(s,f,now);
    if(record.state!=='IN_PROGRESS')throw fail('AUTHORIZATION_STAGE_CONFLICT');
    await append(f,s,{...record,state:'CONSUMED'},'AUTHORIZATION_CONSUMED');
   });
  }
 };
}
const productionService=config=>service({facts:()=>loadRecoveryContext(config),kind:'production'});
export async function authorizeProductionRestore(config,options){return productionService(config).authorize(options);}
export async function inspectProductionAuthorization(config){return productionService(config).inspect();}
export async function revokeProductionAuthorization(config){return productionService(config).revoke();}
export async function issueProductionPlanAuthority(config){return productionService(config).issue();}
export async function assertProductionPlanAuthority(token){
 const entry=tokens.get(token);
 if(entry?.kind!=='production')throw fail('AUTHORIZATION_AUTHORITY_FORGED');
 return entry.service.check(entry.id);
}
export async function createOwnedAuthorizationHarness({capability,facts,clock,harden}){
 return withOwnedCandidateRead(capability,async()=>{
  // No test callback can enter the production token registry.
  const scopedFacts=async()=>{
   const value=await facts();
   const directory=await canonicalProtectedPath(value.authorizationDirectory,{directory:true});
   if(dirname(directory)!==join(capability.root,'artifacts'))
    throw fail('AUTHORIZATION_TEST_SCOPE_DENIED');
   return value;
  };
  const engine=service({facts:scopedFacts,kind:'owned-test',clock,harden});
  const harness=Object.freeze({
   authorize:o=>engine.authorize(o),inspect:()=>engine.inspect(),peek:()=>engine.peek(),revoke:()=>engine.revoke(),
   issue:()=>engine.issue(),
   check:async token=>{const entry=tokens.get(token);if(entry?.kind!=='owned-test'||entry.service!==engine)throw fail('AUTHORIZATION_AUTHORITY_FORGED');return engine.check(entry.id);},
   admit:async(token,work)=>{const e=tokens.get(token);if(e?.kind!=='owned-test'||e.service!==engine)throw fail('AUTHORIZATION_AUTHORITY_FORGED');return engine.testAdmission(e.id,work);},
   consume:()=>engine.testConsume()
  });
  ownedHarnesses.set(harness,capability);return harness;
 });
}

export function requireOwnedAuthorizationHarness(harness,capability){
 if(ownedHarnesses.get(harness)!==capability)throw fail('AUTHORIZATION_AUTHORITY_FORGED');
 return harness;
}
export async function peekProductionAuthorization(config){return productionService(config).peek();}

// D2 readonly observation only: this never exposes an engine or mints a token.
export async function readAuthorizationObservation(context){return service({facts:async()=>context,kind:'observation-only'}).peek();}
