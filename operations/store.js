import {open,readFile,rename,unlink,lstat,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const checksum=text=>createHash('sha256').update(text).digest('hex');
export async function createOperationalStore(directory,scope){
 const root=await realpath(directory),path=join(root,'operational-state.json');
 const check=async()=>{try{const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size>8*1024*1024)throw Error('OPERATIONAL_STATE_INVALID');}catch(e){if(e.code!=='ENOENT')throw e;}};
 const empty=()=>({version:1,scope,incidents:[],outbox:[],observations:{},auth:{},process:{running:false,crashes:[]}});
 await check();let state;
 try{const envelope=JSON.parse(await readFile(path,'utf8'));if(typeof envelope.data!=='string'||envelope.checksum!==checksum(envelope.data))throw Error('OPERATIONAL_STATE_INVALID');state=JSON.parse(envelope.data);if(state.version!==1||state.scope!==scope||!Array.isArray(state.incidents)||!Array.isArray(state.outbox)||!state.observations||!state.auth||!state.process)throw Error('OPERATIONAL_STATE_INVALID');}
 catch(e){if(e.code!=='ENOENT')throw Error('OPERATIONAL_STATE_INVALID');state=empty();}
 let serial=Promise.resolve();
 return {read:()=>structuredClone(state),update(work){
  const result=serial.then(async()=>{
   const next=structuredClone(state),value=await work(next),data=JSON.stringify(next);
   if(Buffer.byteLength(data)>7*1024*1024)throw Error('OPERATIONAL_STATE_CAPACITY');
   await check();const temporary=resolve(root,'operational-'+randomUUID()+'.tmp');
   let handle;try{handle=await open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify({checksum:checksum(data),data}));await handle.sync();await handle.close();handle=null;await rename(temporary,path);state=next;}
   finally{await handle?.close();await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
   return value;
  });serial=result.catch(()=>{});return result;
 },flush:()=>serial};
}
