import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
export async function syntheticTls(host='ktv-smoke.127.0.0.1.sslip.io'){
 const script="$ErrorActionPreference='Stop';$rsa=[Security.Cryptography.RSA]::Create(2048);$req=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN="+host+"',$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1);$san=[Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new();$san.AddDnsName('"+host+"');$req.CertificateExtensions.Add($san.Build());$cert=$req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddDays(2));@{certificate=$cert.ExportCertificatePem();privateKey=$rsa.ExportPkcs8PrivateKeyPem();sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}|ConvertTo-Json -Compress";
 const {stdout}=await exec('pwsh.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,maxBuffer:65536});
 return JSON.parse(stdout.trim());
}
export async function protectSyntheticFile(path,sid){
 const p=Buffer.from(path).toString('base64'),script="$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+p+"'));$a=[Security.AccessControl.FileSecurity]::new();$a.SetAccessRuleProtection($true,$false);$a.SetOwner([Security.Principal.SecurityIdentifier]::new('"+sid+"'));foreach($id in @('"+sid+"','S-1-5-18','S-1-5-32-544')){$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($id),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))};Set-Acl -LiteralPath $p -AclObject $a";
 await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000,maxBuffer:65536});
}
