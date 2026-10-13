// Explicit narrow case; imported once by the unchanged pre-UAC test list.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {validateRuntimeConfig,validateRuntimeFileAclStructure} from '../production/runtime-config.js';
import {windowsRecoveryIdentity} from '../recovery/production-authorization-context.js';
const exec=promisify(execFile),helper=fileURLToPath(new URL('./bootstrap-protected-windows-fixture.ps1',import.meta.url));
const env={NODE_ENV:'production',KTV_HTTP_ENV:'production',KTV_DEPLOYMENT_ENV:'production'};
const forbidden=/S3D_(?:RUNTIME_PASSWORD|PROVIDER)_SENTINEL|-----BEGIN (?:RSA )?PRIVATE KEY-----/;
test('bootstrap parses, native no-follow type compiles, generated schema and strict descriptors match real validators',async t=>{
 const encoded=Buffer.from(helper).toString('base64');
 const script=`$ErrorActionPreference='Stop';$file=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'SYNTAX'};
 foreach($name in @('Initialize-PathPins','New-StrictRuntimeAcl','New-OptionAFixtureShape')){
 $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);if(!$fn){throw 'FUNCTION'};. ([ScriptBlock]::Create($fn.Extent.Text))};Initialize-PathPins;
 $sidText=(& ([IO.Path]::Combine([Environment]::GetFolderPath('System'),'sc.exe')) showsid JbhhKtv | Out-String);if($LASTEXITCODE -ne 0 -or $sidText -notmatch 'S-1-5-80-(?:[0-9]+-){4}[0-9]+'){throw 'SID'};$sid=$Matches[0];
 $shape=New-OptionAFixtureShape 'C:\\synthetic-owned-shape-only' $sid;$a=New-StrictRuntimeAcl $sid;
 if($a -isnot [Security.AccessControl.FileSecurity]){throw 'ACL_DESCRIPTOR_TYPE_INVALID'};
 $rules=@(foreach($rule in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
  if($null -eq $rule -or $rule -isnot [Security.AccessControl.FileSystemAccessRule]){throw 'ACL_RULE_INVALID'};
  $ir=$rule.IdentityReference;
  if($ir -is [Security.Principal.SecurityIdentifier]){$principal=$ir.Value}
  elseif($ir -is [Security.Principal.NTAccount]){$principal=$ir.Translate([Security.Principal.SecurityIdentifier]).Value}
  else{throw 'ACL_PRINCIPAL_INVALID'};
  if(!$principal){throw 'ACL_PRINCIPAL_INVALID'};
  @{sid=$principal;type=$rule.AccessControlType.ToString();rights=[int]$rule.FileSystemRights;inheritance=$rule.InheritanceFlags.ToString();propagation=$rule.PropagationFlags.ToString();ruleType=$rule.GetType().FullName;identityType=$ir.GetType().FullName}
 });if($rules.Count -eq 0){throw 'ACL_RULES_EMPTY'};
 $valid=($shape.Secrets.database.password.Length -ge 16 -and $shape.Secrets.database.name -eq 's3d_synthetic_candidate' -and $shape.Secrets.tls.certificate.StartsWith('-----BEGIN CERTIFICATE-----') -and $shape.Secrets.tls.privateKey.StartsWith('-----BEGIN PRIVATE KEY-----') -and $shape.Secrets.database.ca -eq $shape.Secrets.tls.certificate);
 @{descriptorType=$a.GetType().FullName;config=$shape.Config;secretsShapeValid=$valid;acl=@{protected=$a.AreAccessRulesProtected;owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;rules=$rules}}|ConvertTo-Json -Compress -Depth 10`;
 const {stdout,stderr}=await exec('pwsh.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:20000,maxBuffer:32768});
 assert.equal(forbidden.test(stdout+stderr),false,'schema/descriptor diagnostics must not output secrets');
 const result=JSON.parse(stdout);assert.equal(result.secretsShapeValid,true);validateRuntimeConfig(result.config,env);
 assert.equal(result.descriptorType,'System.Security.AccessControl.FileSecurity');
 const {acl}=result,runtime=result.config.serviceAccountSid,identity=await windowsRecoveryIdentity();
 const allowed=new Set([runtime,'S-1-5-18','S-1-5-32-544']);
 assert.equal(acl.owner,'S-1-5-32-544');assert.equal(acl.protected,true);assert.equal(acl.rules.length,3);
 for(const rule of acl.rules){
  assert.equal(rule.ruleType,'System.Security.AccessControl.FileSystemAccessRule');
  assert.equal(rule.identityType,'System.Security.Principal.SecurityIdentifier');
  assert.equal(rule.type,'Allow');assert.equal(rule.inheritance,'None');assert.equal(rule.propagation,'None');assert.equal(allowed.has(rule.sid),true);
 }
 for(const sid of allowed)assert.equal(acl.rules.some(r=>r.sid===sid&&(r.rights&1)!==0),true);
 assert.equal(acl.rules.some(r=>r.sid===identity.sid),false);
 validateRuntimeFileAclStructure(acl,runtime);
 for(const bad of [{...acl,protected:false},{...acl,rules:acl.rules.filter(r=>r.sid!==runtime)},
  {...acl,rules:[...acl.rules,{sid:identity.sid,type:'Allow',rights:1}]},
  {...acl,rules:[...acl.rules,{sid:'S-1-1-0',type:'Allow',rights:1}]}])
  assert.throws(()=>validateRuntimeFileAclStructure(bad,runtime),{code:'RUNTIME_ACL_DENIED'});
 t.diagnostic(JSON.stringify({descriptorType:result.descriptorType,owner:acl.owner,protectedInheritance:acl.protected,runtimeSidRead:true,administratorsRead:true,systemRead:true,operatorAce:false,unexpectedAce:false,ruleCount:acl.rules.length}));
});
