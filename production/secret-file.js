import { realpath, readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refused } from './plan.js';
export async function readExternalSecret(path, repository=fileURLToPath(new URL('../',import.meta.url))) {
  try {
    if(!isAbsolute(path)) throw Error();
    const [file,root]=await Promise.all([realpath(path),realpath(repository)]);
    const rel=relative(root,file);
    if(rel==='' || (!rel.startsWith('..'+sep)&&!isAbsolute(rel))) throw Error();
    for(let dir=dirname(file);;) {
      let marker=false;
      try { await stat(join(dir,'.git')); marker=true; } catch(error) { if(error.code!=='ENOENT') throw error; }
      if(marker) throw Error();
      const parent=dirname(dir);if(parent===dir)break;dir=parent;
    }
    const info=await stat(file);
    if(!info.isFile()||info.size>65536) throw Error();
    return JSON.parse(await readFile(file,'utf8'));
  } catch {throw refused('BOOTSTRAP_SECRET_FILE_DENIED');}
}

