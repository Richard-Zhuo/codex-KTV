// Read-only cutover decisions. No GO result executes a deployment or provider call.
export const CATEGORIES=Object.freeze(['CODE','DATABASE','IDENTITY','INVENTORY','DEVICE','BACKUP','NETWORK','TLS','SERVICE','ALERTING','EXTERNAL_MONITORING','OPERATIONS']);
export function cutoverDecision({scope,checks,humanGo=false}){
 if(!['rehearsal','production'].includes(scope)||typeof humanGo!=='boolean'||!checks||Object.getPrototypeOf(checks)!==Object.prototype)throw Error('CUTOVER_INPUT_INVALID');
 if(Object.keys(checks).some(k=>!CATEGORIES.includes(k)))throw Error('CUTOVER_INPUT_INVALID');
 const rows=CATEGORIES.map(category=>{
  const check=checks[category];
  if(!check||!['PASS','BLOCKED','NOT_APPLICABLE'].includes(check.status)||typeof check.evidence!=='string'||!check.evidence.trim())return {category,status:'BLOCKED',reason:'EVIDENCE_REQUIRED'};
  // These categories are required; N/A cannot make a missing gate disappear.
  if(check.status!=='PASS')return {category,status:'BLOCKED',reason:check.status==='NOT_APPLICABLE'?'REQUIRED_GATE':'CHECK_BLOCKED'};
  if(scope==='production'&&check.synthetic!==false)return {category,status:'BLOCKED',reason:'REAL_EVIDENCE_REQUIRED'};
  return {category,status:'PASS'};
 });
 const ready=rows.every(r=>r.status==='PASS');
 return Object.freeze({scope,ready,decision:ready&&humanGo?'GO':'NO-GO',humanGoRequired:true,automaticCutover:false,checks:rows});
}
export function rollbackDecision({businessWrites,backupRevision,currentRevision,compatible,backupVerified}){
 if(!Number.isSafeInteger(businessWrites)||businessWrites<0||!Number.isSafeInteger(backupRevision)||backupRevision<0||!Number.isSafeInteger(currentRevision)||currentRevision<backupRevision||typeof compatible!=='boolean'||typeof backupVerified!=='boolean')throw Error('ROLLBACK_INPUT_INVALID');
 if(!backupVerified)return {allowed:false,code:'VERIFIED_BACKUP_REQUIRED'};
 if(!compatible)return {allowed:false,code:'APPLICATION_SCHEMA_INCOMPATIBLE'};
 if(businessWrites>0||currentRevision>backupRevision)return {allowed:false,code:'PRESERVE_NEW_TRANSACTIONS',action:'FREEZE_AND_FORWARD_RECOVER'};
 return {allowed:true,code:'PRE_FIRST_WRITE_ABORT_ALLOWED',action:'RESTORE_TO_SEPARATE_DATABASE_AND_VERIFY'};
}
