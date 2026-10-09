import {open,readdir,readFile,unlink,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {externalDirectory} from '../backup/format.js';
// A protected, Git-external mailbox connects the existing backup CLI to the
// runtime without sharing incident-store ownership or carrying artifact paths.
export async function reportBackup(directory,{success,createdAt}){
 const root=await externalDirectory(directory);
 if(typeof success!=='boolean'||success&&(!createdAt||!Number.isFinite(Date.parse(createdAt))))throw Error('BACKUP_REPORT_INVALID');
 const report={version:1,success,at:new Date().toISOString(),...(success?{createdAt:new Date(createdAt).toISOString()}:{})};
 const handle=await open(join(root,'backup-report-'+randomUUID()+'.json'),'wx',0o600);
 try{await handle.writeFile(JSON.stringify(report));await handle.sync();}finally{await handle.close();}
}
export async function consumeBackupReports(directory,consume){
 const names=(await readdir(directory)).filter(n=>/^backup-report-[a-f0-9-]{36}\.json$/.test(n)).sort().slice(0,50),reports=[];
 for(const name of names){const path=join(directory,name),s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size>1024)throw Error('BACKUP_REPORT_INVALID');
  const r=JSON.parse(await readFile(path,'utf8'));
  if(r.version!==1||typeof r.success!=='boolean'||!Number.isFinite(Date.parse(r.at))||r.success&&!Number.isFinite(Date.parse(r.createdAt))||Object.keys(r).some(k=>!['version','success','at','createdAt'].includes(k)))throw Error('BACKUP_REPORT_INVALID');
  reports.push({path,r});
 }
 for(const {path,r}of reports.sort((a,b)=>Date.parse(a.r.at)-Date.parse(b.r.at))){await consume(r);await unlink(path);}
 return reports.length;
}
