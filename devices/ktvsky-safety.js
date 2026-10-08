import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoomDeviceMappings } from './mapping.js';

const policies=new WeakSet();
const text=value=>typeof value==='string'&&value.length>0&&value.length<=191&&value.trim()===value&&!value.includes('*');
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&
  Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
export function denyValidation(code){const error=Error('KTVSky safe validation denied');error.code=code;throw error;}
export function insideDirectory(root,target) {
  const relative=path.relative(root,target);
  return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));
}
export const repositoryRoot=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
export function parseKtvSkyValidationConfig(raw) {
  if(!exact(raw,['schemaVersion','storeId','mappings','safeTarget'])||raw.schemaVersion!==1||
      !Array.isArray(raw.mappings)||raw.mappings.length>1000||
      !(raw.storeId===null||text(raw.storeId)||(Number.isSafeInteger(raw.storeId)&&raw.storeId>0)))denyValidation('INVALID_CONFIG');
  createRoomDeviceMappings(raw.mappings);
  if(raw.mappings.some(row=>row.provider!=='ktvsky'))denyValidation('INVALID_CONFIG');
  const mappings=raw.mappings.map(row=>Object.freeze({...row}));
  let safeTarget=null;
  if(raw.safeTarget!==null) {
    const s=raw.safeTarget;
    if(!exact(s,['internalRoomId','externalDeviceId','storeId','approved','unoccupied','approvalReference','approvedAt','expiresAt'])||
        ![s.internalRoomId,s.externalDeviceId,s.approvalReference,s.approvedAt,s.expiresAt].every(text)||
        typeof s.approved!=='boolean'||typeof s.unoccupied!=='boolean'||
        raw.storeId===null||String(s.storeId)!==String(raw.storeId)||!Number.isFinite(Date.parse(s.approvedAt))||
        !Number.isFinite(Date.parse(s.expiresAt)))denyValidation('INVALID_CONFIG');
    safeTarget=Object.freeze({...s,storeId:String(s.storeId)});
  }
  return Object.freeze({schemaVersion:1,storeId:raw.storeId===null?null:String(raw.storeId),
    mappings:Object.freeze(mappings),safeTarget});
}
export async function loadKtvSkyValidationConfig(file) {
  try {
    const location=await realpath(file),bytes=await readFile(location);
    if(bytes.length>32768)denyValidation('INVALID_CONFIG');
    const config=parseKtvSkyValidationConfig(JSON.parse(bytes.toString('utf8')));
    if(insideDirectory(repositoryRoot,location)&&(config.mappings.length||config.safeTarget))denyValidation('EXTERNAL_CONFIG_REQUIRED');
    return config;
  }catch(error){
    if(['INVALID_CONFIG','EXTERNAL_CONFIG_REQUIRED'].includes(error.code))throw error;
    denyValidation('INVALID_CONFIG');
  }
}
export function createKtvSkySafetyPolicy({config,liveEnabled=false,now=Date.now}={}) {
  const snapshot=parseKtvSkyValidationConfig(config);
  const policy=input=>{
    if(liveEnabled!==true)denyValidation('LIVE_CONTROL_DISABLED');
    const mapping=snapshot.mappings.find(row=>row.internalRoomId===input?.internalRoomId);
    if(!mapping||!mapping.enabled||mapping.provider!=='ktvsky'||mapping.externalDeviceId!==input.externalDeviceId)denyValidation('MAPPING_REQUIRED');
    const safe=snapshot.safeTarget;
    if(!safe||safe.approved!==true||safe.unoccupied!==true||safe.internalRoomId!==mapping.internalRoomId||
        safe.externalDeviceId!==mapping.externalDeviceId||safe.storeId!==snapshot.storeId)denyValidation('SAFE_TEST_TARGET_REQUIRED');
    const start=Date.parse(safe.approvedAt),end=Date.parse(safe.expiresAt),at=now();
    if(!Number.isFinite(at)||end<=start||end-start>900000||at<start||at>=end)denyValidation('SAFE_APPROVAL_EXPIRED');
    return true;
  };
  policies.add(policy);return policy;
}
export const isKtvSkySafetyPolicy=policy=>policies.has(policy);
