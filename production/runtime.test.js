import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeConfig,validateFileAcl,privateHost } from './runtime-config.js';
import { createSafeLogger } from './runtime-log.js';
import { BUSINESS_DAY_POLICY } from '../shared/business-day.js';
import { SESSION_RULE_VERSION } from '../shared/business-session.js';
export const env={NODE_ENV:'production',KTV_HTTP_ENV:'production',KTV_DEPLOYMENT_ENV:'production'};
export const sample={configVersion:1,applicationCommit:'a'.repeat(40),publicOrigin:'https://ktv.example.invalid:8443',listenHost:'127.0.0.1',port:8443,storeId:'synthetic',ledgerId:'synthetic',timeZone:'Asia/Shanghai',businessDateCutoff:BUSINESS_DAY_POLICY.cutoff,sessionRuleVersion:SESSION_RULE_VERSION,deviceControlMode:'disabled',liveControlEnabled:false,secretsFile:'C:/outside/secrets.json',logDirectory:'C:/outside/logs',serviceAccountSid:'S-1-5-21-1-2-3-1001',backupPolicyConfigured:false,directoryAclReviewed:true,networkModel:'private-vpn'};
test('production runtime requires explicit canonical environment, pinned Node and private HTTPS configuration',()=>{
 assert.equal(validateRuntimeConfig(sample,env).publicOrigin,sample.publicOrigin);
 for(const v of [undefined,'test','Production',' production ','unknown'])assert.throws(()=>validateRuntimeConfig(sample,{...env,KTV_DEPLOYMENT_ENV:v}));
 for(const patch of [{publicOrigin:'http://ktv.example.invalid:8443'},{publicOrigin:'https://localhost:8443'},{listenHost:'0.0.0.0'},{liveControlEnabled:true},{networkModel:'public'},{directoryAclReviewed:false},{serviceAccountSid:'S-1-5-18'}])assert.throws(()=>validateRuntimeConfig({...sample,...patch},env));
 assert.throws(()=>validateRuntimeConfig(sample,{...env,NODE_TLS_REJECT_UNAUTHORIZED:'0'}));
 assert.throws(()=>validateRuntimeConfig(sample,env,'26.0.0'));
 for(const host of ['127.0.0.1','10.1.2.3','192.168.1.1','172.16.0.1'])assert.equal(privateHost(host),true);
 for(const host of ['8.8.8.8','0.0.0.0','provider.example'])assert.equal(privateHost(host),false);
});
test('Windows ACL contract requires protected owner/current service SID and no broad allow rules',()=>{
 const sid=sample.serviceAccountSid,acl={protected:true,current:sid,owner:sid,rules:[{sid,type:'Allow',rights:1}]};
 validateFileAcl(acl,sid);
 for(const bad of [{...acl,protected:false},{...acl,current:'S-1-5-18'},{...acl,owner:'S-1-1-0'},{...acl,rules:[...acl.rules,{sid:'S-1-1-0',type:'Allow',rights:1}]}])assert.throws(()=>validateFileAcl(bad,sid),{code:'RUNTIME_ACL_DENIED'});
});
test('production logging omits arbitrary errors, headers, bodies, paths and known secrets',()=>{
 const output=[],secrets=['synthetic-password','synthetic-token','synthetic-cookie','synthetic-provider-secret'];
 const log=createSafeLogger({write:s=>output.push(s),secrets});
 log.error({event:'fatal',code:'SAFE_CODE',password:secrets[0],authorization:secrets[1],cookie:secrets[2],'x-token':secrets[1],body:{password:secrets[0]},stack:'C:/private/secret.json',error:Error(secrets[3]),url:'mysql://user:synthetic-password@host/db',config:{password:secrets[0]}});
 log.error({event:secrets[0],code:'mysql://user:other-password@host/db'});
 const text=output.join('');for(const secret of [...secrets,'other-password','C:/private','mysql://'])assert.equal(text.includes(secret),false);
 assert.equal(JSON.parse(output[0]).code,'SAFE_CODE');
});

test('development HTTP composition refuses production, implicit production and unknown environments',async()=>{
 const {createKtvServer}=await import('../server.js');
 for(const e of [env,{KTV_API_MODE:'enabled'},{KTV_DEPLOYMENT_ENV:'unknown'}])assert.throws(()=>createKtvServer({api:null,env:e}));
});
