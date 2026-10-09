import {readFile,readdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
export async function assertNoSecretMarkers(paths,markers){
 const raw=[...markers].filter(v=>typeof v==='string'&&v.length>=12);const secrets=[...new Set(raw.flatMap(v=>[v,Buffer.from(v).toString('base64'),JSON.stringify(v).slice(1,-1)]))];
 let files=0;
 async function scan(path){const st=await lstat(path);if(st.isSymbolicLink())throw Error('REHEARSAL_SCAN_LINK_DENIED');if(st.isDirectory()){for(const name of await readdir(path))await scan(join(path,name));return;}
 if(!st.isFile())return;const bytes=await readFile(path);files++;for(const secret of secrets)if(bytes.includes(Buffer.from(secret)))throw Error('REHEARSAL_SECRET_LEAK');}
 for(const path of paths)await scan(path);
 return {files,markers:secrets.length,leakage:0};
}
