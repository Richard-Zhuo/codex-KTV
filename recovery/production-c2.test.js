import test from 'node:test';
import assert from 'node:assert/strict';
import {switchOwnedCandidatePointer} from './production-c2.js';

test('C2 production cutover core refuses unissued capability before config or DB access',async()=>{
 let reads=0;
 await assert.rejects(switchOwnedCandidatePointer({capability:{},runtimeConfigFile:'ignored',
  readPlan:async()=>{reads++;throw Error('unexpected read');}}),
 {code:'RESTORE_PRODUCTION_DISABLED'});
 assert.equal(reads,0);
});
