// Same OS creation-time representation for SCM and the runtime's own process.
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {isIP} from 'node:net';
const exec=promisify(execFile);const fail=()=>Object.assign(Error('RUNTIME_ACTIVATION_OS_UNVERIFIED'),{code:'RUNTIME_ACTIVATION_OS_UNVERIFIED'});
export const PROCESS_CREATED_AT="$p.CreationDate.ToUniversalTime().ToString('o')";
export function validProcess(p){return Number.isSafeInteger(p?.pid)&&p.pid>0&&typeof p.createdAt==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,7}Z$/.test(p.createdAt)&&Number.isFinite(Date.parse(p.createdAt));}
async function query(script){if(process.platform!=='win32')throw fail();try{const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop';"+script,'utf16le').toString('base64')],{windowsHide:true,timeout:5000,maxBuffer:32768});return JSON.parse(stdout);}catch{throw fail();}}
export async function ownProcessIdentity(){const p=await query('$p=Get-CimInstance Win32_Process -Filter "ProcessId='+process.pid+'";if(!$p){throw "MISSING"};@{pid=[int]$p.ProcessId;createdAt='+PROCESS_CREATED_AT+'}|ConvertTo-Json -Compress');if(!validProcess(p)||p.pid!==process.pid)throw fail();return Object.freeze(p);}
export async function observeListener(port,pid){
 if(!Number.isInteger(port)||port<1024||port>65535||!Number.isSafeInteger(pid)||pid<1)throw fail();
 const rows=await query('@(Get-NetTCPConnection -State Listen -LocalPort '+port+'|ForEach-Object{@{host=$_.LocalAddress;port=[int]$_.LocalPort;pid=[int]$_.OwningProcess}})|ConvertTo-Json -Compress');
 const a=Array.isArray(rows)?rows:[rows];if(a.length!==1||a[0].pid!==pid||a[0].port!==port||!isIP(a[0].host)||['0.0.0.0','::'].includes(a[0].host))throw fail();return Object.freeze(a[0]);
}
