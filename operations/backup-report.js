import {open,readdir,readFile,unlink,lstat,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {externalDirectory} from '../backup/format.js';
// A protected, Git-external mailbox connects the existing backup CLI to the
// runtime without sharing incident-store ownership or carrying artifact paths.
export async function reportBackup(directory,{success,createdAt}){
 const root=await externalDirectory(directory);
 if(typeof success!=='boolean'||success&&(!createdAt||!Number.isFinite(Date.parse(createdAt))))throw Error('BACKUP_REPORT_INVALID');
 const report={version:1,success,at:new Date().toISOString(),...(success?{createdAt:new Date(createdAt).toISOString()}:{})};
 const target=join(root,'backup-report-'+randomUUID()+'.json'),temporary=target+'.tmp';let handle;
 try{handle=await open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify(report));await handle.sync();await handle.close();handle=null;await rename(temporary,target);}
 finally{await handle?.close();await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
export async function consumeBackupReports(directory,consume){
 const names=(await readdir(directory)).filter(n=>/^backup-report-[a-f0-9-]{36}\.json$/.test(n)).sort().slice(0,50),reports=[];let invalid=false;
 for(const name of names){try{const path=join(directory,name),s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size>1024)throw Error('BACKUP_REPORT_INVALID');
  const r=JSON.parse(await readFile(path,'utf8'));
  if(r.version!==1||typeof r.success!=='boolean'||!Number.isFinite(Date.parse(r.at))||r.success&&!Number.isFinite(Date.parse(r.createdAt))||Object.keys(r).some(k=>!['version','success','at','createdAt'].includes(k)))throw Error('BACKUP_REPORT_INVALID');
  reports.push({path,r});
 }catch{invalid=true;}}
 for(const {path,r}of reports.sort((a,b)=>Date.parse(a.r.at)-Date.parse(b.r.at))){await consume(r);await unlink(path);}
 if(invalid)throw Error('BACKUP_REPORT_INVALID');
 return reports.length;
}
