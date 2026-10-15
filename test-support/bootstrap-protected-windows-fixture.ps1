# TEST/DEVELOPMENT ONLY. Run manually in elevated PowerShell 7 (pwsh.exe).
# No target path, SID, credential, service or database parameter is accepted.
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$FixtureId,
 [Parameter(Mandatory=$true)][ValidateSet('Bootstrap','Cleanup')][string]$Action
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Refuse([string]$Code){throw $Code}
function Is-Reparse([string]$Path){
 return (([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}
function Check-Ancestors([string]$Path){
 $cursor=[IO.DirectoryInfo]::new($Path)
 while($null -ne $cursor){
  if(Is-Reparse $cursor.FullName){Refuse 'FIXTURE_REPARSE_DENIED'}
  if(Test-Path -LiteralPath ([IO.Path]::Combine($cursor.FullName,'.git'))){Refuse 'FIXTURE_GIT_PATH_DENIED'}
  $cursor=$cursor.Parent
 }
}
function Apply-DirectoryAcl([string]$Path,[Security.AccessControl.FileSystemRights]$OperatorRights){
 $acl=[Security.AccessControl.DirectorySecurity]::new()
 $acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($script:AdminSid)
 foreach($sid in @($script:SystemSid,$script:AdminSid)){
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
 }
 if([int]$OperatorRights -ne 0){
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($script:OperatorSid,$OperatorRights,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
 }
 Set-Acl -LiteralPath $Path -AclObject $acl
}
function Apply-FileAcl([string]$Path,[Security.Principal.SecurityIdentifier]$Owner,[Security.AccessControl.FileSystemRights]$OperatorRights){
 $acl=[Security.AccessControl.FileSecurity]::new()
 $acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($Owner)
 foreach($sid in @($script:SystemSid,$script:AdminSid)){
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
 }
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($script:OperatorSid,$OperatorRights,[Security.AccessControl.AccessControlType]::Allow))
 Set-Acl -LiteralPath $Path -AclObject $acl
}
# Pure shape/descriptor factories: no filesystem or authority action.
function New-StrictRuntimeAcl([string]$RuntimeSid){
 $acl=[Security.AccessControl.FileSecurity]::new()
 $acl.SetAccessRuleProtection($true,$false);$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
 foreach($sid in @('S-1-5-18','S-1-5-32-544')){
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
 }
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($RuntimeSid),[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow))
 return $acl
}
function New-OptionAFixtureShape([string]$Root,[string]$RuntimeSid){
 $key=[Security.Cryptography.RSA]::Create(2048)
 try{
  $request=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=ktv.example.invalid',$key,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $san=[Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new();$san.AddDnsName('ktv.example.invalid');$request.CertificateExtensions.Add($san.Build())
  $cert=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddDays(1))
  try{
   $configPath=[IO.Path]::Combine($Root,'secrets','runtime.json')
   $secretPath=[IO.Path]::Combine($Root,'secrets','runtime-secrets.json')
   $config=@{configVersion=1;applicationCommit=('a'*40);publicOrigin='https://ktv.example.invalid:8443';listenHost='127.0.0.1';port=8443;storeId='s3d-synthetic-store';ledgerId='s3d-synthetic-ledger';timeZone='Asia/Shanghai';businessDateCutoff='06:00';sessionRuleVersion='opening-hours-v1';deviceControlMode='disabled';liveControlEnabled=$false;secretsFile=$secretPath;logDirectory=[IO.Path]::Combine($Root,'logs');serviceAccountSid=$RuntimeSid;backupPolicyConfigured=$false;directoryAclReviewed=$true;networkModel='private-vpn';monitoring=@{backupDirectory=[IO.Path]::Combine($Root,'backups')};recovery=@{journalDirectory=[IO.Path]::Combine($Root,'journal');operatorDbSecretsFile=[IO.Path]::Combine($Root,'secrets','operator-db.json')}}
   $secrets=@{database=@{host='127.0.0.1';port=33313;name='s3d_synthetic_candidate';user='s3d_synthetic_runtime';password='S3D_RUNTIME_PASSWORD_SENTINEL';ca=$cert.ExportCertificatePem()};tls=@{certificate=$cert.ExportCertificatePem();privateKey=$key.ExportPkcs8PrivateKeyPem()};ktvsky=@{telno='synthetic';password='S3D_PROVIDER_SENTINEL'}}
   return @{ConfigPath=$configPath;SecretPath=$secretPath;Config=$config;Secrets=$secrets}
  }finally{$cert.Dispose()}
 }finally{$key.Dispose()}
}
function Initialize-PathPins {
 Add-Type -TypeDefinition @'
using System;using System.ComponentModel;using System.Runtime.InteropServices;using System.Text;using Microsoft.Win32.SafeHandles;
public static class S3dFixturePin {
 [StructLayout(LayoutKind.Sequential)] struct Tag {public uint Attributes,ReparseTag;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string p,uint a,uint s,IntPtr x,uint c,uint f,IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int k,out Tag t,uint n);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder b,uint n,uint f);
 public static SafeFileHandle Open(string path,bool directory) {
  var h=CreateFile(path,0x20000,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
  try {if(h.IsInvalid)throw new Win32Exception();Tag t;if(!GetFileInformationByHandleEx(h,9,out t,8)||(t.Attributes&0x400)!=0||((t.Attributes&0x10)!=0)!=directory)throw new InvalidOperationException();
   var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(h,b,32768,0);if(n==0||n>=32768)throw new Win32Exception();
   var actual=b.ToString();if(actual.StartsWith(@"\\?\"))actual=actual.Substring(4);if(!String.Equals(actual,path,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException();return h;
  }catch{h.Dispose();throw;}
 }
}
'@
}
function Retain-DirectoryPin([string]$Path){[void]$script:FixturePins.Add([S3dFixturePin]::Open($Path,$true))}
function Write-NewJson([string]$Path,[string]$Json,[Security.Principal.SecurityIdentifier]$Owner,[Security.AccessControl.FileSystemRights]$Rights,[string]$RuntimeSid=''){
 $stream=[IO.FileStream]::new($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 try{
  if($RuntimeSid){Set-Acl -LiteralPath $Path -AclObject (New-StrictRuntimeAcl $RuntimeSid)}else{Apply-FileAcl $Path $Owner $Rights}
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes($Json);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)
 }finally{$stream.Dispose()}
}

function New-Probe([string]$Relative){
 $path=[IO.Path]::Combine($script:FixtureRoot,$Relative)
 Write-NewJson $path '{"syntheticFixtureOnly":true,"artifactKind":"acl-probe-not-an-authorization"}' $script:AdminSid ([Security.AccessControl.FileSystemRights]::Read)
 return $path
}
# Never recursively follow a reparse point. Revoke operator mutation on each
# directory before enumerating it, then remove only its immediate children.
function Remove-OwnedTree([string]$Path){
 $pin=[S3dFixturePin]::Open($Path,$true)
 try{
  Apply-DirectoryAcl $Path ([Security.AccessControl.FileSystemRights]0)
  foreach($child in [IO.Directory]::GetFileSystemEntries($Path)){
   $attributes=[IO.File]::GetAttributes($child)
   if(($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
    if(($attributes -band [IO.FileAttributes]::Directory) -ne 0){[IO.Directory]::Delete($child,$false)}else{[IO.File]::Delete($child)}
   }elseif(($attributes -band [IO.FileAttributes]::Directory) -ne 0){Remove-OwnedTree $child}
   else{
    $filePin=[S3dFixturePin]::Open($child,$false)
    try{Apply-FileAcl $child $script:AdminSid ([Security.AccessControl.FileSystemRights]::Read)}finally{$filePin.Dispose()}
    [IO.File]::Delete($child)
   }
  }
 }finally{$pin.Dispose()}
 [IO.Directory]::Delete($Path,$false)
}
$script:FixturePins=[Collections.Generic.List[IDisposable]]::new()

try{
 if($FixtureId -cnotmatch '^[a-f0-9]{32}$'){Refuse 'FIXTURE_ID_INVALID'}
 foreach($name in @('NODE_ENV','KTV_HTTP_ENV','KTV_DEPLOYMENT_ENV')){
  $value=[Environment]::GetEnvironmentVariable($name)
  if($null -ne $value -and $value -ne '' -and $value -notin @('test','development')){Refuse 'FIXTURE_PRODUCTION_ENV_DENIED'}
 }
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
 $principal=[Security.Principal.WindowsPrincipal]::new($identity)
 if(!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){Refuse 'FIXTURE_ELEVATION_REQUIRED'}
 $script:OperatorSid=$identity.User
 $script:SystemSid=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
 $script:AdminSid=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
 # Use the OS profile registry/CIM identity, never TEMP/TMP supplied by a caller.
 $profile=Get-CimInstance Win32_UserProfile -Filter ("SID='"+$OperatorSid.Value+"'")
 if($null -eq $profile -or !$profile.LocalPath){Refuse 'FIXTURE_PROFILE_UNVERIFIED'}
 $base=[IO.Path]::GetFullPath([IO.Path]::Combine($profile.LocalPath,'AppData\Local\Temp'))
 if(!(Test-Path -LiteralPath $base -PathType Container)){Refuse 'FIXTURE_TEMP_REQUIRED'}
 Check-Ancestors $base
 $script:FixtureRoot=[IO.Path]::Combine($base,'ktv-s3d-protected-'+$FixtureId)
 if([IO.Path]::GetDirectoryName($FixtureRoot) -cne $base -or $FixtureRoot.StartsWith([Environment]::GetFolderPath('CommonApplicationData'),[StringComparison]::OrdinalIgnoreCase)){Refuse 'FIXTURE_SCOPE_DENIED'}
 Initialize-PathPins
 $marker=[IO.Path]::Combine($FixtureRoot,'fixture-owner.json')
 if($Action -eq 'Cleanup'){
  if(!(Test-Path -LiteralPath $FixtureRoot -PathType Container)){Refuse 'FIXTURE_NOT_FOUND'}
  Check-Ancestors $FixtureRoot
  if(!(Test-Path -LiteralPath $marker -PathType Leaf) -or (Is-Reparse $marker)){Refuse 'FIXTURE_MARKER_INVALID'}
  $acl=(Get-Acl -LiteralPath $marker)
  if(!$acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $AdminSid.Value){Refuse 'FIXTURE_MARKER_INVALID'}
  foreach($rule in $acl.Access){
   $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
   if($rule.AccessControlType -ne 'Allow' -or $sid -notin @($OperatorSid.Value,$SystemSid.Value,$AdminSid.Value)){Refuse 'FIXTURE_MARKER_INVALID'}
   if($sid -eq $OperatorSid.Value){
    $readMask=([int][Security.AccessControl.FileSystemRights]::Read -bor [int][Security.AccessControl.FileSystemRights]::Synchronize)
    if(([int]$rule.FileSystemRights -band (-bnot $readMask)) -ne 0 -or ([int]$rule.FileSystemRights -band 1) -eq 0){Refuse 'FIXTURE_MARKER_INVALID'}
   }
  }
  $record=[IO.File]::ReadAllText($marker)|ConvertFrom-Json
  if($record.fixtureVersion -ne 1 -or $record.kind -ne 'synthetic-s3d-windows-acl' -or $record.fixtureId -cne $FixtureId -or $record.operatorSid -ne $OperatorSid.Value){Refuse 'FIXTURE_MARKER_INVALID'}
  # The exact absolute root was checked above; the walker removes links as links.
  Remove-OwnedTree $FixtureRoot
  @{FIXTURE_CLEANUP='PASS';FIXTURE_ID=$FixtureId;ROOT=$FixtureRoot;PRODUCTION_TOUCHED='NO'}|ConvertTo-Json -Compress
  exit 0
 }
 if(Test-Path -LiteralPath $FixtureRoot){Refuse 'FIXTURE_ALREADY_EXISTS'}
 # Translate the real virtual-service account SID; do not invent an operator SID.
 $sidText=(& ([IO.Path]::Combine([Environment]::GetFolderPath('System'),'sc.exe')) showsid JbhhKtv | Out-String)
 if($LASTEXITCODE -ne 0 -or $sidText -notmatch 'S-1-5-80-(?:[0-9]+-){4}[0-9]+'){Refuse 'FIXTURE_RUNTIME_SID_UNVERIFIED'}
 $runtimeSid=$Matches[0]
 if($runtimeSid -eq $OperatorSid.Value){Refuse 'FIXTURE_IDENTITY_CONFLICT'}
 [void][IO.Directory]::CreateDirectory($FixtureRoot)
 Retain-DirectoryPin $FixtureRoot
 Apply-DirectoryAcl $FixtureRoot ([Security.AccessControl.FileSystemRights]::ReadAndExecute)
 $record=@{fixtureVersion=1;kind='synthetic-s3d-windows-acl';fixtureId=$FixtureId;operatorSid=$OperatorSid.Value;runtimeServiceSid=$runtimeSid}
 Write-NewJson $marker ($record|ConvertTo-Json -Compress) $AdminSid ([Security.AccessControl.FileSystemRights]::Read)
 foreach($relative in @('recovery','journal','journal\authorization','policy','secrets','negative','logs','backups')){
  $path=[IO.Path]::Combine($FixtureRoot,$relative);[void][IO.Directory]::CreateDirectory($path)
  Retain-DirectoryPin $path
  if($relative -eq 'secrets'){Apply-DirectoryAcl $path ([Security.AccessControl.FileSystemRights]::ReadAndExecute)}else{Apply-DirectoryAcl $path ([Security.AccessControl.FileSystemRights]::Modify)}
 }
 $shape=New-OptionAFixtureShape $FixtureRoot $runtimeSid
 $configPath=$shape.ConfigPath
 Write-NewJson $configPath ($shape.Config|ConvertTo-Json -Compress -Depth 8) $AdminSid ([Security.AccessControl.FileSystemRights]0) $runtimeSid
 Write-NewJson $shape.SecretPath ($shape.Secrets|ConvertTo-Json -Compress -Depth 8) $AdminSid ([Security.AccessControl.FileSystemRights]0) $runtimeSid
 # Readback security descriptors only; do not run the evidence reader in Bootstrap.
 foreach($file in @($configPath,$shape.SecretPath)){
  $a=Get-Acl -LiteralPath $file
  if(!$a.AreAccessRulesProtected -or $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $AdminSid.Value){Refuse 'FIXTURE_STRICT_ACL_FAILED'}
  $runtimeRead=$false;$adminRead=$false
  foreach($rule in $a.Access){
   $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
   if($rule.AccessControlType -ne 'Allow' -or $sid -notin @($runtimeSid,$SystemSid.Value,$AdminSid.Value)){Refuse 'FIXTURE_STRICT_ACL_FAILED'}
   if($sid -eq $runtimeSid -and ([int]$rule.FileSystemRights -band 1)){$runtimeRead=$true}
   if($sid -eq $AdminSid.Value -and ([int]$rule.FileSystemRights -band 1)){$adminRead=$true}
  }
  if(!$runtimeRead -or !$adminRead){Refuse 'FIXTURE_STRICT_ACL_FAILED'}
 }
 $shape=$null
 $authorizationPath=New-Probe 'journal\authorization\authorization-acl-probe.json'
 $policyPath=[IO.Path]::Combine($FixtureRoot,'policy\recovery-policy.json')
 $policy=@{policyVersion=1;approvedOperatorSid=$OperatorSid.Value;runtimeServiceSid=$runtimeSid;runtimeConfigFile=$configPath}
 Write-NewJson $policyPath ($policy|ConvertTo-Json -Compress) $AdminSid ([Security.AccessControl.FileSystemRights]::Read)
 $wrongOwner=New-Probe 'negative\wrong-policy-owner.json'
 Apply-FileAcl $wrongOwner $OperatorSid ([Security.AccessControl.FileSystemRights]::Read)
 $inherited=New-Probe 'negative\inherited-policy.json'
 $acl=(Get-Acl -LiteralPath $inherited);$acl.SetAccessRuleProtection($false,$true);Set-Acl -LiteralPath $inherited -AclObject $acl
 $runtimeFile=New-Probe 'negative\runtime-readable-authorization.json'
 $acl=(Get-Acl -LiteralPath $runtimeFile);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($runtimeSid),[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow));Set-Acl -LiteralPath $runtimeFile -AclObject $acl
 $broadFile=New-Probe 'negative\users-write-authorization.json'
 $acl=(Get-Acl -LiteralPath $broadFile);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),[Security.AccessControl.FileSystemRights]::Modify,[Security.AccessControl.AccessControlType]::Allow));Set-Acl -LiteralPath $broadFile -AclObject $acl
 $ownerAttempt=New-Probe 'negative\normal-owner-attempt.json'
 Apply-FileAcl $ownerAttempt $OperatorSid ([Security.AccessControl.FileSystemRights]([int][Security.AccessControl.FileSystemRights]::Read -bor [int][Security.AccessControl.FileSystemRights]::Write))
 [void](New-Item -ItemType Junction -Path ([IO.Path]::Combine($FixtureRoot,'negative\policy-alias')) -Target ([IO.Path]::Combine($FixtureRoot,'policy')))
 @{FIXTURE_BOOTSTRAP='CREATED';FIXTURE_ID=$FixtureId;ROOT=$FixtureRoot;OWNER='S-1-5-32-544';ACL_VERIFICATION='STRICT_DESCRIPTOR_READBACK_PASS';RUNTIME_CONFIG='PRODUCTION_SHAPED_SYNTHETIC';RUNTIME_SECRET_BUNDLE='SYNTHETIC';OPERATOR_SPECIFIC_ARTIFACT_ACE='NONE';ELEVATED_READER_EVIDENCE='NOT_RUN';PRODUCTION_TOUCHED='NO';DB='NOT_USED';SERVICE='NOT_USED'}|ConvertTo-Json -Compress
 exit 0
}catch{
 $code=$_.Exception.Message
 if($code -cnotmatch '^FIXTURE_[A-Z_]+$'){$code='FIXTURE_BOOTSTRAP_FAILED'}
 @{FIXTURE='BLOCKED';CODE=$code;FIXTURE_ID=$FixtureId}|ConvertTo-Json -Compress
 exit 1
}finally{foreach($pin in $script:FixturePins){$pin.Dispose()}}
