// Offline final-HTTP regression: real SDK + real urllib; no live entry or socket.
import test,{mock,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import dns from 'node:dns';import net from 'node:net';import tls from 'node:tls';
import http from 'node:http';import https from 'node:https';import dgram from 'node:dgram';

const scope={region:'oss-cn-shenzhen',bucket:'ktv-oss-acceptance-synthetic',
 endpoint:'https://oss-cn-shenzhen.aliyuncs.com',prefix:'oss-acceptance/e7dd29ba-5a7a-4cb8-9625-f18d659e42ce/'};
const address='https://'+scope.bucket+'.'+scope.region+'.aliyuncs.com/';
let captures=[],signed=[],authorizations=[],network=0,queryError='CAPTURE_STOP';
const forbidden=()=>{network++;throw Error('REAL_NETWORK_FORBIDDEN');};
for(const [owner,names]of [[dns,['lookup','resolve','resolve4','resolve6','lookupService']],
 [dns.promises,['lookup','resolve','resolve4','resolve6']],[net,['connect','createConnection']],
 [net.Socket.prototype,['connect']],[tls,['connect']],[http,['request','get']],
 [https,['get']],[dgram,['createSocket']]])
 for(const name of names)mock.method(owner,name,forbidden);
mock.method(globalThis,'fetch',forbidden);
if(globalThis.WebSocket)mock.method(globalThis,'WebSocket',forbidden);
mock.method(https,'request',options=>{
 captures.push({...options,headers:{...options.headers}});
 throw Object.assign(Error('SYNTHETIC_HTTP_CAPTURE_STOP'),{code:queryError});
});
mock.module('node:readline/promises',{exports:{createInterface(){return {
 async question(){return 'AUTHORIZE NONPRODUCTION OSS '+scope.region+' '+scope.bucket+' '+scope.prefix;},close(){}
};}}});
const require=createRequire(import.meta.url),sdkRequire=createRequire(require.resolve('ali-oss'));
const OSS=require('ali-oss'),urllib=sdkRequire('urllib'),sign=sdkRequire('./common/signUtils');
const originalCanonical=sign.getCanonicalRequest,originalAuthorization=OSS.prototype.authorizationV4;
mock.method(sign,'getCanonicalRequest',function(...args){
 const value=originalCanonical.apply(this,args);signed.push(value);return value;
});
mock.method(OSS.prototype,'authorizationV4',function(method,request,...rest){
 // Pin synthetic request time before signing, leaving the same header on the request.
 request.headers['x-oss-date']='20261024T175620Z';
 const value=originalAuthorization.call(this,method,request,...rest);authorizations.push(value);return value;
});
const auth=await import('./oss-acceptance-authorization.js');
const {createOssSdkAcceptanceBridge}=await import('./oss-sdk-bridge.js');
const entry=fileURLToPath(new URL('./oss-acceptance.js',import.meta.url));
const envKeys=['NODE_ENV','KTV_HTTP_ENV','KTV_DEPLOYMENT_ENV','NODE_OPTIONS','NODE_DEBUG','NODE_DEBUG_NATIVE',
 'DEBUG','NODE_TLS_REJECT_UNAUTHORIZED','URLLIB_ENABLE_PROXY','URLLIB_PROXY'];
let oldEnv,oldArgv,inTTY,outTTY;
beforeEach(()=>{
 oldEnv=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
 for(const k of envKeys)delete process.env[k];process.env.NODE_ENV='test';
 oldArgv=process.argv;process.argv=[process.execPath,entry,'--run-nonproduction'];
 inTTY=Object.getOwnPropertyDescriptor(process.stdin,'isTTY');outTTY=Object.getOwnPropertyDescriptor(process.stdout,'isTTY');
 Object.defineProperty(process.stdin,'isTTY',{value:true,configurable:true});
 Object.defineProperty(process.stdout,'isTTY',{value:true,configurable:true});
 captures=[];signed=[];authorizations=[];network=0;queryError='CAPTURE_STOP';
});
afterEach(()=>{
 process.argv=oldArgv;
 for(const k of envKeys){if(oldEnv[k]===undefined)delete process.env[k];else process.env[k]=oldEnv[k];}
 if(inTTY)Object.defineProperty(process.stdin,'isTTY',inTTY);else delete process.stdin.isTTY;
 if(outTTY)Object.defineProperty(process.stdout,'isTTY',outTTY);else delete process.stdout.isTTY;
 assert.equal(network,0);
});
const credentials=role=>({accessKeyId:'SYNTHETIC_'+role,accessKeySecret:'SYNTHETIC_SECRET_ONLY'});
const clients=async()=>auth.consumeOssAcceptancePermit(await auth.authorizeOssAcceptance(scope));
const adapter=async()=>createOssSdkAcceptanceBridge(await auth.authorizeOssAcceptance(scope),
 {readCredentials:credentials('READ'),writeCredentials:credentials('WRITE')});
const sdk=transport=>new OSS({...credentials('WRITE'),...scope,secure:true,authorizationV4:true,
 retryMax:0,timeout:5000,enableProxy:false,cname:false,internal:false,urllib:transport});

test('V4 versioning preserves SDK signing and normalizes only the admitted query at final HTTPS',async t=>{
 assert.equal(require('ali-oss/package.json').version,'6.23.0');
 assert.equal(sdkRequire('urllib/package.json').version,'2.44.1');
 assert.equal(sdkRequire('qs/package.json').version,'6.16.1');
 // Control: untouched official SDK still emits "="; the candidate must not patch it.
 await assert.rejects(sdk(urllib).getBucketVersioning(scope.bucket,{timeout:5000}));
 const before=captures[0],beforeCanonical=signed[0],beforeAuthorization=authorizations[0];
 assert.equal(before.path,'/?versioning=');
 const a=await adapter();
 await assert.rejects(a.writer.putIfAbsent({objectId:'probe',bytes:Buffer.from('SYNTHETIC')}),{code:'BACKUP_OSS_REJECTED'});
 assert.equal(captures.length,2);const after=captures[1],canonical=signed[1];
 assert.equal(canonical.split('\n')[2],'versioning');
 assert.equal(canonical.split('\n')[1],'/'+scope.bucket+'/');
 assert.equal(after.path,'/?versioning');assert.equal(after.method,'GET');
 assert.equal(after.host,scope.bucket+'.oss-cn-shenzhen.aliyuncs.com');assert.equal(after.port,443);
 assert.ok(canonical===beforeCanonical,'canonical request unchanged');
 assert.ok(authorizations[1]===beforeAuthorization,'SDK authorization unchanged');
 for(const name of ['authorization','x-oss-date','x-oss-content-sha256'])
  assert.ok(after.headers[name]===before.headers[name],'signed header unchanged: '+name);
 assert.equal(after.headers['x-oss-date'],'20261024T175620Z');
 assert.equal(after.headers['x-oss-content-sha256'],'UNSIGNED-PAYLOAD');
 assert.ok(after.headers.authorization.includes('/cn-shenzhen/oss/aliyun_v4_request'),'region scope unchanged');
 assert.equal(captures.filter(c=>c.method==='PUT').length,0);
 t.diagnostic(JSON.stringify({before:{canonicalQuery:'versioning',path:before.path},
  after:{canonicalQuery:'versioning',path:after.path},method:after.method,host:after.host,
  signatureHeadersUnchanged:true,realNetworkRequests:network}));
});

const invalidRequests=[
 ['bare query',address+'?versioning'],
 ['valued query',address+'?versioning=unexpected'],
 ['duplicate query',address+'?versioning=&versioning='],
 ['extra query',address+'?versioning=&other='],
 ['encoded query name',address+'?%76ersioning='],
 ['wrong bucket',address.replace(scope.bucket,'ktv-oss-acceptance-other')+'?versioning='],
 ['wrong region',address.replace('oss-cn-shenzhen','oss-cn-hangzhou')+'?versioning='],
 ['wrong domain',address.replace('aliyuncs.com','invalid.example')+'?versioning='],
 ['HTTP',address.replace('https:','http:')+'?versioning='],
 ['unexpected path',address+'other?versioning='],
 ['query via reader',address+'?versioning=',{reader:true}],
 ['query via PUT',address+'?versioning=',{method:'PUT'}],
 ['query via DELETE',address+'?versioning=',{method:'DELETE'}],
 ['query via HEAD',address+'?versioning=',{method:'HEAD'}],
 ['query via LIST',address+'?versioning=',{method:'LIST'}],
 ['query via COPY',address+'?versioning=',{method:'COPY'}],
 ['redirect option',address+'?versioning=',{followRedirect:true}],
 ['proxy option',address+'?versioning=',{proxy:'http://127.0.0.1:1'}],
 ['proxy enabled',address+'?versioning=',{enableProxy:true}]
];
for(const [label,url,{reader=false,...options}={}]of invalidRequests)
 test('V4 original admission rejects before final HTTPS: '+label,async()=>{
  const {transportFor}=await clients();
  await assert.rejects(transportFor(!reader).request(url,{method:'GET',headers:{},...options}),{status:400});
  assert.equal(captures.length,0);
 });

test('V4 conditional PUT and independent exact GET keep their final HTTPS representation',async()=>{
 const {transportFor}=await clients(),writer=transportFor(true);
 const body=auth.ossAcceptancePayloads(scope.prefix.split('/')[1])[0];
 await assert.rejects(sdk(writer).put(scope.prefix+'probe',body,
  {headers:{'x-oss-forbid-overwrite':'true','Content-Type':'application/octet-stream'}}));
 assert.equal(captures.length,1);assert.equal(captures[0].method,'PUT');
 assert.equal(captures[0].path,'/'+scope.prefix+'probe');
 assert.equal(captures[0].headers['x-oss-forbid-overwrite'],'true');
 assert.equal(captures[0].headers['content-length'],String(body.length));
 const a=await adapter();
 await assert.rejects(a.reader.getExact({objectId:'probe',version:'a'.repeat(64)}),{code:'BACKUP_OSS_REJECTED'});
 assert.equal(captures.length,2);assert.equal(captures[1].method,'GET');
 assert.equal(captures[1].path,'/'+scope.prefix+'probe');
 assert.equal(captures[1].headers['cache-control'],'no-cache, no-store');
 assert.equal(captures[1].headers['accept-encoding'],'identity');
 assert.ok(captures[1].headers.authorization.includes('Credential=SYNTHETIC_READ/'),'independent reader identity');
});

test('V4 version query still consumes the shared 24-request budget exactly once per attempt',async()=>{
 const {transportFor}=await clients(),writer=transportFor(true);
 for(let i=0;i<24;i++)await assert.rejects(writer.request(address+'?versioning=',{method:'GET',headers:{}}));
 assert.equal(captures.length,24);assert.ok(captures.every(c=>c.path==='/?versioning'));
 await assert.rejects(writer.request(address+'?versioning=',{method:'GET',headers:{}}),{status:400});
 assert.equal(captures.length,24);
});

test('V4 query timeout or unknown result cannot advance to PUT',async()=>{
 queryError='ETIMEDOUT';const a=await adapter();
 await assert.rejects(a.writer.putIfAbsent({objectId:'probe',bytes:Buffer.from('SYNTHETIC')}),{code:'BACKUP_OSS_REJECTED'});
 assert.equal(captures.length,1);assert.equal(captures[0].method,'GET');
 assert.equal(captures[0].path,'/?versioning');
 assert.equal(captures.filter(c=>c.method==='PUT').length,0);
});
