import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {canonical,digest,fail} from '../backup/format.js';
const exec=promisify(execFile);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const same=(a,b)=>canonical({value:a})===canonical({value:b});
// Only SCM/CIM is an injectable system boundary. Production constructs this adapter
// from protected deployment policy; its CLI accepts neither status nor process facts.
async function windowsSnapshot(){
 if(process.platform!=='win32')throw fail('RECOVERY_SERVICE_UNVERIFIED');
 const script=String.raw`$ErrorActionPreference='Stop';
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class KtvArgv{[DllImport("shell32.dll",SetLastError=true)]static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)]string s,out int n);[DllImport("kernel32.dll")]static extern IntPtr LocalFree(IntPtr p);public static string[] Parse(string s){int n;var p=CommandLineToArgvW(s,out n);if(p==IntPtr.Zero)throw new Exception();try{var a=new string[n];for(int i=0;i<n;i++)a[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size));return a;}finally{LocalFree(p);}}}'
$s=Get-CimInstance Win32_Service -Filter "Name='JbhhKtv'";if(!$s){throw 'MISSING'}
$sid=([Security.Principal.NTAccount]::new($s.StartName)).Translate([Security.Principal.SecurityIdentifier]).Value
$args=[KtvArgv]::Parse($s.PathName);if($args.Length -ne 7){throw 'ARGS'}
$all=@(Get-CimInstance Win32_Process);$ids=[Collections.Generic.HashSet[uint32]]::new()
foreach($p in $all){if($p.ProcessId -eq $s.ProcessId -and $s.ProcessId -ne 0 -or $p.ExecutablePath -eq $args[0] -or $p.ExecutablePath -eq $args[2] -and $p.CommandLine -and $p.CommandLine.Contains($args[4])){[void]$ids.Add($p.ProcessId)}}
do{$changed=$false;foreach($p in $all){if($ids.Contains($p.ParentProcessId) -and !$ids.Contains($p.ProcessId)){[void]$ids.Add($p.ProcessId);$changed=$true}}}while($changed)
$ps=@(foreach($p in $all){if($ids.Contains($p.ProcessId)){$o=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid;if($o.ReturnValue -ne 0 -or !$p.ExecutablePath -or !$p.CommandLine -or !$p.CreationDate){throw 'PROCESS_UNVERIFIED'};@{pid=[int]$p.ProcessId;ppid=[int]$p.ParentProcessId;createdAt=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath;argv=@([KtvArgv]::Parse($p.CommandLine));sid=$o.Sid}}})
@{name=$s.Name;state=$s.State;pid=[int]$s.ProcessId;serviceSid=$sid;argv=@($args);processes=$ps}|ConvertTo-Json -Compress -Depth 6`;
 try{const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,maxBuffer:131072});return JSON.parse(stdout);}
 catch{throw fail('RECOVERY_SERVICE_UNVERIFIED');}
}
async function windowsCommand(action){
 if(!['start','stop'].includes(action)||process.platform!=='win32')throw fail('RECOVERY_SERVICE_UNVERIFIED');
 try{await exec('sc.exe',[action,'JbhhKtv'],{windowsHide:true,timeout:10000,maxBuffer:65536});}
 catch{throw fail('RECOVERY_SERVICE_COMMAND_FAILED');}
}
export function createRecoveryServiceAdapter(expected,{snapshot=windowsSnapshot,command=windowsCommand,pause=sleep}={}){
 const hostArgs=[expected.hostExecutable,'--node',expected.nodeExecutable,'--entry',expected.entryFile,'--config',expected.configFile];
 const nodeArgs=[expected.nodeExecutable,expected.entryFile,'--config-file',expected.configFile];
 if(expected.serviceName!=='JbhhKtv')throw fail('RECOVERY_SERVICE_IDENTITY_MISMATCH');
 let observedHost=null;
 async function status(){
  const s=await snapshot();
  if(s?.name!==expected.serviceName||s.serviceSid!==expected.serviceSid||!same(s.argv,hostArgs)||
     !Array.isArray(s.processes)||!Number.isInteger(s.pid)||s.pid<0)
   throw fail('RECOVERY_SERVICE_IDENTITY_MISMATCH');
  const ids=new Set();
  for(const p of s.processes){
   if(!Number.isInteger(p.pid)||p.pid<1||ids.has(p.pid)||!Number.isInteger(p.ppid)||
      p.sid!==expected.serviceSid||typeof p.createdAt!=='string'||!Number.isFinite(Date.parse(p.createdAt)))
    throw fail('RECOVERY_SERVICE_PROCESS_CONFLICT');
   ids.add(p.pid);
  }
  if(s.state==='Stopped'){
   if(s.pid!==0||s.processes.length)throw fail('RECOVERY_SERVICE_PROCESS_CONFLICT');
   return {phase:'STOPPED',workerStopped:true,operationalStopped:true,connectionsClosed:true,
    normalWriterCount:0,proofDigest:digest(canonical(s))};
  }
  if(s.state!=='Running'||s.pid===0)throw fail('RECOVERY_SERVICE_NOT_STABLE');
  const host=s.processes.find(p=>p.pid===s.pid);
  const nodes=s.processes.filter(p=>p.pid!==s.pid);
  if(!host||host.executable!==expected.hostExecutable||!same(host.argv,hostArgs)||nodes.length!==1||
     nodes[0].ppid!==host.pid||nodes[0].executable!==expected.nodeExecutable||!same(nodes[0].argv,nodeArgs)||
     Date.parse(nodes[0].createdAt)<Date.parse(host.createdAt))
   throw fail('RECOVERY_SERVICE_PROCESS_CONFLICT');
  if(observedHost&&observedHost.pid===host.pid&&observedHost.createdAt!==host.createdAt)
   throw fail('RECOVERY_SERVICE_PROCESS_CONFLICT');
  observedHost={pid:host.pid,createdAt:host.createdAt};
  return {phase:'RUNNING',workerStopped:false,operationalStopped:false,connectionsClosed:false,
   normalWriterCount:1,hostPid:host.pid,hostCreatedAt:host.createdAt,proofDigest:digest(canonical(s))};
 }
 async function wait(phase){
  for(let n=0;n<120;n++){
   try{const state=await status();if(state.phase===phase)return state;}
   catch(e){if(e.code!=='RECOVERY_SERVICE_NOT_STABLE')throw e;}
   await pause(250);
  }
  throw fail('RECOVERY_SERVICE_TIMEOUT');
 }
 return Object.freeze({status,
  async shutdown(){const before=await status();if(before.phase==='STOPPED')return true;
   await command('stop');await wait('STOPPED');return true;},
  async start(){const before=await status();if(before.phase==='RUNNING')return before;
   await command('start');return wait('RUNNING');}
 });
}
