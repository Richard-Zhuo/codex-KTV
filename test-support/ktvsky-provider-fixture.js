import http from 'node:http';
import { once } from 'node:events';
import { createKtvSkyHttpClient } from '../devices/ktvsky-http-client.js';
import { KtvSkyRoomControlGateway } from '../devices/ktvsky-gateway.js';

export const syntheticCredentials=Object.freeze({telno:'synthetic-account',password:'synthetic-password'});
export const deviceInput=Object.freeze({provider:'ktvsky',externalDeviceId:'synthetic-device',
  workflowId:'synthetic-workflow',stepId:'synthetic-workflow:OPEN',
  countdownSeconds:60,targetEndAt:'2026-10-08T10:00:00.000Z'});
export async function providerFixture(t,{handler,clientOptions={},gatewayOptions={}}={}) {
  const requests=[],logs=[],state={alive:1,status:0,opentime:0};
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null;
    const url=new URL(req.url,'http://127.0.0.1');
    const entry={method:req.method,path:url.pathname,telno:url.searchParams.get('telno'),headers:req.headers,body};
    requests.push(entry);
    if(handler && await handler({req,res,entry,state,requests}))return;
    res.setHeader('Content-Type','application/json');
    if(url.pathname==='/h5/login'){
      res.setHeader('Set-Cookie','provider_sid=synthetic-cookie; Path=/h5; HttpOnly');
      res.end(JSON.stringify({code:200,token:'synthetic-provider-token',result:{}}));return;
    }
    if(url.pathname==='/h5/search'){
      res.end(JSON.stringify({code:200,result:{store_id:123,list:[{mac:'synthetic-device',
        room_name:'Synthetic room',ip:'private-provider-detail',version:'private-detail',...state}]}}));return;
    }
    if(url.pathname==='/h5/mac_control'){
      state.status=body.status;if(body.status===1)state.opentime=body.opentime;
      res.end(JSON.stringify({code:200,msg:'private provider diagnostic'}));return;
    }
    res.writeHead(404);res.end('{}');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const client=createKtvSkyHttpClient({baseUrl:'http://127.0.0.1:'+server.address().port,
    testOnly:true,logger:row=>logs.push(row),...clientOptions});
  const gateway=new KtvSkyRoomControlGateway({httpClient:client,
    credentialProvider:async()=>syntheticCredentials,storeId:123,...gatewayOptions});
  return {server,client,gateway,requests,logs,state};
}
