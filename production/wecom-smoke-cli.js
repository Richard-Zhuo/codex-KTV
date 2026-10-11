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
const options=new Set(['--validate-only','--inspect-existing','--send-open','--retry-rejected','--send-resolved']);
export function parseSmokeArgs(argv){
  if(argv.length<3||argv.length>4||argv[0]!=='--config-file'||
    !options.has(argv[2])||(argv.length===4&&argv[3]!=='--open-phone-confirmed')||
    (argv[2]==='--send-resolved')!==(argv.length===4))throw fail('SMOKE_ARGUMENTS_INVALID');
  return {configFile:argv[1],mode:argv[2]};
}
function onlySmokeState(state,recipient){
  const restricted=list=>list!==undefined&&(!Array.isArray(list)||
    list.length>1||(recipient!==undefined&&list.some(id=>id!==recipient)));
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
function diagnosticView(delivery){
  if(!delivery||delivery.attempts===0)return {providerResult:'NOT_ATTEMPTED',failureStage:'NOT_AVAILABLE',
    providerErrcode:'NOT_AVAILABLE',providerErrorClass:'NOT_AVAILABLE'};
  if(!Object.hasOwn(delivery,'providerResult')){
    if(['failureStage','providerErrcode','providerErrorClass'].some(key=>Object.hasOwn(delivery,key)))
      throw fail('SMOKE_STATE_INVALID');
    return {providerResult:'LEGACY_UNKNOWN',failureStage:'LEGACY_UNKNOWN',
      providerErrcode:'NOT_AVAILABLE',providerErrorClass:'LEGACY_DIAGNOSTIC_UNAVAILABLE'};
  }
  const {providerResult,failureStage,providerErrcode,providerErrorClass}=delivery;
  const classes=['TOKEN_REJECTED','RECIPIENT_REJECTED','PROVIDER_REJECTED_OTHER',
    'NETWORK_UNKNOWN','PROVIDER_RESPONSE_INVALID','REQUEST_REJECTED'];
  if(!['ACCEPTED','REJECTED','UNKNOWN'].includes(providerResult)||
    !['TOKEN','MESSAGE_SEND',null].includes(failureStage)||
    !(providerErrcode===null||Number.isSafeInteger(providerErrcode)&&providerErrcode>=-999999&&providerErrcode<=999999)||
    !(providerErrorClass===null||classes.includes(providerErrorClass))||
    providerResult==='ACCEPTED'&&(failureStage!=='MESSAGE_SEND'||providerErrcode!==0||
      providerErrorClass!==null||delivery.state!=='DELIVERED'||delivery.uncertain)||
    providerResult==='REJECTED'&&(failureStage===null||providerErrcode===null||
      providerErrorClass===null||delivery.uncertain)||
    providerResult==='UNKNOWN'&&(providerErrcode!==null||providerErrorClass===null||
      failureStage==='TOKEN'&&delivery.uncertain||failureStage!=='TOKEN'&&!delivery.uncertain))
    throw fail('SMOKE_STATE_INVALID');
  return {providerResult,failureStage,providerErrcode,providerErrorClass};
}
function providerResult(transition,incident,delivery,kind){
  const prefix=transition==='OPEN'?'OPEN':'RESOLVED';
  return {SMOKE:kind==='UNKNOWN'?'INCONCLUSIVE':'BLOCKED',
    ...(kind==='REJECTED'?{[prefix+'_PROVIDER_ACCEPTED']:'NO'}:{}),
    [prefix+'_PROVIDER_RESULT']:kind,
    PROVIDER_ACCEPTANCE_UNCERTAIN:delivery.uncertain?'YES':'NO',
    ...(delivery.failureStage==='TOKEN'?{MESSAGE_ACCEPTED:'NO'}:{}),
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
  const config=mode==='--inspect-existing'?null:await loadConfig(configFile);
  const stateDirectory=await checkDirectory(join(dirname(configFile),'wecom-smoke-state'));
  if(mode==='--inspect-existing'){
    const store=await storeFactory(stateDirectory,SCOPE);
    const state=store.read();onlySmokeState(state);
    const incident=state.incidents[0],delivery=deliveryFor(state,'RESOLVED')??deliveryFor(state,'OPEN');
    if(!incident||!delivery)return {SMOKE:'INSPECT',EXISTING:'NO',REAL_WECOM_TOKEN:'NO',REAL_WECOM_SEND:'NO'};
    const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
    if(!uuid.test(incident.incidentId)||!uuid.test(delivery.deliveryId)||
      !Number.isSafeInteger(delivery.sequence)||delivery.sequence<1||
      !Number.isSafeInteger(delivery.attempts)||delivery.attempts<0)throw fail('SMOKE_STATE_INVALID');
    return {SMOKE:'INSPECT',EXISTING:'YES',incidentId:incident.incidentId,
      deliveryId:delivery.deliveryId,sequence:delivery.sequence,attempts:delivery.attempts,
      ...diagnosticView(delivery),uncertain:delivery.uncertain===true,
      recipientCount:delivery.recipients?.length??0,REAL_WECOM_TOKEN:'NO',REAL_WECOM_SEND:'NO'};
  }
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
        lastProviderResult=provider.diagnoseOutcome({accepted:false,failure:error}).providerResult;
        throw error;
      }
    }};
    const dispatcher=createAlertDispatcher({store,transport,logger,now,secrets:[config.secret],
      timeoutMs:provider.maxDeliveryMs});
    let state=store.read();onlySmokeState(state,config.warnRecipients[0]);
    if(mode==='--send-open'||mode==='--retry-rejected'){
      if(mode==='--send-open'&&state.incidents.length===0)await lifecycle.condition(TYPE,true,CONTEXT);
      state=store.read();
      const incident=state.incidents[0],open=deliveryFor(state,'OPEN');
      if(!incident||incident.state!=='OPEN'||!open||open.state==='DELIVERED')
        throw fail('SMOKE_OPEN_ALREADY_ATTEMPTED');
      if(open.recipients?.length&&
        (open.recipients.length!==1||open.recipients[0]!==config.warnRecipients[0]))
        throw fail('SMOKE_RECIPIENT_CHANGED');
      if(open.uncertain||open.providerResult==='UNKNOWN'){
        if(mode==='--retry-rejected')throw fail('SMOKE_RETRY_REQUIRES_REJECTED_OPEN');
        return providerResult('OPEN',incident,open,'UNKNOWN');
      }
      if(open.state!=='PENDING')throw fail('SMOKE_OPEN_ALREADY_ATTEMPTED');
      if(mode==='--send-open'&&open.attempts>0)throw fail(open.providerResult==='REJECTED'
        ?'SMOKE_EXPLICIT_RETRY_REQUIRED':'SMOKE_LEGACY_DIAGNOSTIC_UNAVAILABLE');
      if(mode==='--retry-rejected')diagnosticView(open);
      if(mode==='--retry-rejected'&&(open.attempts===0||open.providerResult!=='REJECTED'))
        throw fail('SMOKE_RETRY_REQUIRES_REJECTED_OPEN');
      if(mode==='--retry-rejected'&&open.nextAttemptAt>now())throw fail('SMOKE_RETRY_NOT_DUE');
      await checkStateFile(stateDirectory,{required:true});
      await dispatcher.tick();state=store.read();
      const result=deliveryFor(state,'OPEN');
      if(result.uncertain||result.providerResult==='UNKNOWN')return providerResult('OPEN',incident,result,'UNKNOWN');
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
    if(recovery?.uncertain||recovery?.providerResult==='UNKNOWN')
      return providerResult('RESOLVED',incident,recovery,'UNKNOWN');
    if(recovery?.state!=='PENDING'||recovery.recipients?.length&&
      (recovery.recipients.length!==1||recovery.recipients[0]!==open.recipients[0]))
      throw fail('SMOKE_RECOVERY_ALREADY_ATTEMPTED');
    if(!recovery||recovery.incidentId!==open.incidentId||
      recovery.sequence<=open.sequence)throw fail('SMOKE_STATE_INVALID');
    await checkStateFile(stateDirectory,{required:true});
    await dispatcher.tick();state=store.read();
    const result=deliveryFor(state,'RESOLVED');
    if(result.uncertain||result.providerResult==='UNKNOWN')
      return providerResult('RESOLVED',incident,result,'UNKNOWN');
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