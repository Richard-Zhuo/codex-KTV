import {resolve,join} from 'node:path';
import {assertOwnedRoot} from './scope.js';
// Only the full regression launcher supplies this owned disposable-server identity.
export async function assertRegressionFixture(connection,env=process.env){
 if(env.STAGE5E_RUN!=='synthetic-only')throw Error('REHEARSAL_FIXTURE_SCOPE_REQUIRED');
 const root=await assertOwnedRoot(env.STAGE5E_FIXTURE_ROOT,env.STAGE5E_FIXTURE_ID);
 const [[r]]=await connection.query('SELECT @@port AS port,@@datadir AS datadir,@@server_uuid AS uuid,DATABASE() AS databaseName');
 if(Number(r.port)!==33313||resolve(r.datadir)!==join(root,'data')||r.uuid!==env.STAGE5E_FIXTURE_UUID||!r.uuid||r.databaseName!=='jbhh_ktv_test')throw Error('REHEARSAL_FIXTURE_SERVER_MISMATCH');
}
