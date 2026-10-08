import test from 'node:test';import assert from 'node:assert/strict';
import { canonical,digest,pack,unpack,externalDirectory } from './format.js';
import { runBackupCli } from './cli.js';import { fileURLToPath } from 'node:url';
test('backup serialization is canonical; binary and null roundtrip without timestamp coercion',()=>{
 assert.equal(canonical({z:1,a:{b:null,a:2}}),canonical({a:{a:2,b:null},z:1}));assert.equal(digest(canonical({a:1})),digest(canonical({a:1})));
 assert.deepEqual(unpack(pack(Buffer.from([0,255,1]))),Buffer.from([0,255,1]));assert.equal(unpack(null),null);
 assert.throws(()=>pack(new Date()),{code:'BACKUP_TEMPORAL_PRECISION'});assert.throws(()=>unpack({binary:'invalid!!'}));
});
test('backup refuses repository storage and secret command-line options',async()=>{
 await assert.rejects(externalDirectory(fileURLToPath(new URL('../',import.meta.url))),{code:'BACKUP_PATH_DENIED'});
 const output=[];assert.equal(await runBackupCli(['backup','--password','synthetic-secret'],{},{log:v=>output.push(v),error:v=>output.push(v)}),1);
 assert.equal(output.length,1);assert.equal(output[0].includes('synthetic-secret'),false);
});
