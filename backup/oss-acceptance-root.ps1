# Dedicated local OSS lab boundary. No provisioning, ACL mutation, deletion or network operation.
# Trusted administrator/SYSTEM/current administrator processes must remain trusted throughout a run.
# ACL validation is not a defence against those principals or a changed OS/volume namespace.
# Definitions only: the caller appends one fixed operation after explicit local-read consent.
$ErrorActionPreference='Stop'
$PSModuleAutoLoadingPreference='None'
$ProgressPreference='SilentlyContinue'
function Refuse { throw 'OSS_ACCEPTANCE_ROOT_DENIED' }
function Check-Acl($acl,[bool]$private){
 $trusted=@('S-1-5-18','S-1-5-32-544',$script:Operator)
 if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted){Refuse}
 if($private -and !$acl.AreAccessRulesProtected){Refuse}
 $rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
 if($rules.Count -eq 0){Refuse}
 foreach($r in $rules){
  if($private -and $r.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $r.IdentityReference.Value -notin $trusted){Refuse}
  if(($r.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0){continue}
  if($r.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){continue}
  if($r.IdentityReference.Value -notin $trusted){
   # On system ancestors, creating unrelated subdirectories alone is not replacement authority.
   # WRITE_DATA/ADD_FILE can also grant reparse mutation; reject it with DELETE, DELETE_CHILD, WRITE_DAC/OWNER, attributes and EA.
   # Whitelist only read/list/traverse, READ_CONTROL, SYNCHRONIZE and ADD_SUBDIRECTORY. Unknown rights fail closed.
   if($private -or (([long]$r.FileSystemRights -band (-bnot 0x1200AD)) -ne 0)){Refuse}
  }
 }
}
function Check-Drive($type,[string]$mapping){
 if($type -ne 3 -or !$mapping.StartsWith('\Device\',[StringComparison]::Ordinal) -or $mapping.Length -le 8 -or $mapping.Substring(8).Contains('\')){Refuse}
}
function Initialize-Native {
 $a=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('OssFixedRoot'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
 $m=$a.DefineDynamicModule('Native');$t=$m.DefineType('Native',[Reflection.TypeAttributes]::Public)
 function Bind([string]$name,[type]$result,[type[]]$parameters){
  $f=$t.DefinePInvokeMethod($name,'kernel32.dll',$name,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,$result,$parameters,[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
  $f.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
 }
 Bind 'GetDriveTypeW' ([uint32]) @([string])
 Bind 'QueryDosDeviceW' ([uint32]) @([string],[Text.StringBuilder],[uint32])
 Bind 'CreateFileW' ([IntPtr]) @([string],[uint32],[uint32],[IntPtr],[uint32],[uint32],[IntPtr])
 Bind 'GetFileInformationByHandleEx' ([uint32]) @([IntPtr],[int],[IntPtr],[uint32])
 Bind 'GetFinalPathNameByHandleW' ([uint32]) @([IntPtr],[Text.StringBuilder],[uint32],[uint32])
 $f=$t.DefinePInvokeMethod('GetKernelObjectSecurity','advapi32.dll','GetKernelObjectSecurity',[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,[uint32],@([IntPtr],[uint32],[IntPtr],[uint32],[uint32].MakeByRefType()),[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
 $f.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
 $script:Native=$t.CreateType()
}
function Check-Tag([int]$attrs,[bool]$directory){
 if(($attrs -band 0x400) -ne 0 -or ((($attrs -band 0x10) -ne 0) -ne $directory)){Refuse}
}
function Read-PinnedDirectoryAcl($handle){
 # Read OWNER + DACL from the already verified directory handle, never reopen its name.
 $method=$script:Native.GetMethod('GetKernelObjectSecurity')
 $args=[object[]]@($handle.DangerousGetHandle(),[uint32]5,[IntPtr]::Zero,[uint32]0,[uint32]0)
 [void]$method.Invoke($null,$args);$size=[uint32]$args[4]
 if($size -eq 0 -or $size -gt 65536){Refuse}
 $buffer=[Runtime.InteropServices.Marshal]::AllocHGlobal([int]$size)
 try{
  $args[2]=$buffer;$args[3]=$size
  if($method.Invoke($null,$args) -eq 0){Refuse}
  $bytes=[byte[]]::new([int]$size);[Runtime.InteropServices.Marshal]::Copy($buffer,$bytes,0,[int]$size)
  $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetSecurityDescriptorBinaryForm($bytes)
  return $acl
 }finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)}
}
function Pin([string]$path,[bool]$directory){
 $access=[uint32]0x20080;if(!$directory){$access=[uint32]2147614848}
 # OPEN_EXISTING, no share-write/delete; OPEN_REPARSE_POINT plus BACKUP_SEMANTICS.
 # Every parent remains pinned until this operation completes. Final-component flag alone is insufficient.
 $raw=$script:Native.GetMethod('CreateFileW').Invoke($null,@($path,$access,[uint32]1,[IntPtr]::Zero,[uint32]3,[uint32]0x02200000,[IntPtr]::Zero))
 $h=[Microsoft.Win32.SafeHandles.SafeFileHandle]::new($raw,$true)
 if($h.IsInvalid){$h.Dispose();Refuse}
 [void]$script:Pins.Add($h)
 $buf=[Runtime.InteropServices.Marshal]::AllocHGlobal(8)
 try{
  if($script:Native.GetMethod('GetFileInformationByHandleEx').Invoke($null,@($raw,[int]9,$buf,[uint32]8)) -eq 0){Refuse}
  $attrs=[Runtime.InteropServices.Marshal]::ReadInt32($buf)
  Check-Tag $attrs $directory
 }finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($buf)}
 $b=[Text.StringBuilder]::new(1024)
 $size=$script:Native.GetMethod('GetFinalPathNameByHandleW').Invoke($null,@($raw,$b,[uint32]1024,[uint32]0))
 if($size -eq 0 -or $size -ge 1024 -or ![string]::Equals($b.ToString(),'\\?\'+$path,[StringComparison]::OrdinalIgnoreCase)){Refuse}
 return $h
}
function Invoke-OssFixedRead([string]$operation){
 if($operation -notin @('CONFIG','READ','WRITE','ROOT')){Refuse}
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
 if(!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){Refuse}
 $script:Operator=$identity.User.Value
 $script:Pins=[Collections.Generic.List[IDisposable]]::new()
 try{
  Initialize-Native
  # Root-only OS queries precede every target filesystem operation; no stat/realpath inference.
  if($script:Native.GetMethod('GetDriveTypeW').Invoke($null,@('C:\')) -ne 3){Refuse}
  $device=[Text.StringBuilder]::new(8192)
  if($script:Native.GetMethod('QueryDosDeviceW').Invoke($null,@('C:',$device,[uint32]8192)) -eq 0){Refuse}
  $mapping=$device.ToString().Split([char]0)[0]
  Check-Drive 3 $mapping
  $chain=@('C:\','C:\ProgramData','C:\ProgramData\JbhhKtv','C:\ProgramData\JbhhKtv\private','C:\ProgramData\JbhhKtv\private\oss-acceptance')
  for($i=0;$i -lt $chain.Length;$i++){
   $p=$chain[$i];$parent=Pin $p $true
   # Parent is pinned before child lookup; ACL lookup cannot be redirected by renaming that parent.
   Check-Acl (Read-PinnedDirectoryAcl $parent) ($i -ge 2)
   try{[void][IO.File]::GetAttributes([IO.Path]::Combine($p,'.git'));Refuse}
   catch [IO.FileNotFoundException]{} catch [IO.DirectoryNotFoundException]{}
  }
  if($operation -eq 'ROOT'){[Console]::WriteLine('ROOT_OK');return}
  $name=@{CONFIG='config.json';READ='read.json';WRITE='write.json'}[$operation]
  $path=[IO.Path]::Combine($chain[-1],$name)
  $h=Pin $path $false
  $stream=[IO.FileStream]::new($h,[IO.FileAccess]::Read)
  try{
   Check-Acl ($stream.GetAccessControl()) $true
   if($stream.Length -le 0 -or $stream.Length -gt 65536){Refuse}
   $bytes=[byte[]]::new([int]$stream.Length);$offset=0
   while($offset -lt $bytes.Length){$count=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($count -le 0){Refuse};$offset+=$count}
   [Console]::WriteLine('DATA:'+ [Convert]::ToBase64String($bytes))
  }finally{$stream.Dispose()}
 }finally{for($i=$script:Pins.Count-1;$i -ge 0;$i--){$script:Pins[$i].Dispose()}}
}
