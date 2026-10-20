import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readBackupDeployment} from './backup-deployment.js';
import {readExternalSecret} from './secret-file.js';
import {externalDirectory,verifyArtifact} from '../backup/format.js';
import {reportBackup} from '../operations/backup-report.js';
import {backupExecutionPolicy} from './backup-execution-policy.js';

const entry=fileURLToPath(new URL('./start.js',import.meta.url));
let serviceRun=null;
const safe=code=>Object.freeze({code});
// Ports are for isolated tests; the production composition supplies none.
export function createServiceBackupExecution({loaded,runtimeConfigFile,logger,onContainmentFailure},ports={}) {
  const policy=backupExecutionPolicy(loaded.config.backupExecution);
  const containmentFailure=onContainmentFailure??(()=>process.exit(1));
  const deployment=ports.deployment??readBackupDeployment,readConfig=ports.readConfig??readExternalSecret;
  const launch=ports.launch??spawn,checkArtifact=ports.checkArtifact??verifyArtifact;
  const directory=ports.directory??externalDirectory,report=ports.report??reportBackup;
  let stopped=false,current=null;
  function emit(code,requestId) {try{logger?.info({event:'backup_execution',code,requestId});}catch{}}
  async function run() {
    if(stopped)return safe('BACKUP_EXECUTION_STOPPED');
    const requestId=randomUUID();let child,cancelled=null,timer,closePromise;
    const cancel=code=>{
      cancelled??=code;
      if(child)try{child.kill('SIGKILL');}catch{} // Watchdog requires observed close.
    };
    current.cancel=cancel;
    timer=setTimeout(()=>cancel('BACKUP_EXECUTION_TIMEOUT'),policy.timeoutMs);
    emit('BACKUP_EXECUTION_STARTED',requestId);
    try {
      const binding=await deployment();
      if(binding.runtimeConfigFile!==runtimeConfigFile||binding.node!==process.execPath||
        binding.entry!==entry||binding.backupConfigFile!==join(dirname(runtimeConfigFile),'backup.json'))
        throw Error();
      const config=await readConfig(binding.backupConfigFile);
      const url=new URL(config.databaseUrl);
      if(config.environment!=='production'||config.storeId!==loaded.config.storeId||
        config.ledgerId!==loaded.config.ledgerId||url.protocol!=='mysql:'||
        !/^[a-z][a-z0-9_]{0,63}$/.test(decodeURIComponent(url.pathname.slice(1)))||
        typeof config.serverUuid!=='string'||!/^[a-f0-9-]{36}$/.test(config.serverUuid)||
        config.operationalDirectory!==undefined&&config.operationalDirectory!==loaded.logDirectory)
        throw Error();
      const root=await directory(loaded.config.monitoring?.backupDirectory);
      const output=join(root,'backup-'+requestId);
      if(cancelled||stopped)throw Error();
      // SCM host's one-shot mode owns a nested kill-on-close Job before spawning
      // the original CLI. It uses the same service token, never alternate credentials.
      const env={NODE_ENV:'production',KTV_HTTP_ENV:'production',KTV_DEPLOYMENT_ENV:'production'};
      for(const k of ['SystemRoot','WINDIR','TEMP','TMP','PATH','PATHEXT'])
        if(process.env[k]!==undefined)env[k]=process.env[k];
      child=launch(binding.host,['--backup-child','--node',binding.node,'--entry',binding.entry,
        '--config',binding.runtimeConfigFile,'--output-dir',output,'--confirm',
        config.serverUuid+'/'+decodeURIComponent(url.pathname.slice(1))+'/'+config.storeId+'/'+config.ledgerId],
        {shell:false,windowsHide:true,detached:false,env,stdio:['ignore','pipe','pipe']});
      let stdout='',overflow=false,launchError=false;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',bytes=>{
        if(Buffer.byteLength(stdout)+Buffer.byteLength(bytes)>16384){overflow=true;cancel('BACKUP_EXECUTION_FAILED');}
        else stdout+=bytes.toString('utf8');
      });
      child.stderr.resume(); // Never forward raw CLI or native-host diagnostics.
      closePromise=new Promise(resolveClose=>{
        child.on('error',()=>{launchError=true;cancel('BACKUP_EXECUTION_FAILED');});
        child.once('close',(code,signal)=>resolveClose({code,signal}));
      });
      // On timeout/stop, require observed native supervisor exit. If containment
      // cannot be confirmed, permanently fence this executor and terminate service.
      const closed=await new Promise((resolveClose,reject)=>{
        let cleanup;
        closePromise.then(value=>{clearInterval(cleanup);resolveClose(value);});
        let killAt=null;
        cleanup=setInterval(()=>{
          if(!cancelled)return;
          killAt??=Date.now();
          if(Date.now()-killAt>=3000){clearInterval(cleanup);reject(Error('CONTAINMENT'));}
        },50);
      });
      child=null;
      if(cancelled||stopped||overflow||launchError||closed.code!==0||closed.signal)throw Error();
      const result=JSON.parse(stdout);
      if(result.code!=='BACKUP_VERIFIED'||result.directory!==output||
        result.storeId!==config.storeId||result.ledgerId!==config.ledgerId||
        result.source?.serverUuid!==config.serverUuid||
        result.source?.database!==decodeURIComponent(url.pathname.slice(1))||
        result.source?.environment!=='production')throw Error();
      const verified=await checkArtifact(output,{expectedChecksum:result.checksum,storeId:config.storeId,ledgerId:config.ledgerId});
      if(verified.manifest.createdAt!==result.createdAt||
        verified.manifest.applicationCommit!==loaded.config.applicationCommit||
        verified.manifest.source.serverUuid!==config.serverUuid||
        verified.manifest.source.database!==result.source.database||
        verified.manifest.source.environment!=='production'||cancelled||stopped)throw Error();
      // Completion is committed synchronously after artifact verification. A
      // later service stop cannot relabel that completed backup as a timeout.
      clearTimeout(timer);current.cancel=null;
      // The CLI already reports when configured. Otherwise publish its verified fact.
      if(!config.operationalDirectory)await report(loaded.logDirectory,{success:true,createdAt:result.createdAt});
      emit('BACKUP_EXECUTION_VERIFIED',requestId);
      return Object.freeze({code:'BACKUP_VERIFIED',checksum:verified.checksum,backupId:verified.manifest.backupId,createdAt:result.createdAt});
    } catch {
      if(child) {
        stopped=true;cancel('BACKUP_EXECUTION_FAILED');
        emit('BACKUP_EXECUTION_CONTAINMENT_FAILED',requestId);
        // Production always exits; SCM host Job teardown contains all descendants.
        containmentFailure();
      }
      try{await report(loaded.logDirectory,{success:false});}catch{emit('BACKUP_REPORT_FAILED',requestId);}
      const code=cancelled??(stopped?'BACKUP_EXECUTION_STOPPED':'BACKUP_EXECUTION_FAILED');
      emit(code,requestId);return safe(code);
    } finally {clearTimeout(timer);}
  }
  return Object.freeze({
    runOnce(...args) {
      if(args.length)return Promise.resolve(safe('BACKUP_EXECUTION_ARGUMENTS_DENIED'));
      if(stopped)return Promise.resolve(safe('BACKUP_EXECUTION_STOPPED'));
      if(!policy.enabled)return Promise.resolve(safe('BACKUP_EXECUTION_DISABLED'));
      if(serviceRun)return Promise.resolve(safe('BACKUP_EXECUTION_BUSY'));
      current={cancel:null};serviceRun=current;
      const owned=current;
      // Claim before any asynchronous admission or spawn.
      owned.promise=Promise.resolve().then(run).finally(()=>{if(serviceRun===owned)serviceRun=null;current=null;});
      return owned.promise;
    },
    async stop() {
      stopped=true;
      if(current){current.cancel?.('BACKUP_EXECUTION_STOPPED');await current.promise;}
    }
  });
}
