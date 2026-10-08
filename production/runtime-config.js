import { realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { createHash,X509Certificate,createPrivateKey } from 'node:crypto';
import { readExternalSecret } from './secret-file.js';
import { externalDirectory } from '../backup/format.js';
import { validateProductionConfig } from './config.js';
import { isProductionEnvironment } from '../shared/deployment-environment.js';
const exec=promisify(execFile);
export const runtimeFailure=code=>Object.assign(Error(code),{code});
const fail=()=>{throw runtimeFailure('RUNTIME_CONFIG_INVALID');};
function fields(value,required,optional=[]){
 if(!value||typeof value!=='object'||Array.isArray(value)||required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>![...required,...optional].includes(k)))fail();
}
export function privateHost(host){
 if(host==='localhost'||host==='::1'||host==='127.0.0.1')return true;
 if(isIP(host)!==4)return false;
 const [a,b]=host.split('.').map(Number);return a===10||a===192&&b===168||a===172&&b>=16&&b<=31;
}
export function validateRuntimeConfig(c,env=process.env,nodeVersion=process.versions.node){
 isProductionEnvironment(env);
 if(env.KTV_DEPLOYMENT_ENV!=='production'||env.NODE_ENV!=='production'||env.KTV_HTTP_ENV!=='production'||env.NODE_OPTIONS||env.NODE_TLS_REJECT_UNAUTHORIZED!==undefined)fail();
 if(!/^24\.19\.\d+$/.test(nodeVersion))throw runtimeFailure('RUNTIME_NODE_UNSUPPORTED');
 fields(c,['configVersion','applicationCommit','publicOrigin','listenHost','port','storeId','ledgerId','timeZone','businessDateCutoff','sessionRuleVersion','deviceControlMode','liveControlEnabled','secretsFile','logDirectory','serviceAccountSid','backupPolicyConfigured','directoryAclReviewed','networkModel']);
 if(c.configVersion!==1||!/^[a-f0-9]{40}$/.test(c.applicationCommit)||!privateHost(c.listenHost)||!Number.isInteger(c.port)||c.port<1024||c.port>65535||c.liveControlEnabled!==false||typeof c.backupPolicyConfigured!=='boolean'||c.directoryAclReviewed!==true||c.networkModel!=='private-vpn'||!/^S-1-5-(?:\d+-)*\d+$/.test(c.serviceAccountSid)||['S-1-5-18','S-1-5-32-544'].includes(c.serviceAccountSid))fail();
 let origin;try{origin=new URL(c.publicOrigin);}catch{fail();}
 if(origin.protocol!=='https:'||origin.origin!==c.publicOrigin||origin.username||origin.password||['localhost','127.0.0.1','[::1]'].includes(origin.hostname)||origin.hostname.endsWith('.localhost')||Number(origin.port||443)!==c.port)fail();
 return Object.freeze({...c});
}
export async function windowsFileAcl(path){
 if(process.platform!=='win32')throw runtimeFailure('RUNTIME_PLATFORM_UNSUPPORTED');
 const encoded=Buffer.from(path,'utf8').toString('base64');
 const script="$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encoded+"'));$a=[IO.File]::GetAccessControl($p);$rules=@($a.Access|ForEach-Object{@{sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;type=$_.AccessControlType.ToString();rights=[int]$_.FileSystemRights}});@{protected=$a.AreAccessRulesProtected;owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;rules=$rules}|ConvertTo-Json -Compress -Depth 4";
 try{const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:5000,maxBuffer:65536});return JSON.parse(stdout.trim());}catch{throw runtimeFailure('RUNTIME_ACL_UNVERIFIED');}
}
export function validateFileAcl(acl,serviceSid){
 const trusted=new Set([serviceSid,'S-1-5-18','S-1-5-32-544']);
 if(!acl?.protected||acl.current!==serviceSid||!trusted.has(acl.owner)||!Array.isArray(acl.rules)||acl.rules.some(r=>r.type==='Allow'&&!trusted.has(r.sid))||!acl.rules.some(r=>r.type==='Allow'&&r.sid===serviceSid&&(r.rights&1)))throw runtimeFailure('RUNTIME_ACL_DENIED');
}
export async function loadRuntimeConfig(path,env=process.env){
 const config=validateRuntimeConfig(await readExternalSecret(path),env);
 const configPath=await realpath(path);validateFileAcl(await windowsFileAcl(configPath),config.serviceAccountSid);
 const secrets=await readExternalSecret(config.secretsFile),secretPath=await realpath(config.secretsFile);validateFileAcl(await windowsFileAcl(secretPath),config.serviceAccountSid);
 fields(secrets,['database','tls'],['ktvsky','backup']);
 fields(secrets.database,['host','port','name','user','password'],['ca']);
 const db=secrets.database;
 if(!privateHost(db.host)||!Number.isInteger(db.port)||db.port<1||db.port>65535||typeof db.user!=='string'||!db.user||typeof db.password!=='string'||db.password.length<16||(!['localhost','127.0.0.1','::1'].includes(db.host)&&typeof db.ca!=='string'))fail();
 fields(secrets.tls,['certificate','privateKey']);
 let cert,key;
 try{
  cert=new X509Certificate(secrets.tls.certificate);key=createPrivateKey(secrets.tls.privateKey);
  if(!cert.checkPrivateKey(key)||!cert.checkHost(new URL(config.publicOrigin).hostname)||Date.parse(cert.validFrom)>Date.now()||Date.parse(cert.validTo)<=Date.now()+86400000||!['rsa','ec','ed25519'].includes(key.asymmetricKeyType))fail();
  if(key.asymmetricKeyType==='rsa'&&key.asymmetricKeyDetails.modulusLength<2048)fail();
 }catch{throw runtimeFailure('RUNTIME_TLS_INVALID');}
 if(secrets.ktvsky){fields(secrets.ktvsky,['telno','password']);if(!secrets.ktvsky.telno||!secrets.ktvsky.password)fail();}
 if(secrets.backup){fields(secrets.backup,[],['encryptionKey','signingKey']);}
 const url=new URL('mysql://localhost');url.hostname=db.host;url.port=String(db.port);url.username=db.user;url.password=db.password;url.pathname='/'+db.name;
 // File values are authoritative; ambient KTV_MYSQL_URL/provider/cookie settings cannot replace them.
 const apiEnv={NODE_ENV:'production',KTV_HTTP_ENV:'production',KTV_DEPLOYMENT_ENV:'production',KTV_API_MODE:'enabled',KTV_INSECURE_COOKIE:'false',KTV_MYSQL_URL:url.href,KTV_STORE_ID:config.storeId,KTV_LEDGER_ID:config.ledgerId,KTV_BUSINESS_TIME_ZONE:config.timeZone,KTV_PUBLIC_ORIGIN:config.publicOrigin,KTV_BUSINESS_DATE_CUTOFF:config.businessDateCutoff,KTV_SESSION_RULE_VERSION:config.sessionRuleVersion,DEVICE_CONTROL_MODE:config.deviceControlMode,KTVSKY_LIVE_CONTROL_ENABLED:'false'};
 const productionConfig=validateProductionConfig(apiEnv);
 const logDirectory=await externalDirectory(config.logDirectory);
 const publicFacts={configVersion:config.configVersion,backupPolicyConfigured:config.backupPolicyConfigured,directoryAclReviewed:config.directoryAclReviewed,businessDateCutoff:config.businessDateCutoff,sessionRuleVersion:config.sessionRuleVersion,liveControlEnabled:config.liveControlEnabled,applicationCommit:config.applicationCommit,publicOrigin:config.publicOrigin,listenHost:config.listenHost,port:config.port,storeId:config.storeId,ledgerId:config.ledgerId,timeZone:config.timeZone,deviceControlMode:config.deviceControlMode,networkModel:config.networkModel};
 const configFingerprint=createHash('sha256').update(JSON.stringify(publicFacts)).digest('hex');
 return {config,productionConfig,apiEnv,logDirectory,configFingerprint,tls:{cert:secrets.tls.certificate,key:secrets.tls.privateKey,minVersion:'TLSv1.2'},mysqlSsl:db.ca?{ca:db.ca,rejectUnauthorized:true}:undefined,redactionSecrets:[db.password,url.href,secrets.tls.privateKey,secrets.ktvsky?.telno,secrets.ktvsky?.password,secrets.backup?.encryptionKey,secrets.backup?.signingKey].filter(Boolean)};
}
