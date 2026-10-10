import test from 'node:test';
import assert from 'node:assert/strict';
import {createWeComAlertTransport} from './wecom.js';
import {createOperationalStore} from './store.js';
import {createIncidentLifecycle} from './incidents.js';
import {createAlertDispatcher} from './alerts.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const incidentPayload = Object.freeze({
  deliveryId: 'd-1', incidentId: 'i-1', sequence: 1, transition: 'OPEN',
  severity: 'ERROR', code: 'DATABASE_UNAVAILABLE', component: 'database',
  message: '数据库不可用', action: '联系负责人', runbook: 'DATABASE_UNAVAILABLE',
  openedAt: '2026-10-11T00:00:00.000Z', occurredAt: '2026-10-11T00:00:00.000Z'
});

test('WeCom accepts a safe text alert and reuses its server-side token', async () => {
  const calls=[];
  const fetchImpl=async (url,options) => {
    calls.push({url:String(url),options});
    return new Response(JSON.stringify(calls.length===1
      ? {errcode:0,access_token:'synthetic-token',expires_in:7200}
      : {errcode:0,errmsg:'ok'}),{status:200});
  };
  const transport=createWeComAlertTransport({corpId:'synthetic-corp',agentId:123,
    secret:'synthetic-secret',storeLabel:'金碧辉煌 KTV',
    criticalRecipients:['boss'],warnRecipients:['boss'],fetchImpl});
  const first=await transport.send(incidentPayload,['boss']);
  const second=await transport.send({...incidentPayload,deliveryId:'d-2',sequence:2},['boss']);
  assert.deepEqual(first,{accepted:true,acceptedRecipients:['boss'],invalidRecipients:[]});
  assert.equal(second.accepted,true);
  assert.equal(calls.filter(call=>call.url.includes('/gettoken')).length,1);
  assert.equal(calls.filter(call=>call.url.includes('/message/send')).length,2);
  const sent=JSON.parse(calls[1].options.body);
  assert.equal(sent.msgtype,'text');
  assert.equal(sent.touser,'boss');
  assert.equal(sent.enable_duplicate_check,1);
  assert.match(sent.text.content,/i-1/);
  assert.match(sent.text.content,/d-1/);
  assert.doesNotMatch(sent.text.content,/synthetic-secret|synthetic-token/);
});

const config={corpId:'synthetic-corp',agentId:123,secret:'synthetic-secret',
  storeLabel:'Synthetic KTV',criticalRecipients:['boss'],warnRecipients:['boss']};
const json=value=>new Response(JSON.stringify(value),{status:200});
const tokenReply={errcode:0,access_token:'synthetic-token',expires_in:7200};
const ok={errcode:0,errmsg:'ok'};
function fake(reply=ok){
  const calls=[];
  return {calls,fetchImpl:async (url,options)=>{
    calls.push({url:String(url),options});
    return json(String(url).includes('/gettoken')?tokenReply:reply);
  }};
}

test('WeCom refreshes expired token and singleflights concurrent acquisition',async()=>{
  let clock=0,tokens=0,sends=0;
  const fetchImpl=async url=>{
    if(String(url).includes('/gettoken')){tokens++;await new Promise(r=>setTimeout(r,15));return json({errcode:0,access_token:'token-'+tokens,expires_in:120});}
    sends++;return json(ok);
  };
  const transport=createWeComAlertTransport({...config,fetchImpl,now:()=>clock});
  await Promise.all(Array.from({length:5},()=>transport.send(incidentPayload,['boss'])));
  assert.equal(tokens,1);assert.equal(sends,5);
  clock=61000;await transport.send(incidentPayload,['boss']);
  assert.equal(tokens,2);
});

test('confirmed invalid token gets exactly one refreshed resend of identical content',async()=>{
  let tokens=0;const bodies=[];
  const fetchImpl=async (url,options)=>{
    if(String(url).includes('/gettoken'))return json({errcode:0,access_token:'token-'+ ++tokens,expires_in:7200});
    bodies.push(options.body);
    return json(bodies.length===1?{errcode:42001,errmsg:'raw secret should not leak'}:ok);
  };
  const transport=createWeComAlertTransport({...config,fetchImpl});
  assert.equal((await transport.send(incidentPayload,['boss'])).accepted,true);
  assert.equal(tokens,2);assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);
});

test('provider rejection and partial invalid recipients are not accepted as full delivery',async()=>{
  const partial=fake({errcode:0,invaliduser:'wife',unlicenseduser:''});
  const transport=createWeComAlertTransport({...config,criticalRecipients:['boss','wife'],fetchImpl:partial.fetchImpl});
  assert.deepEqual(await transport.send(incidentPayload,['boss','wife']),{
    accepted:false,acceptedRecipients:['boss'],invalidRecipients:['wife']});
  const rejected=fake({errcode:45009,errmsg:'raw secret should not leak'});
  const failed=createWeComAlertTransport({...config,fetchImpl:rejected.fetchImpl});
  await assert.rejects(failed.send(incidentPayload,['boss']),error=>
    error.code==='WECOM_RATE_LIMIT'&&error.providerCode===45009&&!error.message.includes('raw secret'));
  assert.equal(rejected.calls.length,2);
});

test('protected recovery recipient approval allows old owner but rejects unknown IDs',async()=>{
  const f=fake();
  const transport=createWeComAlertTransport({...config,criticalRecipients:['new-boss'],
    warnRecipients:['new-boss'],recoveryRecipients:['boss'],fetchImpl:f.fetchImpl});
  assert.deepEqual(transport.targetsFor({notifiedRecipients:['boss']},{transition:'RESOLVED'}),['boss']);
  assert.equal((await transport.send(incidentPayload,['boss'])).accepted,true);
  await assert.rejects(transport.send(incidentPayload,['stranger']),{code:'WECOM_RECIPIENT_INVALID'});
});

