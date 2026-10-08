import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { refused } from './plan.js';
export const schemaDigest = value => createHash('sha256').update(value).digest('hex');
export const normalizedDdl = value => value.replace(/ AUTO_INCREMENT=\d+/g,'').replace(/\r\n/g,'\n');
export async function validateSchema(connection, database) {
  const [[target]]=await connection.query('SELECT DATABASE() AS db, VERSION() AS version');
  if(target.db!==database || !/^8\.4\./.test(target.version)) throw refused('BOOTSTRAP_SCHEMA_MISMATCH');
  const manifest=JSON.parse(await readFile(new URL('./schema-manifest.json',import.meta.url),'utf8'));
  const files=(await readdir(new URL('../database/migrations/',import.meta.url))).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort();
  if(JSON.stringify(files)!==JSON.stringify(Object.keys(manifest.migrations))) throw refused('BOOTSTRAP_SCHEMA_MISMATCH');
  for(const file of files) {
    const source=await readFile(new URL('../database/migrations/'+file,import.meta.url),'utf8');
    if(schemaDigest(source.replace(/\r\n/g,'\n'))!==manifest.migrations[file]) throw refused('BOOTSTRAP_SCHEMA_MISMATCH');
  }
  const [tables]=await connection.execute('SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.tables WHERE TABLE_SCHEMA=?',[database]);
  if(tables.length!==Object.keys(manifest.tables).length) throw refused('BOOTSTRAP_SCHEMA_MISMATCH');
  for(const row of tables) {
    if(!Object.hasOwn(manifest.tables,row.name) || row.engine!=='InnoDB') throw refused('BOOTSTRAP_SCHEMA_MISMATCH');
    const [[ddl]]=await connection.query('SHOW CREATE TABLE '+String.fromCharCode(96)+row.name+String.fromCharCode(96));
    if(schemaDigest(normalizedDdl(ddl['Create Table']))!==manifest.tables[row.name]) throw refused('BOOTSTRAP_SCHEMA_MISMATCH');
  }
  return { migrations:files, tables:tables.length };
}
