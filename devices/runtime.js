import { recoveryMode,withRecoveryDispatch,bindRecoveryWriteGuard } from '../recovery/gate.js';
import { createMySqlRoomControlStore } from './mysql-store.js';
import { createRoomControlApplication } from './application.js';
import { createRoomControlWorker } from './worker.js';
// Explicit server composition; never accepts browser supplied control targets or identity.
export function createRoomControlRuntime({pool,database,ledgerId,authStore,gateway,testOnly=false,intervalMs=2000,recoveryGuard=!testOnly}) {
  let accepting=true;
  const store=createMySqlRoomControlStore({pool,database,ledgerId,bindSessionRevalidation:authStore.bindSessionRevalidation,testOnly,...(recoveryGuard?{bindRecoveryGuard:bindRecoveryWriteGuard}:{})});
  const application=createRoomControlApplication({store,gateway,serverWorker:true,allowTestGateway:testOnly,canDispatch:()=>accepting});
  const guarded=recoveryGuard ? {advance:(...args)=>withRecoveryDispatch(pool,database,()=>application.advance(...args))} : application;
  const worker=createRoomControlWorker({store,application:guarded,intervalMs});
  return Object.freeze({store,application:guarded,worker,enabled:gateway.productionEnabled!==false,
    async start(){if(gateway.productionEnabled===false)return;if(recoveryGuard){const c=await pool.getConnection();try{if(await recoveryMode(c)!=='NORMAL')return;}finally{c.release();}}accepting=true;worker.start();},stop:()=>{accepting=false;return worker.stop();}});
}
