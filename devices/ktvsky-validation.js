import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { KtvSkyRoomControlGateway } from './ktvsky-gateway.js';
import { parseKtvSkyValidationConfig, createKtvSkySafetyPolicy, denyValidation,
  insideDirectory, repositoryRoot } from './ktvsky-safety.js';
import { journalLocation, readJournal, updateJournal, isPending } from './validation-journal.js';

function scopeKey(config,mapping) {
  return createHash('sha256').update(JSON.stringify([config.storeId,'ktvsky',mapping.externalDeviceId])).digest('hex');
}
function stateMatches(record,observation) {
  return observation.kind==='STATE' && observation.exists===true && observation.room?.online===true &&
    observation.room.open===(record.action==='open') &&
    (record.action!=='open' || observation.room.observedCountdownValue===record.countdownSeconds);
}
const fields=record=>Object.fromEntries(Object.entries(record).filter(([k])=>k!=='history'));
export function createKtvSkyValidationBoundary({config,env=process.env,httpClient,credentialProvider,
  journalDirectory=env.KTVSKY_VALIDATION_JOURNAL_DIR,now=Date.now}={}) {
  const snapshot=parseKtvSkyValidationConfig(config),enabled=env.KTVSKY_LIVE_CONTROL_ENABLED==='true';
  const policy=createKtvSkySafetyPolicy({config:snapshot,liveEnabled:enabled,now});
  const gateway=new KtvSkyRoomControlGateway({httpClient,credentialProvider,storeId:snapshot.storeId,
    enabled,mutationPolicy:policy,now});
  function mappingFor(id) {
    const mapping=snapshot.mappings.find(row=>row.internalRoomId===id);
    if(!mapping)denyValidation('MAPPING_REQUIRED');
    return mapping;
  }
  async function observePending(file,key,record,mapping) {
    const observation=await gateway.queryRoomState({...mapping,workflowId:record.workflowId,stepId:record.stepId});
    let current=record;
    // Plain read state cannot settle a lost response. Only a persisted ACK can
    // advance this validation prerequisite, never claim provider APPLIED proof.
    if(record.status==='ACKNOWLEDGED' && stateMatches(record,observation))
      current=await updateJournal(file,key,old=>old?.workflowId===record.workflowId && old.status==='ACKNOWLEDGED'?
        {...fields(old),status:'DESIRED_STATE_CONFIRMED'}:null);
    return {code:current.status==='UNKNOWN'?'DEVICE_UNKNOWN':current.status,pending:Boolean(isPending(current)),
      workflowId:record.workflowId,observation};
  }
  return Object.freeze({
    // Explicit offline recovery of the legacy ACK + pre-existing CLOSED case.
    // The operator supplies the archived report and its independently checked
    // digest. No current read or new identity can substitute for the old ACK.
    // Original journal fields survive in append-only history; no provider call.
    async recoverAcknowledgedClose({internalRoomId,workflowId,evidenceFile,evidenceSha256}={}) {
      const mapping=mappingFor(internalRoomId),key=scopeKey(snapshot,mapping);
      policy({...mapping,workflowId,stepId:workflowId+':close'});
      if(typeof evidenceFile!=='string'||!path.isAbsolute(evidenceFile)||!/^[a-f0-9]{64}$/.test(evidenceSha256??''))denyValidation('INVALID_RECOVERY_EVIDENCE');
      let bytes,archive;
      try{
        const resolved=await realpath(evidenceFile);
        if(insideDirectory(repositoryRoot,resolved))denyValidation('INVALID_RECOVERY_EVIDENCE');
        bytes=await readFile(resolved);
        if(bytes.length>32768)denyValidation('INVALID_RECOVERY_EVIDENCE');
        archive=JSON.parse(bytes.toString('utf8'));
      }catch{denyValidation('INVALID_RECOVERY_EVIDENCE');}
      const digest=createHash('sha256').update(bytes).digest('hex'),events=archive.events;
      const controls=Array.isArray(events)?events.filter(e=>e.category==='control'):[];
      const reads=Array.isArray(events)?events.filter(e=>e.category==='search'):[];
      const control=controls[0],pre=reads[0],post=reads[1];
      if(digest!==evidenceSha256 || archive.phase!=='ONE_V06_CLOSE_THEN_QUERY' ||
          archive.result?.workflowId!==workflowId || archive.controlRequests!==1 || archive.openExecuted!==false ||
          archive.automaticMutationRetries!==0 || controls.length!==1 || reads.length!==2 ||
          control.httpStatus!==200 || control.providerCode!==200 || control.intent?.status!==0 ||
          control.intent.deviceSuffix!==mapping.externalDeviceId.slice(-4) ||
          archive.controlEvidence?.acknowledged!==true || archive.controlEvidence.settled!==false ||
          events.some(e=>e.error || e.timeout || e.disconnect || e.reason) ||
          ![pre,post].every(e=>e.httpStatus===200 && e.providerCode===200 && e.targetMatches===1 &&
            e.observed?.alive===1 && e.observed.status===0) ||
          !(Date.parse(pre.at)<Date.parse(control.at) && Date.parse(control.at)<Date.parse(post.at)))
        denyValidation('INVALID_RECOVERY_EVIDENCE');
      const file=await journalLocation(journalDirectory,key);
      const recovered=await updateJournal(file,key,old=>{
        if(old?.schemaVersion!==1 || old.status!=='UNKNOWN' || old.action!=='close' || old.workflowId!==workflowId)
          denyValidation('INVALID_RECOVERY_EVIDENCE');
        return {...fields(old),status:'DESIRED_STATE_CONFIRMED',acknowledged:true,
          preExistingDesiredState:true,causalEffect:'UNVERIFIED',evidenceSha256:digest};
      });
      return {code:recovered.status,pending:false,workflowId,acknowledged:true,preExistingDesiredState:true,
        causalEffect:'UNVERIFIED',settled:false,evidenceSha256:digest};
    },
    async run({action='query',internalRoomId,countdownSeconds,targetEndAt}={}) {
      if(!['auth','query','close','open'].includes(action))denyValidation('INVALID_VALIDATION_ACTION');
      if(action==='auth')return gateway.ensureSession();
      const mapping=mappingFor(internalRoomId),key=scopeKey(snapshot,mapping);
      let file,record;
      if(journalDirectory){file=await journalLocation(journalDirectory,key);record=await readJournal(file,key);}
      if(isPending(record))return observePending(file,key,record,mapping);
      const workflowId=randomUUID();
      const input={...mapping,workflowId,stepId:workflowId+':'+action,countdownSeconds,targetEndAt};
      if(action==='query') {
        const observation=await gateway.queryRoomState(input);
        return {code:observation.kind==='STATE'?'READ_OBSERVED':observation.diagnosticCode??'DEVICE_UNKNOWN',
          pending:false,workflowId,observation};
      }
      policy(input); // Gates precede auth, HTTP and journal claims.
      if(action==='open'&&(![60,300].includes(countdownSeconds)||typeof targetEndAt!=='string'||
          !Number.isFinite(Date.parse(targetEndAt))))denyValidation('SAFE_COUNTDOWN_REQUIRED');
      if(!file)denyValidation('EXTERNAL_JOURNAL_REQUIRED');
      const before=await gateway.getRoomStatus(input);
      if(before.kind!=='STATE'||before.exists!==true)return {code:before.diagnosticCode??'DEVICE_UNKNOWN',pending:false,observation:before};
      if(before.room?.online!==true)return {code:'DEVICE_OFFLINE',pending:false,observation:before};
      // Validate the minimum-effect sequence; opening an already-open test room
      // must not silently reset its timer.
      if(action==='open' && before.room.open!==false)return {code:'OPEN_PRECONDITION_NOT_SATISFIED',pending:false,observation:before};
      const skipped=action==='close' && before.room.open===false;
      const claimed=await updateJournal(file,key,old=>{
        if(isPending(old) || (old?.workflowId??null)!==(record?.workflowId??null))return null;
        return {workflowId,stepId:input.stepId,action,status:skipped?'PRECONDITION_SATISFIED':'UNKNOWN',
          ...(skipped?{preExistingDesiredState:true,causalEffect:'UNVERIFIED'}:{}),
          ...(action==='open'?{countdownSeconds,targetEndAt}:{})};
      });
      if(claimed?.workflowId!==workflowId)return observePending(file,key,claimed,mapping);
      if(skipped)return {code:'PRECONDITION_SATISFIED',pending:false,workflowId,mutationDispatched:false,settled:false,observation:before};
      const evidence=await gateway[action==='close'?'closeRoom':'openRoom'](input);
      if(evidence.kind==='ACKNOWLEDGED' && evidence.acknowledged===true)
        await updateJournal(file,key,old=>old?.workflowId===workflowId && old.status==='UNKNOWN'?
          {...fields(old),status:'ACKNOWLEDGED',acknowledged:true,preExistingDesiredState:false,causalEffect:'UNVERIFIED'}:null);
      const result=await observePending(file,key,await readJournal(file,key),mapping);
      return {...result,evidence,...(evidence.kind==='UNKNOWN'?{code:evidence.diagnosticCode??'DEVICE_UNKNOWN'}:{})};
    }
  });
}
export function summarizeValidation(result) {
  if(Object.hasOwn(result,'ready'))return {ready:result.ready,code:result.code??'SESSION_AVAILABLE'};
  const observation=result.observation;
  return {code:result.code,pending:result.pending,workflowId:result.workflowId,
    observation:observation?{evidenceVersion:observation.evidenceVersion,kind:observation.kind,
      diagnosticCode:observation.diagnosticCode,exists:observation.exists,
      online:observation.room?.online,open:observation.room?.open,
      observedCountdownValue:observation.room?.observedCountdownValue,
      countdownUnit:observation.room?.countdownUnit,settled:observation.settled,retrySafe:observation.retrySafe}:null};
}
