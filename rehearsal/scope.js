import {lstat,readFile,realpath,rm,readdir,unlink,rmdir} from 'node:fs/promises';import {dirname,resolve,basename} from 'node:path';import {tmpdir} from 'node:os';
export function scopeNames(id){if(!/^[a-f0-9]{16}$/.test(id))throw Error('REHEARSAL_ID_INVALID');return {id,storeId:'REHEARSAL-STORE-'+id,ledgerId:'REHEARSAL-LEDGER-'+id,rootName:'ktv-stage5e-'+id,database:'jbhh_ktv_test',entryDatabase:'jbhh_ktv_restore_s5e_entry_'+id,failureDatabase:'jbhh_ktv_restore_s5e_failure_'+id};}
export async function assertOwnedRoot(root,id){
 const names=scopeNames(id),path=resolve(root),st=await lstat(path);
 if(st.isSymbolicLink()||!st.isDirectory()||dirname(path)!==resolve(tmpdir())||basename(path)!==names.rootName||await realpath(path)!==path)throw Error('REHEARSAL_PATH_DENIED');
 const marker=JSON.parse(await readFile(resolve(path,'rehearsal-owner.json'),'utf8'));
 if(marker.id!==id||marker.kind!=='synthetic-cutover-rehearsal')throw Error('REHEARSAL_OWNER_REQUIRED');
 return path;
}
export async function removeOwnedRoot(root,id){const path=await assertOwnedRoot(root,id);for(const name of await readdir(path)){if(name==='rehearsal-owner.json')continue;await rm(resolve(path,name),{recursive:true,force:false,maxRetries:20,retryDelay:100});}await unlink(resolve(path,'rehearsal-owner.json'));await rmdir(path);}
export function assertOwnedDatabase(name,names,registered){if(!registered.has(name)||!(name===names.database||name.startsWith('jbhh_ktv_restore_s5e_')&&name.endsWith('_'+names.id))||!/^[a-z][a-z0-9_]{0,63}$/.test(name))throw Error('REHEARSAL_DATABASE_DENIED');}
