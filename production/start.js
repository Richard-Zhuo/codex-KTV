import {createBackupScheduler} from './backup-schedule.js';
import {createServiceBackupExecution} from './backup-execution.js';
import {createOperationalRuntime} from '../operations/runtime.js';
import {createWeComAlertTransport} from '../operations/wecom.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {createRotatingLog} from './rotating-log.js';
import {monitoringConfig} from '../operations/monitors.js';
import { createInterface } from 'node:readline';
import { loadRuntimeConfig } from './runtime-config.js';
import { createSafeLogger } from './runtime-log.js';
import {createRuntimeActivationProducer} from './activation-producer.js';
import { createProductionRuntime } from './runtime.js';
export async function startProduction(argv=process.argv.slice(2),env=process.env){
 if(argv.length!==2||argv[0]!=='--config-file')throw Object.assign(Error('RUNTIME_ARGUMENTS_INVALID'),{code:'RUNTIME_ARGUMENTS_INVALID'});
 const loaded=await loadRuntimeConfig(argv[1],env);
 const monitoring=monitoringConfig(loaded.config.monitoring??{});
 let logFailure=()=>{};
 const stream=createRotatingLog(loaded.logDirectory,{maxBytes:monitoring.logMaxBytes,maxFiles:monitoring.logMaxFiles,onFailure:()=>logFailure()});
 const logger=createSafeLogger({secrets:loaded.redactionSecrets,write:line=>stream.write(line)});
 const transport=loaded.alertTransportConfig?createWeComAlertTransport(loaded.alertTransportConfig):undefined;
 const operations=await createOperationalRuntime({loaded,logger,transport});
 const backupExecution=createServiceBackupExecution({loaded,runtimeConfigFile:argv[1],logger,onContainmentFailure:()=>process.exit(1)});
 const backupScheduler=createBackupScheduler({config:loaded.config,execution:backupExecution,observations:operations.backupSchedule,logger});
 const runtime=createProductionRuntime(loaded,{logger,operations,activation:createRuntimeActivationProducer(loaded),backupExecution,backupScheduler});
 let exiting=false;
 const stop=async(reason,exit=0)=>{
  if(exiting)return;exiting=true;
  let code=exit;try{await runtime.shutdown(reason);}catch{code=1;}
  try{stream.close();}catch{code=1;}process.exit(code);
 };
 process.once('SIGINT',()=>void stop('SIGINT'));process.once('SIGTERM',()=>void stop('SIGTERM'));
 process.once('uncaughtException',()=>{logger.error({event:'fatal',code:'UNCAUGHT_EXCEPTION'});void operations.fatal('UNCAUGHT_EXCEPTION').finally(()=>stop('FATAL',1));});
 process.once('unhandledRejection',()=>{logger.error({event:'fatal',code:'UNHANDLED_REJECTION'});void operations.fatal('UNHANDLED_REJECTION').finally(()=>stop('FATAL',1));});
 logFailure=()=>{void operations.fatal('LOG_WRITE_FAILURE').finally(()=>stop('LOG_IO_FAILED',1));};
 // SCM host owns this private stdin pipe; it can stop the process, never authenticate or mutate business.
 const input=createInterface({input:process.stdin});input.on('line',line=>{if(line==='STOP')void stop('SERVICE_STOP');});input.on('close',()=>void stop('SERVICE_PIPE_CLOSED'));
 try{await runtime.start();}
 catch(error){await backupScheduler.stop().catch(()=>{});await backupExecution.stop();if(operations.ownsWriter())await operations.stop({clean:false});throw error;}
 // Internal capability only: never passed to HTTP, stdin or operational projections.
 return runtime;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await startProduction();}catch{process.stderr.write(JSON.stringify({event:'startup_failed',code:'RUNTIME_STARTUP_FAILED'})+'\n');process.exit(1);}
}
