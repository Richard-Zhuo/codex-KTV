import { createMySqlRoomControlStore } from './mysql-store.js';
import { createRoomControlApplication } from './application.js';
import { createRoomControlWorker } from './worker.js';
// Explicit server composition; never accepts browser supplied control targets or identity.
export function createRoomControlRuntime({pool,database,ledgerId,authStore,gateway,testOnly=false,intervalMs=2000}) {
  const store=createMySqlRoomControlStore({pool,database,ledgerId,bindSessionRevalidation:authStore.bindSessionRevalidation,testOnly});
  const application=createRoomControlApplication({store,gateway,serverWorker:true,allowTestGateway:testOnly});
  const worker=createRoomControlWorker({store,application,intervalMs});
  return Object.freeze({store,application,worker,enabled:gateway.productionEnabled!==false,
    start(){if(gateway.productionEnabled!==false)worker.start();},stop:()=>worker.stop()});
}
