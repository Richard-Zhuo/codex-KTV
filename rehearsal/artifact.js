import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {readFile,writeFile,readdir,lstat,realpath,mkdir} from 'node:fs/promises';import {resolve,dirname,relative,sep} from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
import {externalDirectory} from '../backup/format.js';
const run=promisify(execFile);export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const roots=new Set(['auth','backup','database','devices','employees','http','ledger','operations','production','recovery','shared','ui','vouchers']);
export function runtimePath(path){
 if(!/^[A-Za-z0-9_./-]+$/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..')||/\.(test|integration)\.js$/.test(path))return false;
 if(['package.json','pnpm-lock.yaml','index.html','admin.html','style.css'].includes(path))return true;
 if(!path.includes('/'))return path.endsWith('.js');
 const root=path.split('/')[0];
 return roots.has(root)&&(/\.js$/.test(path)||path==='production/schema-manifest.json'||/^database\/migrations\/\d{3}_[a-z_]+\.sql$/.test(path));
}
export async function packageAccepted({repository,commit,acceptedCommits,output,dependencyRoot=repository}){
 if(!/^[a-f0-9]{40}$/.test(commit)||!Array.isArray(acceptedCommits)||!acceptedCommits.includes(commit))throw Error('ARTIFACT_COMMIT_NOT_ACCEPTED');
 await externalDirectory(dirname(output));
 const git=async args=>(await run('git',args,{cwd:repository,encoding:'utf8',maxBuffer:32*1024*1024,windowsHide:true})).stdout;
 if((await git(['status','--porcelain=v1'])).trim())throw Error('ARTIFACT_DIRTY_TREE');
 // An accepted commit must be in the stable main history, regardless of checkout branch.
 await git(['merge-base','--is-ancestor',commit,'main']);
 const entries=(await git(['ls-tree','-r',commit])).trim().split('\n').map(line=>{const [meta,path]=line.split('\t');return {mode:meta.split(' ')[0],oid:meta.split(' ')[2],path};}).filter(e=>runtimePath(e.path));
 if(entries.some(e=>e.mode!=='100644'&&e.mode!=='100755'))throw Error('ARTIFACT_LINK_DENIED');
 const files=[];
 for(const e of entries){const {stdout}=await run('git',['cat-file','blob',e.oid],{cwd:repository,encoding:'buffer',maxBuffer:4*1024*1024,windowsHide:true});files.push({path:e.path,bytes:stdout.toString('base64'),sha256:sha(stdout)});}
 const lock=Buffer.from(files.find(e=>e.path==='pnpm-lock.yaml').bytes,'base64').toString('utf8');
 const require=createRequire(resolve(dependencyRoot,'package.json')),dependencies=[],seen=new Map();
 async function dependency(name,fromRequire){
  let packagePath;
  try{packagePath=fromRequire.resolve(name+'/package.json');}catch{let dir=dirname(fromRequire.resolve(name));for(;;){try{const candidate=resolve(dir,'package.json');if(JSON.parse(await readFile(candidate,'utf8')).name===name){packagePath=candidate;break;}}catch{}const parent=dirname(dir);if(parent===dir)throw Error('ARTIFACT_DEPENDENCY_MISSING');dir=parent;}}
  const packageRoot=await realpath(dirname(packagePath)),info=JSON.parse(await readFile(packagePath,'utf8'));
  if(seen.has(info.name)){if(seen.get(info.name)!==info.version)throw Error('ARTIFACT_DEPENDENCY_VERSION_CONFLICT');return;}seen.set(info.name,info.version);
  if(info.name!==name||!lock.includes(name+'@'+info.version+':')&&!lock.includes(name+'@'+info.version+'('))throw Error('ARTIFACT_DEPENDENCY_NOT_LOCKED');
  dependencies.push({name,version:info.version});
  async function walk(dir){
   for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.name==='node_modules'||entry.name.startsWith('.'))continue;const full=resolve(dir,entry.name),st=await lstat(full);if(st.isSymbolicLink())throw Error('ARTIFACT_DEPENDENCY_LINK_DENIED');if(st.isDirectory())await walk(full);else if(st.isFile()){const bytes=await readFile(full),path='node_modules/'+name+'/'+relative(packageRoot,full).split(sep).join('/');files.push({path,bytes:bytes.toString('base64'),sha256:sha(bytes)});}}
  }
  await walk(packageRoot);
  const next=createRequire(packagePath);for(const child of Object.keys(info.dependencies??{}))await dependency(child,next);
 }
 await dependency('mysql2',require);files.sort((a,b)=>a.path.localeCompare(b.path));
 const manifest={format:1,applicationCommit:commit,lockChecksum:sha(lock),node:process.versions.node,dependencies:dependencies.sort((a,b)=>a.name.localeCompare(b.name)),files};
 const bytes=Buffer.from(JSON.stringify(manifest));await writeFile(output,bytes,{flag:'wx',mode:0o600});return {commit,sha256:sha(bytes),files:files.length,dependencies:manifest.dependencies};
}
export async function unpackAccepted({artifact,expectedChecksum,commit,destination}){
 const bytes=await readFile(artifact);if(sha(bytes)!==expectedChecksum)throw Error('ARTIFACT_CHECKSUM_MISMATCH');
 const data=JSON.parse(bytes);if(data.format!==1||data.applicationCommit!==commit)throw Error('ARTIFACT_COMMIT_MISMATCH');
 const seen=new Set();
 for(const file of data.files){const path=file.path;
  if(typeof path!=='string'||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..')||(!runtimePath(path)&&!/^node_modules\/(?:@[a-z0-9_-]+\/)?[a-z0-9_.-]+\/[A-Za-z0-9_@.\/-]+$/.test(path))||seen.has(path)||sha(Buffer.from(file.bytes,'base64'))!==file.sha256)throw Error('ARTIFACT_PATH_OR_CONTENT_INVALID');
  seen.add(path);
 }
 await mkdir(destination);const root=await realpath(destination);
 for(const file of data.files){const target=resolve(root,file.path);if(!target.startsWith(root+sep))throw Error('ARTIFACT_PATH_DENIED');await mkdir(dirname(target),{recursive:true});await writeFile(target,Buffer.from(file.bytes,'base64'),{flag:'wx',mode:0o600});}
 return {commit,sha256:expectedChecksum,files:data.files.length};
}
