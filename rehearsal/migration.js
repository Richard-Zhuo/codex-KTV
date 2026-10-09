import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export async function migrateFresh(connection,applicationRoot,{failAfterFile}={}){
 const manifest=JSON.parse(await readFile(new URL('production/schema-manifest.json',applicationRoot),'utf8'));
 const [existing]=await connection.query('SHOW TABLES');if(existing.length)throw Error('MIGRATION_TARGET_NOT_EMPTY');
 const applied=[];
 for(const [name,checksum]of Object.entries(manifest.migrations)){
  const source=(await readFile(new URL('database/migrations/'+name,applicationRoot),'utf8')).replace(/\r\n/g,'\n');
  if(createHash('sha256').update(source).digest('hex')!==checksum)throw Error('MIGRATION_SOURCE_MISMATCH');
  for(const sql of source.split('\n').filter(l=>!l.trim().startsWith('--')).join('\n').split(';').map(s=>s.trim()).filter(Boolean))await connection.query(sql);
  applied.push(name);
  if(name===failAfterFile)throw Error('REHEARSAL_MIGRATION_FAILURE');
 }
 return {migrations:applied,last:applied.at(-1),forwardOnly:true};
}
