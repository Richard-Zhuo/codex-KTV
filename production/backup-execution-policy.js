// Execution bounds only; no backup cadence or retry policy.
export function backupExecutionPolicy(value) {
  if(value===undefined)return Object.freeze({enabled:false,timeoutMs:300000});
  if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).some(k=>!['enabled','timeoutMs'].includes(k))||
    !Object.hasOwn(value,'enabled')||typeof value.enabled!=='boolean'||
    value.timeoutMs!==undefined&&(!Number.isSafeInteger(value.timeoutMs)||value.timeoutMs<1000||value.timeoutMs>600000))
    throw Object.assign(Error('BACKUP_EXECUTION_CONFIG_INVALID'),{code:'BACKUP_EXECUTION_CONFIG_INVALID'});
  return Object.freeze({enabled:value.enabled,timeoutMs:value.timeoutMs??300000});
}
