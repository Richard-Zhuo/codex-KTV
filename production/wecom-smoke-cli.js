import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOperationalStore } from '../operations/store.js';
import { acquireOperationalWriter } from '../operations/writer-lock.js';
import { createIncidentLifecycle } from '../operations/incidents.js';
import { createAlertDispatcher } from '../operations/alerts.js';
import { createWeComAlertTransport } from '../operations/wecom.js';
import { loadSmokeConfig,validateSmokeStateDirectory,validateSmokeStateFile,hardenSmokeTemporary,cleanupSmokeTemps } from './wecom-smoke-config.js';

const TYPE='WECOM_SMOKE_TEST',SCOPE='wecom-smoke-v1';
const CONTEXT=Object.freeze({component:'synthetic-smoke'});
const fail=code=>Object.assign(Error(code),{code});
const options=new Set(['--validate-only','--send-open','--send-resolved']);
const definiteRejections=new Set(['WECOM_PROVIDER_REJECTED','WECOM_RECIPIENT_INVALID',
  'WECOM_RATE_LIMIT','WECOM_TOKEN_REJECTED']);
export function parseSmokeArgs(argv){
  if(argv.length<3||argv.length>4||argv[0]!=='--config-file'||
    !options.has(argv[2])||(argv.length===4&&argv[3]!=='--open-phone-confirmed')||
    (argv[2]==='--send-resolved')!==(argv.length===4))throw fail('SMOKE_ARGUMENTS_INVALID');
  return {configFile:argv[1],mode:argv[2]};
}
function onlySmokeState(state,recipient){
  const restricted=list=>list!==undefined&&(!Array.isArray(list)||
    list.length>1||list.some(id=>id!==recipient));
  if(state.incidents.length>1||state.incidents.some(i=>i.type!==TYPE||
    i.context?.component!==CONTEXT.component||restricted(i.notifiedRecipients)||
    restricted(i.possiblyNotifiedRecipients))||state.outbox.length>2||state.outbox.some(e=>
    !['OPEN','RESOLVED'].includes(e.transition)||restricted(e.recipients)||
    !state.incidents.some(i=>i.incidentId===e.incidentId)))throw fail('SMOKE_STATE_INVALID');
}
function deliveryFor(state,transition){
  const incident=state.incidents[0];
  return incident&&state.outbox.findLast(e=>e.incidentId===incident.incidentId&&e.transition===transition);
}
function providerResult(transition,incident,delivery,kind){
  const prefix=transition==='OPEN'?'OPEN':'RESOLVED';
  return {SMOKE:kind==='UNKNOWN'?'INCONCLUSIVE':'BLOCKED',
    ...(kind==='REJECTED'?{[prefix+'_PROVIDER_ACCEPTED']:'NO'}:{}),
    [prefix+'_PROVIDER_RESULT']:kind,
    PROVIDER_ACCEPTANCE_UNCERTAIN:kind==='UNKNOWN'?'YES':'NO',
    incidentId:incident.incidentId,deliveryId:delivery.deliveryId,sequence:delivery.sequence,
    RECIPIENT_COUNT:1,NEXT:kind==='UNKNOWN'
      ?'DO NOT RESEND '+prefix+' AUTOMATICALLY; CHECK PHONE AND EXISTING STATE FIRST'
      :'REVIEW PROVIDER REJECTION AND EXISTING STATE BEFORE RETRY'};
}

