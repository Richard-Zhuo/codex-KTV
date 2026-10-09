import { resolve } from 'node:path';import { fileURLToPath } from 'node:url';
import { loadRuntimeConfig } from './runtime-config.js';
import { createHttpApiFromEnv } from '../http/bootstrap.js';
import { createSafeLogger } from './runtime-log.js';
export async function preflight(path,env=process.env){
 if(!path)return {ready:false,checks:{configuration:'BLOCKED'},blockers:['RUNTIME_CONFIG_REQUIRED'],liveControl:'OFF'};
 let services;
 try{
  const loaded=await loadRuntimeConfig(path,env),logger=createSafeLogger({secrets:loaded.redactionSecrets,write:()=>{}});
  services=createHttpApiFromEnv(loaded.apiEnv,logger,{managed:true,mysqlSsl:loaded.mysqlSsl});
  let report;try{report=await services.readiness();}catch{report={ready:false,blockers:[{code:'DATABASE_OR_SCHEMA_UNAVAILABLE'}]};}
  const blockers=report.blockers.map(b=>b.code);if(!loaded.config.monitoring)blockers.push('MONITORING_CONFIG_REQUIRED');if(loaded.config.monitoring?.alertingRequired)blockers.push('ALERT_CHANNEL_REQUIRED');if(!loaded.config.backupPolicyConfigured)blockers.push('PRODUCTION_BACKUP_POLICY_REQUIRED');
  return {ready:report.ready&&blockers.length===0,checks:{configuration:'PASS',environment:'PASS',node:'PASS',secrets:'PASS',fileAcl:'PASS',https:'PASS',databaseAndInitialization:report.ready?'PASS':'BLOCKED'},blockers,appVersion:loaded.config.applicationCommit,schemaVersion:'001-011',configFingerprint:loaded.configFingerprint,liveControl:'OFF'};
 }catch(error){return {ready:false,checks:{configuration:'BLOCKED'},blockers:[/^RUNTIME_[A-Z_]+$/.test(error.code??'')?error.code:'RUNTIME_PREFLIGHT_FAILED'],liveControl:'OFF'};}
 finally{await services?.close();}
}
export async function runPreflight(argv=process.argv.slice(2),env=process.env,logger=console){
 if(argv.length!==2||argv[0]!=='--config-file'){logger.log(JSON.stringify(await preflight(undefined,env)));return 1;}
 const result=await preflight(argv[1],env);logger.log(JSON.stringify(result));return result.ready?0:1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runPreflight();
