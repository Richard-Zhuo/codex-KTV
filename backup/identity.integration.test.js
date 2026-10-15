import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,access} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {withProductionRuntimeFixture} from '../test-support/production-runtime-fixture.js';
import {protectSyntheticFile} from '../test-support/runtime-tls.js';
import {protectActivationPath} from '../production/activation-receipt.js';
import {packageAccepted,unpackAccepted,runtimePath} from '../rehearsal/artifact.js';
import {sha} from '../shared/release-artifact.js';
import {verifyArtifact} from './format.js';
import {inspectProductionRestore} from '../recovery/production-plan.js';
const run=promisify(execFile),repository=fileURLToPath(new URL('../',import.meta.url));
const production={NODE_ENV:'production',KTV_HTTP_ENV:'production',KTV_DEPLOYMENT_ENV:'production'};
test('S4 actual Git-free packaged backup CLI, protected identity, and read-only restore preflight',
 {skip:!process.env.LEDGER_MYSQL_TEST_URL,timeout:240000},()=>withProductionRuntimeFixture(async f=>{
 const source=join(f.dir,'candidate-source'),installed=join(f.dir,'installed'),artifact=join(f.dir,'controlled-artifact.json'),backupConfig=join(f.dir,'backup-config.json');
 await mkdir(source);
 const listed=(await run('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:repository,windowsHide:true})).stdout.split('\0').filter(runtimePath);
 for(const path of listed){const dest=join(source,path);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,await readFile(join(repository,path)));}
 await run('git',['init','-b','main'],{cwd:source,windowsHide:true});
 await run('git',['add','.'],{cwd:source,windowsHide:true});
 await run('git',['-c','user.name=S4 owned fixture','-c','user.email=s4-fixture@example.invalid','commit','-m','owned candidate snapshot'],{cwd:source,windowsHide:true});
 const commit=(await run('git',['rev-parse','HEAD'],{cwd:source,windowsHide:true})).stdout.trim();
 const packaged=await packageAccepted({repository:source,dependencyRoot:repository,commit,acceptedCommits:[commit],output:artifact});
 await unpackAccepted({artifact,expectedChecksum:packaged.sha256,commit,destination:installed});
 await protectSyntheticFile(artifact,f.tls.sid);
 await assert.rejects(access(join(installed,'.git')),{code:'ENOENT'});
 const backupRoot=join(f.dir,'s4-backups');await mkdir(backupRoot);
 const journal=join(f.logs,'s4-journal');await mkdir(journal);await protectActivationPath(journal,f.tls.sid,true);
 const config={...f.config,applicationCommit:commit,monitoring:{...f.config.monitoring,backupDirectory:backupRoot}};
 await writeFile(f.configPath,JSON.stringify(config));await protectSyntheticFile(f.configPath,f.tls.sid);
 const operator={databaseUrl:f.target.databaseUrl,environment:'production',storeId:f.storeId,ledgerId:f.ledgerId,serverUuid:f.identity.server_uuid,
  runtimeConfigFile:f.configPath,releaseArtifactFile:artifact,releaseArtifactChecksum:packaged.sha256};
 const save=async value=>{await writeFile(backupConfig,JSON.stringify(value));await protectSyntheticFile(backupConfig,f.tls.sid);};
 await save(operator);
 const noGitPath=[join(process.env.SystemRoot,'System32'),join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0')].join(';');
 const noGit={...process.env,...production,PATH:noGitPath};delete noGit.NODE_OPTIONS;delete noGit.NODE_TLS_REJECT_UNAUTHORIZED;
 await assert.rejects(run('git',['--version'],{env:noGit,windowsHide:true}),{code:'ENOENT'});
 const invoke=async(label,{env=noGit,cwd=f.dir}={})=>{
  const output=join(backupRoot,label);
  const argv=[join(installed,'backup/cli.js'),'backup','--config-file',backupConfig,'--output-dir',output,'--confirm',f.identity.server_uuid+'/'+f.database+'/'+f.storeId+'/'+f.ledgerId];
  try{const r=await run(process.execPath,argv,{cwd,env,windowsHide:true,timeout:60000,maxBuffer:65536});return {exit:0,stdout:r.stdout,stderr:r.stderr,output};}
  catch(e){return {exit:e.code,stdout:e.stdout??'',stderr:e.stderr??'',output};}
 };
 const success=await invoke('s4-positive');
 assert.equal(success.exit,0,success.stderr);
 const result=JSON.parse(success.stdout),verified=await verifyArtifact(result.directory,{expectedChecksum:result.checksum,storeId:f.storeId,ledgerId:f.ledgerId});
 assert.equal(verified.manifest.applicationCommit,commit);assert.equal(verified.manifest.backupFormatVersion,1);
 assert.deepEqual((await readdir(result.directory)).sort(),['data.json','manifest.json','manifest.sha256']);
 for(const name of await readdir(result.directory))await protectSyntheticFile(join(result.directory,name),f.tls.sid);
 await protectActivationPath(result.directory,f.tls.sid,true);
 // The identity-only reader must not need the TLS/DB secret bundle.
 await writeFile(f.configPath,JSON.stringify({...config,secretsFile:join(f.dir,'absent-secret-bundle.json')}));await protectSyntheticFile(f.configPath,f.tls.sid);
 assert.equal((await invoke('s4-no-runtime-secrets')).exit,0);
 await writeFile(f.configPath,JSON.stringify(config));await protectSyntheticFile(f.configPath,f.tls.sid);
 const reject=async(label)=>{
  const r=await invoke(label);assert.equal(r.exit,1,r.stdout+r.stderr);
  assert.match(r.stderr,/BACKUP_RELEASE_IDENTITY_REJECTED/);
  await assert.rejects(access(r.output),{code:'ENOENT'});
  for(const secret of [f.runtimeSecrets.database.password,f.runtimeSecrets.tls.privateKey])assert.equal(r.stdout.includes(secret)||r.stderr.includes(secret),false);
 };
 await save({...operator,releaseArtifactFile:join(f.dir,'missing-artifact.json')});await reject('s4-missing');
 await save({...operator,releaseArtifactChecksum:'bad'});await reject('s4-invalid-digest');
 await save(operator);
 const artifactBytes=await readFile(artifact);
 await writeFile(artifact,'{');await save({...operator,releaseArtifactChecksum:sha('{')});await reject('s4-malformed');
 const invalid=JSON.parse(artifactBytes);invalid.applicationCommit='bad';await writeFile(artifact,JSON.stringify(invalid));await save({...operator,releaseArtifactChecksum:sha(JSON.stringify(invalid))});await reject('s4-invalid-commit');
 await writeFile(artifact,artifactBytes);await save(operator);
 await writeFile(f.configPath,JSON.stringify({...config,applicationCommit:'b'.repeat(40)}));await protectSyntheticFile(f.configPath,f.tls.sid);await reject('s4-mismatch');
 await writeFile(f.configPath,JSON.stringify({...config,applicationCommit:'bad'}));await protectSyntheticFile(f.configPath,f.tls.sid);await reject('s4-runtime-invalid-commit');
 await writeFile(f.configPath,JSON.stringify(config));await protectSyntheticFile(f.configPath,f.tls.sid);
 const cli=join(installed,'backup/cli.js'),cliBytes=await readFile(cli);
 await writeFile(cli,Buffer.concat([cliBytes,Buffer.from('\n// altered installed bytes\n')]));await reject('s4-installed-altered');await writeFile(cli,cliBytes);
 // Changing both metadata and its own file hashes still fails the independent pinned digest.
 const changed=JSON.parse(artifactBytes);changed.applicationCommit='b'.repeat(40);await writeFile(artifact,JSON.stringify(changed));await reject('s4-artifact-replaced');await writeFile(artifact,artifactBytes);
 const link=join(f.dir,'artifact-link');const {symlink}=await import('node:fs/promises');
 await symlink(dirname(artifact),link,'junction');await save({...operator,releaseArtifactFile:join(link,'controlled-artifact.json')});await reject('s4-path-junction');await save(operator);
 // Actual Windows ACL failure; restore the owned file's descriptor afterwards.
 const encoded=Buffer.from(artifact).toString('base64');
 const aclScript="$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encoded+"'));$a=[IO.File]::GetAccessControl($p);$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow));[IO.File]::SetAccessControl($p,$a)";
 await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(aclScript,'utf16le').toString('base64')],{windowsHide:true});
 await reject('s4-acl-denied');await protectSyntheticFile(artifact,f.tls.sid);
 // Git exists with a deliberately unrelated HEAD; it cannot influence installed identity.
 await run('git',['-c','user.name=S4 owned fixture','-c','user.email=s4-fixture@example.invalid','commit','--allow-empty','-m','unrelated HEAD'],{cwd:source,windowsHide:true});
 assert.notEqual((await run('git',['rev-parse','HEAD'],{cwd:source,windowsHide:true})).stdout.trim(),commit);
 const withGit=await invoke('s4-git-present',{cwd:source,env:{...process.env,...production}});
 assert.equal(withGit.exit,0,withGit.stderr);
 assert.equal((await verifyArtifact(JSON.parse(withGit.stdout).directory,{expectedChecksum:JSON.parse(withGit.stdout).checksum,storeId:f.storeId,ledgerId:f.ledgerId})).manifest.applicationCommit,commit);
 await save({...operator,releaseArtifactFile:join(f.dir,'missing-with-git.json')});
 const noFallback=await invoke('s4-no-git-fallback',{cwd:source,env:{...process.env,...production}});
 assert.equal(noFallback.exit,1);assert.match(noFallback.stderr,/BACKUP_RELEASE_IDENTITY_REJECTED/);
 await assert.rejects(access(noFallback.output),{code:'ENOENT'});await save(operator);
 console.log(JSON.stringify({S4:{gitUnavailableBackup:true,gitPresentUnrelatedHeadIgnored:true,noGitFallback:true,
  installedCommit:commit,backupCommit:verified.manifest.applicationCommit,format:verified.manifest.backupFormatVersion,
  missingMalformedInvalidMismatchPathAclContentRejected:true,runtimeSecretBundleNotRead:true}}));
 // Read-only production preflight on this fixture only. No create-plan or restore action.
 const admin='s4meta_'+randomBytes(6).toString('hex'),password=randomBytes(32).toString('base64url'),operatorPath=join(f.dir,'metadata-operator.json');
 try{
  await f.setup.query('CREATE USER ?@? IDENTIFIED BY ?',[admin,'127.0.0.1',password]);
  await f.setup.query('GRANT SHOW DATABASES ON *.* TO ?@?',[admin,'127.0.0.1']);
  const url=new URL(f.target.databaseUrl);url.username=admin;url.password=password;url.pathname='/';
  await writeFile(operatorPath,JSON.stringify({databaseUrl:url.href}));await protectSyntheticFile(operatorPath,f.tls.sid);
  const dirEncoded=Buffer.from(backupRoot).toString('base64');
  const dirScript="$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+dirEncoded+"'));$a=[Security.AccessControl.DirectorySecurity]::new();$a.SetAccessRuleProtection($true,$false);$a.SetOwner([Security.Principal.SecurityIdentifier]::new('"+f.tls.sid+"'));foreach($id in @('"+f.tls.sid+"','S-1-5-18','S-1-5-32-544')){$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($id),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))};[IO.Directory]::SetAccessControl($p,$a)";
  await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(dirScript,'utf16le').toString('base64')],{windowsHide:true});
  const recoveryConfig={...config,recovery:{journalDirectory:journal,operatorDbSecretsFile:operatorPath}};
  await writeFile(f.configPath,JSON.stringify(recoveryConfig));await protectSyntheticFile(f.configPath,f.tls.sid);
  await f.connection.execute("UPDATE production_bootstrap_events SET facts=JSON_SET(facts,'$.database',?) WHERE JSON_UNQUOTE(JSON_EXTRACT(facts,'$.source'))='first-install-ledger'",[f.database]);
  const before=JSON.stringify((await f.connection.query('SELECT revision,state_checksum FROM ledger_heads'))[0]);
  const plan=await inspectProductionRestore({runtimeConfigFile:f.configPath,artifactDirectory:result.directory,expectedChecksum:result.checksum,load:async path=>(await import('../production/runtime-config.js')).loadRuntimeConfig(path,production)});
  assert.equal(plan.applicationCommit,commit);assert.equal(plan.status,'PREPARED');
  assert.equal(JSON.stringify((await f.connection.query('SELECT revision,state_checksum FROM ledger_heads'))[0]),before);
  assert.deepEqual(await readdir(journal),[]);
 }finally{await f.setup.query('DROP USER IF EXISTS ?@?',[admin,'127.0.0.1']);}
}));
