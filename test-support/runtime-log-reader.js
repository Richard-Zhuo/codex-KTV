import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';

// This test collector stays at the log root; activation state is not runtime text.
export async function readRuntimeLogFiles(directory,{read=readFile}={}){
 const entries=await readdir(directory,{withFileTypes:true});
 return (await Promise.all(entries.filter(entry=>entry.isFile()).map(entry=>read(join(directory,entry.name),'utf8')))).join('');
}
