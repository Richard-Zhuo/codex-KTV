// Read-only, owned-simulator snapshot exporter. Uses the accepted Stage5B format,
// schema validator, row packing and verifier; it cannot target an arbitrary DB.
import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {connect,serverIdentity,readTables,rowsOf} from '../backup/mysql-backup.js';
import {canonical,digest,schemaSpec,newArtifactDirectory,durableWrite,verifyArtifact,FORMAT_VERSION} from '../backup/format.js';
import {validateSchema} from '../production/schema.js';import {assertOwnedDatabase} from './scope.js';
import {ACCEPTED} from './fresh-environment.js';
export async function backupRestoredRehearsal(f,database,outputDirectory){
 if(process.env.STAGE5E_RUN!=='synthetic-only')throw Error('REHEARSAL_EXPLICIT_SCOPE_REQUIRED');
 assertOwnedDatabase(database,f.names,f.registered);await f.serverGuard();
 const c=await connect(f.dbUrl(database));
 try{
  const identity=await serverIdentity(c);if(identity.server_uuid!==f.identity.server_uuid||identity.database_name!==database)throw Error('REHEARSAL_BACKUP_TARGET_MISMATCH');
  await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  const schema=await validateSchema(c,database),spec=await schemaSpec(),data={backupFormatVersion:FORMAT_VERSION,tables:await readTables(c,spec.tables)};
  const receipts=rowsOf(data,'production_bootstrap_events');if(!receipts.length||receipts.some(r=>r.environment!=='test'||r.store_id!==f.names.storeId||r.ledger_id!==f.names.ledgerId))throw Error('REHEARSAL_BACKUP_SCOPE_MISMATCH');
  const [[clock]]=await c.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS at");
  const dataBytes=canonical(data);if(Buffer.byteLength(dataBytes)>128*1024*1024)throw Error('REHEARSAL_BACKUP_SIZE_LIMIT');
  const manifest={backupFormatVersion:FORMAT_VERSION,createdAt:clock.at,engine:'InnoDB',mysqlVersion:identity.version,schema:spec.manifest,migrationVersion:schema.migrations.at(-1),storeId:f.names.storeId,ledgerId:f.names.ledgerId,source:{environment:'test',database,serverUuid:identity.server_uuid},applicationCommit:ACCEPTED,ledgerHeads:rowsOf(data,'ledger_heads').map(r=>({ledgerId:r.ledger_id,revision:Number(r.revision),checksum:r.state_checksum})),dataChecksum:digest(dataBytes),dataBytes:Buffer.byteLength(dataBytes),backupId:randomUUID()};
  await c.rollback();const directory=await newArtifactDirectory(outputDirectory),manifestBytes=canonical(manifest),checksum=digest(manifestBytes);
  await durableWrite(join(directory,'data.json'),dataBytes);await durableWrite(join(directory,'manifest.json'),manifestBytes);await durableWrite(join(directory,'manifest.sha256'),checksum+'\n');await verifyArtifact(directory,{expectedChecksum:checksum,storeId:f.names.storeId,ledgerId:f.names.ledgerId});
  return {directory,checksum,createdAt:manifest.createdAt,ledgerHeads:manifest.ledgerHeads,source:manifest.source,backupId:manifest.backupId};
 }finally{await c.end();}
}
