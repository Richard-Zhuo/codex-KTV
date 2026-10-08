import { createHash } from 'node:crypto';
import { readFile,realpath,stat,mkdir,open } from 'node:fs/promises';
import { dirname,join,isAbsolute,basename } from 'node:path';
import { encodeLedgerJson } from '../ledger/mysql-snapshot.js';
export const FORMAT_VERSION=1;
export const fail=code=>Object.assign(Error(code),{code});
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export const canonical=value=>encodeLedgerJson(value)+'\n';
export async function schemaSpec() {
  const manifest=JSON.parse(await readFile(new URL('../production/schema-manifest.json',import.meta.url),'utf8'));
  const statements=[];
  for(const name of Object.keys(manifest.migrations)) {
    const sql=await readFile(new URL('../database/migrations/'+name,import.meta.url),'utf8');
    if(digest(sql.replace(/\r\n/g,'\n'))!==manifest.migrations[name])throw fail('BACKUP_SCHEMA_UNSUPPORTED');
    statements.push(...sql.split(/\r?\n/).filter(l=>!l.trim().startsWith('--')).join('\n').split(';').map(s=>s.trim()).filter(Boolean));
  }
  return {manifest,statements,tables:statements.flatMap(s=>/^CREATE TABLE (\w+)/.exec(s)?.slice(1)??[])};
}
export async function externalDirectory(path) {
  if(typeof path!=='string'||!isAbsolute(path))throw fail('BACKUP_PATH_DENIED');
  let resolved;
  try {
    resolved=await realpath(path);if(!(await stat(resolved)).isDirectory())throw Error();
    for(let d=resolved;;d=dirname(d)) {
      try{await stat(join(d,'.git'));throw fail('BACKUP_PATH_DENIED');}catch(e){if(e.code!=='ENOENT')throw e;}
      if(dirname(d)===d)break;
    }
  }catch{throw fail('BACKUP_PATH_DENIED');}
  return resolved;
}
export async function newArtifactDirectory(path) {
  if(!isAbsolute(path)||! /^[A-Za-z0-9_-]+$/.test(basename(path)))throw fail('BACKUP_PATH_DENIED');
  const parent=await externalDirectory(dirname(path));
  const target=join(parent,basename(path));await mkdir(target,{mode:0o700});return target;
}
export async function durableWrite(path,bytes) {
  const file=await open(path,'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
}
export const pack=value=>Buffer.isBuffer(value)?{binary:value.toString('base64')}:value instanceof Date?(()=>{throw fail('BACKUP_TEMPORAL_PRECISION');})():value;
export function unpack(value) {
  if(value===null||typeof value==='string'||typeof value==='number'&&Number.isFinite(value))return value;
  if(value&&Object.keys(value).length===1&&typeof value.binary==='string'&&Buffer.from(value.binary,'base64').toString('base64')===value.binary)return Buffer.from(value.binary,'base64');
  throw fail('BACKUP_INVALID_CELL');
}
export async function verifyArtifact(directory,{expectedChecksum,storeId,ledgerId}) {
  try {
    const root=await externalDirectory(directory);
    if((await stat(join(root,'manifest.json'))).size>1024*1024||(await stat(join(root,'data.json'))).size>128*1024*1024)throw fail('BACKUP_SIZE_LIMIT');
    const manifestBytes=await readFile(join(root,'manifest.json'));
    if(!/^[a-f0-9]{64}$/.test(expectedChecksum??'')||digest(manifestBytes)!==expectedChecksum||(await readFile(join(root,'manifest.sha256'),'utf8')).trim()!==expectedChecksum)throw fail('BACKUP_CHECKSUM_MISMATCH');
    const manifest=JSON.parse(manifestBytes),spec=await schemaSpec();
    if(manifest.backupFormatVersion!==FORMAT_VERSION||canonical(manifest.schema)!==canonical(spec.manifest))throw fail('BACKUP_SCHEMA_UNSUPPORTED');
    if(manifest.migrationVersion!==Object.keys(spec.manifest.migrations).at(-1))throw fail('BACKUP_SCHEMA_UNSUPPORTED');
    if(!Array.isArray(manifest.ledgerHeads)||!manifest.ledgerHeads.length||new Set(manifest.ledgerHeads.map(h=>h.ledgerId)).size!==manifest.ledgerHeads.length||manifest.ledgerHeads.some(h=>typeof h.ledgerId!=='string'||!h.ledgerId||h.ledgerId.length>64||!Number.isSafeInteger(h.revision)||h.revision<0||!/^[a-f0-9]{64}$/.test(h.checksum))||!Number.isFinite(Date.parse(manifest.createdAt))||!/^[a-f0-9]{40}$/.test(manifest.applicationCommit))throw fail('BACKUP_INVALID_MANIFEST');
    if(manifest.storeId!==storeId||manifest.ledgerId!==ledgerId)throw fail('BACKUP_STORE_MISMATCH');
    if(manifest.engine!=='InnoDB'||!/^8\.4\./.test(manifest.mysqlVersion)||!['production','test'].includes(manifest.source?.environment)||!manifest.source.serverUuid||!manifest.source.database)throw fail('BACKUP_INVALID_MANIFEST');
    const bytes=await readFile(join(root,'data.json'));
    if(bytes.length!==manifest.dataBytes||digest(bytes)!==manifest.dataChecksum)throw fail('BACKUP_CHECKSUM_MISMATCH');
    const data=JSON.parse(bytes);
    if(data.backupFormatVersion!==FORMAT_VERSION||JSON.stringify(Object.keys(data.tables).sort())!==JSON.stringify([...spec.tables].sort()))throw fail('BACKUP_INVALID_DATA');
    for(const table of Object.values(data.tables)) {
      if(!Array.isArray(table.columns)||!table.columns.length||new Set(table.columns).size!==table.columns.length||table.columns.some(c=>!/^[a-z_]+$/.test(c))||!Array.isArray(table.rows))throw fail('BACKUP_INVALID_DATA');
      for(const row of table.rows){if(!Array.isArray(row)||row.length!==table.columns.length)throw fail('BACKUP_INVALID_DATA');row.forEach(unpack);}
    }
    const rows=name=>data.tables[name].rows.map(row=>Object.fromEntries(data.tables[name].columns.map((c,i)=>[c,unpack(row[i])])));
    const receipts=rows('production_bootstrap_events');if(!receipts.length||receipts.some(r=>r.store_id!==storeId||r.ledger_id!==ledgerId||r.environment!==manifest.source.environment))throw fail('BACKUP_STORE_MISMATCH');
    const heads=rows('ledger_heads');if(heads.length!==manifest.ledgerHeads.length||!heads.some(h=>h.ledger_id===ledgerId)||heads.some(h=>!manifest.ledgerHeads.some(m=>m.ledgerId===h.ledger_id&&m.revision===Number(h.revision)&&m.checksum===h.state_checksum)))throw fail('BACKUP_INVALID_MANIFEST');
    return {manifest,data,spec,checksum:expectedChecksum};
  }catch(e){throw fail(/^BACKUP_[A-Z_]+$/.test(e.code??'')?e.code:'BACKUP_INVALID_ARTIFACT');}
}
