import {EVENTS} from './contract.js';

const ORIGIN='https://qyapi.weixin.qq.com';
const MAX_RESPONSE_BYTES=32768;
const MAX_MESSAGE_BYTES=1900;
const TOKEN_INVALID=new Set([40014,42001]);
const ID=/^[A-Za-z0-9_.-]{1,64}$/;
const safeError=(code,providerCode)=>Object.assign(Error(code),{code,...(Number.isSafeInteger(providerCode)&&providerCode>=0&&providerCode<=999999?{providerCode}:{})});
const clean=value=>String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim();
const clipped=(value,max=300)=>{let result='';for(const char of clean(value)){if(Buffer.byteLength(result+char,'utf8')>max)break;result+=char;}return result;};

export function validateWeComConfig(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw safeError('WECOM_CONFIG_INVALID');
  const {corpId,agentId,secret,storeLabel,criticalRecipients,warnRecipients,recoveryRecipients=[]}=input;
  if(typeof corpId!=='string'||!ID.test(corpId)||!Number.isSafeInteger(agentId)||agentId<=0||
    typeof secret!=='string'||secret.length<8||typeof storeLabel!=='string'||
    !storeLabel.trim()||storeLabel.length>80||/[\u0000-\u001f\u007f]/.test(storeLabel))throw safeError('WECOM_CONFIG_INVALID');
  for(const list of [criticalRecipients,warnRecipients,recoveryRecipients]){
    if(!Array.isArray(list)||(list!==recoveryRecipients&&!list.length)||list.length>20||
      list.some(id=>typeof id!=='string'||!ID.test(id))||new Set(list.map(id=>id.toLowerCase())).size!==list.length)
      throw safeError('WECOM_CONFIG_INVALID');
  }
  return Object.freeze({corpId,agentId,secret,storeLabel:storeLabel.trim(),
    criticalRecipients:Object.freeze([...criticalRecipients]),warnRecipients:Object.freeze([...warnRecipients]),recoveryRecipients:Object.freeze([...recoveryRecipients])});
}

async function readJson(response){
  if(!response||response.type==='opaqueredirect')throw safeError('WECOM_HTTP_FAILURE');
  if(response.status===429)throw safeError('WECOM_RATE_LIMIT');
  if(response.status>=500)throw safeError('WECOM_SERVER_ERROR');
  if(response.status!==200)throw safeError('WECOM_HTTP_FAILURE');
  const reader=response.body?.getReader();
  if(!reader)throw safeError('WECOM_RESPONSE_INVALID');
  const chunks=[];let size=0;
  try{
    for(;;){
      const {value,done}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>MAX_RESPONSE_BYTES){await reader.cancel();throw safeError('WECOM_RESPONSE_TOO_LARGE');}
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  try{
    const bytes=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||!Number.isSafeInteger(parsed.errcode))
      throw Error();
    return parsed;
  }catch{throw safeError('WECOM_RESPONSE_INVALID');}
}

function contentFor(payload,storeLabel){
  if(!payload||!EVENTS[payload.code]||!ID.test(payload.incidentId??'')||
    !ID.test(payload.deliveryId??'')||!Number.isSafeInteger(payload.sequence)||
    payload.sequence<1||!['OPEN','ESCALATED','REMINDER','RESOLVED'].includes(payload.transition))
    throw safeError('WECOM_PAYLOAD_INVALID');
  const definition=EVENTS[payload.code];
  const resolved=payload.transition==='RESOLVED';
  const fields=[
    resolved?'【金碧辉煌 KTV 系统已恢复】':'【金碧辉煌 KTV 系统告警】',
    '门店：'+storeLabel,
    '级别：'+(resolved?'RESOLVED':payload.severity),
    '状态：'+(resolved?'已恢复':'告警'),
    '事件：'+payload.code,
    '组件：'+(ID.test(payload.component??'')?payload.component:'runtime'),
    '说明：'+clipped(definition.message),
    ...(ID.test(payload.roomId??'')?['房间：'+payload.roomId]:[]),
    ...(ID.test(payload.workflowId??'')?['流程：'+payload.workflowId]:[]),
    '处理建议：'+clipped(definition.action),
    '手册：'+definition.runbook,
    '事件ID：'+payload.incidentId,
    '序号：'+payload.sequence,
    '投递ID：'+payload.deliveryId,
    '时间：'+(resolved?payload.resolvedAt:payload.occurredAt??payload.openedAt)
  ];
  const message=fields.join('\n');
  if(Buffer.byteLength(message,'utf8')>MAX_MESSAGE_BYTES)throw safeError('WECOM_MESSAGE_TOO_LONG');
  return message;
}

