import {createHash} from 'node:crypto';
import {readFile,lstat,realpath,readdir} from 'node:fs/promises';
import {resolve,sep,join} from 'node:path';

export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const roots=new Set(['auth','backup','database','devices','employees','http','ledger','operations','production','recovery','shared','ui','vouchers']);
export function runtimePath(path){
 if(typeof path!=='string'||!/^[A-Za-z0-9_./-]+$/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..')||/\.(test|integration)\.js$/.test(path))return false;
 if(['package.json','pnpm-lock.yaml','index.html','admin.html','style.css'].includes(path))return true;
 if(!path.includes('/'))return path.endsWith('.js');
 const root=path.split('/')[0];
 return roots.has(root)&&(/\.js$/.test(path)||path==='production/schema-manifest.json'||/^database\/migrations\/\d{3}_[a-z_]+\.sql$/.test(path));
}
// Shared by controlled extraction and installed backup admission. Trust comes
// from the caller's independently protected expectedChecksum and accepted commit.
export async function readAcceptedArtifact({artifact,expectedChecksum,commit}){
 if(typeof expectedChecksum!=='string'||!/^[a-f0-9]{64}$/.test(expectedChecksum)||typeof commit!=='string'||!/^[a-f0-9]{40}$/.test(commit))throw Error('ARTIFACT_IDENTITY_INVALID');
 const bytes=await readFile(artifact);if(sha(bytes)!==expectedChecksum)throw Error('ARTIFACT_CHECKSUM_MISMATCH');
 const data=JSON.parse(bytes);if(data?.format!==1||data.applicationCommit!==commit)throw Error('ARTIFACT_COMMIT_MISMATCH');
 if(!Array.isArray(data.files)||!data.files.length)throw Error('ARTIFACT_PATH_OR_CONTENT_INVALID');
 const seen=new Set();
 for(const file of data.files){const path=file?.path;
  if(typeof path!=='string'||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..')||(!runtimePath(path)&&!/^node_modules\/(?:@[a-z0-9_-]+\/)?[a-z0-9_.-]+\/[A-Za-z0-9_@.\/-]+$/.test(path))||seen.has(path)||typeof file.bytes!=='string'||sha(Buffer.from(file.bytes,'base64'))!==file.sha256)throw Error('ARTIFACT_PATH_OR_CONTENT_INVALID');
  seen.add(path);
 }
 return data;
}
export async function verifyInstalledArtifact(data,applicationRoot){
 const root=await realpath(applicationRoot);
 for(const file of data.files){
  const target=resolve(root,file.path);if(!target.startsWith(root+sep))throw Error('ARTIFACT_PATH_DENIED');
  let current=root;
  for(const part of file.path.split('/')){current=join(current,part);if((await lstat(current)).isSymbolicLink())throw Error('ARTIFACT_INSTALLED_CONTENT_INVALID');}
  if(!(await lstat(target)).isFile()||await realpath(target)!==target||sha(await readFile(target))!==file.sha256)throw Error('ARTIFACT_INSTALLED_CONTENT_INVALID');
 }
 const expected=new Set(data.files.map(file=>file.path));
 async function scan(directory,prefix=''){
  for(const entry of await readdir(directory,{withFileTypes:true})){
   const path=prefix+entry.name;
   if(entry.isSymbolicLink())throw Error('ARTIFACT_INSTALLED_CONTENT_INVALID');
   if(entry.isDirectory())await scan(join(directory,entry.name),path+'/');
   else if(!entry.isFile()||!expected.delete(path))throw Error('ARTIFACT_INSTALLED_CONTENT_INVALID');
  }
 }
 await scan(root);if(expected.size)throw Error('ARTIFACT_INSTALLED_CONTENT_INVALID');
 return data.applicationCommit;
}
