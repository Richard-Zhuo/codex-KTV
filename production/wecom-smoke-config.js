import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath,lstat,readdir,unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readExternalSecret } from './secret-file.js';
import { windowsFileAcl } from './runtime-config.js';
import { validateWeComConfig } from '../operations/wecom.js';
import { externalDirectory } from '../backup/format.js';

const exec=promisify(execFile);
const fail=code=>Object.assign(Error(code),{code});
const keys=['configVersion','storeLabel','corpId','agentId','secret','criticalRecipients','warnRecipients'];
const SYSTEM='S-1-5-18',ADMIN='S-1-5-32-544';
const WINDOWS_MODIFY=197055; // FileSystemRights.Modify: read, create/write, and delete.

export function validateSmokeConfig(input){
  try{
    if(!input||typeof input!=='object'||Array.isArray(input)||
      Object.keys(input).length!==keys.length||keys.some(key=>!Object.hasOwn(input,key))||
      input.configVersion!==1)throw Error();
    const config=validateWeComConfig(input);
    const a=config.criticalRecipients,b=config.warnRecipients;
    if(a.length!==1||b.length!==1||a[0]!==b[0]||
      ['all','department','broadcast'].includes(a[0].toLowerCase()))throw Error();
    return config;
  }catch{throw fail('SMOKE_CONFIG_INVALID');}
}

export function validateSmokeAcl(acl,{directory=false}={}){
  const operator=acl?.current,trusted=new Set([operator,SYSTEM,ADMIN]);
  if(typeof operator!=='string'||!/^S-1-5-(?:\d+-)*\d+$/.test(operator)||
    trusted.size!==3||!acl.protected||!trusted.has(acl.owner)||
    !Array.isArray(acl.rules)||acl.rules.some(r=>r.type==='Allow'&&!trusted.has(r.sid))||
    !acl.rules.some(r=>r.type==='Allow'&&r.sid===operator&&(r.rights&1)&&
      (!directory||((r.rights&WINDOWS_MODIFY)===WINDOWS_MODIFY&&String(r.inheritance??'').includes('ObjectInherit')))))throw fail('SMOKE_ACL_DENIED');
}

export async function windowsDirectoryAcl(path){
  if(process.platform!=='win32')throw fail('SMOKE_PLATFORM_UNSUPPORTED');
  const encoded=Buffer.from(path,'utf8').toString('base64');
  const script="$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encoded+"'));$a=[IO.Directory]::GetAccessControl($p);$rules=@($a.Access|ForEach-Object{@{sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;type=$_.AccessControlType.ToString();rights=[int]$_.FileSystemRights;inheritance=$_.InheritanceFlags.ToString()}});@{protected=$a.AreAccessRulesProtected;owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;rules=$rules}|ConvertTo-Json -Compress -Depth 4";
  try{
    const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:5000,maxBuffer:65536});
    return JSON.parse(stdout.trim());
  }catch{throw fail('SMOKE_ACL_UNVERIFIED');}
}

export async function loadSmokeConfig(path,{read=readExternalSecret,fileAcl=windowsFileAcl}={}){
  const file=await realpath(path);
  validateSmokeAcl(await fileAcl(file));
  return validateSmokeConfig(await read(file));
}

export async function validateSmokeStateFile(directory,{fileAcl=windowsFileAcl,required=false}={}){
  const path=join(directory,'operational-state.json');
  let actual;
  try{
    const info=await lstat(path);
    if(!info.isFile()||info.isSymbolicLink())throw fail('SMOKE_STATE_FILE_UNVERIFIED');
    actual=await realpath(path);
  }catch(error){
    if(error.code==='ENOENT'&&!required)return;
    throw fail('SMOKE_STATE_FILE_UNVERIFIED');
  }
  try{validateSmokeAcl(await fileAcl(actual));}
  catch(error){throw fail(error.code==='SMOKE_ACL_DENIED'?error.code:'SMOKE_STATE_FILE_UNVERIFIED');}
}
export async function validateSmokeStateDirectory(path,{directoryAcl=windowsDirectoryAcl,fileAcl=windowsFileAcl}={}){
  const directory=await externalDirectory(path);
  validateSmokeAcl(await directoryAcl(directory),{directory:true});
  await validateSmokeStateFile(directory,{fileAcl});
  return directory;
}

// Protect the same-directory temporary file before any state bytes are written.
export async function hardenSmokeTemporary(path,{fileAcl=windowsFileAcl,run=exec}={}){
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink())throw fail('SMOKE_STATE_TEMP_UNVERIFIED');
  if(process.platform!=='win32')throw fail('SMOKE_PLATFORM_UNSUPPORTED');
  const encoded=Buffer.from(path,'utf8').toString('base64');
  const script="$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encoded+"'));$a=[IO.File]::GetAccessControl($p);$a.SetAccessRuleProtection($true,$true);[IO.File]::SetAccessControl($p,$a)";
  try{await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',
    Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:5000,maxBuffer:65536});}
  catch{throw fail('SMOKE_STATE_TEMP_UNVERIFIED');}
  validateSmokeAcl(await fileAcl(path));
}

// The writer lock is held when this is called. A crashed write is never loaded as state.
export async function cleanupSmokeTemps(directory,{harden=hardenSmokeTemporary}={}){
  for(const name of await readdir(directory)){
    if(!/^operational-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.tmp$/i.test(name))continue;
    const path=join(directory,name),info=await lstat(path);
    if(!info.isFile()||info.isSymbolicLink())throw fail('SMOKE_STATE_TEMP_UNVERIFIED');
    await harden(path);
    await unlink(path);
  }
}
