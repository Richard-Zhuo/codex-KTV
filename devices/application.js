import { verifyRemainingCountdown } from './ktvsky-countdown.js';
import { randomUUID, createHash } from 'node:crypto';
import { requireTrustedPermission, AuthorizationDenied } from '../shared/identity.js';
import { prepareSessionCredential, revalidateCommandSession } from '../ledger/trusted-execution.js';
import { countdownFor } from '../shared/business-session.js';
import { createRoomDeviceMappings } from './mapping.js';
import { STEPS, statusForStep, changeWorkflow, scopeMatches, desiredState } from './domain.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function exact(value,keys) { return value && Object.getPrototypeOf(value)===Object.prototype &&
  Object.keys(value).length===keys.length && keys.every(k=>Object.hasOwn(value,k)); }
function identity(record,context) {
  if(record.actorId!==context.principalId)throw new AuthorizationDenied('device-workflow-actor-mismatch');
}
function stillOwnsRoom(head,record) {
  return head.state.rooms.some(r=>r.id===record.internalRoomId && r.order===record.orderId) &&
    head.state.orders.some(o=>o.id===record.orderId && o.status==='营业中');
}
export function createRoomControlApplication({store,gateway,mappings,allowTestGateway=false,timeoutMs=15000,leaseMs=30000,serverWorker=false}) {
  if(typeof store?.runAtomic!=='function' || !store.ledgerId ||
      ['ensureSession','getRoomStatus','closeRoom','openRoom','queryRoomState'].some(k=>typeof gateway?.[k]!=='function') ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || !Number.isSafeInteger(leaseMs) || leaseMs<=timeoutMs) throw TypeError('Invalid room-control composition');
  if(gateway.testOnly && (!allowTestGateway || store.testOnly!==true))throw TypeError('Fake gateway requires explicit isolated test mode');
  const mapping=mappings===undefined?null:createRoomDeviceMappings(mappings);
  const targetFor=(tx,id)=>mapping?mapping.get(id):tx.readMapping(id);
  const available=()=>{if(gateway.productionEnabled===false)throw Error('KTVSky production control is not enabled');};
  async function authorized(tx,credential) {
    if(serverWorker && !credential) return {dbNow:await tx.readDbNow()};
    const context=await revalidateCommandSession(tx,credential);requireTrustedPermission(context,'room.open');return context;
  }
  async function callGateway(input,queryOnly) {
    const abort=new AbortController();let timer;
    const work=async()=>{
      const session=await gateway.ensureSession({provider:input.provider,signal:abort.signal});
      if(abort.signal.aborted || session?.ready!==true)return {kind:'UNKNOWN'};
      if(queryOnly)return gateway.queryRoomState({...input,signal:abort.signal});
      const status=await gateway.getRoomStatus({...input,signal:abort.signal});
      if(abort.signal.aborted || !scopeMatches(input,status))return {kind:'UNKNOWN'};
      if(status.room?.online===false)return {...status,kind:'OFFLINE',notDispatched:true};
      if(status.room?.online!==true)return {kind:'UNKNOWN'};
      if(input.step==='STATUS')return status;
      if(input.step==='CLOSE' && typeof status.room.open!=='boolean')return {kind:'UNKNOWN'};
      if(input.step==='CLOSE' && status.room.open===false)return {...status,kind:'PRECONDITION_SATISFIED'};
      const method={CLOSE:'closeRoom',OPEN:'openRoom',VERIFY:'queryRoomState'}[input.step];
      return gateway[method]({...input,signal:abort.signal});
    };
    try{return await Promise.race([work(),new Promise(resolve=>{timer=setTimeout(()=>{abort.abort();resolve({kind:'UNKNOWN'});},timeoutMs);})]);}
    catch{return {kind:'UNKNOWN'};}
    finally{clearTimeout(timer);}
  }
  return Object.freeze({
    // Starts only from an existing server-confirmed order; never creates a second
    // order, payment or inventory movement. Formal open enrolls atomically through mysql-port.
    async start(command,sessionCredential) {
      available();
      if(!exact(command,['operationKey','expectedRevision','payload']) || typeof command.operationKey!=='string' ||
          !command.operationKey || command.operationKey.trim()!==command.operationKey || command.operationKey.length>120 ||
          !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision<0 || !exact(command.payload,['orderId']) ||
          typeof command.payload.orderId!=='string' || !command.payload.orderId || command.payload.orderId.length>191)throw TypeError('Invalid device workflow command');
      const credential=prepareSessionCredential(sessionCredential);
      const fingerprint=createHash('sha256').update(JSON.stringify([command.expectedRevision,command.payload.orderId])).digest('hex');
      return store.runAtomic(async tx=>{
        const context=await authorized(tx,credential),head=await tx.readHead();
        const old=await tx.findByOperation(command.operationKey);
        if(old){if(old.actorId!==context.principalId || old.fingerprint!==fingerprint)return {status:'idempotency-conflict'};return old;}
        if(head.revision!==command.expectedRevision)return {status:'revision-conflict',currentRevision:head.revision};
        const order=head.state.orders.find(o=>o.id===command.payload.orderId && o.kind==='room' && o.status==='营业中');
        if(!order || !head.state.rooms.some(r=>r.id===order.room && r.order===order.id))throw TypeError('Confirmed active room order required');
        const target=await targetFor(tx,order.room);
        if(!target?.enabled)throw TypeError('Enabled stable room/device mapping required');
        countdownFor(order.businessSession,context.dbNow);
        if(await tx.findByOrder(order.id))return {status:'idempotency-conflict',reason:'order-already-has-workflow'};
        const record={id:randomUUID(),ledgerId:store.ledgerId,operationKey:command.operationKey,fingerprint,actorId:context.principalId,
          orderId:order.id,...target,businessSession:structuredClone(order.businessSession),version:0,
          status:'DEVICE_PENDING',roomReadiness:'OPENING',step:'STATUS',uncertain:false,inFlight:null,
          createdAt:context.dbNow,updatedAt:context.dbNow,events:[{at:context.dbNow,step:'STATUS',status:'DEVICE_PENDING',outcome:'created'}]};
        await tx.write(record);return record;
      });
    },
    async get(workflowId,sessionCredential) {
      if(!uuid.test(workflowId))throw TypeError('Workflow UUID required');
      const credential=prepareSessionCredential(sessionCredential);
      return store.runAtomic(async tx=>{const context=await authorized(tx,credential),record=await tx.get(workflowId);
        if(!record)throw TypeError('Unknown workflow');identity(record,context);return record;});
    },
    // One persisted claim -> external call -> one evidence transaction per tick.
    // In-flight duplicates return without sending; expired claims reconcile only.
    async advance(workflowId,sessionCredential) {
      available();if(!uuid.test(workflowId))throw TypeError('Workflow UUID required');
      const credential=serverWorker && sessionCredential===undefined?null:prepareSessionCredential(sessionCredential);
      const claim=await store.runAtomic(async tx=>{
        const context=await authorized(tx,credential),head=await tx.readHead(),record=await tx.get(workflowId);
        if(!record)throw TypeError('Unknown workflow');if(credential)identity(record,context);
        if(['ACTIVE','DEVICE_FAILED'].includes(record.status))return {immediate:record};
        if(record.inFlight && Date.parse(record.inFlight.until)>Date.parse(context.dbNow))return {immediate:record};
        const observingClose=record.step==='CLOSE' && record.closeAcknowledged===true;
        const observingOpen=record.step==='OPEN' && record.openAcknowledged===true;
        const observingMutation=observingClose || observingOpen;
        const recovering=!observingMutation && (record.uncertain || Boolean(record.inFlight));
        const configured=await targetFor(tx,record.internalRoomId);
        if(!recovering && (!stillOwnsRoom(head,record) || !configured?.enabled || configured.provider!==record.provider || configured.externalDeviceId!==record.externalDeviceId)){
          const next=changeWorkflow(record,{status:'DEVICE_FAILED',inFlight:null},context.dbNow,'order-or-mapping-changed');await tx.write(next,record.version);return {immediate:next};
        }
        // A persisted, valid OPEN observation is historical success. The provider's
        // later countdown expiry must not turn that confirmation into UNKNOWN.
        if(record.step==='VERIFY' && record.openConfirmedAt && Date.parse(context.dbNow)>=Date.parse(record.businessSession.targetEndAt)){
          const next=changeWorkflow(record,{status:'ACTIVE',uncertain:false,inFlight:null},context.dbNow,'confirmed-open-retained-after-expiry');
          await tx.write(next,record.version);return {immediate:next};
        }
        let countdown;
        if(!recovering && !observingMutation && !record.openConfirmedAt){try{countdown=countdownFor(record.businessSession,context.dbNow);}catch{
          const next=changeWorkflow(record,{status:'DEVICE_FAILED',inFlight:null},context.dbNow,'session-ended');await tx.write(next,record.version);return {immediate:next};}}
        const attemptId=randomUUID(),stepId=record.id+':'+record.step;
        const next=changeWorkflow(record,{status:observingMutation?'DEVICE_VERIFYING':recovering?'DEVICE_UNKNOWN':statusForStep(record.step),
          inFlight:{attemptId,until:new Date(Date.parse(context.dbNow)+leaseMs).toISOString()}},context.dbNow,recovering?'query-claimed':'step-claimed');
        await tx.write(next,record.version);
        return {record:next,attemptId,recovering,observingClose,observingOpen,observingMutation,input:{provider:record.provider,externalDeviceId:record.externalDeviceId,
          workflowId:record.id,stepId,step:record.step,targetEndAt:record.businessSession.targetEndAt,...countdown,
          ...(countdown?{countdownSeconds:Math.ceil((Date.parse(record.businessSession.targetEndAt)-Date.parse(context.dbNow))/1000)}:{})}};
      });
      if(claim.immediate)return claim.immediate;
      const evidence=await callGateway(claim.input,claim.recovering || claim.observingMutation); // outside every SQL transaction
      return store.runAtomic(async tx=>{
        const record=await tx.get(workflowId);
        if(record?.inFlight?.attemptId!==claim.attemptId)return record; // late outcome is fenced
        const now=await tx.readDbNow();let status='DEVICE_UNKNOWN',step=record.step,uncertain=true,outcome='unknown';
        const scoped=scopeMatches(claim.input,evidence);
        let closeAcknowledged=record.closeAcknowledged===true,openAcknowledged=record.openAcknowledged===true,closePrerequisite=record.closePrerequisite??null;
        if(scoped && evidence.kind==='FAILED' && evidence.settled===true){status='DEVICE_FAILED';uncertain=false;outcome='definitive-failure';}
        else if(scoped && evidence.room?.online===false){status='DEVICE_OFFLINE_WAIT';uncertain=claim.observingMutation?false:claim.recovering || evidence.notDispatched!==true;outcome='offline';}
        else if(scoped){
          const applied=claim.recovering ? evidence.stepResult==='APPLIED' && evidence.settled===true : evidence.kind==='APPLIED' && evidence.settled===true;
          const readSuccess=record.step==='STATUS' && evidence.kind==='STATE' && evidence.room?.online===true && typeof evidence.room.open==='boolean';
          const timedOpen=evidence.kind==='STATE' && evidence.room?.online===true && evidence.room?.open===true &&
            record.openDispatch && verifyRemainingCountdown({...record.openDispatch,
              observedAt:evidence.room.observedAt,remainingCountdownSeconds:evidence.room.remainingCountdownSeconds});
          const verified=record.step==='VERIFY' && evidence.kind==='STATE' &&
            (desiredState('VERIFY',evidence.room,record.businessSession.targetEndAt) || timedOpen);
          const alreadyClosed=!claim.recovering && !claim.observingClose && evidence.room?.online===true && evidence.room.open===false &&
            ((record.step==='STATUS' && readSuccess) || (record.step==='CLOSE' && evidence.kind==='PRECONDITION_SATISFIED'));
          if(alreadyClosed){
            step='OPEN';status=statusForStep(step);uncertain=false;outcome='close-precondition-satisfied';
            closePrerequisite={kind:'PRECONDITION_SATISFIED',mutationDispatched:false,settled:false};
          }else if(record.step==='CLOSE' && !claim.recovering &&
              (claim.observingClose || (evidence.kind==='ACKNOWLEDGED' && evidence.acknowledged===true))){
            closeAcknowledged=true;uncertain=false;status='DEVICE_VERIFYING';outcome='close-acknowledged-awaiting-state';
            if(claim.observingClose && evidence.kind==='STATE' && desiredState('CLOSE',evidence.room)){
              step='OPEN';status=statusForStep(step);outcome='close-desired-state-confirmed';
              closePrerequisite={kind:'DESIRED_STATE_CONFIRMED',mutationDispatched:true,acknowledged:true,settled:false,causalEffect:'UNVERIFIED'};
            }
           }else if(record.step==='OPEN' && !claim.recovering &&
              (claim.observingOpen || (evidence.kind==='ACKNOWLEDGED' && evidence.acknowledged===true))){
            openAcknowledged=true;uncertain=false;status='DEVICE_VERIFYING';outcome='open-acknowledged-awaiting-state';
            if(claim.observingOpen && evidence.kind==='STATE' && (desiredState('OPEN',evidence.room,record.businessSession.targetEndAt)||timedOpen)){
              step='VERIFY';outcome='open-desired-state-confirmed';
            }
          }else if((applied && desiredState(record.step,evidence.room,record.businessSession.targetEndAt)) || readSuccess || verified){
            const index=STEPS.indexOf(record.step);step=STEPS[index+1]??'VERIFY';status=index===STEPS.length-1?'ACTIVE':statusForStep(step);uncertain=false;outcome=claim.recovering?'queried-applied':'confirmed';
          }else if(claim.recovering && evidence.stepResult==='NOT_APPLIED' && evidence.settled===true && evidence.retrySafe===true){
            status=statusForStep(step);uncertain=false;outcome='queried-not-applied-safe';
          }
        }
        if(claim.observingMutation && !scoped){status='DEVICE_VERIFYING';uncertain=false;outcome='mutation-awaiting-valid-state';}
        const safeEvidence=scoped?{kind:['STATE','APPLIED','ACKNOWLEDGED','PRECONDITION_SATISFIED','FAILED','OFFLINE','UNKNOWN'].includes(evidence.kind)?evidence.kind:'UNKNOWN',
          stepResult:['APPLIED','NOT_APPLIED'].includes(evidence.stepResult)?evidence.stepResult:'UNKNOWN',settled:evidence.settled===true,
          online:evidence.room?.online===true,open:evidence.room?.open===true,
          targetMatched:evidence.room?.countdownTargetEndAt===record.businessSession.targetEndAt}:null;
        const openDispatch=record.openDispatch ?? (record.step==='OPEN' && evidence.kind==='ACKNOWLEDGED' && scoped &&
          typeof evidence.sentAt==='string' ? {requestedCountdownSeconds:claim.input.countdownSeconds,sentAt:evidence.sentAt}:null);
        const openConfirmedAt=record.openConfirmedAt ?? ((record.step==='OPEN' && step==='VERIFY' && !uncertain)?now:null);
        const next=changeWorkflow(record,{status,step,uncertain,closeAcknowledged,openAcknowledged,closePrerequisite,openDispatch,openConfirmedAt,inFlight:null,lastEvidence:safeEvidence},now,outcome);
        await tx.write(next,record.version);return next;
      });
    }
  });
}
