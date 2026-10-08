import { createKtvSkyHttpClient } from './ktvsky-http-client.js';
import { verifyRemainingCountdown } from './ktvsky-countdown.js';
import { isKtvSkySafetyPolicy } from './ktvsky-safety.js';

const authCodes=new Set([30010,30011]); // Observed frontend, not an official guarantee.
const text=value=>typeof value==='string'&&value.length>0&&value.length<=191&&value.trim()===value;
const secret=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!/[\r\n]/.test(value);
const cookieName=/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/;
export class KtvSkyBoundaryError extends Error {
  constructor(code) { super('KTVSky validation boundary denied the operation'); this.code=code; }
}
export const createKtvSkyCredentialProvider=(env=process.env)=>async()=>({
  telno:env.KTVSKY_TELNO,password:env.KTVSKY_PASSWORD
});
// Provider secrets and raw responses remain private to this adapter.
export class KtvSkyRoomControlGateway {
  #client;#credentials;#storeId;#enabled;#mutationPolicy;#now;#ttl;#cooldown;#maxLogins;
  #session=null;#cookies=new Map();#telno=null;#loggingIn=null;#lastLogin=-Infinity;#logins=0;
  #attempts=new Set();#pendingDevices=new Set();#acknowledgedDevices=new Map();
  constructor({httpClient=createKtvSkyHttpClient(),credentialProvider=createKtvSkyCredentialProvider(),
    storeId=null,enabled=false,mutationPolicy=()=>false,now=Date.now,
    sessionTtlMs=300000,reauthCooldownMs=30000,maxLoginAttempts=3}={}) {
    if(typeof httpClient?.request!=='function'||typeof credentialProvider!=='function'||
        typeof mutationPolicy!=='function'||typeof now!=='function'||typeof enabled!=='boolean'||
        ![sessionTtlMs,reauthCooldownMs,maxLoginAttempts].every(n=>Number.isSafeInteger(n)&&n>0))throw TypeError('Invalid KTVSky adapter configuration');
    this.#client=httpClient;this.#credentials=credentialProvider;this.#storeId=storeId===null?null:String(storeId);
    this.#enabled=enabled;this.#mutationPolicy=mutationPolicy;this.#now=now;
    this.#ttl=sessionTtlMs;this.#cooldown=reauthCooldownMs;this.#maxLogins=maxLoginAttempts;
  }
  // Stage 4B permits isolated validation, never production application wiring.
  get productionEnabled(){return false;}
  get testOnly(){return this.#client.testOnly===true;}
  #invalidate(){this.#session=null;this.#cookies.clear();}
  #acceptCookies(values,endpoint) {
    const origin=new URL(this.#client.origin);
    for(const raw of values) {
      if(typeof raw!=='string'||raw.length>8192)continue;
      const parts=raw.split(';').map(s=>s.trim()),i=parts[0].indexOf('=');
      if(i<1)continue;
      const name=parts[0].slice(0,i),value=parts[0].slice(i+1);
      if(!cookieName.test(name)||!(secret(value)||value===''))continue;
      const attrs=Object.fromEntries(parts.slice(1).map(s=>{const i=s.indexOf('=');return [s.slice(0,i<0?undefined:i).toLowerCase(),i<0?true:s.slice(i+1)];}));
      if(attrs.domain && origin.hostname!==String(attrs.domain).replace(/^\./,'').toLowerCase())continue;
      const path=typeof attrs.path==='string'&&attrs.path.startsWith('/')?attrs.path:'/h5';
      let expires=Infinity;
      if(attrs['max-age']!==undefined){const n=Number(attrs['max-age']);if(!Number.isSafeInteger(n))continue;expires=this.#now()+n*1000;}
      else if(attrs.expires){expires=Date.parse(attrs.expires);if(!Number.isFinite(expires))continue;}
      if(expires<=this.#now()){this.#cookies.delete(name);continue;}
      this.#cookies.set(name,{value,path,secure:attrs.secure===true,expires});
    }
  }
  #cookieHeader(endpoint) {
    const https=this.#client.origin.startsWith('https:'),path=endpoint==='search'?'/h5/search':'/h5/mac_control';
    return [...this.#cookies].filter(([,c])=>c.expires>this.#now()&&
      (!c.secure||https)&&(path===c.path||path.startsWith(c.path.endsWith('/')?c.path:c.path+'/'))).map(([name,c])=>name+'='+c.value).join('; ');
  }
  async ensureSession({signal}={}) {
    if(this.#session && this.#session.expires>this.#now())return {ready:true};
    if(this.#loggingIn)return this.#loggingIn;
    if(this.#logins>=this.#maxLogins || this.#now()-this.#lastLogin<this.#cooldown)return {ready:false,code:'AUTH_REQUIRED'};
    this.#invalidate();this.#lastLogin=this.#now();this.#logins++;
    const login=async()=>{
      try {
        const credentials=await this.#credentials();
        if(!text(credentials?.telno)||!secret(credentials?.password))return {ready:false,code:'AUTH_REQUIRED'};
        const response=await this.#client.request({endpoint:'login',body:{telno:credentials.telno,password:credentials.password},signal});
        if(response.status===401||response.status===403||authCodes.has(response.data?.code))return {ready:false,code:'AUTH_REQUIRED'};
        if(response.status!==200)return {ready:false,code:'PROVIDER_UNAVAILABLE'};
        if(response.data?.code!==200||!secret(response.data.token))return {ready:false,code:'AUTH_REQUIRED'};
        this.#telno=credentials.telno;this.#session={token:response.data.token,expires:this.#now()+this.#ttl};
        this.#acceptCookies(response.setCookies,'login');return {ready:true};
      }catch{return {ready:false,code:'PROVIDER_UNAVAILABLE'};}
    };
    this.#loggingIn=login();
    try{return await this.#loggingIn;}finally{this.#loggingIn=null;}
  }
  #scope(input) {
    if(!input||input.provider!=='ktvsky'||!text(input.externalDeviceId)||!text(input.workflowId)||!text(input.stepId))throw TypeError('Explicit KTVSky device and workflow identity required');
    return {provider:'ktvsky',externalDeviceId:input.externalDeviceId,workflowId:input.workflowId,stepId:input.stepId,evidenceVersion:1};
  }
  #unknown(input,code='DEVICE_UNKNOWN',extra={}) {
    return {...this.#scope(input),kind:'UNKNOWN',diagnosticCode:code,stepResult:'UNKNOWN',settled:false,retrySafe:false,...extra};
  }
  async #request(endpoint,input,body) {
    const auth=await this.ensureSession(input);
    if(!auth.ready)return {error:auth.code};
    try {
      if(input?.signal?.aborted||(endpoint==='control'&&input.canDispatch!==undefined&&input.canDispatch()!==true))return {error:'DISPATCH_STOPPED'};
      if(endpoint==='control'&&this.#mutationPolicy(input)!==true)return {error:'SAFE_VALIDATION_REQUIRED'};
      const sentAt=new Date(this.#now()).toISOString();
      const response=await this.#client.request({endpoint,telno:this.#telno,body:endpoint==='control'?{...body,telno:this.#telno}:body,
        token:this.#session.token,cookie:this.#cookieHeader(endpoint),signal:input?.signal});
      if(response.status===401||response.status===403||authCodes.has(response.data?.code)){
        this.#invalidate();return {error:'AUTH_REQUIRED'};
      }
      if(response.status!==200)return {error:'PROVIDER_UNAVAILABLE'};
      if(response.data?.code!==200)return {error:'DEVICE_UNKNOWN'};
      this.#acceptCookies(response.setCookies,endpoint);return {data:response.data,sentAt,acknowledgedAt:new Date(this.#now()).toISOString()};
    }catch{return {error:'PROVIDER_UNAVAILABLE'};}
  }
  async getRoomStatus(input) {
    const scope=this.#scope(input);
    if(!text(this.#storeId))return this.#unknown(input,'STORE_SCOPE_REQUIRED');
    const acknowledgedAtQueryStart=this.#acknowledgedDevices.get(input.externalDeviceId);
    const response=await this.#request('search',input);
    if(response.error)return this.#unknown(input,response.error);
    const result=response.data.result;
    if(!result||String(result.store_id)!==this.#storeId||!Array.isArray(result.list)||result.list.length>1000)return this.#unknown(input,'INVALID_PROVIDER_EVIDENCE');
    const matches=result.list.filter(row=>row && row.mac===input.externalDeviceId);
    if(matches.length===0)return {...scope,kind:'STATE',exists:false,room:null,stepResult:'UNKNOWN',settled:false,retrySafe:false};
    if(matches.length!==1)return this.#unknown(input,'INVALID_PROVIDER_EVIDENCE');
    const row=matches[0];
    if(![0,1].includes(row.alive)||![0,1].includes(row.status))return this.#unknown(input,'INVALID_PROVIDER_EVIDENCE');
    const observedAt=new Date(this.#now()).toISOString();
    const remainingCountdownSeconds=Number.isSafeInteger(row.opentime)&&row.opentime>=0?row.opentime:null;
    const ack=this.#acknowledgedDevices.get(input.externalDeviceId);
    if(ack && ack===acknowledgedAtQueryStart && row.alive===1 && row.status===ack.status && (ack.status===0 || verifyRemainingCountdown({...ack,observedAt,remainingCountdownSeconds}))){
      this.#pendingDevices.delete(input.externalDeviceId);this.#acknowledgedDevices.delete(input.externalDeviceId);
    }
    return {...scope,kind:'STATE',exists:true,stepResult:'UNKNOWN',settled:false,retrySafe:false,
      room:{online:row.alive===1,open:row.status===1,countdownTargetEndAt:null,
        remainingCountdownSeconds,observedAt,
        observedCountdownValue:remainingCountdownSeconds, // Compatibility alias.
        countdownUnit:'SECONDS'}};
  }
  async queryRoomState(input){return this.getRoomStatus(input);}
  async #mutate(input,status) {
    this.#scope(input);
    if(!this.#enabled)throw new KtvSkyBoundaryError('LIVE_CONTROL_DISABLED');
    if((!this.testOnly&&!isKtvSkySafetyPolicy(this.#mutationPolicy))||this.#mutationPolicy(input)!==true)throw new KtvSkyBoundaryError('SAFE_VALIDATION_REQUIRED');
    if(status===1&&(!Number.isSafeInteger(input.countdownSeconds)||input.countdownSeconds<=0||
        typeof input.targetEndAt!=='string'||!Number.isFinite(Date.parse(input.targetEndAt))))throw TypeError('Combined countdown input required');
    const key=JSON.stringify([input.workflowId,input.stepId,input.externalDeviceId]);
    if(this.#attempts.has(key)||this.#pendingDevices.has(input.externalDeviceId))return this.#unknown(input);
    if(this.#attempts.size>=1000)throw new KtvSkyBoundaryError('RECONCILIATION_REQUIRED');
    this.#attempts.add(key);this.#pendingDevices.add(input.externalDeviceId); // Unknown effects also block new steps.
    const response=await this.#request('control',input,{
      mac:input.externalDeviceId,status,telno:this.#telno,
      ...(status===1?{opentime:input.countdownSeconds}:{})
    });
    if(response.error)return this.#unknown(input,response.error==='AUTH_REQUIRED'?'AUTH_REQUIRED':'DEVICE_UNKNOWN');
    // ACK is known transport outcome, not completion. The caller must query the
    // desired state before another step; the same operation identity stays blocked.
    this.#acknowledgedDevices.set(input.externalDeviceId,{status,requestedCountdownSeconds:input.countdownSeconds,sentAt:response.sentAt});
    return {...this.#unknown(input,'ACKNOWLEDGED',{acknowledged:true}),kind:'ACKNOWLEDGED',
      sentAt:response.sentAt,acknowledgedAt:response.acknowledgedAt};
  }
  async closeRoom(input){return this.#mutate(input,0);}
  async openRoom(input){return this.#mutate(input,1);}
}
