import { writeFile,mkdir } from 'node:fs/promises';
import { join } from 'node:path';import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';import { execFileSync,spawn } from 'node:child_process';
import { once } from 'node:events';import net from 'node:net';import https from 'node:https';
import mysql from 'mysql2/promise';
import { withBackupFixture } from './backup-fixture.js';
import { syntheticTls,protectSyntheticFile } from './runtime-tls.js';
import { backupDatabase,restoreDatabase,connect } from '../backup/mysql-backup.js';
import { verifyRecovery,resumeRecovery } from '../recovery/operator.js';
import { decodeLedgerSnapshot,encodeLedgerSnapshot } from '../ledger/mysql-snapshot.js';
import { BUSINESS_DAY_POLICY } from '../shared/business-day.js';import { SESSION_RULE_VERSION } from '../shared/business-session.js';
import { assertFixtureEnvironment } from './destructive-safety.js';
export async function withProductionRuntimeFixture(work){
 return withBackupFixture(async f=>{
  const head=await f.store.read(),state=head.state;
  for(const stock of [...Object.values(state.inventory),...Object.values(state.consumables)])stock.count=1000;
  const encoded=encodeLedgerSnapshot(state);await f.pool.execute('UPDATE ledger_heads SET state_json=?,state_checksum=? WHERE ledger_id=?',[encoded.json,encoded.checksum,f.ledgerId]);
  const backup=await backupDatabase({...f.backupArgs,outputDirectory:join(f.dir,'runtime-backup')}),target=f.targetArgs(backup,'stage5c');
  await restoreDatabase(target);await verifyRecovery(target);await resumeRecovery({...target,confirmation:target.confirmation+'/RESUME'});
  const connection=await connect(target.databaseUrl),database=new URL(target.databaseUrl).pathname.slice(1),user='stage5c_'+randomBytes(8).toString('hex'),dbPassword=randomBytes(32).toString('base64url');
  const tls=await syntheticTls(),domain='ktv-smoke.127.0.0.1.sslip.io';
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const logs=join(f.dir,'logs');await mkdir(logs);
  const configPath=join(f.dir,'runtime.json'),secretPath=join(f.dir,'secrets.json'),hostExe=join(f.dir,'service-host.exe');
  let userCreated=false,child;
  const config={configVersion:1,applicationCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:fileURLToPath(new URL('../',import.meta.url)),encoding:'utf8'}).trim(),publicOrigin:'https://'+domain+':'+port,listenHost:'127.0.0.1',port,storeId:f.storeId,ledgerId:f.ledgerId,timeZone:'Asia/Shanghai',businessDateCutoff:BUSINESS_DAY_POLICY.cutoff,sessionRuleVersion:SESSION_RULE_VERSION,deviceControlMode:'disabled',liveControlEnabled:false,secretsFile:secretPath,logDirectory:logs,serviceAccountSid:tls.sid,backupPolicyConfigured:true,directoryAclReviewed:true,networkModel:'private-vpn'};
  const secret={database:{host:'127.0.0.1',port:33313,name:database,user,password:dbPassword},tls:{certificate:tls.certificate,privateKey:tls.privateKey}};
  const request=(path,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
   const req=https.request({host:'127.0.0.1',port,servername:domain,ca:tls.certificate,agent:false,path,method,headers:{Host:new URL(config.publicOrigin).host,...headers}},res=>{let text='';res.on('data',c=>{text+=c;});res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text,json:()=>JSON.parse(text)}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  const start=()=>{
   if(child&&child.exitCode===null&&child.signalCode===null)throw Error('SYNTHETIC_CHILD_ALREADY_RUNNING');
   child=spawn(hostExe,['--console','--node',process.execPath,'--entry',fileURLToPath(new URL('../production/start.js',import.meta.url)),'--config',configPath],{cwd:f.dir,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env}});
   child.stdout.resume();child.stderr.resume();return child;
  };
  const wait=async (ready=true)=>{
   for(let n=0;n<120;n++){if(child.exitCode!==null||child.signalCode!==null)throw Error('SYNTHETIC_RUNTIME_EXIT_'+child.exitCode);try{const r=await request(ready?'/health/ready':'/health/live');if(r.status===200)return r;}catch{}await new Promise(r=>setTimeout(r,100));}
   throw Error('SYNTHETIC_RUNTIME_START_TIMEOUT');
  };
  const stop=async()=>{
   if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.stdin.end('STOP\n');const [code]=await exited;if(code!==0)throw Error('SYNTHETIC_RUNTIME_STOP_FAILED');}
  };
  try{
   await connection.query("UPDATE production_bootstrap_events SET environment='production'");
   await f.setup.query('CREATE USER ?@? IDENTIFIED BY ?',[user,'127.0.0.1',dbPassword]);userCreated=true;
   await f.setup.query('GRANT SELECT,INSERT,UPDATE,DELETE ON '+database+'.* TO ?@?',[user,'127.0.0.1']);
   await writeFile(configPath,JSON.stringify(config));await writeFile(secretPath,JSON.stringify(secret));
   await protectSyntheticFile(configPath,tls.sid);await protectSyntheticFile(secretPath,tls.sid);
   execFileSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',['/nologo','/target:exe','/platform:x64','/reference:System.ServiceProcess.dll','/out:'+hostExe,fileURLToPath(new URL('../deployment/KtvServiceHost.cs',import.meta.url))],{windowsHide:true,stdio:'pipe'});
   await work({...f,target,database,connection,config,runtimeSecrets:secret,configPath,secretPath,hostExe,logs,tls,domain,request,start,wait,stop,get child(){return child;}});
  }catch(error){if(error.sql)throw Object.assign(Error('SYNTHETIC_DATABASE_SETUP_FAILED'),{code:error.code});throw error;}
  finally{
   try{await stop();}finally{assertFixtureEnvironment();if(userCreated)await f.setup.query('DROP USER ?@?',[user,'127.0.0.1']);await connection.end();}
  }
 });
}
