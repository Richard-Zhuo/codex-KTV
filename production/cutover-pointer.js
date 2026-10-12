import {randomUUID} from 'node:crypto';
import {dirname,join} from 'node:path';
import {lstat,realpath,open,rename,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readExternalSecret} from './secret-file.js';
import {windowsFileAcl,validateFileAcl} from './runtime-config.js';
import {canonical,fail} from '../backup/format.js';

const exec=promisify(execFile);
const safeName=name=>typeof name==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(name);
const inspect=async(path,sid,fileAcl)=>{
 const info=await lstat(path);
 if(!info.isFile()||info.isSymbolicLink()||info.size>65536||await realpath(path)!==path)
  throw fail('PRODUCTION_CUTOVER_CONFIG_INVALID');
 validateFileAcl(await fileAcl(path),sid);
};
// Copy the existing protected DACL/owner to the empty same-directory temp before secrets are written.
export async function hardenCutoverTemp(temp,source){
 if(process.platform!=='win32')throw fail('PRODUCTION_CUTOVER_CONFIG_INVALID');
 const a=Buffer.from(source,'utf8').toString('base64');
 const b=Buffer.from(temp,'utf8').toString('base64');
 const script="$ErrorActionPreference='Stop';$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+a+"'));$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+b+"'));[IO.File]::SetAccessControl($t,[IO.File]::GetAccessControl($s))";
 try{await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',
  Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:5000,maxBuffer:65536});}
 catch{throw fail('PRODUCTION_CUTOVER_CONFIG_INVALID');}
}
export async function updateProtectedDatabasePointer(loaded,plan,{
 read=readExternalSecret,fileAcl=windowsFileAcl,harden=hardenCutoverTemp,
 move=rename,beforeMove}={}){
 const sid=loaded.config.serviceAccountSid,configured=loaded.config.secretsFile;
 if(!safeName(plan.currentDatabase)||!safeName(plan.targetDatabase)||
    plan.currentDatabase===plan.targetDatabase||!configured)
  throw fail('PRODUCTION_CUTOVER_CONFIG_INVALID');
 // A new target is never selected from the operator's command line.
 const path=await realpath(configured);
 await inspect(path,sid,fileAcl);
 const prior=await read(path);
 if(prior?.database?.name!==plan.currentDatabase)
  throw fail('PRODUCTION_CUTOVER_POINTER_CONFLICT');
 const next={...prior,database:{...prior.database,name:plan.targetDatabase}};
 const original=canonical(prior),replacement=canonical(next);
 if(Buffer.byteLength(replacement)>65536)throw fail('PRODUCTION_CUTOVER_CONFIG_INVALID');
 const temp=join(dirname(path),'cutover-secret-'+randomUUID()+'.tmp');
 let moved=false,created=false;
 try{
  const file=await open(temp,'wx',0o600);created=true;
  try{await harden(temp,path);await inspect(temp,sid,fileAcl);
   await file.writeFile(replacement);await file.sync();
  }finally{await file.close();}
  await inspect(temp,sid,fileAcl);
  await beforeMove?.();
  await inspect(path,sid,fileAcl);
  if(canonical(await read(path))!==original)
   throw fail('PRODUCTION_CUTOVER_POINTER_CONFLICT');
  await move(temp,path);moved=true;
  await inspect(path,sid,fileAcl);
  const final=await read(path);
  if(canonical(final)!==replacement||final.database.name!==plan.targetDatabase)
   throw fail('PRODUCTION_CUTOVER_CONFIG_INVALID');
  return {before:plan.currentDatabase,after:plan.targetDatabase,atomic:true,
   aclPreserved:true,secretsPreserved:true};
 }finally{if(created&&!moved)await rm(temp,{force:true});}
}
