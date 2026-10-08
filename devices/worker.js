// Server-owned bounded scheduler. No employee token, no browser lifetime dependency.
export function createRoomControlWorker({store,application,intervalMs=2000,batchSize=10,onError=()=>{}}) {
  if(typeof store?.listPending!=='function'||typeof application?.advance!=='function'||
      !Number.isSafeInteger(intervalMs)||intervalMs<100||intervalMs>60000||!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>25)throw TypeError('Invalid worker bounds');
  let timer=null,running=null,stopped=true;
  const tick=()=>running??(running=(async()=>{
    for(const id of await store.listPending(batchSize)) {
      try{await application.advance(id);}catch(error){onError(error);}
    }
  })().finally(()=>{running=null;}));
  const schedule=()=>{if(!stopped)timer=setTimeout(async()=>{try{await tick();}catch(error){onError(error);}finally{schedule();}},intervalMs);timer?.unref?.();};
  return Object.freeze({tick,start(){if(stopped){stopped=false;schedule();}},async stop(){stopped=true;clearTimeout(timer);await running;}});
}
