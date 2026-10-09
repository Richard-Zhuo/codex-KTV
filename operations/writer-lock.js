import {open,readFile,lstat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
export async function acquireOperationalWriter(directory,scope){
 const path=join(directory,'operational-writer.lock');
 let handle;
 for(let n=0;n<2;n++){
  try{handle=await open(path,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid,scope}));await handle.sync();break;}
  catch(e){
   if(e.code!=='EEXIST')throw e;
   const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024)throw Error('OPERATIONAL_WRITER_LOCK_INVALID');
   const previous=JSON.parse(await readFile(path,'utf8'));
   if(previous.scope!==scope||!Number.isSafeInteger(previous.pid)||previous.pid<1)throw Error('OPERATIONAL_WRITER_LOCK_INVALID');
   let dead=false;try{process.kill(previous.pid,0);}catch(error){if(error.code==='ESRCH')dead=true;}
   if(!dead)throw Error('OPERATIONAL_WRITER_ALREADY_RUNNING');
   await unlink(path);
  }
 }
 if(!handle)throw Error('OPERATIONAL_WRITER_ALREADY_RUNNING');
 return async()=>{await handle.close();const current=JSON.parse(await readFile(path,'utf8'));if(current.pid===process.pid&&current.scope===scope)await unlink(path);};
}