test('WeCom rejects HTTP, redirects, malformed and oversized responses safely',async()=>{
  const cases=[
    [()=>new Response('',{status:429}),'WECOM_RATE_LIMIT'],
    [()=>new Response('',{status:503}),'WECOM_SERVER_ERROR'],
    [()=>new Response('',{status:302}),'WECOM_HTTP_FAILURE'],
    [()=>new Response('{bad',{status:200}),'WECOM_RESPONSE_INVALID'],
    [()=>new Response('x'.repeat(33000),{status:200}),'WECOM_RESPONSE_TOO_LARGE']
  ];
  for(const [response,code] of cases){
    const transport=createWeComAlertTransport({...config,fetchImpl:async()=>response()});
    await assert.rejects(transport.send(incidentPayload,['boss']),{code});
  }
});

test('WeCom classifies timeout and connection reset as unknown without exposing URLs',async()=>{
  const timeout=createWeComAlertTransport({...config,timeoutMs:100,fetchImpl:(_,options)=>
    new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('private body'))))});
  await assert.rejects(timeout.send(incidentPayload,['boss']),{code:'WECOM_TIMEOUT'});
  const reset=createWeComAlertTransport({...config,fetchImpl:async()=>{throw Error('private URL token');}});
  await assert.rejects(reset.send(incidentPayload,['boss']),error=>
    error.code==='WECOM_NETWORK_UNKNOWN'&&!error.message.includes('private'));
});

test('WeCom fixed safe payload ignores arbitrary supplied message and bounds content',async()=>{
  const f=fake();
  const transport=createWeComAlertTransport({...config,fetchImpl:f.fetchImpl});
  await transport.send({...incidentPayload,message:'password=synthetic-secret',
    action:'raw request body',roomId:'private customer name'},['boss']);
  const content=JSON.parse(f.calls[1].options.body).text.content;
  for(const value of ['synthetic-secret','synthetic-token','password=','raw request body','private customer name'])
    assert.equal(content.includes(value),false);
  assert.ok(Buffer.byteLength(content,'utf8')<=1900);
});

test('synthetic incident OPEN and RESOLVED reach the same WeCom recipient with ordered identity',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ktv-wecom-lifecycle-'));
  try{
    const store=await createOperationalStore(dir,'synthetic');
    const life=createIncidentLifecycle({store,scope:'synthetic',logger:{log(){}}});
    const sent=[];
    const fetchImpl=async (url,options)=>{
      if(String(url).includes('/gettoken'))return json(tokenReply);
      sent.push(JSON.parse(options.body));return json(ok);
    };
    const transport=createWeComAlertTransport({...config,fetchImpl});
    const dispatcher=createAlertDispatcher({store,transport,logger:{log(){}}});
    const opened=await life.condition('DATABASE_UNAVAILABLE',true,{component:'database'});
    await dispatcher.tick();
    assert.deepEqual(store.read().incidents[0].notifiedRecipients,['boss']);
    await life.condition('DATABASE_UNAVAILABLE',false,{component:'database'});
    await dispatcher.tick();
    assert.equal(sent.length,2);
    assert.deepEqual(sent.map(item=>item.touser),['boss','boss']);
    assert.match(sent[0].text.content,new RegExp(opened.incidentId));
    assert.match(sent[1].text.content,new RegExp(opened.incidentId));
    const deliveries=store.read().outbox;
    assert.deepEqual(deliveries.map(item=>item.sequence),[1,2]);
    assert.ok(deliveries.every(item=>item.state==='DELIVERED'));
    assert.notEqual(deliveries[0].deliveryId,deliveries[1].deliveryId);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('crash after provider acceptance still sends recovery to the possibly notified owner',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ktv-wecom-crash-'));
  try{
    const persisted=await createOperationalStore(dir,'synthetic');
    const life=createIncidentLifecycle({store:persisted,scope:'synthetic',logger:{log(){}}});
    const incident=await life.condition('DATABASE_UNAVAILABLE',true,{component:'database'});
    const sent=[];
    const transport=createWeComAlertTransport({...config,fetchImpl:async (url,options)=>{
      if(String(url).includes('/gettoken'))return json(tokenReply);
      sent.push(JSON.parse(options.body));return json(ok);
    }});
    let updates=0;
    const crashStore={read:()=>persisted.read(),update:work=>{
      if(++updates===2)throw Error('SYNTHETIC_PROCESS_CRASH');
      return persisted.update(work);
    }};
    await assert.rejects(createAlertDispatcher({store:crashStore,transport,
      logger:{log(){}}}).tick(),/SYNTHETIC_PROCESS_CRASH/);
    assert.equal(sent.length,1);
    assert.equal(persisted.read().outbox[0].uncertain,true);
    assert.equal(persisted.read().incidents[0].notifiedRecipients,undefined);
    const restarted=await createOperationalStore(dir,'synthetic');
    const resumedLife=createIncidentLifecycle({store:restarted,scope:'synthetic',logger:{log(){}}});
    await resumedLife.condition('DATABASE_UNAVAILABLE',false,{component:'database'});
    assert.deepEqual(restarted.read().incidents[0].possiblyNotifiedRecipients,['boss']);
    await createAlertDispatcher({store:restarted,transport,logger:{log(){}}}).tick();
    assert.equal(sent.length,2);
    assert.deepEqual(sent.map(item=>item.touser),['boss','boss']);
    assert.match(sent[1].text.content,new RegExp(incident.incidentId));
    assert.equal(restarted.read().outbox.at(-1).state,'DELIVERED');
  }finally{await rm(dir,{recursive:true,force:true});}
});
