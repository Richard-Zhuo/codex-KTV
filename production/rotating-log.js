import {openSync,closeSync,writeSync,fsyncSync,readdirSync,lstatSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
// One bounded log sink. Rotation only touches this sink's generated files;
// incident state, backup artifacts and unrelated files are never candidates.
export function createRotatingLog(directory,{maxBytes=10*1024*1024,maxFiles=10,fallback=line=>process.stderr.write(line),onFailure=()=>{}}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1024||!Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>100)throw Error('LOG_ROTATION_CONFIG_INVALID');
 const pattern=/^ktv-\d+-[a-f0-9-]{36}\.jsonl$/;let fd,size=0,failed=false,closed=false;
 function rotate(){
  if(fd!==undefined){fsyncSync(fd);closeSync(fd);fd=undefined;}
  const names=readdirSync(directory).filter(n=>pattern.test(n)).sort();
  for(const name of names.slice(0,Math.max(0,names.length-maxFiles+1))){const path=join(directory,name),s=lstatSync(path);if(s.isFile()&&!s.isSymbolicLink())unlinkSync(path);}
  fd=openSync(join(directory,'ktv-'+Date.now()+'-'+randomUUID()+'.jsonl'),'wx',0o600);size=0;
 }
 function fail(line){
  fallback(line);if(!failed){failed=true;fallback(JSON.stringify({code:'LOG_WRITE_FAILURE',severity:'CRITICAL'})+'\n');queueMicrotask(()=>onFailure());}
 }
 rotate();
 return {write(line){
  if(typeof line!=='string'||Buffer.byteLength(line)>8192)throw Error('LOG_RECORD_INVALID');
  if(closed||failed){fail(line);return;}
  try{const length=Buffer.byteLength(line);if(size&&size+length>maxBytes)rotate();const bytes=Buffer.from(line);let offset=0;while(offset<bytes.length)offset+=writeSync(fd,bytes,offset);size+=length;}
  catch{fail(line);}
 },close(){
  closed=true;if(fd!==undefined){try{fsyncSync(fd);}finally{closeSync(fd);fd=undefined;}}
 },get failed(){return failed;}};
}
