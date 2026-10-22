// Dedicated manual non-production probe; importing this file never executes it.
import {open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest} from './format.js';
import {OSS_ACCEPTANCE_ROOT,OSS_ACCEPTANCE_FILES,readOssAcceptanceFixed} from './oss-acceptance-path.js';
import {createOssSdkAcceptanceBridge,validateOssSdkBridgeConfig} from './oss-sdk-bridge.js';
import {authorizeOssAcceptance,confirmOssAcceptanceLocalRead,assertOssAcceptanceHost,ossAcceptanceScope,ossAcceptancePayloads,OSS_ACCEPTANCE_LIMITS} from './oss-acceptance-authorization.js';

const fail=()=>Object.assign(Error('OSS_ACCEPTANCE_UNCONFIRMED'),{code:'OSS_ACCEPTANCE_UNCONFIRMED'});
const keys=['configVersion','purpose','region','bucket','endpoint','prefix','readCredentialsFile','writeCredentialsFile','evidenceFile'];
function acceptanceConfig(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||
    keys.some(k=>!Object.hasOwn(value,k))||value.configVersion!==1||value.purpose!=='nonproduction-oss-acceptance'||
    value.readCredentialsFile!==OSS_ACCEPTANCE_FILES.READ||value.writeCredentialsFile!==OSS_ACCEPTANCE_FILES.WRITE)throw fail();
  const scope=ossAcceptanceScope(Object.fromEntries(['region','bucket','endpoint','prefix'].map(k=>[k,value[k]])));
  validateOssSdkBridgeConfig(scope);
  const runId=scope.prefix.split('/')[1];
  if(value.evidenceFile!==join(OSS_ACCEPTANCE_ROOT,'oss-acceptance-'+runId+'.jsonl'))throw fail();
  return Object.freeze({...value,scope,runId});
}
async function openEvidence(config){
  await readOssAcceptanceFixed('ROOT');
  // The root's validated ACL denies non-trusted replacement throughout the session.
  // Exclusive creation cannot overwrite/follow an existing evidence entry.
  return open(config.evidenceFile,'wx',0o600);
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
  if(argv.length!==1||argv[0]!=='--run-nonproduction')throw fail();
  await confirmOssAcceptanceLocalRead(); // No supplied path or local target IO precedes this confirmation.
  const config=acceptanceConfig(await readOssAcceptanceFixed('CONFIG'));
  const permit=await authorizeOssAcceptance(config.scope); // No cloud credentials loaded before consent.
  const confirmed=acceptanceConfig(await readOssAcceptanceFixed('CONFIG'));
  if(keys.some(key=>confirmed[key]!==config[key]))throw fail(); // Actual fixed config still matches the approved scope.
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
    const readCredentials=await readOssAcceptanceFixed('READ');
    const writeCredentials=await readOssAcceptanceFixed('WRITE');
    if(JSON.stringify(ossAcceptanceScope(config.scope))!==JSON.stringify(config.scope))throw fail();
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
