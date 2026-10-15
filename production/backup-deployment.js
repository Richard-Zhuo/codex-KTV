import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath,lstat} from 'node:fs/promises';
import {isAbsolute,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {externalDirectory} from '../backup/format.js';
import {windowsFileAcl,validateFileAcl} from './runtime-config.js';
const exec=promisify(execFile);
const administrators=['S-1-5-18','S-1-5-32-544'];
const deniedWrites=2|4|16|64|256|65536|262144|524288|0x40000000|0x10000000;
const reject=()=>{throw Error('BACKUP_DEPLOYMENT_UNVERIFIED');};
// Pure checks only. The production reader obtains these facts exclusively from SCM.
export function validateBackupRegistration(s){
 if(s?.name!=='JbhhKtv'||s.startName!=='NT SERVICE\\JbhhKtv'||
    !/^S-1-5-(?:\d+-)*\d+$/.test(s.serviceSid)||administrators.includes(s.serviceSid)||
    !Array.isArray(s.argv)||s.argv.length!==7||s.argv[1]!=='--node'||s.argv[3]!=='--entry'||s.argv[5]!=='--config'||
    [0,2,4,6].some(i=>typeof s.argv[i]!=='string'||!isAbsolute(s.argv[i])||/["\r\n]/.test(s.argv[i])))reject();
 return {serviceSid:s.serviceSid,host:s.argv[0],node:s.argv[2],entry:s.argv[4],runtimeConfigFile:s.argv[6],backupConfigFile:join(dirname(s.argv[6]),'backup.json')};
}
export function validateBackupAnchorAcl(acl,sid){
 validateFileAcl(acl,sid);
 if(!administrators.includes(acl.owner)||acl.rules.some(r=>r.type==='Allow'&&r.sid===sid&&(r.rights&deniedWrites)))reject();
}
async function canonicalFile(path){
 if(await realpath(path)!==path)reject();
 const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())reject();
 return path;
}
export async function readBackupDeployment(){
 if(process.platform!=='win32')reject();
 // Fixed OS executable and fixed installed service: neither PATH nor CLI chooses authority.
 const script=String.raw`$ErrorActionPreference='Stop';
# JBHH_BACKUP_DEPLOYMENT_REGISTRATION
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class KtvBackupArgv{[DllImport("shell32.dll",SetLastError=true)]static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)]string s,out int n);[DllImport("kernel32.dll")]static extern IntPtr LocalFree(IntPtr p);public static string[] Parse(string s){int n;var p=CommandLineToArgvW(s,out n);if(p==IntPtr.Zero)throw new Exception();try{var a=new string[n];for(int i=0;i<n;i++)a[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size));return a;}finally{LocalFree(p);}}}'
Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\CimCmdlets\CimCmdlets.psd1' -ErrorAction Stop
$s=CimCmdlets\Get-CimInstance Win32_Service -Filter "Name='JbhhKtv'";if(!$s -or $s.StartName -ne 'NT SERVICE\JbhhKtv'){throw 'SERVICE'}
$sid=([Security.Principal.NTAccount]::new($s.StartName)).Translate([Security.Principal.SecurityIdentifier]).Value
@{name=$s.Name;startName=$s.StartName;serviceSid=$sid;argv=@([KtvBackupArgv]::Parse($s.PathName))}|ConvertTo-Json -Compress -Depth 4`;
 const {stdout}=await exec('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000,maxBuffer:65536});
 const binding=validateBackupRegistration(JSON.parse(stdout));
 for(const path of [binding.host,binding.node,binding.entry,binding.runtimeConfigFile])await canonicalFile(path);
 const root=await externalDirectory(fileURLToPath(new URL('../',import.meta.url)));
 if(binding.node!==await realpath(process.execPath)||binding.entry!==join(root,'production','start.js'))reject();
 const privateRoot=await externalDirectory(dirname(binding.runtimeConfigFile));
 validateBackupAnchorAcl(await windowsFileAcl(privateRoot,{directory:true}),binding.serviceSid);
 await canonicalFile(binding.backupConfigFile);
 validateBackupAnchorAcl(await windowsFileAcl(binding.backupConfigFile),binding.serviceSid);
 return binding;
}
