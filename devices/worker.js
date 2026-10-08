// Server-owned bounded scheduler. No employee token, no browser lifetime dependency.
export function createRoomControlWorker({store,application,intervalMs=2000,batchSize=10,onError=()=>{}}) {
  if(typeof store?.listPending!=='function'||typeof application?.advance!=='function'||
      !Number.isSafeInteger(intervalMs)||intervalMs<100||intervalMs>60000||!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>25)throw TypeError('Invalid worker bounds');
  let timer=null,running=null,stopped=true,generation=0;
  const tick=()=>running??(running=(async()=>{
    const current=generation;
    for(const id of await store.listPending(batchSize)) {
      if(current!==generation)break;
      try{await application.advance(id);}catch(error){onError(error);}
    }
  })().finally(()=>{running=null;}));
  const schedule=()=>{if(!stopped)timer=setTimeout(async()=>{try{await tick();}catch(error){onError(error);}finally{schedule();}},intervalMs);timer?.unref?.();};
  return Object.freeze({tick,start(){if(stopped){stopped=false;schedule();}},async stop(){generation++;stopped=true;clearTimeout(timer);await running;}});
}
