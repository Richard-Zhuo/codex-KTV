// A manual, non-production operator boundary; ordinary config cannot mint this capability.
import {createInterface} from 'node:readline/promises';
import {createRequire} from 'node:module';
import {debuglog} from 'node:util';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isProductionEnvironment} from '../shared/deployment-environment.js';

const require=createRequire(import.meta.url), sdkRequire=createRequire(require.resolve('ali-oss'));
const urllib=sdkRequire('urllib');
const permits=new WeakMap();
const fail=()=>Object.assign(Error('OSS_ACCEPTANCE_REJECTED'),{code:'OSS_ACCEPTANCE_REJECTED'});
const entry=fileURLToPath(new URL('./oss-acceptance.js',import.meta.url));
export const OSS_ACCEPTANCE_LIMITS=Object.freeze({objects:2,objectBytes:1024,puts:5,requests:24,responseBytes:8192});
export function assertOssAcceptanceHost(){
  if(isProductionEnvironment(process.env)||process.env.NODE_ENV!=='test'||process.env.NODE_OPTIONS||
    process.env.NODE_DEBUG||process.env.NODE_DEBUG_NATIVE||process.env.DEBUG||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED!==undefined||['urllib','http','net','tls'].some(name=>debuglog(name).enabled)||process.versions.node!=='24.19.0')throw fail();
}
export function ossAcceptanceScope(value){
  assertOssAcceptanceHost();
  if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).length!==4||!['bucket','region','endpoint','prefix'].every(k=>Object.hasOwn(value,k))||
    typeof value.bucket!=='string'||!/^ktv-oss-acceptance-[a-z0-9][a-z0-9-]{0,39}[a-z0-9]$/.test(value.bucket)||
    typeof value.region!=='string'||!/^oss-cn-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.region)||
    value.endpoint!=='https://'+value.region+'.aliyuncs.com'||typeof value.prefix!=='string'||
    !/^oss-acceptance\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/$/.test(value.prefix))throw fail();
  return Object.freeze({...value});
}
export function ossAcceptancePayloads(runId){
  return ['A','B'].map(suffix=>Buffer.from('KTV_OSS_ACCEPTANCE_V1 '+runId+' '+suffix));
}
export async function authorizeOssAcceptance(scope){
  const config=ossAcceptanceScope(scope);
  // This is an explicit manual invocation, not a service/environment enablement flag.
  if(resolve(process.argv[1]??'')!==entry||process.argv.length!==5||
    process.argv[2]!=='--run-nonproduction'||process.argv[3]!=='--config-file'||
    process.stdin.isTTY!==true||process.stdout.isTTY!==true)throw fail();
  const phrase='AUTHORIZE NONPRODUCTION OSS '+config.region+' '+config.bucket+' '+config.prefix;
  const terminal=createInterface({input:process.stdin,output:process.stdout});
  let answer;
  try{answer=await terminal.question('Owner authorization required. Synthetic data only; no DELETE.\nType exactly: '+phrase+'\n> ');}
  finally{terminal.close();}
  assertOssAcceptanceHost();
  if(answer!==phrase)throw fail();
  const permit=Object.freeze({});
  permits.set(permit,{config,expires:Date.now()+300000});
  return permit;
}
export function consumeOssAcceptancePermit(permit){
  assertOssAcceptanceHost();
  const approved=permits.get(permit);
  if(!approved||Date.now()>=approved.expires)throw fail();
  permits.delete(permit); // No second session, SDK exposure or arbitrary transport injection.
  const {config,expires}=approved, allowed=new Set(['probe','race'].map(id=>'/'+config.prefix+id));
  const bodies=ossAcceptancePayloads(config.prefix.split('/')[1]);
  let requests=0, puts=0;const observations=[];
  const transportFor=writable=>Object.freeze({async request(address,options){
    let stream,timer,status,attempted=false,observed=false,sequence,operation;
    try{
      assertOssAcceptanceHost();
      if(Date.now()>=expires||++requests>OSS_ACCEPTANCE_LIMITS.requests)throw fail();
      const url=new URL(address), query=url.search==='?versioning=';
      if(url.protocol!=='https:'||url.hostname!==config.bucket+'.'+config.region+'.aliyuncs.com'||
        url.port||url.username||url.password||url.hash||
        (query?url.pathname!=='/'||options.method!=='GET'||!writable:
          url.search!==''||!allowed.has(url.pathname)||!['GET','PUT'].includes(options.method)))throw fail();
      const headerNames=new Set(['x-oss-date','x-oss-content-sha256','user-agent','x-oss-security-token',
        'authorization','content-type','content-md5','content-length','x-oss-forbid-overwrite','cache-control','accept-encoding']);
      if(!options.headers||Object.keys(options.headers).some(k=>!headerNames.has(k.toLowerCase()))||
        options.stream!=null||options.writeStream!=null||options.customResponse!=null||options.ctx!=null||options.proxy!=null||options.enableProxy===true||
        Object.keys(options).some(k=>!['method','content','stream','headers','timeout','writeStream','customResponse','ctx','enableProxy','proxy'].includes(k)))throw fail();
      if(options.method==='PUT'){
        if(!writable||++puts>OSS_ACCEPTANCE_LIMITS.puts||!Buffer.isBuffer(options.content)||
          options.content.length<1||options.content.length>OSS_ACCEPTANCE_LIMITS.objectBytes||!bodies.some(b=>b.equals(options.content))||
          options.headers?.['x-oss-forbid-overwrite']!=='true')throw fail();
      }
      sequence=requests;operation=query?'VERSIONING':options.method;attempted=true;
      const result=await urllib.request(url.href,{method:options.method,headers:{...options.headers},
        content:options.content?Buffer.from(options.content):undefined,streaming:true,writeStream:null,
        followRedirect:false,maxRedirects:0,enableProxy:false,rejectUnauthorized:true,
        agent:false,httpsAgent:false,timeout:5000});
      status=result.status;stream=result.res;
      observations.push({sequence,operation,status:Number.isInteger(status)?status:'UNKNOWN'});observed=true;
      if(!stream||typeof stream[Symbol.asyncIterator]!=='function')throw fail();
      timer=setTimeout(()=>stream.destroy(fail()),5000);
      const max=status===200&&!query&&options.method==='GET'?OSS_ACCEPTANCE_LIMITS.objectBytes:OSS_ACCEPTANCE_LIMITS.responseBytes;
      let size=0;const chunks=[];
      for await(const chunk of stream){
        const bytes=Buffer.from(chunk);size+=bytes.length;
        if(size>max)throw fail();chunks.push(bytes);
      }
      assertOssAcceptanceHost();
      return {...result,data:Buffer.concat(chunks),res:{status:result.status,headers:result.headers}};
    }catch{
      stream?.destroy();
      if(attempted&&!observed)observations.push({sequence,operation,status:'UNKNOWN'});
      // Preserve definite authorization failures even if their response body is unreadable.
      throw Object.assign(fail(),!attempted?{status:400,code:'OSS_ACCEPTANCE_REQUEST_REJECTED'}:
        Number.isInteger(status)&&status>=400&&status<500
        ?{status,code:status===403?'AccessDenied':'OSS_ACCEPTANCE_REQUEST_REJECTED'}
        :{status:-1,name:'RequestError'});
    }finally{clearTimeout(timer);}
  }});
  return {config:Object.freeze({...config,timeoutMs:5000}),transportFor,
    observations:()=>Object.freeze(observations.map(o=>Object.freeze({...o})).sort((a,b)=>a.sequence-b.sequence))};
}
