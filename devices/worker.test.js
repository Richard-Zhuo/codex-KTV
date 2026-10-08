import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomControlWorker } from './worker.js';

test('worker concurrent ticks share one bounded batch and stop waits for in-flight evidence',async()=>{
 let release,lists=0,advances=0;const held=new Promise(r=>release=r);
 const worker=createRoomControlWorker({store:{async listPending(limit){assert.equal(limit,2);lists++;return ['one','two'];}},
  application:{async advance(){advances++;await held;}},batchSize:2,intervalMs:100});
 const first=worker.tick(),second=worker.tick();assert.equal(first,second);
 let stopped=false;const stopping=worker.stop().then(()=>stopped=true);await new Promise(r=>setTimeout(r,5));assert.equal(stopped,false);
 release();await stopping;assert.equal(lists,1);assert.equal(advances,2);
});
test('worker isolates one workflow error so other pending rooms can continue',async()=>{
 const ids=[],errors=[];const worker=createRoomControlWorker({store:{async listPending(){return ['bad','good'];}},
  application:{async advance(id){ids.push(id);if(id==='bad')throw Error('synthetic');}},onError:e=>errors.push(e)});
 await worker.tick();assert.deepEqual(ids,['bad','good']);assert.equal(errors.length,1);
});
