import assert from 'node:assert/strict';
import {writeFile,readFile,mkdir} from 'node:fs/promises';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {randomBytes,randomUUID} from 'node:crypto';import {spawn} from 'node:child_process';import {once} from 'node:events';import net from 'node:net';import https from 'node:https';
import {createTestTls,ACCEPTED} from './fresh-environment.js';import {protectSyntheticFile} from '../test-support/runtime-tls.js';
import {loadRuntimeConfig} from '../production/runtime-config.js';
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const productionEnv={NODE_ENV:'production',KTV_HTTP_ENV:'production',KTV_DEPLOYMENT_ENV:'production'};
export async function launcher(f,{database=f.active.database,label='fake',formal=false,previous=false}={}){
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const domain='ktv-smoke.127.0.0.1.sslip.io',tls=f.tls??=await createTestTls(domain),user='s5e_'+randomBytes(8).toString('hex'),password=randomBytes(32).toString('base64url');
 f.secretMarkers.add(password);f.secretMarkers.add(tls.privateKey);await f.serverGuard();await f.setup.query('CREATE USER ?@? IDENTIFIED BY ?',[user,'127.0.0.1',password]);f.users.add(user);await f.setup.query('GRANT SELECT,INSERT,UPDATE,DELETE ON '+database+'.* TO ?@?',[user,'127.0.0.1']);
 const logs=join(f.dirs.logs,label);await mkdir(logs);const configPath=join(f.dirs.secrets,label+'-config.json'),secretPath=join(f.dirs.secrets,label+'-secret.json');
 const config={configVersion:1,applicationCommit:previous?f.packages.previous.commit:ACCEPTED,publicOrigin:'https://'+domain+':'+port,listenHost:'127.0.0.1',port,storeId:f.names.storeId,ledgerId:f.names.ledgerId,timeZone:'Asia/Shanghai',businessDateCutoff:'12:00',sessionRuleVersion:'opening-hours-v1',deviceControlMode:'disabled',liveControlEnabled:false,secretsFile:secretPath,logDirectory:logs,serviceAccountSid:tls.sid,backupPolicyConfigured:true,directoryAclReviewed:true,networkModel:'private-vpn',monitoring:{intervalMs:1000,probeTimeoutMs:2500,minFreeBytes:1,backupDirectory:f.dirs.backups,alertingRequired:!formal,offlineMs:1000,verificationMs:1000,tlsWarnDays:3,tlsErrorDays:2,tlsCriticalDays:1}};
 if(previous)delete config.monitoring;
 const secret={database:{host:'127.0.0.1',port:f.port,name:database,user,password},tls:{certificate:tls.certificate,privateKey:tls.privateKey}};
 await writeFile(configPath,JSON.stringify(config));await writeFile(secretPath,JSON.stringify(secret));await protectSyntheticFile(configPath,tls.sid);await protectSyntheticFile(secretPath,tls.sid);
 await loadRuntimeConfig(configPath,productionEnv);
 const application=previous?f.packages.previous.app:f.packages.current.app,controlPath=join(f.dirs.secrets,label+'-control.json');
 await writeFile(controlPath,JSON.stringify({id:f.names.id,root:f.root,application,database,configPath,serverUuid:f.identity.server_uuid}));
 try{await readFile(join(f.root,'controls.json'));}catch{await writeFile(join(f.root,'controls.json'),JSON.stringify({online:true,clock:'2026-10-10T07:00:00.000Z',clockSetAt:Date.now()}));}
 let child,output='';
 const request=(path,{method='GET',headers={},body,loseResponse=false}={})=>new Promise((resolve,reject)=>{
  const req=https.request({host:'127.0.0.1',port,servername:domain,ca:tls.ca,agent:false,path,method,headers:{Host:new URL(config.publicOrigin).host,...headers}},res=>{let text='';res.on('data',v=>text+=v);res.on('end',()=>{if(loseResponse)return reject(Error('SYNTHETIC_RESPONSE_LOST'));resolve({status:res.statusCode,headers:res.headers,text,json:()=>JSON.parse(text)});});});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
 });
 const start=()=>{
  if(child&&child.exitCode===null&&child.signalCode===null)throw Error('REHEARSAL_CHILD_RUNNING');
  const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TEMP:process.env.TEMP,TMP:process.env.TMP,USERPROFILE:process.env.USERPROFILE,...(formal?productionEnv:{NODE_ENV:'test',KTV_HTTP_ENV:'test',KTV_DEPLOYMENT_ENV:'test'})};
  child=spawn(process.execPath,formal?[join(application,'production/start.js'),'--config-file',configPath]:[fileURLToPath(new URL('./runtime-child.js',import.meta.url)),controlPath],{cwd:f.root,windowsHide:true,stdio:['pipe','pipe','pipe'],env});f.children.add(child);
  child.stdout.on('data',d=>output=(output+d).slice(-100000));child.stderr.on('data',d=>output=(output+d).slice(-100000));return child;
 };
 const wait=async()=>{for(let n=0;n<180;n++){if(child.exitCode!==null||child.signalCode!==null)throw Error('REHEARSAL_CHILD_EXIT '+output);try{const r=await request('/health/ready');if(r.status===200)return r;}catch{}await sleep(100);}throw Error('REHEARSAL_READY_TIMEOUT '+output);};
 const stop=async()=>{if(child&&child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.stdin.end('STOP\n');const [code]=await exit;assert.equal(code,0,'runtime stop');}};
 const crash=async()=>{const exit=once(child,'exit');child.kill('SIGKILL');await exit;};
 const controls=async patch=>{const path=join(f.root,'controls.json'),old=JSON.parse(await readFile(path,'utf8'));await writeFile(path,JSON.stringify({...old,...patch,...(patch.clock?{clockSetAt:Date.now()}:{})}));};
 const login=async(person=f.source.people[0])=>{const r=await request('/api/v1/auth/login',{method:'POST',headers:{Origin:config.publicOrigin,'Content-Type':'application/json'},body:{loginIdentifier:person.loginIdentifier,password:f.source.password}});assert.equal(r.status,200,'login '+r.text);const cookie=r.headers['set-cookie'][0].split(';')[0];f.secretMarkers.add(cookie.split('=')[1]);f.secretMarkers.add(r.json().csrfToken);return {cookie,csrf:r.json().csrfToken,person};};
 const call=async(session,path,options={})=>request(path,{...options,headers:{Cookie:session.cookie,Origin:config.publicOrigin,'X-CSRF-Token':session.csrf,'Content-Type':'application/json',...options.headers}});
 const snapshot=async(session)=>{const r=await call(session,'/api/v1/store/snapshot');assert.equal(r.status,200);return r.json();};
 const command=async(session,action,payload,body)=>{body??={operationKey:randomUUID(),expectedRevision:(await snapshot(session)).revision,payload};const r=await call(session,'/api/v1/commands/'+action,{method:'POST',body});return {...r,body};};
 return {config,configPath,secretPath,secret,tls,port,user,password,logs,request,start,wait,stop,crash,controls,login,call,snapshot,command,get child(){return child;},get output(){return output;}};
}
