import {open,readFile,lstat,readdir,unlink,rename} from 'node:fs/promises';import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {externalDirectory} from '../backup/format.js';
export async function reportInvariant(directory,active){
 if(typeof active!=='boolean')throw Error('OPERATIONAL_SIGNAL_INVALID');
 const root=await externalDirectory(directory),target=join(root,'invariant-report-'+randomUUID()+'.json'),temporary=target+'.tmp';let file;
 try{file=await open(temporary,'wx',0o600);await file.writeFile(JSON.stringify({version:1,code:'DATA_INVARIANT_FAILURE',active,at:new Date().toISOString()}));await file.sync();await file.close();file=null;await rename(temporary,target);}
 finally{await file?.close();await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
export async function consumeInvariants(directory,consume){
 const names=(await readdir(directory)).filter(n=>/^invariant-report-[a-f0-9-]{36}\.json$/.test(n)).sort().slice(0,50),entries=[];let invalid=false;
 for(const name of names){try{const path=join(directory,name),s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size>512)throw Error('OPERATIONAL_SIGNAL_INVALID');const r=JSON.parse(await readFile(path,'utf8'));if(r.version!==1||r.code!=='DATA_INVARIANT_FAILURE'||typeof r.active!=='boolean'||!Number.isFinite(Date.parse(r.at))||Object.keys(r).some(k=>!['version','code','active','at'].includes(k)))throw Error('OPERATIONAL_SIGNAL_INVALID');entries.push({path,r});}catch{invalid=true;}}
 for(const {path,r}of entries.sort((a,b)=>Date.parse(a.r.at)-Date.parse(b.r.at))){await consume(r);await unlink(path);}
 if(invalid)throw Error('OPERATIONAL_SIGNAL_INVALID');
}
