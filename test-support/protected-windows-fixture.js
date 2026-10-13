// TEST/DEVELOPMENT ONLY: actual OS token and ACL observations, no injection.
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,lstat,realpath} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {windowsRecoveryIdentity,validateRecoveryAcl,canonicalProtectedPath,exact} from '../recovery/production-authorization-context.js';
import {windowsFileAcl} from '../production/runtime-config.js';
const exec=promisify(execFile);
const fail=code=>Object.assign(Error(code),{code});
const helper=fileURLToPath(new URL('./bootstrap-protected-windows-fixture.ps1',import.meta.url));
export function fixtureId(value){if(typeof value!=='string'||!/^[a-f0-9]{32}$/.test(value))throw fail('FIXTURE_ID_INVALID');return value;}
function testEnvironment(){
 if(process.platform!=='win32'||['NODE_ENV','KTV_HTTP_ENV','KTV_DEPLOYMENT_ENV'].some(k=>process.env[k]&&!['test','development'].includes(process.env[k])))throw fail('FIXTURE_PRODUCTION_ENV_DENIED');
}
export async function fixtureRoot(id){
 testEnvironment();fixtureId(id);
 const identity=await windowsRecoveryIdentity();
 const script="$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_UserProfile -Filter \"SID='"+identity.sid+"'\";if(!$p -or !$p.LocalPath){throw 'PROFILE'};[IO.Path]::Combine($p.LocalPath,'AppData\\Local\\Temp')";
 const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:5000,maxBuffer:4096});
 const base=stdout.trim();if(!base||await realpath(base)!==resolve(base))throw fail('FIXTURE_PROFILE_UNVERIFIED');
 return join(base,'ktv-s3d-protected-'+id);
}
export async function readProtectedFixture(id){
 const root=await fixtureRoot(id),identity=await windowsRecoveryIdentity();
 await canonicalProtectedPath(root,{directory:true});
 const file=join(root,'fixture-owner.json');await canonicalProtectedPath(file);
 const marker=JSON.parse(await readFile(file,'utf8'));
 if(!exact(marker,['fixtureVersion','kind','fixtureId','operatorSid','runtimeServiceSid'])||marker.fixtureVersion!==1||
    marker.kind!=='synthetic-s3d-windows-acl'||marker.fixtureId!==id||marker.operatorSid!==identity.sid||
    !/^S-1-5-80-(?:\d+-){4}\d+$/.test(marker.runtimeServiceSid)||marker.runtimeServiceSid===identity.sid)
  throw fail('FIXTURE_MARKER_INVALID');
 validateRecoveryAcl(await windowsFileAcl(file),{identity,runtimeServiceSid:marker.runtimeServiceSid,policy:true});
 return {root,identity,marker,policy:join(root,'policy','recovery-policy.json'),
  authorization:join(root,'journal','authorization','authorization-acl-probe.json')};
}
export async function attemptAclChange(id,subject,mode){
 const f=await readProtectedFixture(id);
 const paths={policy:f.policy,authorization:f.authorization,'owner-attempt':join(f.root,'negative','normal-owner-attempt.json')};
 if(!Object.hasOwn(paths,subject)||!['owner','dacl'].includes(mode)||mode==='owner'&&subject!=='owner-attempt')throw fail('FIXTURE_ARGUMENTS_INVALID');
 const actual=await canonicalProtectedPath(paths[subject]);
 // Called only after readProtectedFixture binds the acceptance suite to its own root.
 const encoded=Buffer.from(actual).toString('base64');
 const script="$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encoded+"'));$a=[IO.File]::GetAccessControl($p);$before=$a.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All);"+
  (mode==='owner'?"$a.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'));":
   "$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),[Security.AccessControl.FileSystemRights]::Modify,[Security.AccessControl.AccessControlType]::Allow));")+
  "try{[IO.File]::SetAccessControl($p,$a);'CHANGED'}catch{$e=$_.Exception;while($e.InnerException){$e=$e.InnerException};if($e -isnot [UnauthorizedAccessException] -and $e -isnot [InvalidOperationException]){throw};$after=[IO.File]::GetAccessControl($p);if($after.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All) -ceq $before){'DENIED'}else{throw 'ACL_CHANGED'}}";
 const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:5000,maxBuffer:4096});
 return stdout.trim();
}
export async function protectedFixtureCommand(argv){
 const [action,...args]=argv;
 testEnvironment();
 if(action==='prepare'&&args.length===0){
  const id=randomBytes(16).toString('hex'),root=await fixtureRoot(id);
  try{await lstat(root);throw fail('FIXTURE_ALREADY_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
  const quote=x=>"'"+x.replaceAll("'","''")+"'";
  return {FIXTURE_ID:id,ROOT:root,STATUS:'WAITING_FOR_MANUAL_ELEVATED_BOOTSTRAP',
   BOOTSTRAP_COMMAND:'pwsh.exe -NoProfile -File '+quote(helper)+' -Action Bootstrap -FixtureId '+quote(id),
   VERIFY_COMMAND:'node '+quote(fileURLToPath(import.meta.url))+' verify --fixture-id '+quote(id),
   ELEVATED_EVIDENCE_COMMAND:'node '+quote(fileURLToPath(new URL('./run-s3d-windows-evidence.js',import.meta.url)))+' --fixture-id '+quote(id),
   CLEANUP_COMMAND:'pwsh.exe -NoProfile -File '+quote(helper)+' -Action Cleanup -FixtureId '+quote(id)};
 }
 if(action==='verify'&&args.length===2&&args[0]==='--fixture-id'){
  const id=fixtureId(args[1]),identity=await windowsRecoveryIdentity();
  if(identity.elevated)throw fail('FIXTURE_VERIFICATION_MUST_BE_NON_ELEVATED');
  await readProtectedFixture(id);
  const child=spawn(process.execPath,['--test','--test-isolation=none','--test-reporter=tap',fileURLToPath(new URL('./protected-windows-fixture.acceptance.js',import.meta.url))],
   {windowsHide:true,stdio:'inherit',env:{...process.env,S3D_PROTECTED_FIXTURE_ID:id}});
  const code=await new Promise((r,j)=>{child.once('error',j);child.once('exit',r);});
  if(code!==0)throw fail('FIXTURE_ACCEPTANCE_FAILED');
  return {REAL_WINDOWS_PROTECTED_FIXTURE:'AVAILABLE',FIXTURE_ID:id,NON_ELEVATED_VERIFICATION:'PASS',PRODUCTION_AUTHORITY_ISSUED:'NO'};
 }
 throw fail('FIXTURE_ARGUMENTS_INVALID');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(await protectedFixtureCommand(process.argv.slice(2))));}
 catch(e){console.log(JSON.stringify({FIXTURE:'BLOCKED',code:/^FIXTURE_[A-Z_]+$/.test(e.code??'')?e.code:'FIXTURE_UNVERIFIED'}));process.exitCode=1;}
}