export async function runWeComSmoke({configFile,mode},{
  loadConfig=loadSmokeConfig,checkDirectory=validateSmokeStateDirectory,
  checkStateFile=validateSmokeStateFile,hardenTemp=hardenSmokeTemporary,cleanTemps=cleanupSmokeTemps,
  fetchImpl=globalThis.fetch,now=Date.now,writer=acquireOperationalWriter,storeFactory=createOperationalStore
}={}){
  if(!options.has(mode)||basename(configFile??'')!=='wecom-smoke.json')
    throw fail('SMOKE_ARGUMENTS_INVALID');
  const config=await loadConfig(configFile);
  const stateDirectory=await checkDirectory(join(dirname(configFile),'wecom-smoke-state'));
  if(mode==='--validate-only')return {CONFIG:'PASS',ACL:'PASS',RECIPIENT_COUNT:1,
    REAL_WECOM_TOKEN:'NO',REAL_WECOM_SEND:'NO'};
  const release=await writer(stateDirectory,SCOPE);
  try{
    await cleanTemps(stateDirectory);
    const store=await storeFactory(stateDirectory,SCOPE,{prepareTemporary:hardenTemp,
      verifyState:()=>checkStateFile(stateDirectory,{required:true})});
    const logger={log(){}};
    const lifecycle=createIncidentLifecycle({store,logger,scope:SCOPE,now,secrets:[config.secret]});
    const provider=createWeComAlertTransport({...config,fetchImpl,now});
    let lastProviderResult=null;
    const transport={...provider,async send(...args){
      try{
        const result=await provider.send(...args);
        lastProviderResult=result.accepted?'ACCEPTED':'REJECTED';
        return result;
      }catch(error){
        if(definiteRejections.has(error?.code)&&Number.isSafeInteger(error?.providerCode)){
          lastProviderResult='REJECTED';throw error;
        }
        lastProviderResult='UNKNOWN';
        throw Object.assign(Error('WECOM_NETWORK_UNKNOWN'),{code:'WECOM_NETWORK_UNKNOWN'});
      }
    }};
    const dispatcher=createAlertDispatcher({store,transport,logger,now,secrets:[config.secret]});
    let state=store.read();onlySmokeState(state,config.warnRecipients[0]);
    if(mode==='--send-open'){
      if(state.incidents.length===0)await lifecycle.condition(TYPE,true,CONTEXT);
      state=store.read();
      const incident=state.incidents[0],open=deliveryFor(state,'OPEN');
      if(incident.state!=='OPEN'||!open||open.state==='DELIVERED')
        throw fail('SMOKE_OPEN_ALREADY_ATTEMPTED');
      if(open.recipients?.length&&
        (open.recipients.length!==1||open.recipients[0]!==config.warnRecipients[0]))
        throw fail('SMOKE_RECIPIENT_CHANGED');
      if(open.uncertain)return providerResult('OPEN',incident,open,'UNKNOWN');
      if(open.state!=='PENDING')throw fail('SMOKE_OPEN_ALREADY_ATTEMPTED');
      await checkStateFile(stateDirectory,{required:true});
      await dispatcher.tick();state=store.read();
      const result=deliveryFor(state,'OPEN');
      if(result.uncertain)return providerResult('OPEN',incident,result,'UNKNOWN');
      if(result.state!=='DELIVERED'){
        if(result.attempts===open.attempts)throw fail('SMOKE_DELIVERY_NOT_ATTEMPTED');
        if(lastProviderResult!=='REJECTED')throw fail('SMOKE_DELIVERY_STATE_UNVERIFIED');
        return providerResult('OPEN',incident,result,'REJECTED');
      }
      return {SMOKE:'PASS',OPEN_PROVIDER_RESULT:'ACCEPTED',OPEN_PROVIDER_ACCEPTED:'YES',TOKEN_ACQUIRED:'YES',MESSAGE_ACCEPTED:'YES',
        incidentId:incident.incidentId,deliveryId:result.deliveryId,sequence:result.sequence,
        RECIPIENT_COUNT:1,NEXT:'WAITING_FOR_HUMAN_PHONE_CONFIRMATION'};
    }
    const incident=state.incidents[0],open=deliveryFor(state,'OPEN');
    if(open?.uncertain)return providerResult('OPEN',incident,open,'UNKNOWN');
    if(!incident||!['OPEN','RESOLVED'].includes(incident.state)||!open||open.state!=='DELIVERED'||
      open.sequence!==1||open.recipients?.length!==1||
      open.recipients[0]!==config.warnRecipients[0]||
      !incident.notifiedRecipients?.includes(open.recipients[0]))
      throw fail('SMOKE_RESOLVE_REQUIRES_CONFIRMED_OPEN');
    if(incident.state==='OPEN')await lifecycle.condition(TYPE,false,CONTEXT);
    state=store.read();const recovery=deliveryFor(state,'RESOLVED');
    if(recovery?.uncertain)return providerResult('RESOLVED',incident,recovery,'UNKNOWN');
    if(recovery?.state!=='PENDING'||recovery.recipients?.length&&
      (recovery.recipients.length!==1||recovery.recipients[0]!==open.recipients[0]))
      throw fail('SMOKE_RECOVERY_ALREADY_ATTEMPTED');
    if(!recovery||recovery.incidentId!==open.incidentId||
      recovery.sequence<=open.sequence)throw fail('SMOKE_STATE_INVALID');
    await checkStateFile(stateDirectory,{required:true});
    await dispatcher.tick();state=store.read();
    const result=deliveryFor(state,'RESOLVED');
    if(result.uncertain)return providerResult('RESOLVED',incident,result,'UNKNOWN');
    if(result.state!=='DELIVERED'){
      if(result.attempts===recovery.attempts)throw fail('SMOKE_DELIVERY_NOT_ATTEMPTED');
      if(lastProviderResult!=='REJECTED')throw fail('SMOKE_DELIVERY_STATE_UNVERIFIED');
      return providerResult('RESOLVED',incident,result,'REJECTED');
    }
    if(result.recipients?.length!==1||result.recipients[0]!==open.recipients[0])
      throw fail('SMOKE_RECIPIENT_CHANGED');
    return {SMOKE:'PASS',RESOLVED_PROVIDER_RESULT:'ACCEPTED',RESOLVED_PROVIDER_ACCEPTED:'YES',TOKEN_ACQUIRED:'YES',MESSAGE_ACCEPTED:'YES',
      incidentId:incident.incidentId,deliveryId:result.deliveryId,sequence:result.sequence,
      RECIPIENT_COUNT:1,NEXT:'VERIFY_PHONE_RECOVERY'};
  }finally{await release();}
}
export async function main(argv=process.argv.slice(2),run=runWeComSmoke){
  try{
    const result=await run(parseSmokeArgs(argv));
    const code=result.SMOKE==='INCONCLUSIVE'?2:result.SMOKE==='BLOCKED'?1:0;
    (code===0?process.stdout:process.stderr).write(JSON.stringify(result)+'\n');
    return code;
  }catch(error){
    const code=typeof error?.code==='string'&&/^SMOKE_[A-Z_]+$/.test(error.code)
      ?error.code:'SMOKE_FAILED';
    process.stderr.write(JSON.stringify({status:'BLOCKED',code})+'\n');
    return 1;
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  process.exitCode=await main();