function invalidUsers(value){
  const values=[value.invaliduser,value.unlicenseduser];
  if(values.some(item=>item!==undefined&&typeof item!=='string'))throw safeError('WECOM_RESPONSE_INVALID');
  return new Set(values.flatMap(item=>item?item.split('|').filter(Boolean):[]).map(id=>id.toLowerCase()));
}

export function createWeComAlertTransport(options){
  const config=validateWeComConfig(options);
  const fetchImpl=options.fetchImpl??globalThis.fetch;
  const now=options.now??Date.now;
  const timeoutMs=options.timeoutMs??2000;
  if(typeof fetchImpl!=='function'||typeof now!=='function'||!Number.isSafeInteger(timeoutMs)||
    timeoutMs<100||timeoutMs>10000)throw safeError('WECOM_CONFIG_INVALID');
  const allowed=new Set([...config.criticalRecipients,...config.warnRecipients,...config.recoveryRecipients].map(id=>id.toLowerCase()));
  let cached=null,expiresAt=0,refreshing=null;
  async function request(path,{method='GET',body}={}){
    const url=new URL(path,ORIGIN);
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const response=await fetchImpl(url,{method,redirect:'manual',signal:controller.signal,
        ...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
      return await readJson(response);
    }catch(error){
      if(error?.code?.startsWith('WECOM_'))throw error;
      throw safeError(controller.signal.aborted?'WECOM_TIMEOUT':'WECOM_NETWORK_UNKNOWN');
    }finally{clearTimeout(timer);}
  }
  async function token(force=false){
    if(!force&&cached&&now()<expiresAt)return cached;
    if(refreshing)return refreshing;
    refreshing=(async()=>{
      const query=new URLSearchParams({corpid:config.corpId,corpsecret:config.secret});
      const reply=await request('/cgi-bin/gettoken?'+query);
      if(reply.errcode!==0)throw safeError('WECOM_TOKEN_REJECTED',reply.errcode);
      if(typeof reply.access_token!=='string'||!reply.access_token||
        !Number.isSafeInteger(reply.expires_in)||reply.expires_in<=0)
        throw safeError('WECOM_RESPONSE_INVALID');
      cached=reply.access_token;
      expiresAt=now()+Math.max(1000,reply.expires_in*1000-60000);
      return cached;
    })().finally(()=>{refreshing=null;});
    return refreshing;
  }
  const targetsFor=(incident,entry)=>{
    if(entry.transition==='RESOLVED')return [...new Set([...(incident.notifiedRecipients??[]),...(incident.possiblyNotifiedRecipients??[])])];
    if(entry.transition==='REMINDER'&&incident.notifiedRecipients?.length)
      return [...incident.notifiedRecipients];
    return [...(['CRITICAL','ERROR'].includes(entry.severity??incident.severity)
      ?config.criticalRecipients:config.warnRecipients)];
  };
  async function send(payload,recipients,contentOverride){
    if(!Array.isArray(recipients)||!recipients.length||recipients.some(id=>!allowed.has(id.toLowerCase())))
      throw safeError('WECOM_RECIPIENT_INVALID');
    const content=contentOverride??contentFor(payload,config.storeLabel);
    if(typeof content!=='string'||Buffer.byteLength(content,'utf8')>MAX_MESSAGE_BYTES)throw safeError('WECOM_MESSAGE_TOO_LONG');
    const message={touser:recipients.join('|'),msgtype:'text',agentid:config.agentId,
      text:{content},safe:0,enable_duplicate_check:1,duplicate_check_interval:1800};
    let access=await token();
    let reply=await request('/cgi-bin/message/send?'+new URLSearchParams({access_token:access}),
      {method:'POST',body:message});
    if(TOKEN_INVALID.has(reply.errcode)){
      if(cached===access){cached=null;expiresAt=0;}
      access=await token(cached===null);
      reply=await request('/cgi-bin/message/send?'+new URLSearchParams({access_token:access}),
        {method:'POST',body:message});
    }
    if(reply.errcode!==0)throw safeError(reply.errcode===81013?'WECOM_RECIPIENT_INVALID':
      reply.errcode===45009?'WECOM_RATE_LIMIT':'WECOM_PROVIDER_REJECTED',reply.errcode);
    const invalid=invalidUsers(reply);
    if([...invalid].some(id=>!recipients.some(target=>target.toLowerCase()===id)))throw safeError('WECOM_RESPONSE_INVALID');
    const invalidRecipients=recipients.filter(id=>invalid.has(id.toLowerCase()));
    const acceptedRecipients=recipients.filter(id=>!invalid.has(id.toLowerCase()));
    return {accepted:invalidRecipients.length===0&&acceptedRecipients.length>0,
      acceptedRecipients,invalidRecipients};
  }
  return Object.freeze({configured:true,targetsFor,messageFor:payload=>contentFor(payload,config.storeLabel),send});
}
