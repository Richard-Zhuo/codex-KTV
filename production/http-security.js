import { createHash } from 'node:crypto';
export const HTTP_LIMITS=Object.freeze({maxBodyBytes:1024*1024,headersTimeout:5000,requestTimeout:15000,keepAliveTimeout:5000,inactivityTimeout:15000,maxConnections:64,maxRequestsPerSocket:100});
export const SECURITY_HEADERS=Object.freeze({
 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
 'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
 'Strict-Transport-Security':'max-age=31536000','Permissions-Policy':'camera=(), microphone=(), geolocation=()'
});
export function secureRequest(req,origin){
 const expected=new URL(origin).host.toLowerCase();
 const hosts=(req.rawHeaders??[]).filter((v,i)=>i%2===0&&v.toLowerCase()==='host');
 if(req.socket.encrypted!==true||req.headers.host?.toLowerCase()!==expected||hosts.length!==1||!req.url.startsWith('/')||req.url.startsWith('//')||['forwarded','x-forwarded-proto','x-forwarded-host','x-forwarded-port'].some(k=>req.headers[k]!==undefined))return 'https_boundary_denied';
 if(req.headers['content-length']!==undefined){
  const n=Number(req.headers['content-length']);if(!Number.isSafeInteger(n)||n<0)return 'invalid_input';if(n>HTTP_LIMITS.maxBodyBytes)return 'payload_too_large';
 }
 return null;
}
export function createTransportLoginLimiter({now=()=>Date.now(),maxKeys=2048}={}){
 const counters=new Map();
 const reserve=(key,limit,windowMs)=>{
  const time=now();for(const [k,v]of counters)if(v.until<=time)counters.delete(k);
  let value=counters.get(key);if(!value){if(counters.size>=maxKeys)return false;value={n:0,until:time+windowMs};counters.set(key,value);}
  if(value.n>=limit)return false;value.n++;return true;
 };
 return (req,account)=>{
  const source=req.socket.remoteAddress??'unknown',hash=value=>createHash('sha256').update(value).digest('hex');
  return reserve('source:'+hash(source),60,60000)&&reserve('account-source:'+hash(source+'\0'+account),12,15*60000);
 };
}
export function configureHttpServer(server){
 server.headersTimeout=HTTP_LIMITS.headersTimeout;server.requestTimeout=HTTP_LIMITS.requestTimeout;server.keepAliveTimeout=HTTP_LIMITS.keepAliveTimeout;
 server.maxConnections=HTTP_LIMITS.maxConnections;server.maxRequestsPerSocket=HTTP_LIMITS.maxRequestsPerSocket;server.maxHeadersCount=64;
 server.setTimeout(HTTP_LIMITS.inactivityTimeout,socket=>socket.destroy());
}
