// Dedicated manual non-production probe; importing this file never executes it.
import {open,lstat} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,resolve,parse,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readExternalSecret} from '../production/secret-file.js';
import {windowsFileAcl} from '../production/runtime-config.js';
import {validateSmokeAcl,windowsDirectoryAcl} from '../production/wecom-smoke-config.js';
import {externalDirectory,digest} from './format.js';
import {isOssAcceptanceLocalPath as localPath,guardOssAcceptanceFixedRoot} from './oss-acceptance-path.js';
import {createOssSdkAcceptanceBridge,validateOssSdkBridgeConfig} from './oss-sdk-bridge.js';
import {authorizeOssAcceptance,assertOssAcceptanceHost,ossAcceptanceScope,ossAcceptancePayloads,OSS_ACCEPTANCE_LIMITS} from './oss-acceptance-authorization.js';

const fail=()=>Object.assign(Error('OSS_ACCEPTANCE_UNCONFIRMED'),{code:'OSS_ACCEPTANCE_UNCONFIRMED'});
const keys=['configVersion','purpose','region','bucket','endpoint','prefix','readCredentialsFile','writeCredentialsFile','evidenceFile'];
async function localDirectory(path){
  if(!localPath(path))throw fail();
  const guard=await guardOssAcceptanceFixedRoot(path); // No target FS access before DRIVE_FIXED.
  const full=resolve(path),root=parse(full).root;let current=root;
  await guard.checkComponent(root);
  for(const part of relative(root,full).split(sep).filter(Boolean)){
    current=join(current,part);await guard.checkComponent(current);
    if((await lstat(current)).isSymbolicLink())throw fail();
  }
  return {directory:await externalDirectory(full),guard};
}
async function protectedJson(path){
  if(!localPath(path))throw fail();
  // Existing external/Git exclusion and Owner-only Windows ACL checks, no new secret store.
  const {directory:parent,guard}=await localDirectory(dirname(path));
  validateSmokeAcl(await windowsDirectoryAcl(parent),{directory:true});
  const file=join(parent,basename(path));await guard.checkComponent(file);
  const info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink())throw fail();
  validateSmokeAcl(await windowsFileAcl(file));
  return readExternalSecret(file);
}
function acceptanceConfig(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||
    keys.some(k=>!Object.hasOwn(value,k))||value.configVersion!==1||value.purpose!=='nonproduction-oss-acceptance'||
    ['readCredentialsFile','writeCredentialsFile','evidenceFile'].some(k=>!localPath(value[k]))||
    resolve(value.readCredentialsFile)===resolve(value.writeCredentialsFile))throw fail();
  const scope=ossAcceptanceScope(Object.fromEntries(['region','bucket','endpoint','prefix'].map(k=>[k,value[k]])));
  validateOssSdkBridgeConfig(scope);
  const runId=scope.prefix.split('/')[1];
  if(basename(value.evidenceFile)!=='oss-acceptance-'+runId+'.jsonl')throw fail();
  return Object.freeze({...value,scope,runId});
}
async function openEvidence(config){
  const {directory:parent}=await localDirectory(dirname(config.evidenceFile));
  validateSmokeAcl(await windowsDirectoryAcl(parent),{directory:true});
  // Exclusive create, canonical parent, fixed basename: never overwrite or clean up an old file.
  return open(join(parent,basename(config.evidenceFile)),'wx',0o600);
}
async function probes(adapter,runId,record){
  const [a,b]=ossAcceptancePayloads(runId);
  const probe={objectId:'probe',bytes:a};
  await record('FIRST_WRITE','STARTED');
  const original=await adapter.writer.putIfAbsent(probe);
  await record('FIRST_WRITE','CONFIRMED');
  await record('IDENTICAL_RETRY','STARTED');
  const beforeRepeat=adapter.observations().length;
  const repeated=await adapter.writer.putIfAbsent(probe);
  const repeatPuts=adapter.observations().slice(beforeRepeat).filter(o=>o.operation==='PUT');
  if(repeatPuts.length!==1||repeatPuts[0].status!==409)throw fail();
  if(JSON.stringify(repeated)!==JSON.stringify(original))throw fail();
  await record('IDENTICAL_RETRY','CONFIRMED');
  await record('CONFLICT','STARTED');
  const beforeConflict=adapter.observations().length;
  let conflictRejected=false;
  try{await adapter.writer.putIfAbsent({...probe,bytes:b});}catch{conflictRejected=true;}
  const conflict=adapter.observations().slice(beforeConflict).filter(o=>o.operation==='PUT');
  if(!conflictRejected||conflict.length!==1||conflict[0].status!==409||
    !(await adapter.reader.getExact(original)).bytes.equals(a))throw fail();
  await record('CONFLICT','REJECTED_AND_ORIGINAL_CONFIRMED');
  await record('CONCURRENT_WRITE','STARTED');
  const beforeRace=adapter.observations().length;
  const race=await Promise.allSettled([a,b].map(bytes=>adapter.writer.putIfAbsent({objectId:'race',bytes})));
  const winners=race.filter(r=>r.status==='fulfilled');
  const racePuts=adapter.observations().slice(beforeRace).filter(o=>o.operation==='PUT');
  if(winners.length!==1||race.filter(r=>r.status==='rejected').length!==1||racePuts.length!==2||
    racePuts.filter(o=>o.status===409).length!==1||racePuts.some(o=>![200,409,'UNKNOWN'].includes(o.status)))throw fail();
  const winner=winners[0].value;
  const recovered=await adapter.reader.getExact(winner);
  if(![a,b].some(bytes=>bytes.equals(recovered.bytes)))throw fail();
  await record('CONCURRENT_WRITE','ONE_CONFIRMED_WINNER');
  const final=await adapter.reader.getExact(original);
  if(!final.bytes.equals(a)||original.version!==digest(a))throw fail();
  return [original,winner].map(p=>({objectId:p.objectId,version:p.version,size:a.length}));
}
export async function runOssAcceptance(argv=process.argv.slice(2)){
  try{return await executeOssAcceptance(argv);}catch{throw fail();}
}
async function executeOssAcceptance(argv){
  assertOssAcceptanceHost();
  if(argv.length!==3||argv[0]!=='--run-nonproduction'||argv[1]!=='--config-file'||!isAbsolute(argv[2]))throw fail();
  const config=acceptanceConfig(await protectedJson(argv[2]));
  const permit=await authorizeOssAcceptance(config.scope); // No cloud credentials loaded before consent.
  const evidence=await openEvidence(config);
  let stage='CREDENTIALS';
  const record=async (next,outcome,extra={})=>{
    stage=next;
    await evidence.writeFile(JSON.stringify({schema:1,runId:config.runId,stage,outcome,...extra})+'\n');
    await evidence.sync();
  };
  try{
    await record('SESSION','AUTHORIZED',{scope:config.scope,limits:OSS_ACCEPTANCE_LIMITS,sdkVersion:'6.23.0'});
    await record('CREDENTIALS','STARTED');
    const readCredentials=await protectedJson(config.readCredentialsFile);
    const writeCredentials=await protectedJson(config.writeCredentialsFile);
    const adapter=createOssSdkAcceptanceBridge(permit,{readCredentials,writeCredentials});
    const references=await probes(adapter,config.runId,record);
    await record('RESULT','PROBES_PASSED',{references,requests:adapter.observations()});
    return Object.freeze({code:'OSS_ACCEPTANCE_PROBES_PASSED',runId:config.runId,objectCount:2,
      productionEnabled:false,physicalDeletion:false});
  }catch{
    // No raw SDK error, request, header, credential, Token, response body or secret path is logged.
    try{await record('RESULT','UNCONFIRMED',{failedStage:stage,remoteMayContainObjects:true});}catch{}
    throw fail();
  }finally{await evidence.close();}
}
export async function main(argv=process.argv.slice(2)){
  try{const result=await runOssAcceptance(argv);process.stdout.write(JSON.stringify(result)+'\n');return 0;}
  catch{process.stderr.write('OSS_ACCEPTANCE_UNCONFIRMED\n');return 1;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
