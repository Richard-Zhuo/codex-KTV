// Explicit real-Windows primitive evidence. Disposable filesystem + HTTPS only; no MySQL/SCM service/UAC.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,lstat,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';import https from 'node:https';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {syntheticTls} from '../test-support/runtime-tls.js';import {createActivationReceiptStore,activationPaths,protectActivationPath,activationAclScript,validateActivationAcl,receiptDigest} from './activation-receipt.js';import {windowsFileAcl} from './runtime-config.js';import {windowsDirectoryAcl} from './wecom-smoke-config.js';import {ownProcessIdentity,observeListener} from './process-observation.js';import {observeActivation} from './activation-observation.js';
test('owned actual Windows receipt producer writes/replaces/reads strict ACL and invalidates with no operator-specific ACE',async()=>{
 if(process.platform!=='win32')throw Error('WINDOWS_EVIDENCE_REQUIRED');const tls=await syntheticTls(),identity=await ownProcessIdentity();const root=await mkdtemp(join(tmpdir(),'ktv-activation-win-'));
 try{
 const originalOwner=(await windowsDirectoryAcl(root)).owner;
 const beforeWrong=JSON.stringify(await windowsDirectoryAcl(root));
 await assert.rejects(()=>protectActivationPath(root,'S-1-5-21-999-999-999-999',true),e=>e.code==='RUNTIME_ACTIVATION_NOT_PROVEN'&&e.cause?.causeCode==='OWNER_MISMATCH'&&!String(e).includes(root));
 assert.equal(JSON.stringify(await windowsDirectoryAcl(root)),beforeWrong);
 const script=activationAclScript(root,tls.sid,true),prefix=script.slice(0,script.indexOf("$step='PERSIST_DACL'"));
 const inspect=prefix+"$flags=[Reflection.BindingFlags]'Instance,NonPublic';$a.GetType().GetMethod('ReadLock',$flags).Invoke($a,@());$result=@{};try{foreach($n in @('OwnerModified','AccessRulesModified','GroupModified')){$result[$n]=$a.GetType().GetProperty($n,$flags).GetValue($a,$null)}}finally{$a.GetType().GetMethod('ReadUnlock',$flags).Invoke($a,@())};$result|ConvertTo-Json -Compress}catch{throw}";
 const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(inspect,'utf16le').toString('base64')],{windowsHide:true,timeout:5000,maxBuffer:4096});
 assert.deepEqual(JSON.parse(stdout),{OwnerModified:false,AccessRulesModified:true,GroupModified:false});
 await protectActivationPath(root,tls.sid,true);assert.equal((await windowsDirectoryAcl(root)).owner,originalOwner);const loaded={config:{logDirectory:root,serviceAccountSid:tls.sid}},store=createActivationReceiptStore(loaded);await store.initialize();
 const receipt={version:1,processId:identity.pid,processCreatedAt:identity.createdAt,deploymentConfigFingerprint:'a'.repeat(64),databaseIdentity:{host:'127.0.0.1',port:33313,name:'synthetic_candidate',serverUuid:'11111111-1111-1111-1111-111111111111'},recoveryOperationId:'22222222-2222-2222-2222-222222222222',planDigest:'b'.repeat(64),activation:'RUNNING'};
 assert.equal(await store.publish(receipt),receiptDigest(receipt));assert.equal(receiptDigest(await store.read()),receiptDigest(receipt));
 const next={...receipt,planDigest:'c'.repeat(64)};await store.publish(next);assert.equal((await store.read()).planDigest,next.planDigest);
 const p=activationPaths(loaded);const fileAcl=await windowsFileAcl(p.file);assert.equal(fileAcl.owner,tls.sid);assert.equal(fileAcl.rules.some(r=>r.sid===tls.sid&&(r.rights&524288)!==0),false);assert.equal(fileAcl.rules.some(r=>r.sid==='S-1-5-32-544'&&(r.rights&(342|65536|262144|524288))!==0),false);validateActivationAcl(fileAcl,tls.sid,{producer:true});validateActivationAcl(await windowsDirectoryAcl(p.directory),tls.sid,{producer:true,directory:true});await store.invalidate();await assert.rejects(()=>lstat(p.file),{code:'ENOENT'});
 }finally{if(dirname(root)!==tmpdir())throw Error('OWNED_CLEANUP_SCOPE_DENIED');await rm(root,{recursive:true,force:true});}
});
test('owned actual Windows process creation identity + local TLS listener ownership + fresh challenge',async()=>{
 const tls=await syntheticTls(),identity=await ownProcessIdentity();const config={publicOrigin:'https://ktv-smoke.127.0.0.1.sslip.io:8443'};
 const server=https.createServer({cert:tls.certificate,key:tls.privateKey},(req,res)=>{const challenge=new URL(req.url,config.publicOrigin).searchParams.get('activationChallenge');res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({activation:{challenge,state:'ACTIVE',phase:'RUNNING',ready:true,workersActive:true,processId:identity.pid,processCreatedAt:identity.createdAt,receiptDigest:'a'.repeat(64)}}));});
 try{await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port,socket=await observeListener(port,identity.pid);assert.equal(socket.pid,process.pid);assert.equal(socket.host,'127.0.0.1');const c='b'.repeat(64),reply=await observeActivation(config,socket,c,{ca:tls.certificate});assert.equal(reply.challenge,c);assert.equal(reply.processCreatedAt,identity.createdAt);assert.equal(reply.peerAddress,socket.host);assert.equal(reply.peerPort,port);await assert.rejects(()=>observeListener(port,identity.pid+100000));
 await assert.rejects(()=>observeActivation(config,socket,c)); // self-signed fixture must fail without its explicit owned trust material
 }finally{server.closeIdleConnections();await new Promise(r=>server.close(r));}
});
