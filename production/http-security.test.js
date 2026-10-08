import test from 'node:test';import assert from 'node:assert/strict';
import https from 'node:https';import http from 'node:http';import net from 'node:net';
import { secureRequest,createTransportLoginLimiter,HTTP_LIMITS,SECURITY_HEADERS } from './http-security.js';
import { createProductionRuntime } from './runtime.js';
import { syntheticTls } from '../test-support/runtime-tls.js';
import { createSafeLogger } from './runtime-log.js';
const origin='https://ktv.example.invalid:8443';
const request=(patch={})=>({url:'/',rawHeaders:['Host','ktv.example.invalid:8443'],headers:{host:'ktv.example.invalid:8443'},socket:{encrypted:true},...patch});
test('direct TLS accepts only exact configured Host, never forwarded scheme/host or plaintext',()=>{
 assert.equal(secureRequest(request(),origin),null);
 for(const r of [request({socket:{encrypted:false}}),request({headers:{host:'evil.invalid'}}),request({headers:{host:'ktv.example.invalid:8443','x-forwarded-proto':'https'}}),request({headers:{host:'ktv.example.invalid:8443',forwarded:'proto=https'}}),request({url:'https://evil.invalid/'}),request({rawHeaders:['Host','ktv.example.invalid:8443','Host','evil.invalid']})])assert.equal(secureRequest(r,origin),'https_boundary_denied');
 assert.equal(secureRequest(request({headers:{host:'ktv.example.invalid:8443','content-length':String(HTTP_LIMITS.maxBodyBytes+1)}}),origin),'payload_too_large');
});
test('bounded source/account login limiter is recoverable and ignores forwarded source',()=>{
 let now=0;const limit=createTransportLoginLimiter({now:()=>now,maxKeys:4}),req={socket:{remoteAddress:'synthetic-source'},headers:{'x-forwarded-for':'fake'}};
 for(let n=0;n<12;n++)assert.equal(limit(req,'synthetic-account'),true);assert.equal(limit(req,'synthetic-account'),false);
 now=15*60000+1;assert.equal(limit(req,'synthetic-account'),true);
 assert.equal(limit({socket:{remoteAddress:'other'}},'other'),true);assert.equal(limit({socket:{remoteAddress:'third'}},'third'),false);
});
test('real HTTPS runtime rejects plaintext, spoofed headers, oversized requests and drains bounded work',{timeout:30000},async()=>{
 const tls=await syntheticTls(),reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const logs=[],logger=createSafeLogger({write:s=>logs.push(s)});let blocked=false,closed=false,release,entered;
 const began=new Promise(r=>{entered=r;});
 const services={readiness:async()=>({ready:!blocked,blockers:blocked?[{code:'RECOVERY_PAUSED'}]:[]}),stopWorker:async()=>{},close:async()=>{closed=true;},async handle(req,res){
  if(req.url==='/api/inflight'){entered();await new Promise(r=>{release=r;});}
  res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');return true;
 }};
 const loaded={config:{applicationCommit:'a'.repeat(40),publicOrigin:'https://ktv-smoke.127.0.0.1.sslip.io:'+port,port,listenHost:'127.0.0.1',backupPolicyConfigured:true},configFingerprint:'b'.repeat(64),tls:{cert:tls.certificate,key:tls.privateKey},redactionSecrets:[]};
 const runtime=createProductionRuntime(loaded,{logger,services});await runtime.start();
 const get=(path,headers={},method='GET')=>new Promise((resolve,reject)=>{const req=https.request({host:'127.0.0.1',port,path,method,servername:'ktv-smoke.127.0.0.1.sslip.io',ca:tls.certificate,headers:{Host:new URL(loaded.config.publicOrigin).host,...headers}},res=>{let body='';res.on('data',c=>{body+=c;});res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});req.on('error',error=>{error.message=path+': '+error.message;reject(error);});req.end();});
 try{
  assert.equal((await get('/health/live')).status,200);assert.equal((await get('/health/ready')).status,200);
  const root=await get('/');assert.equal(root.status,200);for(const [key,value]of Object.entries(SECURITY_HEADERS))assert.equal(root.headers[key.toLowerCase()],value);
  assert.equal((await get('/api/test',{'X-Forwarded-Proto':'https'})).status,403);assert.equal((await get('/api/test',{Host:'evil.invalid'})).status,403);
  assert.equal((await get('/api/test',{'Content-Length':String(HTTP_LIMITS.maxBodyBytes+1)},'POST')).status,413);
  await assert.rejects(new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port,path:'/api/test'},res=>resolve(res));req.on('error',reject);}));
  blocked=true;assert.equal((await get('/health/live')).status,200);assert.equal((await get('/health/ready')).status,503);assert.equal((await get('/api/test')).status,503);blocked=false;
  assert.equal(runtime.server.headersTimeout,5000);assert.equal(runtime.server.requestTimeout,15000);assert.equal(runtime.server.keepAliveTimeout,5000);
  const inflight=get('/api/inflight');await began;
  const stopping=runtime.shutdown();assert.equal(closed,false);
  try{assert.equal((await get('/api/new-write',{},'POST')).status,503);}catch(error){assert.ok(['ECONNREFUSED','ECONNRESET','EPIPE'].includes(error.code));}
  release();assert.equal((await inflight).status,200);await stopping;assert.equal(closed,true);
  assert.ok(logs.some(s=>s.includes('runtime_stopped')));
 }finally{release?.();await runtime.shutdown();}
});

test('production streamed JSON oversize returns stable 413 code without buffering the rest',async()=>{
 const {Readable}=await import('node:stream'),{readJson,HTTP_STATUS}=await import('../http/transport.js');
 const req=Readable.from([Buffer.alloc(16*1024+1)]);req.headers={'content-type':'application/json'};req.ktvProduction=true;
 await assert.rejects(readJson(req),{code:'payload_too_large'});assert.equal(HTTP_STATUS.payload_too_large,413);assert.equal(HTTP_STATUS.rate_limited,429);
});
