import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';

export const KTVSKY_ORIGIN = 'https://lknewcms.ktvsky.com';
const endpoints = Object.freeze({
  login: ['POST', '/h5/login'], search: ['GET', '/h5/search'], control: ['POST', '/h5/mac_control']
});
export class KtvSkyTransportError extends Error {
  constructor(reason) { super('KTVSky provider request unavailable'); this.code='PROVIDER_UNAVAILABLE'; this.reason=reason; }
}
// No redirects, retries, caller-selected paths, or relaxed TLS verification.
export function createKtvSkyHttpClient({baseUrl=KTVSKY_ORIGIN,testOnly=false,
  connectTimeoutMs=3000,requestTimeoutMs=10000,maxResponseBytes=262144,logger=()=>{}}={}) {
  const origin=new URL(baseUrl);
  const isolated=testOnly===true && ['127.0.0.1','[::1]'].includes(origin.hostname) &&
    ['http:','https:'].includes(origin.protocol);
  if(origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash ||
      (!isolated && origin.origin!==KTVSKY_ORIGIN) ||
      ![connectTimeoutMs,requestTimeoutMs,maxResponseBytes].every(n=>Number.isSafeInteger(n)&&n>0) ||
      typeof logger!=='function')throw TypeError('Invalid KTVSky HTTP configuration');
  return Object.freeze({testOnly:isolated,origin:origin.origin,
    async request({endpoint,telno,body,token,cookie,signal}={}) {
      if(!Object.hasOwn(endpoints,endpoint) || (endpoint==='search' && typeof telno!=='string'))throw TypeError('Invalid provider request');
      const [method,path]=endpoints[endpoint],url=new URL(path,origin);
      if(endpoint==='search')url.searchParams.set('telno',telno);
      const encoded=body===undefined?null:JSON.stringify(body);
      if(encoded && Buffer.byteLength(encoded)>16384)throw TypeError('Provider request too large');
      const headers={Accept:'application/json'};
      if(encoded){headers['Content-Type']='application/json';headers['Content-Length']=Buffer.byteLength(encoded);}
      if(token)headers['X-TOKEN']=token;
      if(cookie)headers.Cookie=cookie;
      const requestId=randomUUID();
      return new Promise((resolve,reject)=>{
        let request,deadline,connectionDeadline,done=false,status;
        const abort=()=>finish(new KtvSkyTransportError('ABORTED'));
        function finish(error,value) {
          if(done)return;done=true;clearTimeout(deadline);clearTimeout(connectionDeadline);
          signal?.removeEventListener('abort',abort);request?.destroy();
          try{logger({provider:'ktvsky',endpoint,requestId,httpStatus:status??null,
            code:error?.code??'RESPONSE'});}catch{/* Diagnostics cannot affect provider semantics. */}
          if(error)reject(error);else resolve(value);
        }
        try {
          request=(url.protocol==='https:'?https:http).request(url,{
            method,headers,agent:false,rejectUnauthorized:true,maxHeaderSize:16384
          },response=>{
            status=response.statusCode;
            if(status>=300 && status<400){response.resume();finish(new KtvSkyTransportError('REDIRECT_REFUSED'));return;}
            const chunks=[];let size=0;
            response.on('data',chunk=>{
              size+=chunk.length;
              if(size>maxResponseBytes){finish(new KtvSkyTransportError('RESPONSE_TOO_LARGE'));return;}
              chunks.push(chunk);
            });
            response.on('aborted',()=>finish(new KtvSkyTransportError('CONNECTION_LOST')));
            response.on('error',()=>finish(new KtvSkyTransportError('CONNECTION_LOST')));
            response.on('end',()=>{
              if(done)return;
              try {
                const data=[401,403].includes(status)?null:JSON.parse(Buffer.concat(chunks).toString('utf8'));
                finish(null,{status,data,setCookies:response.headers['set-cookie']??[]});
              }catch{finish(new KtvSkyTransportError('INVALID_JSON'));}
            });
          });
          request.on('error',()=>finish(new KtvSkyTransportError('CONNECTION_LOST')));
          request.on('socket',socket=>{
            const event=url.protocol==='https:'?'secureConnect':'connect';
            connectionDeadline=setTimeout(()=>finish(new KtvSkyTransportError('CONNECT_TIMEOUT')),connectTimeoutMs);
            socket.once(event,()=>clearTimeout(connectionDeadline));
          });
          deadline=setTimeout(()=>finish(new KtvSkyTransportError('REQUEST_TIMEOUT')),requestTimeoutMs);
          if(signal?.aborted){abort();return;}
          signal?.addEventListener('abort',abort,{once:true});
          request.end(encoded);
        }catch{finish(new KtvSkyTransportError('INVALID_REQUEST'));}
      });
    }
  });
}
