import {backupSchedulePolicy,backupSlotAt,nextBackupSlot,scheduleTime,validateScheduleObservation,backupScheduleView,BACKUP_PERIOD_MS,BACKUP_TIME_ZONE} from './backup-schedule-policy.js';

// One controller in the existing service; execution exclusion remains B2-A's.
// This records schedule observations, never backup contents or an alternate receipt.
export function createBackupScheduler({config,execution,observations,logger},clock={now:Date.now,setTimeout,clearTimeout}) {
  const policy=backupSchedulePolicy(config.backupSchedule);
  let started=false,stopped=false,opened=false,timer=null,starting=null,ticking=null,inFlight=null,stopping=null,state,writes=Promise.resolve(),failureCleanup=null;
  function emit(code,slot=null) {
    logger?.info({event:'backup_schedule',code,timeZone:BACKUP_TIME_ZONE,
      ...(slot===null?{}:{scheduledAt:new Date(slot).toISOString()}),
      ...(state?{nextRunAt:new Date(state.nextDueAt).toISOString(),missedCount:state.missedCount}:{})});
  }
  function save(patch) {
    // Serialize observation patches as well as disk writes. Completion and a
    // timer callback can overlap while the existing operational store is busy.
    const pending=writes.then(async()=>{
      const next={...state,...patch};
      next.observedAt=Math.max(state.observedAt,next.observedAt);
      validateScheduleObservation(next);await observations.save(next);state=next;
    });
    writes=pending.catch(()=>{});return pending;
  }
  function missed(from,through) {
    return through<from?{missedCount:0,missedFrom:null,missedThrough:null}:
      {missedCount:(through-from)/BACKUP_PERIOD_MS+1,missedFrom:from,missedThrough:through};
  }
  function failClosed() {
    if(failureCleanup)return;
    stopped=true;if(timer!==null)clock.clearTimeout(timer);timer=null;
    if(state)state={...state,state:'ERROR'};
    try{emit('BACKUP_SCHEDULE_ERROR');}catch{}
    failureCleanup=(async()=>{
      await execution.stop();
      // Best effort only: if storage is unavailable the fixed ERROR log remains.
      if(opened&&state)await save({state:'ERROR',runningSlotAt:null});
    })().catch(()=>{});
  }
  function arm() {
    if(stopped)return;
    const delay=Math.max(1,Math.min(BACKUP_PERIOD_MS,state.nextDueAt-scheduleTime(clock.now())));
    timer=clock.setTimeout(()=>{timer=null;void tick().catch(failClosed);},delay);
    timer?.unref?.();
  }
  async function runSlot(slot) {
    try {
      if(stopped)return;
      await save({state:'RUNNING',runningSlotAt:slot});
      if(stopped)return;
      emit('BACKUP_SCHEDULE_RUNNING',slot);
      let result;try{result=await execution.runOnce();}catch{result={code:'BACKUP_EXECUTION_FAILED'};}
      const outcome=result?.code==='BACKUP_VERIFIED'?'VERIFIED':
        result?.code==='BACKUP_EXECUTION_TIMEOUT'?'TIMED_OUT':
        ['BACKUP_EXECUTION_BUSY','BACKUP_EXECUTION_DISABLED','BACKUP_EXECUTION_STOPPED'].includes(result?.code)?'SKIPPED':'FAILED';
      if(stopped)return;
      await save({state:outcome,lastSlotAt:slot,runningSlotAt:null,observedAt:Math.max(state.observedAt,scheduleTime(clock.now()))});
      emit('BACKUP_SCHEDULE_'+outcome,slot);
      // Retry limit is zero; the already-armed next slot is the only future trigger.
    }catch{failClosed();}
  }
  async function processTick() {
    if(stopped)return;
    const now=scheduleTime(clock.now());
    if(now<state.nextDueAt) {
      if(now<state.observedAt)emit('BACKUP_SCHEDULE_CLOCK_BACKWARD');
      arm();return;
    }
    const slot=backupSlotAt(now),busy=inFlight!==null;
    await save({nextDueAt:slot+BACKUP_PERIOD_MS,observedAt:Math.max(state.observedAt,now),
      state:busy?'SKIPPED':'TRIGGERED',lastSlotAt:slot,
      ...missed(state.nextDueAt,busy?slot:slot-BACKUP_PERIOD_MS)});
    if(stopped)return;
    if(state.missedCount)emit('BACKUP_SCHEDULE_MISSED',state.missedFrom);
    if(busy){emit('BACKUP_SCHEDULE_SKIPPED',slot);arm();return;}
    emit('BACKUP_SCHEDULE_TRIGGERED',slot);
    // Claim synchronously before the RUNNING observation can yield.
    inFlight=Promise.resolve().then(()=>runSlot(slot)).finally(()=>{inFlight=null;});
    arm();
  }
  function tick() {
    if(stopped||!started||!policy.enabled)return Promise.resolve();
    return ticking??(ticking=processTick().finally(()=>{ticking=null;}));
  }
  return Object.freeze({
    start() {
      if(starting)return starting;
      if(started||stopped||!policy.enabled)return Promise.resolve();
      started=true;
      starting=(async()=>{
        const previous=await observations.open();opened=true;
        if(previous!==undefined)validateScheduleObservation(previous);
        if(stopped)return;
        const now=scheduleTime(clock.now()),nextDueAt=Math.max(nextBackupSlot(now),previous?.nextDueAt??0);
        state={version:1,state:'WAITING',nextDueAt,observedAt:Math.max(now,previous?.observedAt??0),
          lastSlotAt:previous?.lastSlotAt??null,runningSlotAt:null,
          ...missed(previous?.nextDueAt??nextDueAt,backupSlotAt(now))};
        await observations.save(state);
        if(stopped)return;
        if(previous?.runningSlotAt!==null&&previous?.runningSlotAt!==undefined)
          emit('BACKUP_SCHEDULE_INTERRUPTED',previous.runningSlotAt);
        if(state.missedCount)emit('BACKUP_SCHEDULE_MISSED',state.missedFrom);
        if(now<state.observedAt)emit('BACKUP_SCHEDULE_CLOCK_BACKWARD');
        emit('BACKUP_SCHEDULE_WAITING');arm();
      })().catch(()=>{failClosed();throw Error('BACKUP_SCHEDULE_START_FAILED');});
      return starting;
    },
    snapshot:()=>state?backupScheduleView(state):{state:policy.enabled?'WAITING':'DISABLED',timeZone:BACKUP_TIME_ZONE},
    stop() {
      if(stopping)return stopping;
      stopped=true;if(timer!==null)clock.clearTimeout(timer);timer=null;
      stopping=(async()=>{
        if(!policy.enabled)return;
        await execution.stop();await starting?.catch(()=>{});await ticking?.catch(()=>{});await inFlight;await failureCleanup;
        if(opened&&state){await save({state:'STOPPED',runningSlotAt:null});emit('BACKUP_SCHEDULE_STOPPED');}
      })();
      return stopping;
    }
  });
}
