import mysql from 'mysql2/promise';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateSchema } from '../production/schema.js';
import { decodeLedgerJson } from '../ledger/mysql-snapshot.js';
import { isProductionEnvironment } from '../shared/deployment-environment.js';
import { canonical,digest,fail,schemaSpec,pack,unpack,newArtifactDirectory,durableWrite,verifyArtifact,FORMAT_VERSION } from './format.js';
export async function connect(raw,admin=false) {
  let url;try{url=new URL(raw);}catch{throw fail('BACKUP_TARGET_INVALID');}
  if(url.protocol!=='mysql:'||!url.hostname||url.search||url.hash||! /^[a-z][a-z0-9_]{0,63}$/.test(decodeURIComponent(url.pathname.slice(1))))throw fail('BACKUP_TARGET_INVALID');
  if(admin)url.pathname='/';
  return mysql.createConnection({uri:url.href,dateStrings:true,jsonStrings:true,supportBigNumbers:true,bigNumberStrings:true});
}
export async function serverIdentity(c) {
  const [[r]]=await c.query('SELECT DATABASE() AS database_name,@@server_uuid AS server_uuid,VERSION() AS version');return r;
}
export async function readTables(c,names) {
  const result={};
  for(const name of names) {
    const [columns]=await c.execute('SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[name]);
    const [rows]=await c.query({sql:'SELECT * FROM '+name,rowsAsArray:true});
    result[name]={columns:columns.map(r=>r.name),rows:rows.map(row=>row.map(pack)).sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0)};
  }
  return result;
}
export function rowsOf(data,name) {const t=data.tables[name];return t.rows.map(row=>Object.fromEntries(t.columns.map((c,i)=>[c,unpack(row[i])])));}
function storeCheck(data,storeId,ledgerId,environment) {
  const facts=rowsOf(data,'production_bootstrap_events');
  if(!facts.length||facts.some(r=>r.store_id!==storeId||r.ledger_id!==ledgerId||r.environment!==environment))throw fail('BACKUP_STORE_MISMATCH');
  if(!rowsOf(data,'ledger_heads').some(r=>r.ledger_id===ledgerId))throw fail('BACKUP_LEDGER_REQUIRED');
}
export async function backupDatabase({databaseUrl,environment,storeId,ledgerId,serverUuid,confirmation,outputDirectory,applicationCommit,env=process.env,connectSource=connect}) {
  let c;
  try {
    isProductionEnvironment(env);
    const database=decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    if(!['production','test'].includes(environment)||confirmation!==serverUuid+'/'+database+'/'+storeId+'/'+ledgerId||! /^[a-f0-9]{40}$/.test(applicationCommit))throw fail('BACKUP_CONFIRMATION_REQUIRED');
    if(environment==='test'&&(database!=='jbhh_ktv_test'||databaseUrl!==env.LEDGER_MYSQL_TEST_URL||isProductionEnvironment(env)))throw fail('BACKUP_TEST_TARGET_DENIED');
    c=await connectSource(databaseUrl);const identity=await serverIdentity(c);
    if(identity.server_uuid!==serverUuid)throw fail('BACKUP_SERVER_MISMATCH');
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [[clock]]=await c.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt");
    const schema=await validateSchema(c,database),spec=await schemaSpec();
    const data={backupFormatVersion:FORMAT_VERSION,tables:await readTables(c,spec.tables)};
    storeCheck(data,storeId,ledgerId,environment);await validateSchema(c,database);
    const dataBytes=canonical(data);if(Buffer.byteLength(dataBytes)>128*1024*1024)throw fail('BACKUP_SIZE_LIMIT');
    const manifest={backupFormatVersion:FORMAT_VERSION,createdAt:clock.createdAt,engine:'InnoDB',mysqlVersion:identity.version,
      schema:spec.manifest,migrationVersion:schema.migrations.at(-1),storeId,ledgerId,
      source:{environment,database,serverUuid},applicationCommit,
      ledgerHeads:rowsOf(data,'ledger_heads').map(r=>({ledgerId:r.ledger_id,revision:Number(r.revision),checksum:r.state_checksum})),
      dataChecksum:digest(dataBytes),dataBytes:Buffer.byteLength(dataBytes),backupId:randomUUID()};
    await c.rollback();const directory=await newArtifactDirectory(outputDirectory);
    const manifestBytes=canonical(manifest),checksum=digest(manifestBytes);
    await durableWrite(join(directory,'data.json'),dataBytes);await durableWrite(join(directory,'manifest.json'),manifestBytes);await durableWrite(join(directory,'manifest.sha256'),checksum+'\n');
    await verifyArtifact(directory,{expectedChecksum:checksum,storeId,ledgerId});
    return {code:'BACKUP_VERIFIED',directory,checksum,createdAt:manifest.createdAt,source:manifest.source,storeId,ledgerId,ledgerHeads:manifest.ledgerHeads};
  }catch(e){if(c)try{await c.rollback();}catch{}throw fail(/^BACKUP_[A-Z_]+$/.test(e.code??'')?e.code:'BACKUP_FAILED');}finally{await c?.end();}
}
export async function restoreDatabase({directory,expectedChecksum,databaseUrl,serverUuid,environment,storeId,ledgerId,confirmation,restoreToNewDb=false,initiatedBy,env=process.env}) {
  let c,begun=false,controlCreated=false,lock=false;
  try {
    // Artifact and operator checks precede opening a connection or issuing any SQL.
    const verified=await verifyArtifact(directory,{expectedChecksum,storeId,ledgerId}),{manifest,data,spec}=verified;
    const target=decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    if(!restoreToNewDb||environment!=='test'||isProductionEnvironment(env)||! /^jbhh_ktv_restore_[a-z0-9_]+$/.test(target)||typeof initiatedBy!=='string'||!initiatedBy.trim()||confirmation!==serverUuid+'/'+target+'/'+storeId+'/'+ledgerId+'/'+expectedChecksum)throw fail('RESTORE_CONFIRMATION_REQUIRED');
    if(target===manifest.source.database)throw fail('RESTORE_SOURCE_OVERWRITE_DENIED');
    if(manifest.source.environment!=='test')throw fail('RESTORE_PRODUCTION_DISABLED');
    c=await connect(databaseUrl,true);const identity=await serverIdentity(c);
    if(identity.server_uuid!==serverUuid||!/^8\.4\./.test(identity.version))throw fail('RESTORE_SERVER_MISMATCH');
    const [[claim]]=await c.execute('SELECT GET_LOCK(?,10) AS acquired',['restore.'+target]);if(Number(claim.acquired)!==1)throw fail('RESTORE_BUSY');lock=true;
    const [tables]=await c.execute('SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA=?',[target]);if(tables.length)throw fail('RESTORE_TARGET_NOT_EMPTY');
    await c.query('CREATE DATABASE IF NOT EXISTS '+target+' CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');await c.query('USE '+target);
    for(const sql of spec.statements)await c.query(sql);
    await validateSchema(c,target);
    await c.execute('INSERT INTO recovery_control(control_id,mode,store_id,ledger_id,environment,backup_digest,initiated_by,facts) VALUES(1,?,?,?,?,?,?,?)',['RESTORING',storeId,ledgerId,environment,expectedChecksum,initiatedBy,canonical({source:manifest.source,backupCreatedAt:manifest.createdAt,restoreStartedAt:new Date().toISOString()})]);controlCreated=true;
    await c.beginTransaction();begun=true;
    for(const name of spec.tables) {
      if(name==='recovery_control')continue; // Restored operational mode must never become the source's NORMAL mode.
      const table=data.tables[name];const [columns]=await c.execute('SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[name]);
      if(JSON.stringify(columns.map(r=>r.name))!==JSON.stringify(table.columns))throw fail('RESTORE_COLUMN_MISMATCH');
      for(const row of table.rows)await c.execute('INSERT INTO '+name+'('+table.columns.join(',')+') VALUES('+row.map(()=>'?').join(',')+')',row.map(unpack));
    }
    await c.execute('INSERT INTO recovery_events(event_type,initiated_by,reason,facts) VALUES(?,?,?,?)',['restored',initiatedBy,'separate-db-restore',canonical({checksum:expectedChecksum,source:manifest.source})]);
    await c.execute("UPDATE recovery_control SET mode='VERIFYING',updated_at=UTC_TIMESTAMP(6) WHERE control_id=1");
    await c.commit();begun=false;
    return {code:'RESTORE_REQUIRES_VERIFICATION',database:target,serverUuid,storeId,ledgerId,mode:'VERIFYING',checksum:expectedChecksum};
  }catch(e){
    if(c&&begun)try{await c.rollback();}catch{}
    if(c&&controlCreated)try{await c.execute("UPDATE recovery_control SET mode='FAILED',updated_at=UTC_TIMESTAMP(6) WHERE control_id=1");}catch{}
    throw fail(/^(BACKUP|RESTORE)_[A-Z_]+$/.test(e.code??'')?e.code:'RESTORE_FAILED');
  }finally{if(c&&lock)try{await c.execute('SELECT RELEASE_LOCK(?)',['restore.'+decodeURIComponent(new URL(databaseUrl).pathname.slice(1))]);}catch{}await c?.end();}
}
