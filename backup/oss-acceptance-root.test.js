import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile),source=await readFile(new URL('./oss-acceptance-root.ps1',import.meta.url),'utf8');
const setup=String.raw`
$script:Operator='S-1-5-21-111-222-333-1001'
function New-SyntheticAcl([string]$owner='S-1-5-32-544',[bool]$protected=$true){
 $a=[Security.AccessControl.DirectorySecurity]::new()
 $a.SetOwner([Security.Principal.SecurityIdentifier]::new($owner));$a.SetAccessRuleProtection($protected,$false)
 $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
 return $a
}
function Add-Untrusted($acl,[Security.AccessControl.FileSystemRights]$rights){
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-21-111-222-333-1999'),$rights,[Security.AccessControl.AccessControlType]::Allow))
}
`;
async function ps(body){
 const {stdout,stderr}=await exec('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source+setup+'\n'+body,'utf16le').toString('base64')],{windowsHide:true,timeout:10000,maxBuffer:16384});
 assert.equal(stderr.trim(),'');assert.equal(stdout.trim(),'PASS');
}
test('fixed native private ACL accepts only trusted protected synthetic descriptor',()=>ps("Check-Acl (New-SyntheticAcl) $true;[Console]::WriteLine('PASS')"));
for(const [name,body] of [
 ['untrusted owner',"$a=New-SyntheticAcl 'S-1-5-21-111-222-333-1999'"],
 ['inherited private ACL',"$a=New-SyntheticAcl 'S-1-5-32-544' $false"],
 ['untrusted private reader',"$a=New-SyntheticAcl;Add-Untrusted $a ([Security.AccessControl.FileSystemRights]::Read)"],
 ['untrusted ancestor WRITE_DATA/ADD_FILE',"$a=New-SyntheticAcl;Add-Untrusted $a ([Security.AccessControl.FileSystemRights]::WriteData)"],
 ['untrusted ancestor DELETE',"$a=New-SyntheticAcl;Add-Untrusted $a ([Security.AccessControl.FileSystemRights]::Delete)"],
 ['untrusted ancestor DELETE_CHILD',"$a=New-SyntheticAcl;Add-Untrusted $a ([Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles)"],
 ['untrusted ancestor WRITE_DAC',"$a=New-SyntheticAcl;Add-Untrusted $a ([Security.AccessControl.FileSystemRights]::ChangePermissions)"],
 ['untrusted ancestor WRITE_OWNER',"$a=New-SyntheticAcl;Add-Untrusted $a ([Security.AccessControl.FileSystemRights]::TakeOwnership)"],
 ['untrusted ancestor reparse mutation rights',"$a=New-SyntheticAcl;Add-Untrusted $a ([Security.AccessControl.FileSystemRights]::WriteAttributes)"]
])test('fixed native ACL rejects '+name,()=>ps(body+";$denied=$false;try{Check-Acl $a "+(name.includes('ancestor')?'$false':'$true')+"}catch{$denied=$true};if(!$denied){throw 'DID_NOT_DENY'};[Console]::WriteLine('PASS')"));
test('fixed native ancestor read-only public access is not replacement authority',()=>ps("$a=New-SyntheticAcl;Add-Untrusted $a ([Security.AccessControl.FileSystemRights]::ReadAndExecute);Check-Acl $a $false;[Console]::WriteLine('PASS')"));
test('fixed native bindings pin and release only the local volume root without reading configuration',()=>ps(String.raw`
Initialize-Native
$script:Pins=[Collections.Generic.List[IDisposable]]::new()
try{$h=Pin 'C:\' $true;if($script:Pins.Count -ne 1 -or $null -eq (Read-PinnedDirectoryAcl $h)){throw 'PIN_MISSING'}}
finally{foreach($h in $script:Pins){$h.Dispose()}}
[Console]::WriteLine('PASS')
`));
test('fixed native source contains no provisioning, deletion, path input or path-based config reader',()=>{
 assert.doesNotMatch(source.replace(/^\s*#.*$/gm,''),/Set-Acl|SetAccessControl|Remove-Item|::Delete\(|Add-Type|\$env:|readExternalSecret|realpath/);
 assert.match(source,/\[IO\.FileStream\]::new\(\$h/);assert.match(source,/\$stream\.GetAccessControl\(\)/);assert.doesNotMatch(source,/\[IO\.Directory\]::GetAccessControl/);
 assert.match(source,/for\(\$i=\$script:Pins.Count-1/);
});

for(const [attrs,directory] of [[0x400,false],[0x410,true],[0x10,false],[0,true]])test('fixed native rejects reparse or object-type mismatch '+attrs+'/'+directory,()=>ps('$denied=$false;try{Check-Tag '+attrs+' $'+directory+'}catch{$denied=$true};if(!$denied){throw "TAG_ACCEPTED"};[Console]::WriteLine("PASS")'));

for(const [type,mapping] of [[0,'\\Device\\Disk'],[1,'\\Device\\Disk'],[4,'\\Device\\Disk'],[3,'\\??\\C:\\alias'],[3,'\\Device\\Mup\\share'],[3,'']])test('fixed native drive rejects '+type+'/'+mapping,()=>ps('$denied=$false;try{Check-Drive '+type+" '"+mapping+"'}catch{$denied=$true};if(!$denied){throw 'DRIVE_ACCEPTED'};[Console]::WriteLine('PASS')"));

test('fixed native file handle reads only this non-secret test source and excludes competing write/delete access',()=>ps(String.raw`
Initialize-Native
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(fileURLToPath(import.meta.url)).toString('base64')}'))
$script:Pins=[Collections.Generic.List[IDisposable]]::new()
# Access-only probes: OPEN_EXISTING, no writes, renames, DELETE_ON_CLOSE or deletion calls.
function Open-Access([uint32]$rights){return $script:Native.GetMethod('CreateFileW').Invoke($null,@($p,$rights,[uint32]3,[IntPtr]::Zero,[uint32]3,[uint32]0x02200000,[IntPtr]::Zero))}
foreach($rights in @([uint32]2,[uint32]0x10000)){
 $raw=Open-Access $rights;$h=[Microsoft.Win32.SafeHandles.SafeFileHandle]::new($raw,$true)
 try{if($h.IsInvalid){throw 'FIXTURE_ACCESS_REQUIRED'}}finally{$h.Dispose()}
}
try{
 $h=Pin $p $false
 $stream=[IO.FileStream]::new($h,[IO.FileAccess]::Read)
 try{
  if($null -eq $stream.GetAccessControl() -or $stream.ReadByte() -lt 0){throw 'HANDLE_READ_FAILED'}
  foreach($rights in @([uint32]2,[uint32]0x10000)){
   $raw=Open-Access $rights;$other=[Microsoft.Win32.SafeHandles.SafeFileHandle]::new($raw,$true)
   try{if(!$other.IsInvalid){throw 'PIN_DID_NOT_EXCLUDE_MUTATION'}}finally{$other.Dispose()}
  }
 }finally{$stream.Dispose()}
}finally{foreach($h in $script:Pins){$h.Dispose()}}
[Console]::WriteLine('PASS')
`));

test('fixed native ancestor creating other subdirectories alone does not permit replacing protected chain',()=>ps("$a=New-SyntheticAcl;Add-Untrusted $a ([Security.AccessControl.FileSystemRights]::CreateDirectories);Check-Acl $a $false;[Console]::WriteLine('PASS')"));
