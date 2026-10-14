// Test-only deterministic evidence of file paths and bytes; not a production digest contract.
import {readFile,readdir} from 'node:fs/promises';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {canonical,digest} from '../backup/format.js';
export async function filesystemDigest(roots){let parts=[];async function walk(path){for(const entry of await readdir(path,{withFileTypes:true})){const p=join(path,entry.name);if(entry.isDirectory())await walk(p);else parts.push([p,createHash('sha256').update(await readFile(p)).digest('hex')]);}}for(const root of roots)await walk(root);return digest(canonical({files:parts.sort()}));}
