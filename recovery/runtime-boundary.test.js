import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRecoveryPointer,parseRecoveryDatabaseCredential} from './runtime-boundary.js';
const plan={recoveryOperationId:'operation',planDigest:'digest',currentDatabase:'source',targetDatabase:'candidate',
 currentHost:'127.0.0.1',targetHost:'127.0.0.1',currentPort:33313,targetPort:33313,sourceServerUuid:'uuid',targetServerUuid:'uuid'};
const pointer=name=>({host:'127.0.0.1',port:33313,name});
const state=state=>({state,recoveryOperationId:plan.recoveryOperationId,planDigest:plan.planDigest});
test('stage pointer follows existing journals and never treats intent as completion',()=>{
 assert.equal(validateRecoveryPointer(pointer('source'),plan).side,'SOURCE');
 assert.throws(()=>validateRecoveryPointer(pointer('candidate'),plan));
 const execution=state('VERIFYING');
 for(const name of ['source','candidate'])assert.equal(validateRecoveryPointer(pointer(name),plan,{execution,cutover:state('CUTOVER_INTENT')}).stage,'CUTOVER_INTENT');
 assert.equal(validateRecoveryPointer(pointer('candidate'),plan,{execution,cutover:state('CUTOVER_SWITCHED')}).side,'TARGET');
 assert.throws(()=>validateRecoveryPointer(pointer('source'),plan,{execution,cutover:state('CUTOVER_SWITCHED')}));
 for(const phase of ['READY_INTENT','READY_FOR_RESUME','RESUME_INTENT','RESUMED']){
  const journals={execution,cutover:state('CUTOVER_SWITCHED'),c3:state(phase)};
  assert.equal(validateRecoveryPointer(pointer('candidate'),plan,journals).stage,phase);
  assert.throws(()=>validateRecoveryPointer(pointer('source'),plan,journals));
 }
 for(const journals of [{execution:state('FAILED_AMBIGUOUS')},{cutover:state('CUTOVER_INTENT')},
  {execution,c3:state('RESUMED')},{execution,cutover:{...state('CUTOVER_INTENT'),planDigest:'other'}}])
  assert.throws(()=>validateRecoveryPointer(pointer('source'),plan,journals));
});
test('recovery credentials select no database and endpoints must match pointer and plan',()=>{
 const secret={databaseUrl:'mysql://operator:operator-fixture-password@127.0.0.1:33313/'};
 assert.equal(new URL(parseRecoveryDatabaseCredential(secret,pointer('source'),plan)).pathname,'/');
 for(const databaseUrl of [secret.databaseUrl+'source',secret.databaseUrl.replace('33313','33315'),secret.databaseUrl.replace('127.0.0.1','localhost')])
  assert.throws(()=>parseRecoveryDatabaseCredential({databaseUrl},pointer('source'),plan));
 assert.throws(()=>parseRecoveryDatabaseCredential(secret,pointer('source'),{...plan,targetPort:33315}));
});
