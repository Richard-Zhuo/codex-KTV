import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { KtvSkyRoomControlGateway } from './ktvsky-gateway.js';
import { parseKtvSkyValidationConfig, createKtvSkySafetyPolicy, denyValidation,
  insideDirectory, repositoryRoot } from './ktvsky-safety.js';
import { verifyRemainingCountdown, KTVSKY_COUNTDOWN_TOLERANCE_SECONDS } from './ktvsky-countdown.js';
import { journalLocation, readJournal, updateJournal, isPending } from './validation-journal.js';

function scopeKey(config,mapping) {
  return createHash('sha256').update(JSON.stringify([config.storeId,'ktvsky',mapping.externalDeviceId])).digest('hex');
}
function stateMatches(record,observation) {
  return observation.kind==='STATE' && observation.exists===true && observation.room?.online===true &&
    observation.room.open===(record.action==='open') &&
    (record.action!=='open' || record.acknowledged===true && Number.isFinite(Date.parse(record.acknowledgedAt)) &&
      Date.parse(observation.room.observedAt)>=Date.parse(record.acknowledgedAt) &&
      verifyRemainingCountdown({requestedCountdownSeconds:record.requestedCountdownSeconds,
        sentAt:record.sentAt,observedAt:observation.room.observedAt,
        remainingCountdownSeconds:observation.room.remainingCountdownSeconds}));
}
function verificationDetails(record,observation) {
  const mutationUnknown=record.status==='UNKNOWN',verificationPending=record.status==='ACKNOWLEDGED';
  return {mutationUnknown,verificationPending,stepSettled:record.status==='DESIRED_STATE_CONFIRMED',
    verificationStatus:mutationUnknown?'MUTATION_UNKNOWN':verificationPending?
      (observation.kind!=='STATE'?'QUERY_UNAVAILABLE':record.action==='open'&&!record.sentAt?
        'TIMING_EVIDENCE_REQUIRED':record.action==='open'&&observation.room?.online===true&&observation.room.open===true?
          'COUNTDOWN_INCONSISTENT':'DESIRED_STATE_NOT_CONFIRMED'):record.status,
    ...(record.openObservation?{openVerification:{requestedCountdownSeconds:record.requestedCountdownSeconds,
      sentAt:record.sentAt,acknowledgedAt:record.acknowledgedAt,...record.openObservation,
      toleranceSeconds:KTVSKY_COUNTDOWN_TOLERANCE_SECONDS}}:{})};
}
async function recoveryArchive(evidenceFile,evidenceSha256) {
  if(typeof evidenceFile!=='string'||!path.isAbsolute(evidenceFile)||!/^[a-f0-9]{64}$/.test(evidenceSha256??''))denyValidation('INVALID_RECOVERY_EVIDENCE');
  try {
    const resolved=await realpath(evidenceFile);
    if(insideDirectory(repositoryRoot,resolved))denyValidation('INVALID_RECOVERY_EVIDENCE');
    const bytes=await readFile(resolved);
    if(bytes.length>131072 || createHash('sha256').update(bytes).digest('hex')!==evidenceSha256)
      denyValidation('INVALID_RECOVERY_EVIDENCE');
    return JSON.parse(bytes.toString('utf8'));
  }catch{denyValidation('INVALID_RECOVERY_EVIDENCE');}
}
function archivedOpenProof(archive,mapping,workflowId) {
  const live=archive?.live,events=live?.events;
  if(!Array.isArray(events))denyValidation('INVALID_RECOVERY_EVIDENCE');
  const mutations=events.filter(e=>e.category==='control'),control=mutations[0];
  const step=live.steps?.find(s=>s.label==='open-with-countdown');
  const reads=[archive.recoveryQuery,archive.countdownQuery];
  const goodRead=e=>e?.httpStatus===200&&e.providerCode===200&&e.storeMatches===true&&e.targetMatches===1&&
    e.observed?.alive===1&&!e.failure&&!e.error&&Number.isSafeInteger(e.elapsedMs)&&e.elapsedMs>=0&&e.elapsedMs<=10000&&
    typeof e.at==='string'&&Number.isFinite(Date.parse(e.at));
  const pre=events.filter(e=>e.category==='search'&&goodRead(e)&&e.observed.status===0).at(-1);
  if(live.phase!=='V06_SECOND_SAFE_LIVE_VALIDATION'||live.initiallyClosed!==true||live.controlRequests!==1||
      live.automaticMutationRetries!==0||mutations.length!==1||!control||control.httpStatus!==200||control.providerCode!==200||
      control.failure||control.error||typeof control.at!=='string'||!Number.isFinite(Date.parse(control.at))||!Number.isSafeInteger(control.elapsedMs)||control.elapsedMs<0||control.elapsedMs>10000||
      control.intent?.status!==1||control.intent.internalRoomId!==mapping.internalRoomId||
      control.intent.deviceSuffix!==mapping.externalDeviceId.slice(-4)||
      control.intent.opentime!==control.intent.countdownSeconds||![60,300].includes(control.intent.countdownSeconds)||
      archive.safeTarget?.internalRoomId!==mapping.internalRoomId||step?.workflowId!==workflowId||
      step.controlEvidence?.kind!=='ACKNOWLEDGED'||step.controlEvidence.acknowledged!==true||!pre||pre.observed.opentime!==0||
      Date.parse(pre.at)+pre.elapsedMs>Date.parse(control.at))denyValidation('INVALID_RECOVERY_EVIDENCE');
  const sentAt=control.at,acknowledgedAt=new Date(Date.parse(sentAt)+control.elapsedMs).toISOString();
  let previousObservation;
  for(const read of reads){
    const search=read?.events?.filter(e=>e.category==='search');
    if(read?.controlRequests!==0||read?.result?.workflowId!==workflowId||!Array.isArray(read.events)||
        read.events.some(e=>!['login','search'].includes(e.category))||search?.length!==1||!goodRead(search[0])||
        search[0].observed.status!==1||Date.parse(search[0].at)<Date.parse(acknowledgedAt))denyValidation('INVALID_RECOVERY_EVIDENCE');
    const observation={observedAt:new Date(Date.parse(search[0].at)+search[0].elapsedMs).toISOString(),
      remainingCountdownSeconds:search[0].observed.opentime};
    if(!verifyRemainingCountdown({requestedCountdownSeconds:control.intent.countdownSeconds,sentAt,
        ...observation,previousObservation}))denyValidation('INVALID_RECOVERY_EVIDENCE');
    previousObservation=observation;
  }
  return {requestedCountdownSeconds:control.intent.countdownSeconds,sentAt,acknowledgedAt,openObservation:previousObservation};
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
        {...fields(old),status:'DESIRED_STATE_CONFIRMED',...(old.action==='open'?{
          openObservation:{observedAt:observation.room.observedAt,
            remainingCountdownSeconds:observation.room.remainingCountdownSeconds}}:{})}:null);
    return {code:current.status==='UNKNOWN'?'DEVICE_UNKNOWN':current.status,pending:Boolean(isPending(current)),
      workflowId:record.workflowId,observation,...verificationDetails(current,observation)};
  }
  return Object.freeze({
    // Narrow offline recovery of the second-round ACK with archived timed OPEN
    // observations. Never runs implicitly, calls a provider or clears UNKNOWN.
    async recoverAcknowledgedOpen({internalRoomId,workflowId,evidenceFile,evidenceSha256}={}) {
      const mapping=mappingFor(internalRoomId),key=scopeKey(snapshot,mapping);
      policy({...mapping,workflowId,stepId:workflowId+':open'});
      const archive=await recoveryArchive(evidenceFile,evidenceSha256);
      let proof;
      try{proof=archivedOpenProof(archive,mapping,workflowId);}catch{denyValidation('INVALID_RECOVERY_EVIDENCE');}
      if(Date.parse(proof.openObservation.observedAt)>now())denyValidation('INVALID_RECOVERY_EVIDENCE');
      const file=await journalLocation(journalDirectory,key);
      const recovered=await updateJournal(file,key,old=>{
        if(old?.schemaVersion!==2||old.status!=='ACKNOWLEDGED'||old.action!=='open'||old.workflowId!==workflowId||
            old.acknowledged!==true||old.countdownSeconds!==proof.requestedCountdownSeconds||
            (old.sentAt&&old.sentAt!==proof.sentAt))denyValidation('INVALID_RECOVERY_EVIDENCE');
        return {...fields(old),...proof,status:'DESIRED_STATE_CONFIRMED',evidenceSha256};
      });
      return {code:recovered.status,pending:false,workflowId,
        ...verificationDetails(recovered,{kind:'STATE'})};
    },
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
          pending:false,workflowId:record?.workflowId??workflowId,observation,
          ...(record?verificationDetails(record,observation):{})};
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
          ...(action==='open'?{countdownSeconds,requestedCountdownSeconds:countdownSeconds,targetEndAt}:{})};
      });
      if(claimed?.workflowId!==workflowId)return observePending(file,key,claimed,mapping);
      if(skipped)return {code:'PRECONDITION_SATISFIED',pending:false,workflowId,mutationDispatched:false,settled:false,observation:before};
      const evidence=await gateway[action==='close'?'closeRoom':'openRoom'](input);
      if(evidence.kind==='ACKNOWLEDGED' && evidence.acknowledged===true)
        await updateJournal(file,key,old=>old?.workflowId===workflowId && old.status==='UNKNOWN'?
          {...fields(old),status:'ACKNOWLEDGED',acknowledged:true,preExistingDesiredState:false,causalEffect:'UNVERIFIED',
            sentAt:evidence.sentAt,acknowledgedAt:evidence.acknowledgedAt}:null);
      const result=await observePending(file,key,await readJournal(file,key),mapping);
      return {...result,evidence,...(evidence.kind==='UNKNOWN'?{code:evidence.diagnosticCode??'DEVICE_UNKNOWN'}:{})};
    }
  });
}
export function summarizeValidation(result) {
  if(Object.hasOwn(result,'ready'))return {ready:result.ready,code:result.code??'SESSION_AVAILABLE'};
  const observation=result.observation;
  return {code:result.code,pending:result.pending,workflowId:result.workflowId,
    mutationUnknown:result.mutationUnknown,verificationPending:result.verificationPending,
    verificationStatus:result.verificationStatus,stepSettled:result.stepSettled,openVerification:result.openVerification,
    observation:observation?{evidenceVersion:observation.evidenceVersion,kind:observation.kind,
      diagnosticCode:observation.diagnosticCode,exists:observation.exists,
      online:observation.room?.online,open:observation.room?.open,
      remainingCountdownSeconds:observation.room?.remainingCountdownSeconds,observedAt:observation.room?.observedAt,
      observedCountdownValue:observation.room?.observedCountdownValue,
      countdownUnit:observation.room?.countdownUnit,settled:observation.settled,retrySafe:observation.retrySafe}:null};
}
