import https from 'node:https';import {activationFailure} from './activation-receipt.js';
// Direct local connection. Agent/proxy/redirect and unsafe TLS options are not exposed.
export function observeActivation(config,socket,challenge,{ca}={}){
 return new Promise((resolve,reject)=>{
  if(!/^[a-f0-9]{64}$/.test(challenge))return reject(activationFailure());
  const origin=new URL(config.publicOrigin);let settled=false;const done=(err,value)=>{if(settled)return;settled=true;if(err)reject(activationFailure());else resolve(value);};
  const request=https.request({host:socket.host,port:socket.port,servername:origin.hostname,headers:{Host:origin.host},method:'GET',path:'/health/ready?activationChallenge='+challenge,agent:false,rejectUnauthorized:true,...(ca?{ca}:{})},response=>{
   const peerAddress=response.socket.remoteAddress,peerPort=response.socket.remotePort;let bytes=0,parts=[];
   response.on('data',part=>{bytes+=part.length;if(bytes>8192){request.destroy();done(true);}else parts.push(part);});response.on('error',()=>done(true));response.on('end',()=>{try{if(response.statusCode!==200)throw activationFailure();const value=JSON.parse(Buffer.concat(parts).toString('utf8')).activation;done(false,{...value,peerAddress,peerPort});}catch{done(true);}});
  });request.setTimeout(2500,()=>{request.destroy();done(true);});request.on('error',()=>done(true));request.end();
 });
}
