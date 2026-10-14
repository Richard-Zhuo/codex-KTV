import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,lstat} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {readRuntimeLogFiles} from './runtime-log-reader.js';

test('runtime log collector reads files and preserves activation directory without reading it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ktv-log-reader-'));
 try{
  const file=join(root,'runtime.log'),activation=join(root,'runtime-activation');
  await writeFile(file,'runtime_started');await mkdir(activation);await writeFile(join(activation,'current.json'),'not runtime log text');
  const reads=[];
  const text=await readRuntimeLogFiles(root,{read:async(path,encoding)=>{reads.push(path);return readFile(path,encoding);}});
  assert.equal(text,'runtime_started');assert.deepEqual(reads,[file]);assert.equal((await lstat(activation)).isDirectory(),true);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('runtime log collector propagates a real file read failure',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ktv-log-reader-'));
 try{
  const file=join(root,'runtime.log');await writeFile(file,'runtime_started');
  await assert.rejects(()=>readRuntimeLogFiles(root,{read:async(path,encoding)=>{await rm(path);return readFile(path,encoding);}}),{code:'ENOENT'});
 }finally{await rm(root,{recursive:true,force:true});}
});
