import {open,readFile,lstat,realpath,mkdir,rename,unlink} from 'node:fs/promises';import {join,resolve} from 'node:path';import {randomUUID} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {canonical,digest} from '../backup/format.js';import {canonicalProtectedPath} from '../recovery/production-authorization-context.js';import {windowsFileAcl,validateRuntimeFileAclStructure} from './runtime-config.js';import {windowsDirectoryAcl} from './wecom-smoke-config.js';import {validProcess} from './process-observation.js';
const exec=promisify(execFile),SYSTEM='S-1-5-18',ADMIN='S-1-5-32-544';
export const activationFailure=(step='VERIFY',causeCode='NOT_PROVEN',nativeCode=null)=>Object.assign(Error('RUNTIME_ACTIVATION_NOT_PROVEN'),{code:'RUNTIME_ACTIVATION_NOT_PROVEN',cause:Object.freeze({step:['VERIFY','READ_OWNER','BUILD_DACL','PERSIST_DACL','INITIALIZE','PUBLISH'].includes(step)?step:'VERIFY',causeCode:['NOT_PROVEN','OWNER_MISMATCH','ACCESS_DENIED','ACL_OPERATION_FAILED','EACCES','EPERM','ENOENT','EEXIST'].includes(causeCode)?causeCode:'NOT_PROVEN',nativeCode:Number.isInteger(nativeCode)&&nativeCode>=0&&nativeCode<=65535?nativeCode:null})});
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function validateActivationReceipt(v){
 if(!exact(v,['version','processId','processCreatedAt','deploymentConfigFingerprint','databaseIdentity','recoveryOperationId','planDigest','activation'])||v.version!==1||v.activation!=='RUNNING'||!validProcess({pid:v.processId,createdAt:v.processCreatedAt})||!hash(v.deploymentConfigFingerprint)||!hash(v.planDigest)||typeof v.recoveryOperationId!=='string'||!/^[a-f0-9-]{36}$/.test(v.recoveryOperationId))throw activationFailure();
 const d=v.databaseIdentity;if(!exact(d,['host','port','name','serverUuid'])||typeof d.host!=='string'||!d.host||d.host.length>253||!Number.isInteger(d.port)||d.port<1||d.port>65535||typeof d.name!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(d.name)||typeof d.serverUuid!=='string'||!/^[a-f0-9-]{36}$/.test(d.serverUuid)||Buffer.byteLength(canonical(v))>8192)throw activationFailure();
 return Object.freeze({...v,databaseIdentity:Object.freeze({...d})});
}
export const receiptDigest=v=>digest(canonical(validateActivationReceipt(v)));
export function validateActivationAcl(acl,sid,{directory=false,producer=false}={}){
 const allowed=new Set([sid,SYSTEM,ADMIN]),READ=directory?131241:131209,WRITE=197055,FORBIDDEN=342; // write/append/EA/attributes/delete plus security rights below
 if(!acl?.protected||![sid,SYSTEM].includes(acl.owner)||!Array.isArray(acl.rules)||producer&&acl.current!==sid||acl.rules.some(r=>r.type!=='Allow'||!allowed.has(r.sid))||!acl.rules.some(r=>r.sid===sid&&(r.rights&WRITE)===WRITE)||!acl.rules.some(r=>r.sid===ADMIN&&(r.rights&READ)===READ)||acl.rules.some(r=>r.sid===ADMIN&&(r.rights&(FORBIDDEN|65536|262144|524288))))throw activationFailure();
 if(directory&&!acl.rules.some(r=>r.sid===sid&&String(r.inheritance??'').includes('ObjectInherit')))throw activationFailure();
}
// Existing owner is verified, never changed by the runtime operational path.
export function activationAclScript(path,sid,directory=false){
 if(!/^S-1-5-(?:\d+-)*\d+$/.test(sid))throw activationFailure();
 const p=Buffer.from(path).toString('base64'),kind=directory?'Directory':'File';
 return "$ErrorActionPreference='Stop';$step='READ_OWNER';$cause='ACL_OPERATION_FAILED';try{$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+p+"'));$owner=[IO."+kind+"]::GetAccessControl($p).GetOwner([Security.Principal.SecurityIdentifier]).Value;if($owner -ne '"+sid+"' -and $owner -ne 'S-1-5-18'){$cause='OWNER_MISMATCH';throw 'OWNER_MISMATCH'};$step='BUILD_DACL';$a=[Security.AccessControl."+(directory?'DirectorySecurity':'FileSecurity')+"]::new();$a.SetAccessRuleProtection($true,$false);foreach($r in @(@('"+sid+"',197055),@('S-1-5-18',2032127),@('S-1-5-32-544',"+(directory?'131241':'131209')+"))){$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($r[0]),[Security.AccessControl.FileSystemRights]$r[1],"+(directory?"[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'":"[Security.AccessControl.InheritanceFlags]::None")+",[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))};$step='PERSIST_DACL';[IO."+kind+"]::SetAccessControl($p,$a);@{ok=$true}|ConvertTo-Json -Compress}catch{$e=$_.Exception.GetBaseException();$native=$null;if($e.HResult -eq -2147024891){$cause='ACCESS_DENIED';$native=5};@{ok=$false;step=$step;causeCode=$cause;nativeCode=$native}|ConvertTo-Json -Compress}";
}
export async function protectActivationPath(path,sid,directory=false){
 if(process.platform!=='win32')throw activationFailure();
 let result;try{const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(activationAclScript(path,sid,directory),'utf16le').toString('base64')],{windowsHide:true,timeout:5000,maxBuffer:4096});result=JSON.parse(stdout);}catch{throw activationFailure('PERSIST_DACL','ACL_OPERATION_FAILED');}
 if(result?.ok!==true)throw activationFailure(result?.step,result?.causeCode,result?.nativeCode);
}
export function activationPaths(loaded){const parent=resolve(loaded.config.logDirectory);return {parent,directory:join(parent,'runtime-activation'),file:join(parent,'runtime-activation','current.json')};}
export function createActivationReceiptStore(loaded,{fileAcl=windowsFileAcl,directoryAcl=windowsDirectoryAcl,protect=protectActivationPath,move=rename}={}){
 const paths=activationPaths(loaded),sid=loaded.config.serviceAccountSid;
 async function checkDirectory(producer=false){await canonicalProtectedPath(paths.parent,{directory:true});validateRuntimeFileAclStructure(await directoryAcl(paths.parent),sid);await canonicalProtectedPath(paths.directory,{directory:true});validateActivationAcl(await directoryAcl(paths.directory),sid,{directory:true,producer});}
 async function checkFile(path,producer=false){await canonicalProtectedPath(path);const s=await lstat(path);if(s.size>8192||await realpath(path)!==resolve(path))throw activationFailure();validateActivationAcl(await fileAcl(path),sid,{producer});}
 async function read(){try{await checkDirectory();await checkFile(paths.file);const v=validateActivationReceipt(JSON.parse(await readFile(paths.file,'utf8')));await checkFile(paths.file);return v;}catch{throw activationFailure();}}
 async function invalidate(){await checkDirectory(true);try{await lstat(paths.file);}catch(e){if(e.code==='ENOENT')return;throw activationFailure();}await checkFile(paths.file,true);await unlink(paths.file);}
 return Object.freeze({read,invalidate,
  async initialize(){await canonicalProtectedPath(paths.parent,{directory:true});validateRuntimeFileAclStructure(await directoryAcl(paths.parent),sid);try{await mkdir(paths.directory);await protect(paths.directory,sid,true);}catch(e){if(e.code!=='EEXIST')throw e.code==='RUNTIME_ACTIVATION_NOT_PROVEN'?e:activationFailure('INITIALIZE',e.code);}await checkDirectory(true);await invalidate();},
  async publish(value){const v=validateActivationReceipt(value),bytes=canonical(v);await checkDirectory(true);const temp=join(paths.directory,'activation-'+randomUUID()+'.tmp');let created=false,moved=false;
   try{const f=await open(temp,'wx',0o600);created=true;try{await protect(temp,sid);await checkFile(temp,true);await f.writeFile(bytes);await f.sync();}finally{await f.close();}await checkFile(temp,true);await checkDirectory(true);await move(temp,paths.file);moved=true;if(canonical(await read())!==bytes)throw activationFailure();return receiptDigest(v);}catch(e){throw e.code==='RUNTIME_ACTIVATION_NOT_PROVEN'?e:activationFailure('PUBLISH',e.code);}finally{if(created&&!moved)await unlink(temp).catch(()=>{});}
  }
 });
}
