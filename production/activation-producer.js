import {createActivationReceiptStore,validateActivationReceipt} from './activation-receipt.js';import {ownProcessIdentity} from './process-observation.js';import {validatedStartupBinding} from '../recovery/production-cutover-journal.js';
// The binding is obtainable only after this same loaded context passed the trusted guard.
export function createRuntimeActivationProducer(loaded){
 const store=createActivationReceiptStore(loaded);let processIdentity,proof=null;
 return Object.freeze({
  async initialize(){processIdentity=await ownProcessIdentity();await store.initialize();},
  async publish(){const binding=validatedStartupBinding(loaded);if(!binding){proof=null;return null;}
   const receipt=validateActivationReceipt({version:1,processId:processIdentity.pid,processCreatedAt:processIdentity.createdAt,deploymentConfigFingerprint:loaded.configFingerprint,...binding,activation:'RUNNING'});
   const hash=await store.publish(receipt);proof={hash,processIdentity};return proof;
  },
  async invalidate(){proof=null;await store.invalidate();},
  observation(challenge,{phase,ready,workersActive}){const active=proof&&phase==='RUNNING'&&ready&&workersActive;
   return {challenge,state:active?'ACTIVE':'NOT_PROVEN',phase,ready:ready===true,workersActive:workersActive===true,receiptDigest:active?proof.hash:null,processId:processIdentity?.pid??null,processCreatedAt:processIdentity?.createdAt??null};}
 });
}
