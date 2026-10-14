// Internal verification algorithm; callers receive one verdict, never independent writer flags.
import {randomBytes} from 'node:crypto';import {canonical} from '../backup/format.js';import {validateActivationReceipt,receiptDigest} from './activation-receipt.js';
const same=(a,b)=>canonical({v:a})===canonical({v:b});
export async function verifyActivationCore(expected,{scm,receipt,listener,observe}){
 try{
  const first=await scm();if(first.phase!=='RUNNING'||!first.nodeProcess)return 'NOT_PROVEN';
  const r=validateActivationReceipt(await receipt());
  if(r.processId!==first.nodeProcess.pid||r.processCreatedAt!==first.nodeProcess.createdAt||r.deploymentConfigFingerprint!==expected.deploymentConfigFingerprint||r.recoveryOperationId!==expected.recoveryOperationId||r.planDigest!==expected.planDigest||!same(r.databaseIdentity,expected.databaseIdentity))return 'NOT_PROVEN';
  const socket=await listener(first.nodeProcess.pid);if(socket.pid!==first.nodeProcess.pid||socket.port!==expected.port)return 'NOT_PROVEN';
  const challenge=randomBytes(32).toString('hex'),reply=await observe(socket,challenge);
  if(reply?.challenge!==challenge||reply.phase!=='RUNNING'||reply.ready!==true||reply.workersActive!==true||reply.state!=='ACTIVE'||reply.receiptDigest!==receiptDigest(r)||reply.processId!==r.processId||reply.processCreatedAt!==r.processCreatedAt||reply.peerAddress!==socket.host||reply.peerPort!==socket.port)return 'NOT_PROVEN';
  const lastSocket=await listener(first.nodeProcess.pid),last=await scm(),lastReceipt=await receipt();
  if(!same(first,last)||!same(socket,lastSocket)||receiptDigest(lastReceipt)!==receiptDigest(r))return 'NOT_PROVEN';
  return 'ACTIVE';
 }catch{return 'NOT_PROVEN';}
}
export const expectedActivation=f=>({deploymentConfigFingerprint:f.loaded.configFingerprint,recoveryOperationId:f.plan.recoveryOperationId,planDigest:f.plan.planDigest,databaseIdentity:{host:f.plan.targetHost,port:f.plan.targetPort,name:f.plan.targetDatabase,serverUuid:f.plan.targetServerUuid},port:f.loaded.config.port});
