import mysql from 'mysql2/promise';
import {canonical,digest,fail} from '../backup/format.js';
import {validateSchema} from '../production/schema.js';
import {readProductionReadiness} from '../production/readiness.js';
import {readC3State} from './production-c3-journal.js';
import {readC1Evidence} from './c1-evidence.js';
import {requireControl,server} from './production-c1.js';

const targetUrl=(base,name)=>{const url=new URL(base);url.pathname='/'+name;return url.href;};
const control=async c=>{
 const [[row]]=await c.query('SELECT mode,store_id,ledger_id,environment,backup_digest,facts FROM recovery_control WHERE control_id=1');
 let facts;try{facts=typeof row?.facts==='string'?JSON.parse(row.facts):row?.facts;}catch{}
 return row&&{...row,facts};
};
async function productionReadiness(loaded){
 const pool=mysql.createPool({uri:loaded.apiEnv.KTV_MYSQL_URL,ssl:loaded.mysqlSsl,
  connectionLimit:1,dateStrings:true,jsonStrings:true,supportBigNumbers:true,bigNumberStrings:true});
 try{return readProductionReadiness({pool,config:loaded.productionConfig});}
 finally{await pool.end();}
}
export async function assertCompletedC3Startup(loaded,plan,journal,{
 cutover,execution,readC3=readC3State,readEvidence=readC1Evidence,
 readinessCheck=productionReadiness}={}){
 if(cutover?.state!=='CUTOVER_SWITCHED'||execution?.state!=='VERIFYING'||
    loaded.config.storeId!==plan.storeId||
    loaded.config.ledgerId!==plan.ledgerId||
    loaded.config.applicationCommit!==plan.applicationCommit)
  throw fail('PRODUCTION_C3_STARTUP_BLOCKED');
 const progress=await readC3(journal,plan);
 if(progress?.state!=='RESUMED')throw fail('PRODUCTION_C3_STARTUP_BLOCKED');
 const url=new URL(loaded.apiEnv.KTV_MYSQL_URL);
 if(url.hostname!==plan.targetHost||Number(url.port||3306)!==plan.targetPort||
    decodeURIComponent(url.pathname.slice(1))!==plan.targetDatabase)
  throw fail('PRODUCTION_C3_STARTUP_BLOCKED');
 let old,candidate;
 try{
  old=await mysql.createConnection({uri:targetUrl(url.href,plan.currentDatabase),
   ssl:loaded.mysqlSsl,dateStrings:true,jsonStrings:true,supportBigNumbers:true,bigNumberStrings:true});
  candidate=await mysql.createConnection({uri:url.href,ssl:loaded.mysqlSsl,
   dateStrings:true,jsonStrings:true,supportBigNumbers:true,bigNumberStrings:true});
  await old.query('SET SESSION TRANSACTION READ ONLY');
  await candidate.query('SET SESSION TRANSACTION READ ONLY');
  await server(old,plan.currentDatabase,plan);
  await server(candidate,plan.targetDatabase,plan);
  await validateSchema(candidate,plan.targetDatabase);
  const source=await control(old),target=await control(candidate);
  requireControl(source,plan,'FROZEN','plan-bound-recovery-freeze');
  requireControl(target,plan,'NORMAL','plan-bound-candidate-restore');
  if(target.facts?.c3Status!=='RESUMED'||
     target.facts?.preparedDigest!==progress.candidateBusinessDigest||
     !target.facts?.verifiedAt||
     target.facts?.source?.database!==plan.currentDatabase||
     target.facts?.source?.serverUuid!==plan.targetServerUuid)
   throw fail('PRODUCTION_C3_STARTUP_BLOCKED');
  // The terminal journal proves the pre-resume snapshot. After NORMAL, new
  // business writes, sessions, and alerts are legitimate on later starts.
  const evidence=await readEvidence(journal,plan,{
   oldDigest:progress.oldDigest,candidateDigest:progress.c1CandidateDigest,
   alertDigest:progress.alertDigest,journalState:'VERIFYING'});
  if(!evidence?.cutoverEligible||digest(canonical(evidence))!==progress.c1EvidenceDigest)
   throw fail('PRODUCTION_C3_STARTUP_BLOCKED');
  const ready=await readinessCheck(loaded);
  if(!ready?.ready||ready.database!==plan.targetDatabase||
     ready.storeId!==plan.storeId||ready.ledgerId!==plan.ledgerId)
   throw fail('PRODUCTION_C3_STARTUP_BLOCKED');
  return true;
 }finally{await candidate?.end();await old?.end();}
}
