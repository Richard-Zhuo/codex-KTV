import test,{mock,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {Readable} from 'node:stream';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as fs from 'node:fs/promises';
import * as childProcess from 'node:child_process';
import {promisify} from 'node:util';
import dns from 'node:dns';import http from 'node:http';import https from 'node:https';import net from 'node:net';
import * as format from './format.js';
import * as runtime from '../production/runtime-config.js';
import * as smoke from '../production/wecom-smoke-config.js';

const root=resolve('C:/JbhhKtvSecure/oss-acceptance'),runId='e7dd29ba-5a7a-4cb8-9625-f18d659e42ce';
const configFile=join(root,'config.json'), readFile=join(root,'read.json'),writeFile=join(root,'write.json');
const entry=fileURLToPath(new URL('./oss-acceptance.js',import.meta.url));
const scope={region:'oss-cn-hangzhou',bucket:'ktv-oss-acceptance-synthetic',endpoint:'https://oss-cn-hangzhou.aliyuncs.com',prefix:'oss-acceptance/'+runId+'/'};
const config=()=>({configVersion:1,purpose:'nonproduction-oss-acceptance',...scope,readCredentialsFile:readFile,writeCredentialsFile:writeFile,evidenceFile:join(root,'oss-acceptance-'+runId+'.jsonl')});
const credentials=role=>({accessKeyId:'SYNTHETIC_'+role,accessKeySecret:'SYNTHETIC_PRIVATE_SECRET_'+role,stsToken:'SYNTHETIC_PRIVATE_TOKEN_'+role});
const acl={current:'S-1-5-21-111-222-333-1001',owner:'S-1-5-21-111-222-333-1001',protected:true,rules:[{sid:'S-1-5-21-111-222-333-1001',type:'Allow',rights:197055,inheritance:'ObjectInherit'}]};
let state={calls:[],reads:[],lines:[],pathEvents:[],nativeQueries:[]},network=0;
for(const [owner,name] of [[dns,'lookup'],[http,'request'],[https,'request'],[net.Socket.prototype,'connect']])mock.method(owner,name,()=>{network++;throw Error('REAL_NETWORK_FORBIDDEN');});
// Model the fixed native boundary; native policy/bindings have separate offline tests.
const nativeExec=()=>{throw Error('UNEXPECTED_CALLBACK_EXEC');};
nativeExec[promisify.custom]=async(executable,args,options)=>{
 assert.equal(executable,'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
 assert.deepEqual(args.slice(0,3),['-NoProfile','-NonInteractive','-EncodedCommand']);
 assert.equal(options.windowsHide,true);assert.equal(options.timeout,10000);
 const script=Buffer.from(args[3],'base64').toString('utf16le');
 const op=script.match(/Invoke-OssFixedRead '(CONFIG|READ|WRITE|ROOT)'$/)?.[1];assert.ok(op);
 state.operations??=[];state.operations.push(op);state.nativeQueries.push('C:\\');
 if(state.driveFailure||state.rootDenied||(state.driveType??3)!==3||state.device!==undefined||state.mode==='acl-denied')throw Error('SYNTHETIC_PRIVATE_ROOT_DENIED');
 if(state.driveOutput!==undefined)return {stdout:state.driveOutput,stderr:''};
 for(const path of ['C:\\',resolve('C:/JbhhKtvSecure'),root]){
  state.pathEvents.push({op:'GetFileAttributesW',path});
  if(state.reparseAt===path||state.componentFailure===path||state.attributes!==undefined||state.mode==='symlink')throw Error('SYNTHETIC_PRIVATE_REPARSE_DENIED');
  state.pathEvents.push({op:'pinnedAcl',path});
 }
 if(op==='ROOT')return {stdout:'ROOT_OK',stderr:''};
 const path={CONFIG:configFile,READ:readFile,WRITE:writeFile}[op];
 state.pathEvents.push({op:'GetFileAttributesW',path});
 if(state.reparseAt===path||op==='CONFIG'&&state.configMissing)throw Error('SYNTHETIC_PRIVATE_REPARSE_DENIED');
 state.pathEvents.push({op:'pinnedFileRead',path});state.reads.push(path);
 if(state.mode==='expired'&&op==='READ')state.clock+=300001;
 const data=op==='CONFIG'?state.config:credentials(state.mode==='same-identity'?'SAME':op);
 return {stdout:'DATA:'+Buffer.from(JSON.stringify(data)).toString('base64'),stderr:''};
};
mock.module('node:child_process',{exports:{...childProcess,execFile:nativeExec}});
mock.module('node:readline/promises',{exports:{createInterface(){return {async question(prompt){state.prompts.push(prompt);if(state.mode==='scope-changed'&&prompt.includes('AUTHORIZE NONPRODUCTION OSS'))state.config.bucket='ktv-oss-acceptance-other';return prompt.includes('READ PROTECTED LOCAL OSS CONFIG')?state.localAnswer:state.answer;},close(){}};}}});
mock.module('../production/secret-file.js',{exports:{async readExternalSecret(path){
 state.reads.push(path);
 if(path===configFile||path===state.alternateConfig)return structuredClone(state.config);
 if(![readFile,writeFile].includes(path))throw Error('SYNTHETIC_PRIVATE_PATH');
 if(state.mode==='expired')state.clock+=300001;
 return credentials(state.mode==='same-identity'?'SAME':path===readFile?'READ':'WRITE');
}}});
mock.module('../production/runtime-config.js',{exports:{...runtime,windowsFileAcl:async path=>{state.pathEvents.push({op:'fileAcl',path});return state.mode==='acl-denied'?{...acl,protected:false}:acl;}}});
mock.module('../production/wecom-smoke-config.js',{exports:{...smoke,windowsDirectoryAcl:async path=>{state.pathEvents.push({op:'directoryAcl',path});return acl;}}});
mock.module('./format.js',{exports:{...format,externalDirectory:async path=>{state.pathEvents.push({op:'externalDirectory',path});return path;}}});
mock.module('node:fs/promises',{exports:{...fs,
 lstat:async path=>{state.pathEvents.push({op:'lstat',path});return {isFile:()=>true,isSymbolicLink:()=>state.mode==='symlink'};},
 async open(path,flags){
  state.pathEvents.push({op:'open',path});
  assert.equal(path,state.config.evidenceFile);assert.equal(flags,'wx');
  if(state.mode==='evidence-exists')throw Object.assign(Error(),{code:'EEXIST'});
  state.opened++;
  return {async writeFile(line){state.lines.push(JSON.parse(line));},async sync(){if(state.mode==='sync-failure')throw Error('SYNTHETIC_PRIVATE_SYNC');},async close(){state.closed++;}};
 }
}});
const require=createRequire(import.meta.url),sdkRequire=createRequire(require.resolve('ali-oss')),urllib=sdkRequire('urllib');
function response(status,bytes,headers={}){
 const data=Buffer.from(bytes),res=Readable.from([data]);res.statusCode=status;res.headers=headers;
 return {status,headers,res,data:null};
}
const denied=()=>response(403,'<Error><Code>AccessDenied</Code><Message>SYNTHETIC_PRIVATE_SECRET_WRITE</Message></Error>');
mock.method(urllib,'request',async(url,options)=>{
 state.calls.push({url,...options});
 assert.equal(options.streaming,true);assert.equal(options.followRedirect,false);
 assert.equal(options.rejectUnauthorized,true);assert.equal(options.enableProxy,false);
 assert.equal(options.method==='DELETE',false);
 const parsed=new URL(url);
 if(state.mode==='host-changed')process.env.NODE_ENV='production';
 if(state.mode==='denied-body-error'&&options.method==='PUT'){
  const res=Readable.from((async function*(){throw Error('SYNTHETIC_PRIVATE_TOKEN_WRITE');})());
  return {status:403,headers:{},res};
 }
 if(parsed.searchParams.has('versioning'))return response(200,state.mode==='version-enabled'?'<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>':
  state.mode==='version-malformed'?'<?xml invalid?><VersioningConfiguration/>':'<VersioningConfiguration/>');
 const key=parsed.pathname;
 if(options.method==='PUT'){
  assert.match(options.headers.authorization,/OSS4-HMAC-SHA256 Credential=SYNTHETIC_(WRITE|SAME)\//);
  assert.equal(options.headers['x-oss-forbid-overwrite'],'true');
  if(state.mode==='denied'||state.mode==='conflict-denied'&&state.calls.filter(c=>c.method==='PUT').length===3)return denied();
  if(state.mode==='unknown-no-commit')throw Error('SYNTHETIC_PRIVATE_SECRET_WRITE');
  if(state.objects.has(key)&&state.mode!=='overwrite-server'&&!(state.mode==='overwrite-race-only'&&key.endsWith('/race')))return response(409,'<Error><Code>FileAlreadyExists</Code><Message>SYNTHETIC_PRIVATE_TOKEN_WRITE</Message></Error>');
  state.objects.set(key,Buffer.from(options.content));
  if(state.mode==='unknown-after-commit'&&!state.lost){state.lost=true;throw Error('SYNTHETIC_PRIVATE_SECRET_WRITE');}
  return response(200,'');
 }
 assert.equal(options.method,'GET');
 assert.match(options.headers.authorization,/OSS4-HMAC-SHA256 Credential=SYNTHETIC_READ\//);
 if(!state.objects.has(key))return response(404,'<Error><Code>NoSuchKey</Code></Error>');
 const bytes=state.mode==='tamper'?Buffer.from('TAMPERED'):state.mode==='oversize'?Buffer.alloc(1025):state.objects.get(key);
 return response(200,bytes,{'content-length':String(bytes.length),'x-oss-object-type':'Normal'});
});
const auth=await import('./oss-acceptance-authorization.js');
const bridge=await import('./oss-sdk-bridge.js');
const cli=await import('./oss-acceptance.js');
const importEvidence={calls:state.calls.length,reads:state.reads.length,target:state.pathEvents.length,native:state.nativeQueries.length,network};
const command=['--run-nonproduction'];
const envKeys=['NODE_ENV','KTV_HTTP_ENV','KTV_DEPLOYMENT_ENV','NODE_OPTIONS','NODE_DEBUG','NODE_DEBUG_NATIVE','DEBUG','NODE_TLS_REJECT_UNAUTHORIZED'];
let previousEnv,previousArgv,inTTY,outTTY;
beforeEach(()=>{
 previousEnv=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));for(const k of envKeys)delete process.env[k];process.env.NODE_ENV='test';
 previousArgv=process.argv;process.argv=[process.execPath,entry,...command];
 inTTY=Object.getOwnPropertyDescriptor(process.stdin,'isTTY');outTTY=Object.getOwnPropertyDescriptor(process.stdout,'isTTY');
 Object.defineProperty(process.stdin,'isTTY',{value:true,configurable:true});Object.defineProperty(process.stdout,'isTTY',{value:true,configurable:true});
 state={config:config(),pathEvents:[],nativeQueries:[],calls:[],reads:[],lines:[],prompts:[],objects:new Map(),opened:0,closed:0,clock:Date.now(),localAnswer:'READ PROTECTED LOCAL OSS CONFIG',answer:'AUTHORIZE NONPRODUCTION OSS '+scope.region+' '+scope.bucket+' '+scope.prefix};
});
afterEach(()=>{
 process.argv=previousArgv;
 for(const k of envKeys){if(previousEnv[k]===undefined)delete process.env[k];else process.env[k]=previousEnv[k];}
 if(inTTY)Object.defineProperty(process.stdin,'isTTY',inTTY);else delete process.stdin.isTTY;
 if(outTTY)Object.defineProperty(process.stdout,'isTTY',outTTY);else delete process.stdout.isTTY;
 assert.equal(network,0);
 assert.equal(JSON.stringify(state.lines).includes('SYNTHETIC_PRIVATE'),false);
 assert.equal(JSON.stringify(state.prompts).includes('SYNTHETIC_PRIVATE'),false);
});
const rejected=async()=>assert.rejects(cli.runOssAcceptance(command),{code:'OSS_ACCEPTANCE_UNCONFIRMED',message:'OSS_ACCEPTANCE_UNCONFIRMED'});
test('B2B normal bounded manual session reuses real SDK, five conditional PUTs and separate exact reader',async()=>{
 const result=await cli.runOssAcceptance(command);
 assert.equal(result.code,'OSS_ACCEPTANCE_PROBES_PASSED');assert.equal(result.objectCount,2);
 assert.equal(state.objects.size,2);assert.equal(state.calls.length,18);
 assert.equal(state.calls.filter(c=>c.method==='PUT').length,5);
 assert.deepEqual(state.reads,[configFile,configFile,readFile,writeFile]);assert.equal(state.closed,1);
 assert.equal(state.lines.at(-1).outcome,'PROBES_PASSED');
 assert.equal(state.calls.some(c=>c.method==='HEAD'),false);
});
test('B2B default no arguments rejects without config, credentials or network',async()=>{
 await assert.rejects(cli.runOssAcceptance([]));assert.equal(state.reads.length,0);assert.equal(state.calls.length,0);
});
test('B2B validate-only remains credential-free and offline after new entry import',()=>{
 assert.equal(bridge.validateOssSdkBridgeConfig(scope).networkEnabled,false);
 assert.equal(state.pathEvents.length,0);assert.equal(state.nativeQueries.length,0);
 assert.equal(state.reads.length,0);assert.equal(state.calls.length,0);
});
test('B2B wrong manual consent does not load credentials or send',async()=>{
 state.answer='yes';await rejected();assert.deepEqual(state.reads,[configFile]);assert.equal(state.opened,0);assert.equal(state.calls.length,0);
});
test('B2B noninteractive service cannot authorize even with flags and test env',async()=>{
 Object.defineProperty(process.stdin,'isTTY',{value:false,configurable:true});await rejected();assert.deepEqual(state.reads,[]);assert.equal(state.calls.length,0);
});
test('B2B ordinary business import cannot mint authorization',async()=>{
 process.argv=[process.execPath,resolve('server.js'),...command];await assert.rejects(auth.authorizeOssAcceptance(scope));assert.equal(state.prompts.length,0);
});
test('B2B forged permit and config flags cannot select network',()=>{
 assert.throws(()=>bridge.createOssSdkAcceptanceBridge({allowNetwork:true},{}));assert.equal(state.calls.length,0);
 for(const patch of [{bucket:'production-bucket'},{endpoint:'http://oss-cn-hangzhou.aliyuncs.com'},{prefix:'production/'},{allowNetwork:true}])assert.throws(()=>auth.ossAcceptanceScope({...scope,...patch}));
});
for(const mode of ['evidence-exists','sync-failure','acl-denied','symlink','same-identity'])test('B2B fail before network: '+mode,async()=>{
 state.mode=mode;await rejected();assert.equal(state.calls.length,0);
 if(['evidence-exists','sync-failure','acl-denied','symlink'].includes(mode))assert.equal(state.reads.includes(readFile),false);
});
for(const mode of ['denied','unknown-no-commit','version-enabled','version-malformed','overwrite-server','tamper','oversize'])test('B2B failed/unknown probe never records success or raw error: '+mode,async()=>{
 state.mode=mode;await rejected();assert.equal(state.lines.at(-1).outcome,'UNCONFIRMED');
 assert.equal(state.lines.some(l=>l.outcome==='PROBES_PASSED'),false);
 if(mode==='version-enabled'||mode==='version-malformed')assert.equal(state.calls.filter(c=>c.method==='PUT').length,0);
 if(mode==='denied')assert.deepEqual(state.calls.map(c=>c.method),['GET','PUT']);
});
test('B2B unknown committed write only succeeds after independent exact reader',async()=>{
 state.mode='unknown-after-commit';assert.equal((await cli.runOssAcceptance(command)).code,'OSS_ACCEPTANCE_PROBES_PASSED');
 assert.deepEqual(state.calls.slice(0,3).map(c=>c.method),['GET','PUT','GET']);
});
test('B2B one-use permit cannot reopen another session',async()=>{
 const permit=await auth.authorizeOssAcceptance(scope);
 bridge.createOssSdkAcceptanceBridge(permit,{readCredentials:credentials('READ'),writeCredentials:credentials('WRITE')});
 assert.throws(()=>bridge.createOssSdkAcceptanceBridge(permit,{readCredentials:credentials('READ'),writeCredentials:credentials('WRITE')}));assert.equal(state.calls.length,0);
});
test('B2B trusted clock expiry rejects before cloud request',async t=>{
 t.mock.method(Date,'now',()=>state.clock);state.mode='expired';await rejected();assert.equal(state.calls.length,0);
});
test('B2B scope gate rejects DELETE, third object, wrong host and oversized content before transport',async()=>{
 const permit=await auth.authorizeOssAcceptance(scope),{transportFor}=auth.consumeOssAcceptancePermit(permit);
 const writer=transportFor(true),reader=transportFor(false),url='https://'+scope.bucket+'.'+scope.region+'.aliyuncs.com/'+scope.prefix+'probe';
 for(const [transport,address,options] of [[writer,url,{method:'DELETE'}],[writer,url+'extra',{method:'GET'}],[writer,url.replace(scope.bucket,'production-bucket'),{method:'GET'}],
  [reader,url,{method:'PUT',content:Buffer.from('X'),headers:{'x-oss-forbid-overwrite':'true'}}],
  [writer,url,{method:'PUT',content:Buffer.alloc(1025),headers:{'x-oss-forbid-overwrite':'true'}}]])await assert.rejects(transport.request(address,options),{status:400});
 assert.equal(state.calls.length,0);
});
test('B2B request quota stops independent reads without more network',async()=>{
 const permit=await auth.authorizeOssAcceptance(scope),{transportFor}=auth.consumeOssAcceptancePermit(permit),reader=transportFor(false);
 const url='https://'+scope.bucket+'.'+scope.region+'.aliyuncs.com/'+scope.prefix+'probe';
 for(let i=0;i<24;i++)await reader.request(url,{method:'GET',headers:{authorization:'OSS4-HMAC-SHA256 Credential=SYNTHETIC_READ/'}});
 await assert.rejects(reader.request(url,{method:'GET'}),{status:400});assert.equal(state.calls.length,24);
});
test('B2B actual production selectors, debug and unsafe runtime cannot authorize',async()=>{
 for(const [key,value] of [['NODE_ENV','production'],['KTV_DEPLOYMENT_ENV','production'],['NODE_DEBUG','http'],['NODE_OPTIONS','--inspect'],['NODE_TLS_REJECT_UNAUTHORIZED','0']]){
  const prev=process.env[key];process.env[key]=value;
  try{await rejected();}finally{if(prev===undefined)delete process.env[key];else process.env[key]=prev;}
 }
 assert.equal(state.reads.length,0);assert.equal(state.calls.length,0);
});

test('B2B import has no credential/config reads or network side effects',()=>{
 assert.deepEqual(importEvidence,{calls:0,reads:0,target:0,native:0,network:0});
});
test('B2B PUT quota rejects sixth attempt without another HTTP request',async()=>{
 const permit=await auth.authorizeOssAcceptance(scope),{transportFor}=auth.consumeOssAcceptancePermit(permit),writer=transportFor(true);
 const url='https://'+scope.bucket+'.'+scope.region+'.aliyuncs.com/'+scope.prefix+'probe';
 const options={method:'PUT',content:auth.ossAcceptancePayloads(runId)[0],headers:{authorization:'OSS4-HMAC-SHA256 Credential=SYNTHETIC_WRITE/','x-oss-forbid-overwrite':'true'}};
 for(let i=0;i<5;i++)await writer.request(url,options);
 await assert.rejects(writer.request(url,options),{status:400});assert.equal(state.calls.length,5);
});
test('B2B copy/Host/custom transport options, non-synthetic payload and ambiguous query cannot escape scope',async()=>{
 const permit=await auth.authorizeOssAcceptance(scope),{transportFor}=auth.consumeOssAcceptancePermit(permit),writer=transportFor(true);
 const url='https://'+scope.bucket+'.'+scope.region+'.aliyuncs.com/'+scope.prefix+'probe';
 const base={method:'PUT',content:auth.ossAcceptancePayloads(runId)[0],headers:{authorization:'OSS4-HMAC-SHA256 Credential=SYNTHETIC_WRITE/','x-oss-forbid-overwrite':'true'}};
 for(const options of [{...base,headers:{...base.headers,Host:'production-bucket.oss-cn-hangzhou.aliyuncs.com'}},
  {...base,headers:{...base.headers,'x-oss-copy-source':'/production/secret'}},{...base,beforeRequest(){}},
  {...base,content:Buffer.from('ARBITRARY_NON_SYNTHETIC_INPUT')}])await assert.rejects(writer.request(url,options),{status:400});
 await assert.rejects(writer.request(url+'?versioning=unexpected',{method:'GET',headers:{}}),{status:400});
 assert.equal(state.calls.length,0);
});
test('B2B host production change during response blocks PUT',async()=>{
 state.mode='host-changed';await rejected();assert.deepEqual(state.calls.map(c=>c.method),['GET']);
});
test('B2B unreadable definite permission response cannot become unknown-write success',async()=>{
 state.mode='denied-body-error';await rejected();assert.deepEqual(state.calls.map(c=>c.method),['GET','PUT']);
});
test('B2B unknown config enablement flag is rejected before authorization or credentials',async()=>{
 state.config.allowNetwork=true;await rejected();assert.equal(state.prompts.length,1);assert.deepEqual(state.reads,[configFile]);assert.equal(state.calls.length,0);
});

for(const mode of ['conflict-denied','overwrite-race-only'])test('B2B expected conflict needs actual HTTP conflict evidence: '+mode,async()=>{
 state.mode=mode;await rejected();assert.equal(state.lines.at(-1).outcome,'UNCONFIRMED');
 assert.equal(state.lines.some(l=>l.outcome==='PROBES_PASSED'),false);
});

test('B2B network/device paths are rejected before secret loading and consent',async()=>{
 state.config.readCredentialsFile='\\SYNTHETIC-SHARE\keys\read.json';await rejected();
 assert.deepEqual(state.reads,[configFile]);assert.equal(state.prompts.length,1);assert.equal(state.calls.length,0);
 state.reads=[];
 await assert.rejects(cli.runOssAcceptance(['--run-nonproduction','--config-file','\\SYNTHETIC-SHARE\config.json']));
 assert.equal(state.reads.length,0);
});

test('B2B path P2 REMOTE root rejects before target filesystem access',async()=>{
 state.driveType=4;state.alternateConfig=String.raw`Z:\OwnerOssAcceptance\config.json`;state.answer='DENY';
 const args=['--run-nonproduction','--config-file',state.alternateConfig];process.argv=[process.execPath,entry,...args];
 await assert.rejects(cli.runOssAcceptance(args));
 assert.deepEqual(state.nativeQueries,[]);assert.equal(state.pathEvents.length,0);assert.equal(state.reads.length,0);assert.equal(state.prompts.length,0);
});

for(const driveType of [0,1,2,4,5,6,'UNKNOWN'])test('B2B path P2 non-fixed root has no target access: '+driveType,async()=>{
 state.driveType=driveType;await rejected();
 assert.deepEqual(state.nativeQueries,['C:\\']);assert.equal(state.pathEvents.length,0);
 assert.equal(state.reads.length,0);assert.equal(state.prompts.length,1);
});
for(const patch of [{driveFailure:true},{driveOutput:''},{driveOutput:'{}'},
 {driveOutput:'DRIVE:3:AAAA\nUNEXPECTED'},
 {device:'\\??\\C:\\alias'},{device:'\\Device\\Mup\\server'}])test('B2B path P2 uncertain native root fails before target access: '+JSON.stringify(patch),async()=>{
 Object.assign(state,patch);await rejected();assert.equal(state.pathEvents.length,0);assert.equal(state.reads.length,0);assert.equal(state.prompts.length,1);
});
for(const path of ['\\\\server\\share\\config.json','\\\\?\\C:\\config.json','\\\\.\\C:\\config.json',
 'C:config.json','\\config.json','config.json','C:\\..\\config.json','C:\\test\\config.json:secret',
 'C:\\test.\\config.json','C:\\NUL\\config.json','C:\\test\\\\config.json'])test('B2B path P2 unsupported syntax has zero OS and target queries: '+path,async()=>{
 const args=['--run-nonproduction','--config-file',path];process.argv=[process.execPath,entry,...args];
 await assert.rejects(cli.runOssAcceptance(args));assert.equal(state.nativeQueries.length,0);assert.equal(state.pathEvents.length,0);assert.equal(state.reads.length,0);
});
for(const path of ['C:\\',root,configFile])test('B2B path P2 rejects native reparse before following component: '+path,async()=>{
 state.reparseAt=path;await rejected();
 assert.equal(state.pathEvents.at(-1).op,'GetFileAttributesW');assert.equal(state.pathEvents.at(-1).path,path);
 assert.equal(state.reads.length,0);assert.equal(state.prompts.length,1);assert.equal(state.calls.length,0);
});
for(const attributes of [0xffffffff,-1,'UNKNOWN',null])test('B2B path P2 invalid component metadata rejects: '+attributes,async()=>{
 if(attributes===null)state.componentFailure='C:\\';else state.attributes=attributes;
 await rejected();assert.equal(state.reads.length,0);assert.equal(state.prompts.length,1);
});

test('B2B path P2 fixed drive checks every component before local file access and retains ACL',async()=>{
 await cli.runOssAcceptance(command);
 assert.ok(state.nativeQueries.length>0);assert.ok(state.nativeQueries.every(p=>p==='C:\\'));
 for(const path of [configFile,readFile,writeFile]){
  const attrs=state.pathEvents.findIndex(e=>e.op==='GetFileAttributesW'&&e.path===path);
  const access=state.pathEvents.findIndex(e=>e.op==='pinnedFileRead'&&e.path===path);
  assert.ok(attrs>=0&&access>attrs);
 }
 assert.ok(state.pathEvents.some(e=>e.op==='pinnedAcl'&&e.path===root));
 assert.equal(state.pathEvents.some(e=>e.op==='lstat'||e.op==='externalDirectory'||e.op==='fileAcl'),false);
});

test('fixed-root local consent denial has zero target accesses',async()=>{
 state.localAnswer='DENY';await rejected();assert.equal(state.nativeQueries.length,0);assert.equal(state.reads.length,0);assert.equal(state.calls.length,0);
});
test('fixed-root missing/untrusted bootstrap denies before data and network consent',async()=>{
 state.rootDenied=true;await rejected();assert.deepEqual(state.operations,['CONFIG']);assert.equal(state.reads.length,0);assert.equal(state.pathEvents.length,0);assert.equal(state.prompts.length,1);
});
for(const field of ['readCredentialsFile','writeCredentialsFile','evidenceFile'])test('fixed-root config cannot redirect '+field,async()=>{
 state.config[field]='Z:\\untrusted\\file.json';await rejected();assert.deepEqual(state.reads,[configFile]);assert.deepEqual(state.operations,['CONFIG']);assert.equal(state.calls.length,0);
});
test('fixed-root original ancestor replacement path is refused before any target lookup',async()=>{
 const args=['--run-nonproduction','--config-file','C:\\UNTRUSTED\\OwnerOssAcceptance\\config.json'];process.argv=[process.execPath,entry,...args];
 await assert.rejects(cli.runOssAcceptance(args));assert.equal(state.nativeQueries.length,0);assert.equal(state.pathEvents.length,0);assert.equal(state.prompts.length,0);
});
test('fixed-root successful session binds fixed files and two independent confirmations',async()=>{
 assert.equal((await cli.runOssAcceptance(command)).code,'OSS_ACCEPTANCE_PROBES_PASSED');
 assert.deepEqual(state.operations,['CONFIG','CONFIG','ROOT','READ','WRITE']);assert.equal(state.prompts.length,2);
 assert.ok(state.prompts[0].includes('READ PROTECTED LOCAL OSS CONFIG'));assert.ok(state.prompts[1].includes(scope.bucket));
});

for(const output of ['ROOT_OK','DATA:!!!!','DATA:'+Buffer.from([0xff]).toString('base64'),'DATA:'+Buffer.alloc(65537).toString('base64')])test('fixed-root invalid native data response denies without secret logging '+output.slice(0,12),async()=>{
 state.driveOutput=output;await rejected();assert.equal(state.calls.length,0);assert.equal(state.prompts.length,1);assert.equal(state.reads.length,0);
});

test('fixed-root actual config changed after scope consent is refused before evidence, credentials or OSS',async()=>{
 state.mode='scope-changed';await rejected();assert.deepEqual(state.operations,['CONFIG','CONFIG']);assert.equal(state.calls.length,0);assert.equal(state.opened,0);assert.equal(state.prompts.length,2);
});


test('migration exports only the new fixed config and credential locations',async()=>{
 const {OSS_ACCEPTANCE_ROOT,OSS_ACCEPTANCE_FILES}=await import('./oss-acceptance-path.js');
 assert.equal(OSS_ACCEPTANCE_ROOT,'C:\\JbhhKtvSecure\\oss-acceptance');
 assert.deepEqual(OSS_ACCEPTANCE_FILES,{CONFIG:join(root,'config.json'),READ:join(root,'read.json'),WRITE:join(root,'write.json')});
});
for(const field of ['readCredentialsFile','writeCredentialsFile','evidenceFile'])test('migration never falls back to old ProgramData '+field,async()=>{
 state.config[field]=join('C:\\ProgramData\\JbhhKtv\\private\\oss-acceptance',field==='evidenceFile'?'oss-acceptance-'+runId+'.jsonl':field==='readCredentialsFile'?'read.json':'write.json');
 await rejected();assert.deepEqual(state.reads,[configFile]);assert.equal(state.prompts.length,1);assert.equal(state.opened,0);assert.equal(state.calls.length,0);
});
for(const path of [resolve('C:/JbhhKtvSecure'),root])for(const failure of ['componentFailure','reparseAt'])test('migration refuses uninitialized or redirected private ancestor '+failure+' '+path,async()=>{
 state[failure]=path;await rejected();assert.equal(state.reads.length,0);assert.equal(state.prompts.length,1);assert.equal(state.opened,0);assert.equal(state.calls.length,0);
 assert.equal(state.pathEvents.some(e=>e.op==='pinnedFileRead'),false);
});
test('migration missing config refuses before credentials and network authorization',async()=>{
 state.configMissing=true;await rejected();assert.equal(state.reads.length,0);assert.equal(state.prompts.length,1);assert.equal(state.opened,0);assert.equal(state.calls.length,0);
});
