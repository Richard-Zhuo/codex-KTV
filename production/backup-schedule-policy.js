export const BACKUP_PERIOD_MS=15*60*1000;
export const BACKUP_TIME_ZONE='Asia/Shanghai';
const states=new Set(['WAITING','TRIGGERED','RUNNING','VERIFIED','FAILED','TIMED_OUT','SKIPPED','STOPPED','ERROR']);
export function backupSchedulePolicy(value) {
  const defaults={enabled:false,intervalMinutes:15,timeZone:BACKUP_TIME_ZONE,retryLimit:0};
  if(value===undefined)return Object.freeze(defaults);
  if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).some(k=>!Object.hasOwn(defaults,k))||!Object.hasOwn(value,'enabled')||
    typeof value.enabled!=='boolean'||['intervalMinutes','timeZone','retryLimit'].some(k=>value[k]!==undefined&&value[k]!==defaults[k]))
    throw Object.assign(Error('BACKUP_SCHEDULE_CONFIG_INVALID'),{code:'BACKUP_SCHEDULE_CONFIG_INVALID'});
  return Object.freeze({...defaults,enabled:value.enabled});
}
export function scheduleTime(value) {
  if(!Number.isSafeInteger(value)||value<0||value>8640000000000000-BACKUP_PERIOD_MS)throw Error('BACKUP_SCHEDULE_CLOCK_INVALID');
  return value;
}
// UTC quarter-hours are also Shanghai (+08:00) quarter-hours. Never use host TZ.
export const backupSlotAt=value=>Math.floor(scheduleTime(value)/BACKUP_PERIOD_MS)*BACKUP_PERIOD_MS;
export const nextBackupSlot=value=>backupSlotAt(value)+BACKUP_PERIOD_MS;
export function validateScheduleObservation(s) {
  const keys=['version','state','nextDueAt','observedAt','lastSlotAt','runningSlotAt','missedCount','missedFrom','missedThrough'];
  const slot=v=>v===null||Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000-BACKUP_PERIOD_MS&&v%BACKUP_PERIOD_MS===0;
  if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).length!==keys.length||
    keys.some(k=>!Object.hasOwn(s,k))||s.version!==1||!states.has(s.state)||
    s.nextDueAt===null||!slot(s.nextDueAt)||!slot(s.lastSlotAt)||!slot(s.runningSlotAt)||
    !Number.isSafeInteger(s.observedAt)||s.observedAt<0||s.observedAt>8640000000000000-BACKUP_PERIOD_MS||
    !Number.isSafeInteger(s.missedCount)||s.missedCount<0||!slot(s.missedFrom)||!slot(s.missedThrough)||
    (s.missedCount===0?(s.missedFrom!==null||s.missedThrough!==null):
      (s.missedFrom===null||s.missedThrough===null||s.missedThrough<s.missedFrom||
        s.missedCount!==(s.missedThrough-s.missedFrom)/BACKUP_PERIOD_MS+1)))
    throw Error('BACKUP_SCHEDULE_STATE_INVALID');
  return s;
}
export function backupScheduleView(value) {
  if(value===undefined)return {state:'DISABLED',timeZone:BACKUP_TIME_ZONE};
  try {
    const s=validateScheduleObservation(value);
    return {state:s.state,timeZone:BACKUP_TIME_ZONE,nextRunAt:new Date(s.nextDueAt).toISOString(),
      scheduledAt:s.lastSlotAt===null?null:new Date(s.lastSlotAt).toISOString(),
      running:s.runningSlotAt!==null,missedCount:s.missedCount,
      missedFrom:s.missedFrom===null?null:new Date(s.missedFrom).toISOString(),
      missedThrough:s.missedThrough===null?null:new Date(s.missedThrough).toISOString()};
  }catch{return {state:'ERROR',timeZone:BACKUP_TIME_ZONE};}
}
