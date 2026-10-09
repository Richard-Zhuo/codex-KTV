import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {parseBrowserEvidence,readBrowserEvidence} from './browser-evidence.js';
test('invalid asynchronous browser evidence rejects the wait and reaches caller cleanup without leaking input',async()=>{
 for(const value of ['{','{"wrong":true}','{"browser":{"status":"PASS","password":"synthetic-secret"}}']){
  const input=new EventEmitter();let cleaned=false;
  const work=(async()=>{try{return await readBrowserEvidence(input);}finally{cleaned=true;}})();
  assert.doesNotThrow(()=>input.emit('line',value));
  await assert.rejects(work,{message:'REHEARSAL_BROWSER_EVIDENCE_INVALID'});assert.equal(cleaned,true);assert.equal(input.listenerCount('line'),0);
 }
});
test('browser evidence accepts only bounded result fields and EOF does not invent a PASS',async()=>{
 assert.deepEqual(parseBrowserEvidence('{"browser":{"status":"BLOCKED","recordId":"dcab9edcacbd4","payment":"BLOCKED"}}'),{status:'BLOCKED',recordId:'dcab9edcacbd4',payment:'BLOCKED'});
 const input=new EventEmitter(),result=readBrowserEvidence(input);input.emit('close');assert.equal(await result,undefined);
});
