// TEST SUPPORT ONLY: substitute OS observations, never product authority/config.
// Explicit --import by this owned test only; not packaged and no product selector.
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import {readFile,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {connectOwnedBackupFixture} from './owned-mysql-fixture.js';
const env={...process.env,NODE_ENV:'test',KTV_HTTP_ENV:'test',KTV_DEPLOYMENT_ENV:'test'};
const connection=await connectOwnedBackupFixture(env);await connection.end();
const path=process.env.S4_OWNED_OS_FACTS;
const root=await realpath(env.STAGE5E_FIXTURE_ROOT),actual=await realpath(path),rel=relative(root,actual);
if(actual!==resolve(path)||rel.startsWith('..')||isAbsolute(rel)||!rel)throw Error('S4_OS_FIXTURE_SCOPE_DENIED');
const facts=JSON.parse(await readFile(actual,'utf8'));
const original=childProcess.execFile;
function reply(file,args){
 if(file!=='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')return;
 const index=args.indexOf('-EncodedCommand');if(index<0)return;
 const script=Buffer.from(args[index+1],'base64').toString('utf16le');
 if(script.includes('# JBHH_BACKUP_DEPLOYMENT_REGISTRATION'))return JSON.stringify(facts.registration);
 const encoded=script.match(/FromBase64String\('([^']+)'\)/)?.[1];
 const path=encoded&&Buffer.from(encoded,'base64').toString('utf8');
 if(path===facts.backupConfigFile||path===facts.privateRoot)return JSON.stringify(facts.anchorAcl);
}
function hook(file,args,...rest){
 const value=reply(file,args);if(value===undefined)return original(file,args,...rest);
 const callback=rest.at(-1);queueMicrotask(()=>callback(null,value,''));return {};
}
hook[promisify.custom]=(...args)=>new Promise((resolve,reject)=>hook(...args,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));
childProcess.execFile=hook;syncBuiltinESMExports();
