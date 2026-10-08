export const DEVICE_STATES = Object.freeze(['DEVICE_PENDING','DEVICE_OFFLINE_WAIT','DEVICE_CLOSING',
  'DEVICE_OPENING','DEVICE_VERIFYING','ACTIVE','DEVICE_UNKNOWN','DEVICE_FAILED']);
export const STEPS = Object.freeze(['STATUS','CLOSE','OPEN','VERIFY']);
export const statusForStep = step => ({STATUS:'DEVICE_PENDING',CLOSE:'DEVICE_CLOSING',OPEN:'DEVICE_OPENING',
  VERIFY:'DEVICE_VERIFYING'})[step];
export function readinessFor(status) {
  if (!DEVICE_STATES.includes(status)) throw TypeError('Invalid device status');
  return status === 'ACTIVE' ? 'ACTIVE' : status === 'DEVICE_OFFLINE_WAIT' ? 'WAITING_DEVICE' :
    status === 'DEVICE_FAILED' ? 'FAILED' : 'OPENING';
}
export function changeWorkflow(record, fields, now, outcome) {
  const next={...record,...fields,version:record.version+1,updatedAt:now};
  if (!Number.isSafeInteger(next.version) || !DEVICE_STATES.includes(next.status)) throw TypeError('Invalid device workflow transition');
  next.roomReadiness=readinessFor(next.status);
  next.events=[...record.events,{at:now,step:next.step,status:next.status,outcome}];
  return next;
}
export function scopeMatches(input, evidence) {
  return evidence && evidence.provider===input.provider && evidence.externalDeviceId===input.externalDeviceId &&
    evidence.workflowId===input.workflowId && evidence.stepId===input.stepId;
}
export function desiredState(step, room, targetEndAt) {
  return room?.online===true && (step==='CLOSE' ? room.open===false :
    ['OPEN','VERIFY'].includes(step) ? room.open===true && room.countdownTargetEndAt===targetEndAt : step==='STATUS');
}
