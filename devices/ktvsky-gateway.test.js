import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { createKtvSkyHttpClient } from './ktvsky-http-client.js';
import { KtvSkyRoomControlGateway } from './ktvsky-gateway.js';
import { providerFixture, deviceInput, syntheticCredentials } from '../test-support/ktvsky-provider-fixture.js';

const controls=f=>f.requests.filter(r=>r.path==='/h5/mac_control');
test('KTVSky defaults deny mutation before credentials or network, and never enable production wiring',async t=>{
 const f=await providerFixture(t);
 assert.equal(f.gateway.productionEnabled,false);assert.equal(typeof f.gateway.setCountdown,'undefined');
 await assert.rejects(f.gateway.openRoom(deviceInput),{code:'LIVE_CONTROL_DISABLED'});
 assert.equal(f.requests.length,0);
 const enabled=await providerFixture(t,{gatewayOptions:{enabled:true}});
 await assert.rejects(enabled.gateway.closeRoom(deviceInput),{code:'SAFE_VALIDATION_REQUIRED'});
 assert.equal(enabled.requests.length,0);
});
test('observed login/search contract carries private token and Cookie, returns only sanitized versioned state',async t=>{
 const f=await providerFixture(t);
 assert.deepEqual(await f.gateway.ensureSession(),{ready:true});
 const result=await f.gateway.getRoomStatus(deviceInput);
 assert.equal(result.kind,'STATE');assert.equal(result.exists,true);assert.equal(result.room.online,true);
 assert.equal(result.room.open,false);assert.equal(result.evidenceVersion,1);
 assert.equal(result.room.countdownTargetEndAt,null);assert.equal(result.room.countdownUnit,'UNVERIFIED');
 assert.deepEqual(f.requests[0].body,syntheticCredentials);assert.equal(f.requests[0].method,'POST');
 const read=f.requests[1];assert.equal(read.method,'GET');assert.equal(read.path,'/h5/search');
 assert.equal(read.telno,syntheticCredentials.telno);
 assert.equal(read.headers['x-token'],'synthetic-provider-token');assert.equal(read.headers.cookie,'provider_sid=synthetic-cookie');
 const exposed=JSON.stringify({gateway:f.gateway,result,logs:f.logs});
 for(const value of ['synthetic-password','synthetic-provider-token','synthetic-cookie','synthetic-account','private-provider-detail','private-detail'])
  assert.equal(exposed.includes(value),false);
});
test('query ONLINE/OFFLINE, missing identity, wrong store and duplicate device fail conservatively',async t=>{
 const f=await providerFixture(t);f.state.alive=0;assert.equal((await f.gateway.queryRoomState(deviceInput)).room.online,false);
 assert.equal((await f.gateway.getRoomStatus({...deviceInput,externalDeviceId:'absent'})).exists,false);
 const wrong=await providerFixture(t,{gatewayOptions:{storeId:999}});
 assert.equal((await wrong.gateway.getRoomStatus(deviceInput)).diagnosticCode,'INVALID_PROVIDER_EVIDENCE');
 const duplicate=await providerFixture(t,{handler:({res,entry})=>{
  if(entry.path!=='/h5/search')return false;
  res.end(JSON.stringify({code:200,result:{store_id:123,list:[{mac:'synthetic-device'},{mac:'synthetic-device'}]}}));return true;
 }});
 assert.equal((await duplicate.gateway.getRoomStatus(deviceInput)).kind,'UNKNOWN');
});
for(const action of ['closeRoom','openRoom'])test(action+' maps one POST; acknowledgement is not settled proof or permission to repeat',async t=>{
 const f=await providerFixture(t,{gatewayOptions:{enabled:true,mutationPolicy:()=>true}});
 const result=await f.gateway[action](deviceInput);
 assert.equal(controls(f).length,1);assert.equal(controls(f)[0].method,'POST');
 assert.deepEqual(controls(f)[0].body,{mac:'synthetic-device',status:action==='openRoom'?1:0,
  telno:'synthetic-account',...(action==='openRoom'?{opentime:60}:{})});
 assert.equal(result.kind,'UNKNOWN');assert.equal(result.acknowledged,true);
 assert.equal(result.settled,false);assert.equal(result.retrySafe,false);
 const queried=await f.gateway.queryRoomState(deviceInput);
 assert.equal(queried.stepResult,'UNKNOWN');assert.equal(queried.settled,false);
 await f.gateway[action](deviceInput);assert.equal(controls(f).length,1);
});
test('concurrent open calls send one combined mutation with the application value unchanged',async t=>{
 const f=await providerFixture(t,{gatewayOptions:{enabled:true,mutationPolicy:()=>true}});
 await Promise.all([f.gateway.openRoom({...deviceInput,countdownSeconds:10800}),
  f.gateway.openRoom({...deviceInput,countdownSeconds:10800})]);
 assert.equal(controls(f).length,1);assert.equal(controls(f)[0].body.opentime,10800);
});
test('missing credentials and raw provider errors do not escape',async t=>{
 const f=await providerFixture(t,{gatewayOptions:{credentialProvider:async()=>({})}});
 assert.deepEqual(await f.gateway.ensureSession(),{ready:false,code:'AUTH_REQUIRED'});assert.equal(f.requests.length,0);
 const bad=await providerFixture(t,{handler:({res})=>{res.writeHead(500);res.end(JSON.stringify({password:'synthetic-password',stack:'private-stack'}));return true;}});
 const result=await bad.gateway.ensureSession();assert.equal(result.code,'PROVIDER_UNAVAILABLE');
 assert.equal(JSON.stringify([result,bad.logs]).includes('private-stack'),false);
});
test('session cache, bounded concurrent login, local TTL and explicit re-auth after cooldown',async t=>{
 let clock=0;
 const f=await providerFixture(t,{gatewayOptions:{now:()=>clock,sessionTtlMs:100,reauthCooldownMs:1,maxLoginAttempts:2}});
 await Promise.all([f.gateway.ensureSession(),f.gateway.ensureSession()]);
 assert.equal(f.requests.length,1);await f.gateway.ensureSession();assert.equal(f.requests.length,1);
 clock=101;assert.equal((await f.gateway.ensureSession()).ready,true);assert.equal(f.requests.length,2);
 clock=202;assert.equal((await f.gateway.ensureSession()).code,'AUTH_REQUIRED');assert.equal(f.requests.length,2);
});
for(const authFailure of [401,403,30010,30011])test('auth failure '+authFailure+' invalidates session without retrying mutation',async t=>{
 let clock=0;
 const f=await providerFixture(t,{gatewayOptions:{enabled:true,mutationPolicy:()=>true,now:()=>clock},handler:({res,entry})=>{
  if(entry.path!=='/h5/mac_control')return false;
  if(authFailure<1000){res.writeHead(authFailure);res.end('denied');}
  else res.end(JSON.stringify({code:authFailure,msg:'secret response detail'}));
  return true;
 }});
 const result=await f.gateway.closeRoom(deviceInput);assert.equal(result.kind,'UNKNOWN');
 assert.equal(result.diagnosticCode,'AUTH_REQUIRED');assert.equal(controls(f).length,1);
 assert.equal((await f.gateway.ensureSession()).code,'AUTH_REQUIRED');
 clock=31000;assert.equal((await f.gateway.ensureSession()).ready,true);
 await f.gateway.closeRoom(deviceInput);assert.equal(controls(f).length,1);
 assert.equal(JSON.stringify([result,f.logs]).includes('secret response detail'),false);
});
test('sent open timeout is UNKNOWN; query observes state but never fabricates settled proof',async t=>{
 const f=await providerFixture(t,{clientOptions:{requestTimeoutMs:40},gatewayOptions:{enabled:true,mutationPolicy:()=>true},
  handler:({entry,state})=>{if(entry.path!=='/h5/mac_control')return false;state.status=1;state.opentime=entry.body.opentime;return true;}});
 const result=await f.gateway.openRoom(deviceInput);assert.equal(result.kind,'UNKNOWN');
 assert.equal(result.diagnosticCode,'DEVICE_UNKNOWN');assert.equal(controls(f).length,1);
 const read=await f.gateway.queryRoomState(deviceInput);assert.equal(read.room.open,true);
 assert.equal(read.stepResult,'UNKNOWN');assert.equal(read.retrySafe,false);
 await f.gateway.openRoom(deviceInput);assert.equal(controls(f).length,1);
});
test('HTTP response bound, malformed JSON and redirects reject without credential-bearing diagnostics',async t=>{
 for(const mode of ['oversize','invalid','redirect']){
  const f=await providerFixture(t,{clientOptions:{maxResponseBytes:100},handler:({res})=>{
   if(mode==='redirect'){res.writeHead(302,{Location:'https://example.invalid/'});res.end();}
   else res.end(mode==='invalid'?'not-json':JSON.stringify({detail:'x'.repeat(200)}));
   return true;
  }});
  assert.equal((await f.gateway.ensureSession()).code,'PROVIDER_UNAVAILABLE');
  assert.equal(f.requests.length,1);assert.equal(JSON.stringify(f.logs).includes('telno'),false);
 }
});
test('HTTPS is required outside explicit loopback tests; TLS handshake has a connect deadline',async t=>{
 assert.throws(()=>createKtvSkyHttpClient({baseUrl:'http://lknewcms.ktvsky.com'}));
 assert.throws(()=>createKtvSkyHttpClient({baseUrl:'https://example.invalid'}));
 assert.throws(()=>createKtvSkyHttpClient({baseUrl:'http://127.0.0.1:1'}));
 const sockets=new Set(),server=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{for(const s of sockets)s.destroy();server.close(resolve);}));
 const client=createKtvSkyHttpClient({baseUrl:'https://127.0.0.1:'+server.address().port,testOnly:true,connectTimeoutMs:25,requestTimeoutMs:100});
 await assert.rejects(client.request({endpoint:'login',body:syntheticCredentials}),{reason:'CONNECT_TIMEOUT'});
});
test('Cookie deletion, path scope and Secure flag are honored',async t=>{
 let reads=0;
 const f=await providerFixture(t,{handler:({entry,res})=>{
  if(entry.path==='/h5/login'){
   res.setHeader('Set-Cookie',['normal=yes; Path=/h5','secure=yes; Secure; Path=/','other=no; Path=/else',
    'outside=no; Domain=example.invalid; Path=/']);
   res.end(JSON.stringify({code:200,token:'synthetic-provider-token'}));return true;
  }
  if(entry.path==='/h5/search'&&reads++===0)res.setHeader('Set-Cookie','normal=; Max-Age=0; Path=/h5');
  return false;
 }});
 await f.gateway.getRoomStatus(deviceInput);await f.gateway.getRoomStatus(deviceInput);
 const readsActual=f.requests.filter(r=>r.path==='/h5/search');
 assert.equal(readsActual[0].headers.cookie,'normal=yes');assert.equal(readsActual[1].headers.cookie,undefined);
});
