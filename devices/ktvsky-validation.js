import { open, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { KtvSkyRoomControlGateway } from './ktvsky-gateway.js';
import { parseKtvSkyValidationConfig, createKtvSkySafetyPolicy, denyValidation,
  insideDirectory, repositoryRoot } from './ktvsky-safety.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function scopeKey(config,mapping) {
  return createHash('sha256').update(JSON.stringify([config.storeId,'ktvsky',mapping.externalDeviceId])).digest('hex');
}
async function journalLocation(directory,key) {
  if(typeof directory!=='string'||!path.isAbsolute(directory)||insideDirectory(repositoryRoot,path.resolve(directory)))denyValidation('EXTERNAL_JOURNAL_REQUIRED');
  await mkdir(directory,{recursive:true,mode:0o700});
  const root=await realpath(directory);
  if(insideDirectory(repositoryRoot,root))denyValidation('EXTERNAL_JOURNAL_REQUIRED');
  return path.join(root,key+'.json');
}
async function readJournal(file,key) {
  try {
    const bytes=await readFile(file);
    if(bytes.length>4096)denyValidation('INVALID_PENDING_RECORD');
    const record=JSON.parse(bytes.toString('utf8'));
    const allowed=['schemaVersion','scopeKey','workflowId','stepId','action','status','countdownSeconds','targetEndAt'];
    if(record.schemaVersion!==1||record.scopeKey!==key||!uuid.test(record.workflowId)||
        !['close','open'].includes(record.action)||record.stepId!==record.workflowId+':'+record.action||
        record.status!=='UNKNOWN'||Object.keys(record).some(k=>!allowed.includes(k)))denyValidation('INVALID_PENDING_RECORD');
    return record;
  }catch(error){
    if(error.code==='ENOENT')return null;
    if(error.code==='INVALID_PENDING_RECORD')throw error;
    denyValidation('INVALID_PENDING_RECORD');
  }
}
async function claimJournal(file,record) {
  let handle;
  try {
    handle=await open(file,'wx',0o600);
    await handle.writeFile(JSON.stringify(record),'utf8');await handle.sync();return true;
  }catch(error){
    if(error.code==='EEXIST')return false;
    denyValidation('JOURNAL_IO_ERROR');
  }finally{await handle?.close();}
}
export function createKtvSkyValidationBoundary({config,env=process.env,httpClient,credentialProvider,
  journalDirectory=env.KTVSKY_VALIDATION_JOURNAL_DIR,now=Date.now}={}) {
  const snapshot=parseKtvSkyValidationConfig(config),enabled=env.KTVSKY_LIVE_CONTROL_ENABLED==='true';
  const policy=createKtvSkySafetyPolicy({config:snapshot,liveEnabled:enabled,now});
  const gateway=new KtvSkyRoomControlGateway({httpClient,credentialProvider,storeId:snapshot.storeId,
    enabled,mutationPolicy:policy,now});
  return Object.freeze({
    async run({action='query',internalRoomId,countdownSeconds,targetEndAt}={}) {
      if(!['auth','query','close','open'].includes(action))denyValidation('INVALID_VALIDATION_ACTION');
      if(action==='auth')return gateway.ensureSession();
      const mapping=snapshot.mappings.find(row=>row.internalRoomId===internalRoomId);
      if(!mapping)denyValidation('MAPPING_REQUIRED');
      const key=scopeKey(snapshot,mapping);
      let file,pending;
      if(journalDirectory){file=await journalLocation(journalDirectory,key);pending=await readJournal(file,key);}
      const workflowId=pending?.workflowId??randomUUID();
      const input={...mapping,workflowId,stepId:pending?.stepId??workflowId+':'+action,countdownSeconds,targetEndAt};
      if(action==='query'||pending) {
        const observation=await gateway.queryRoomState(input);
        return {code:pending?'DEVICE_UNKNOWN':(observation.kind==='STATE'?'READ_OBSERVED':observation.diagnosticCode??'DEVICE_UNKNOWN'),pending:Boolean(pending),workflowId,observation};
      }
      policy(input); // Reject all missing gates before auth, HTTP or journal claims.
      if(action==='open'&&(countdownSeconds!==60||typeof targetEndAt!=='string'||
          !Number.isFinite(Date.parse(targetEndAt))))denyValidation('SAFE_COUNTDOWN_REQUIRED');
      if(!file)denyValidation('EXTERNAL_JOURNAL_REQUIRED');
      const before=await gateway.getRoomStatus(input);
      if(before.kind!=='STATE'||before.exists!==true)return {code:before.diagnosticCode??'DEVICE_UNKNOWN',pending:false,observation:before};
      if(before.room?.online!==true)return {code:'DEVICE_OFFLINE',pending:false,observation:before};
      const record={schemaVersion:1,scopeKey:key,workflowId,stepId:input.stepId,action,status:'UNKNOWN',
        ...(action==='open'?{countdownSeconds,targetEndAt}:{})};
      if(!await claimJournal(file,record)) {
        const original=await readJournal(file,key);
        if(!original)denyValidation('INVALID_PENDING_RECORD');
        const observation=await gateway.queryRoomState({...input,workflowId:original.workflowId,stepId:original.stepId});
        return {code:'DEVICE_UNKNOWN',pending:true,workflowId:original.workflowId,observation};
      }
      const evidence=await gateway[action==='close'?'closeRoom':'openRoom'](input);
      const observation=await gateway.queryRoomState(input);
      // No observed provider proof can resolve this durable UNKNOWN. Never clear,
      // change operation identity, chain the next mutation, or retry automatically.
      return {code:evidence.diagnosticCode??'DEVICE_UNKNOWN',pending:true,workflowId,evidence,observation};
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
