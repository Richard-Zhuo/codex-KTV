// Narrow Windows admission for the OSS manual probe; no target file access determines drive type.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {win32} from 'node:path';
const exec=promisify(execFile);
const fail=()=>Object.assign(Error('OSS_ACCEPTANCE_PATH_REJECTED'),{code:'OSS_ACCEPTANCE_PATH_REJECTED'});
const powershell='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
export function isOssAcceptanceLocalPath(path){
  if(typeof path!=='string'||path.length>240||!/^[A-Za-z]:[\\/]/.test(path)||/[\x00-\x1f<>"|?*]/.test(path)||path.slice(2).includes(':'))return false;
  const parts=path.slice(3).split(/[\\/]/);
  return path.length===3||parts.every(p=>p.length>0&&!['.','..'].includes(p)&&!/[. ]$/.test(p)&&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p));
}
// Reflection.Emit binds only three fixed kernel32 entry points in memory: no compiler,
// temporary assembly, target-directory lookup, PowerShell profile or module is loaded.
const native=String.raw`$ErrorActionPreference='Stop'
$PSModuleAutoLoadingPreference='None'
$ProgressPreference='SilentlyContinue'
$a=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('OssAcceptanceNative'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$m=$a.DefineDynamicModule('Native')
$t=$m.DefineType('Native',[Reflection.TypeAttributes]::Public)
function Bind([string]$name,[type[]]$parameters){
 $f=$t.DefinePInvokeMethod($name,'kernel32.dll',$name,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,[uint32],$parameters,[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
 $f.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
}
Bind 'GetDriveTypeW' @([string])
Bind 'QueryDosDeviceW' @([string],[Text.StringBuilder],[uint32])
Bind 'GetFileAttributesW' @([string])
$n=$t.CreateType()
`;
async function query(kind,path){
  try{
    if(process.platform!=='win32')throw fail();
    const value=Buffer.from(path,'utf8').toString('base64');
    const input="$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+value+"'))\n";
    const action=kind==='DRIVE'?String.raw`# OSS_ACCEPTANCE_DRIVE
$d=[uint32]$n.GetMethod('GetDriveTypeW').Invoke($null,@($p))
$device=$null
if($d -eq 3){
 $b=[Text.StringBuilder]::new(8192)
 $count=[uint32]$n.GetMethod('QueryDosDeviceW').Invoke($null,@($p.Substring(0,2),$b,[uint32]8192))
 if($count -eq 0){throw 'OS_QUERY_FAILED'}
 $device=$b.ToString().Split([char]0)[0]
}
[Console]::WriteLine(('DRIVE:{0}:{1}' -f $d,[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([string]$device))))
`:String.raw`# OSS_ACCEPTANCE_COMPONENT
[Console]::WriteLine(('ATTR:{0}' -f [uint32]$n.GetMethod('GetFileAttributesW').Invoke($null,@($p))))
`;
    const script=native+input+action;
    const {stdout,stderr}=await exec(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
      {windowsHide:true,timeout:5000,maxBuffer:16384});
    if(stderr?.trim())throw fail();
    const match=(kind==='DRIVE'?/^DRIVE:(\d+):([A-Za-z0-9+/=]*)\r?\n?$/:/^ATTR:(\d+)\r?\n?$/).exec(stdout);
    if(!match)throw fail();
    return kind==='DRIVE'?{driveType:Number(match[1]),device:Buffer.from(match[2],'base64').toString('utf16le')}:{attributes:Number(match[1])};
  }catch{throw fail();}
}
export async function guardOssAcceptanceFixedRoot(path){
  if(!isOssAcceptanceLocalPath(path))throw fail();
  const root=path[0].toUpperCase()+':\\';
  // GetDriveTypeW takes ONLY this explicit root. QueryDosDeviceW excludes SUBST/path
  // aliases before filesystem calls. Never infer media type from stat/realpath/ACL/open.
  const result=await query('DRIVE',root);
  if(!result||Object.keys(result).length!==2||result.driveType!==3||
    typeof result.device!=='string'||!/^\\Device\\[^\\\x00]+$/.test(result.device))throw fail();
  let checked=null;
  return Object.freeze({root,async checkComponent(path){
    if(!isOssAcceptanceLocalPath(path))throw fail();
    const full=win32.normalize(path);
    if(checked===null?full.toLowerCase()!==root.toLowerCase():win32.dirname(full).toLowerCase()!==checked.toLowerCase())throw fail();
    // GetFileAttributesW reports the final link/mount itself; checked parents precede it.
    // Reject ALL reparse tags, not just the symlink subset recognized by Node lstat.
    const info=await query('COMPONENT',full);
    if(!info||Object.keys(info).length!==1||!Number.isInteger(info.attributes)||info.attributes<0||
      info.attributes>=0xffffffff||(info.attributes&0x400)!==0)throw fail();
    checked=full;
  }});
}
