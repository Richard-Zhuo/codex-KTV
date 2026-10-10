// Synthetic rehearsal only. A killed owner leaves a valid persisted claim;
// keep the production lease intact and cross its boundary using the owned test clock.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {assertOwnedRoot} from './scope.js';

export async function expireCrashedQueryLeases(f,app,crashedChild,crashedWorkflows){
 if(!f.children.has(crashedChild)||(crashedChild.exitCode===null&&crashedChild.signalCode===null))throw Error('REHEARSAL_CRASH_NOT_CONFIRMED');
 if(app.child===crashedChild||!f.children.has(app.child)||app.child.exitCode!==null||app.child.signalCode!==null)throw Error('REHEARSAL_RESTART_REQUIRED');
 await assertOwnedRoot(f.root,f.names.id);
 if(crashedWorkflows.some(w=>w.ledgerId!==f.names.ledgerId))throw Error('REHEARSAL_WORKFLOW_SCOPE_REQUIRED');
 const deadlines=crashedWorkflows.filter(w=>w.inFlight).map(w=>Date.parse(w.inFlight.until));
 if(deadlines.some(t=>!Number.isFinite(t)))throw Error('REHEARSAL_LEASE_INVALID');
 if(!deadlines.length)return {clockAdvancedMs:0};
 const control=JSON.parse(await readFile(join(f.root,'controls.json'),'utf8'));
 const now=Date.parse(control.clock)+Date.now()-control.clockSetAt,until=Math.max(...deadlines);
 if(!Number.isFinite(now))throw Error('REHEARSAL_CLOCK_REQUIRED');
 if(until<now)return {clockAdvancedMs:0,leaseUntil:new Date(until).toISOString()};
 const clock=new Date(until+1).toISOString();
 await app.controls({clock});
 return {clockAdvancedMs:until+1-now,leaseUntil:new Date(until).toISOString(),clock};
}
