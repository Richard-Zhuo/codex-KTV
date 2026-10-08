# Operator template only. Registration is a deployment action and is not executed in Stage5C.
[CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='High')]
param(
 [Parameter(Mandatory=$true)][string]$HostExe,
 [Parameter(Mandatory=$true)][string]$NodeExe,
 [Parameter(Mandatory=$true)][string]$EntryFile,
 [Parameter(Mandatory=$true)][string]$ConfigFile
)
$ErrorActionPreference='Stop'
foreach($item in @($HostExe,$NodeExe,$EntryFile,$ConfigFile)){
 if(-not [IO.Path]::IsPathRooted($item) -or $item -match '["\r\n]' -or -not (Test-Path -LiteralPath $item -PathType Leaf)){throw 'SERVICE_PATH_INVALID'}
}
if(Get-Service -Name JbhhKtv -ErrorAction SilentlyContinue){throw 'SERVICE_ALREADY_EXISTS'}
$binPath='"'+$HostExe+'" --node "'+$NodeExe+'" --entry "'+$EntryFile+'" --config "'+$ConfigFile+'"'
if($PSCmdlet.ShouldProcess('JbhhKtv','Register dedicated virtual-account Windows service, delayed auto start and restart backoff')){
 & sc.exe create JbhhKtv binPath= $binPath start= delayed-auto obj= 'NT SERVICE\JbhhKtv' password= ''
 if($LASTEXITCODE -ne 0){throw 'SERVICE_CREATE_FAILED'}
 & sc.exe failure JbhhKtv reset= 3600 actions= restart/30000/restart/60000/restart/300000
 if($LASTEXITCODE -ne 0){throw 'SERVICE_RECOVERY_CONFIG_FAILED'}
 & sc.exe failureflag JbhhKtv 1
 if($LASTEXITCODE -ne 0){throw 'SERVICE_FAILURE_FLAG_FAILED'}
}
# No Start-Service, migration, bootstrap, fixture, database reset or provider call.
