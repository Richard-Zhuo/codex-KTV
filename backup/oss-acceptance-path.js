// Fixed lab bootstrap only. Import/validate-only does not read this script or invoke Windows.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
const exec=promisify(execFile);
const fail=()=>Object.assign(Error('OSS_ACCEPTANCE_ROOT_DENIED'),{code:'OSS_ACCEPTANCE_ROOT_DENIED'});
export const OSS_ACCEPTANCE_ROOT='C:\\ProgramData\\JbhhKtv\\private\\oss-acceptance';
export const OSS_ACCEPTANCE_FILES=Object.freeze({CONFIG:OSS_ACCEPTANCE_ROOT+'\\config.json',READ:OSS_ACCEPTANCE_ROOT+'\\read.json',WRITE:OSS_ACCEPTANCE_ROOT+'\\write.json'});
export async function readOssAcceptanceFixed(operation){
 try{
  if(process.platform!=='win32'||!['CONFIG','READ','WRITE','ROOT'].includes(operation))throw fail();
  const source=await readFile(new URL('./oss-acceptance-root.ps1',import.meta.url),'utf8');
  const script=source+"\nInvoke-OssFixedRead '"+operation+"'";
  const {stdout,stderr}=await exec('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
   ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000,maxBuffer:100000});
  if(stderr?.trim())throw fail();
  if(operation==='ROOT'){if(!/^ROOT_OK\r?\n?$/.test(stdout))throw fail();return OSS_ACCEPTANCE_ROOT;}
  const match=/^DATA:([A-Za-z0-9+/]+={0,2})\r?\n?$/.exec(stdout);
  if(!match)throw fail();const bytes=Buffer.from(match[1],'base64');
  if(bytes.length>65536||bytes.toString('base64')!==match[1])throw fail();
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }catch{throw fail();}
}
