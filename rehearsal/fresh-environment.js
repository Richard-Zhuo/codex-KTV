// Explicit opt-in, Windows-only disposable server. Never reads a production URL.
import {mkdir,writeFile,readFile,access} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {randomBytes,randomUUID} from 'node:crypto';import {spawn,execFile} from 'node:child_process';import {promisify} from 'node:util';import {once} from 'node:events';import net from 'node:net';import mysql from 'mysql2/promise';
import {scopeNames,assertOwnedRoot,assertOwnedDatabase,removeOwnedRoot} from './scope.js';import {packageAccepted,unpackAccepted} from './artifact.js';import {migrateFresh} from './migration.js';
const run=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const ACCEPTED='c1502c0fb0713ef040b210e5ea35f6c31079b7ee',PREVIOUS='e57af99dd49a46771ff20dd495f71f22d9db97ff';
export async function freshEnvironment(repository,{port=33315,packages:buildPackages=true}={}){
 if(process.env.STAGE5E_RUN!=='synthetic-only'||process.platform!=='win32'||![33313,33315].includes(port)||[process.env.NODE_ENV,process.env.KTV_HTTP_ENV,process.env.KTV_DEPLOYMENT_ENV].some(v=>v&&v!=='development'&&v!=='test'))throw Error('REHEARSAL_EXPLICIT_SCOPE_REQUIRED');
 const names=scopeNames(randomBytes(8).toString('hex')),root=join(tmpdir(),names.rootName),registered=new Set(),children=new Set(),users=new Set(),pools=new Set();
 let server,setup,identity,cleaned=false;
 await mkdir(root);await writeFile(join(root,'rehearsal-owner.json'),JSON.stringify({id:names.id,kind:'synthetic-cutover-rehearsal'}),{flag:'wx'});
 const dirs={};for(const key of ['data','logs','backups','secrets','artifacts']){dirs[key]=join(root,key);await mkdir(dirs[key]);}
 const secretMarkers=new Set();
 const mysqlExe='D:/MySQL/MySQL Server 8.4/bin/mysqld.exe',dbUrl=name=>'mysql://root@127.0.0.1:'+port+'/'+name;
 async function serverGuard(){await assertOwnedRoot(root,names.id);const [[r]]=await setup.query('SELECT @@port AS port,@@datadir AS datadir,@@server_uuid AS uuid');if(r.port!==port||resolve(r.datadir)!==resolve(dirs.data)||r.uuid!==identity.server_uuid)throw Error('REHEARSAL_SERVER_MISMATCH');}
 async function createDatabase(name){await serverGuard();if(!/^[a-z][a-z0-9_]{0,63}$/.test(name)||!(name===names.database||name.startsWith('jbhh_ktv_restore_s5e_')&&name.endsWith('_'+names.id)))throw Error('REHEARSAL_DATABASE_DENIED');const [old]=await setup.execute('SELECT SCHEMA_NAME FROM information_schema.schemata WHERE SCHEMA_NAME=?',[name]);if(old.length)throw Error('REHEARSAL_DATABASE_EXISTS');await setup.query('CREATE DATABASE '+name+' CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');registered.add(name);return mysql.createPool({uri:dbUrl(name),connectionLimit:8,supportBigNumbers:true,bigNumberStrings:true});}
 async function registerRestore(name){await serverGuard();assertOwnedDatabase(name,names,new Set([name]));registered.add(name);}
 async function cleanup(){
  if(cleaned)return {id:names.id,root:'absent',mysqlProcess:'absent'};
  await assertOwnedRoot(root,names.id);
  const result={id:names.id};let sqlCleanup=false;
  for(const child of children)if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}
  result.runtimeProcesses='absent';
  for(const pool of pools)await pool.end().catch(()=>{});
  try{
   if(setup&&identity){await serverGuard();for(const user of users)await setup.query('DROP USER IF EXISTS ?@?',[user,'127.0.0.1']);
    for(const name of registered){assertOwnedDatabase(name,names,registered);await setup.query('DROP DATABASE IF EXISTS '+name);}
    const [left]=await setup.execute('SELECT SCHEMA_NAME FROM information_schema.schemata WHERE SCHEMA_NAME=? OR SCHEMA_NAME LIKE ?',[names.database,'%'+names.id]);if(left.length)throw Error('REHEARSAL_DATABASE_CLEANUP_FAILED');
    sqlCleanup=true;await setup.query('SHUTDOWN');
   }
  }catch(error){result.sqlCleanupFailure=error.code??'REHEARSAL_CLEANUP_SQL_UNAVAILABLE';}finally{
   await setup?.end().catch(()=>{});
   if(server&&server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill('SIGKILL');await done;}
  }
  result.mysqlProcess='absent';
  await removeOwnedRoot(root,names.id);cleaned=true;
  return {...result,databases:'absent',accounts:'absent',root:'absent',sqlCleanup};
 }

 try{
  const probe=net.createServer();await new Promise((r,j)=>{probe.once('error',j);probe.listen(port,'127.0.0.1',r);});await new Promise(r=>probe.close(r));
  await run(mysqlExe,['--no-defaults','--initialize-insecure','--datadir='+dirs.data],{windowsHide:true,timeout:60000,maxBuffer:65536});
  server=spawn(mysqlExe,['--no-defaults','--datadir='+dirs.data,'--port='+port,'--bind-address=127.0.0.1','--mysqlx=OFF','--console'],{windowsHide:true,stdio:['ignore','ignore','pipe']});server.stderr.resume();
  for(let n=0;n<100;n++){try{setup=await mysql.createConnection({host:'127.0.0.1',port,user:'root'});break;}catch{if(server.exitCode!==null)throw Error('REHEARSAL_MYSQL_START_FAILED');await sleep(100);}}
  if(!setup)throw Error('REHEARSAL_MYSQL_START_FAILED');
  const [[r]]=await setup.query('SELECT @@server_uuid AS server_uuid,VERSION() AS version');identity=r;if(r.version!=='8.4.11')throw Error('REHEARSAL_MYSQL_VERSION_REQUIRED');
  const packages={},source=join(root,'accepted-source');
  if(buildPackages)await run('git',['clone','--no-hardlinks','--single-branch','--branch','main',repository,source],{windowsHide:true,timeout:60000,maxBuffer:65536});
  for(const [label,commit]of buildPackages?[['current',ACCEPTED],['previous',PREVIOUS]]:[]){
   const artifact=join(dirs.artifacts,label+'.json'),app=join(root,label+'-application'),facts=await packageAccepted({repository:source,dependencyRoot:repository,commit,acceptedCommits:[ACCEPTED,PREVIOUS],output:artifact});await unpackAccepted({artifact,expectedChecksum:facts.sha256,commit,destination:app});packages[label]={...facts,artifact,app,applicationRoot:pathToFileURL(app+'/')};
  }
  const f={secretMarkers,names,root,dirs,port,dbUrl,identity,setup,packages,registered,children,users,pools,serverGuard,createDatabase,registerRestore,cleanup};
  return f;
 }catch(error){await cleanup();throw error;}
}
export async function migrateDatabase(f,name,options){const pool=await f.createDatabase(name);f.pools.add(pool);const c=await pool.getConnection();try{const migration=await migrateFresh(c,f.packages.current.applicationRoot,options);return {pool,migration};}finally{c.release();}}
export async function createTestTls(host){
 const script="$ErrorActionPreference='Stop';$caKey=[Security.Cryptography.RSA]::Create(2048);$cr=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=KTV Stage5E Synthetic Temporary CA',$caKey,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1);$cr.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$false,0,$true));$cr.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign,$true));$start=[DateTimeOffset]::UtcNow.AddMinutes(-5);$ca=$cr.CreateSelfSigned($start,[DateTimeOffset]::UtcNow.AddDays(5));$key=[Security.Cryptography.RSA]::Create(2048);$r=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN="+host+"',$key,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1);$san=[Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new();$san.AddDnsName('"+host+"');$r.CertificateExtensions.Add($san.Build());$r.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true));$serial=[byte[]]::new(16);[Security.Cryptography.RandomNumberGenerator]::Fill($serial);$cert=$r.Create($ca,$start,[DateTimeOffset]::UtcNow.AddDays(4),$serial);@{ca=$ca.ExportCertificatePem();certificate=$cert.ExportCertificatePem();privateKey=$key.ExportPkcs8PrivateKeyPem();thumbprint=$ca.Thumbprint;sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}|ConvertTo-Json -Compress";
 const {stdout}=await run('pwsh.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,maxBuffer:65536});return JSON.parse(stdout);
}
export const uniquePerson=(label,permissions=[],policyAttributes=[])=>({principalId:randomUUID(),employeeId:randomUUID(),displayName:'REHEARSAL '+label,loginIdentifier:'rehearsal-'+label,enabled:true,template:label==='booking'||label==='limited'||label==='viewer'?'BOOKING_STAFF':'NIGHT_OPERATOR',permissions,policyAttributes});
