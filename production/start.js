import { fileURLToPath } from 'node:url';
import { resolve,join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadRuntimeConfig } from './runtime-config.js';
import { createSafeLogger } from './runtime-log.js';
import { createProductionRuntime } from './runtime.js';
export async function startProduction(argv=process.argv.slice(2),env=process.env){
 if(argv.length!==2||argv[0]!=='--config-file')throw Object.assign(Error('RUNTIME_ARGUMENTS_INVALID'),{code:'RUNTIME_ARGUMENTS_INVALID'});
 const loaded=await loadRuntimeConfig(argv[1],env);
 const stream=createWriteStream(join(loaded.logDirectory,'ktv-'+Date.now()+'-'+process.pid+'.jsonl'),{flags:'wx',mode:0o600});
 await new Promise((resolve,reject)=>{stream.once('open',resolve);stream.once('error',reject);});
 const logger=createSafeLogger({secrets:loaded.redactionSecrets,write:line=>stream.write(line)});
 const runtime=createProductionRuntime(loaded,{logger});
 let exiting=false;
 const stop=async(reason,exit=0)=>{
  if(exiting)return;exiting=true;
  let code=exit;try{await runtime.shutdown(reason);}catch{code=1;}
  await Promise.race([new Promise(resolve=>stream.end(resolve)),new Promise(resolve=>setTimeout(resolve,1000).unref())]);process.exit(code);
 };
 process.once('SIGINT',()=>void stop('SIGINT'));process.once('SIGTERM',()=>void stop('SIGTERM'));
 process.once('uncaughtException',()=>{logger.error({event:'fatal',code:'UNCAUGHT_EXCEPTION'});void stop('FATAL',1);});
 process.once('unhandledRejection',()=>{logger.error({event:'fatal',code:'UNHANDLED_REJECTION'});void stop('FATAL',1);});
 stream.once('error',()=>void stop('LOG_IO_FAILED',1));
 // SCM host owns this private stdin pipe; it can stop the process, never authenticate or mutate business.
 const input=createInterface({input:process.stdin});input.on('line',line=>{if(line==='STOP')void stop('SERVICE_STOP');});input.on('close',()=>void stop('SERVICE_PIPE_CLOSED'));
 await runtime.start();return runtime;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await startProduction();}catch{process.stderr.write(JSON.stringify({event:'startup_failed',code:'RUNTIME_STARTUP_FAILED'})+'\n');process.exit(1);}
}
