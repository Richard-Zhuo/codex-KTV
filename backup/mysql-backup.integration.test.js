import test from 'node:test';import assert from 'node:assert/strict';
import { join } from 'node:path';import { readFile,writeFile,cp } from 'node:fs/promises';
import { withBackupFixture } from '../test-support/backup-fixture.js';
import { backupDatabase,restoreDatabase,connect,readTables,rowsOf } from './mysql-backup.js';
import { verifyArtifact,canonical,digest } from './format.js';
test('Stage 5B verified same-version MySQL backup and separate restore',{skip:!process.env.LEDGER_MYSQL_TEST_URL},async t=>withBackupFixture(async f=>{
 const clean={operationKey:'historical-clean',expectedRevision:0,action:'clean',payload:{room:'V01'}};
 assert.equal((await f.app.execute(clean,f.credential)).status,'committed');
 let concurrent=false;
 const backup=await backupDatabase({...f.backupArgs,outputDirectory:join(f.dir,'backup'),connectSource:async raw=>{
  const c=await connect(raw);return new Proxy(c,{get(target,key){if(key==='query')return async(...args)=>{const result=await target.query(...args);if(args[0]?.sql==='SELECT * FROM ledger_heads'){concurrent=true;assert.equal((await f.app.execute({operationKey:'after-snapshot',expectedRevision:1,action:'clean',payload:{room:'V02'}},f.credential)).status,'committed');}return result;};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 }});
 const verified=await verifyArtifact(backup.directory,{expectedChecksum:backup.checksum,storeId:f.storeId,ledgerId:f.ledgerId});
 await t.test('one repeatable-read snapshot remains coherent while source writes commit',async()=>{
  assert.equal(concurrent,true);assert.equal(verified.manifest.ledgerHeads[0].revision,1);assert.equal(rowsOf(verified.data,'ledger_operations').length,1);assert.equal((await f.store.read()).revision,2);
  const bytes=await readFile(join(backup.directory,'data.json'),'utf8');assert.equal(bytes.includes(f.secret),false);assert.equal(bytes.includes(f.raw),false);
 });
 const target=f.targetArgs(backup);let restored;
 await t.test('restore reproduces every business/auth cell into a separate database',async()=>{
  const sourceBefore=canonical({tables:await readTables(f.setup,verified.spec.tables)});
  restored=await restoreDatabase(target);assert.equal(restored.mode,'VERIFYING');
  const c=await connect(target.databaseUrl);try{const actual=await readTables(c,verified.spec.tables.filter(n=>!['recovery_control','recovery_events'].includes(n)));for(const [name,value]of Object.entries(actual))assert.equal(digest(canonical(value)),digest(canonical(verified.data.tables[name])));assert.equal((await c.query('SELECT mode FROM recovery_control'))[0][0].mode,'VERIFYING');}finally{await c.end();}
  assert.equal(canonical({tables:await readTables(f.setup,verified.spec.tables)}),sourceBefore);
 });
 await t.test('existing target and source-overwrite targets are refused',async()=>{
  await assert.rejects(restoreDatabase(target),{code:'RESTORE_TARGET_NOT_EMPTY'});
  await assert.rejects(restoreDatabase({...target,databaseUrl:f.raw}),e=>['RESTORE_CONFIRMATION_REQUIRED','RESTORE_SOURCE_OVERWRITE_DENIED'].includes(e.code));
 });
 await t.test('partial import fails atomically and retains a FAILED target without auto-wipe',async()=>{
  const directory=join(f.dir,'partial');await cp(backup.directory,directory,{recursive:true});
  const data=JSON.parse(await readFile(join(directory,'data.json'),'utf8'));data.tables.auth_accounts.rows.push(data.tables.auth_accounts.rows[0]);
  const bytes=canonical(data),manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));manifest.dataBytes=Buffer.byteLength(bytes);manifest.dataChecksum=digest(bytes);
  const mb=canonical(manifest),checksum=digest(mb);await writeFile(join(directory,'data.json'),bytes);await writeFile(join(directory,'manifest.json'),mb);await writeFile(join(directory,'manifest.sha256'),checksum+'\n');
  const failed=f.targetArgs({...backup,directory,checksum},'failed');await assert.rejects(restoreDatabase(failed),{code:'RESTORE_FAILED'});
  const c=await connect(failed.databaseUrl);try{assert.equal((await c.query('SELECT mode FROM recovery_control'))[0][0].mode,'FAILED');assert.equal(Number((await c.query('SELECT COUNT(*) AS n FROM auth_accounts'))[0][0].n),0);}finally{await c.end();}
  await assert.rejects(restoreDatabase(failed),{code:'RESTORE_TARGET_NOT_EMPTY'});
 });
 await t.test('tampering, truncation, wrong-store and future schema refuse before connecting',async()=>{
  for(const variant of ['tampered','truncated','future','schema','migration','embedded-store']){
   const dir=join(f.dir,variant);await cp(backup.directory,dir,{recursive:true});let checksum=backup.checksum;
   if(['future','schema','migration','embedded-store'].includes(variant)){const m=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));if(variant==='future')m.backupFormatVersion=999;else if(variant==='schema')m.schema.migrations['999_unknown.sql']='0'.repeat(64);else if(variant==='migration')m.migrationVersion='999_future.sql';else {const data=JSON.parse(await readFile(join(dir,'data.json'),'utf8'));const table=data.tables.production_bootstrap_events;table.rows[0][table.columns.indexOf('store_id')]='another-store';const bytes=canonical(data);m.dataChecksum=digest(bytes);m.dataBytes=Buffer.byteLength(bytes);await writeFile(join(dir,'data.json'),bytes);}const bytes=canonical(m);checksum=digest(bytes);await writeFile(join(dir,'manifest.json'),bytes);await writeFile(join(dir,'manifest.sha256'),checksum+'\n');}
   else {const bytes=await readFile(join(dir,'data.json'));await writeFile(join(dir,'data.json'),variant==='truncated'?bytes.subarray(0,bytes.length/2):Buffer.concat([bytes,Buffer.from(' ')]));}
   await assert.rejects(restoreDatabase({...target,directory:dir,expectedChecksum:checksum,databaseUrl:'not-a-url'}),{code:variant==='embedded-store'?'BACKUP_STORE_MISMATCH':['future','schema','migration'].includes(variant)?'BACKUP_SCHEMA_UNSUPPORTED':'BACKUP_CHECKSUM_MISMATCH'});
  }
  await assert.rejects(restoreDatabase({...target,storeId:'wrong',databaseUrl:'not-a-url'}),{code:'BACKUP_STORE_MISMATCH'});
 });
}));
