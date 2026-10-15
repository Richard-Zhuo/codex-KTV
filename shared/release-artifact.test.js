import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir,symlink} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {readAcceptedArtifact,verifyInstalledArtifact,sha} from './release-artifact.js';
import {unpackAccepted} from '../rehearsal/artifact.js';
const commit='a'.repeat(40);
async function fixture(work){
 const root=await mkdtemp(join(tmpdir(),'s4-artifact-'));
 try{
  const bytes=Buffer.from('export const value=1;\n');
  const data={format:1,applicationCommit:commit,files:[{path:'shared/example.js',bytes:bytes.toString('base64'),sha256:sha(bytes)}]};
  const artifact=join(root,'artifact.json');await writeFile(artifact,JSON.stringify(data));
  await work({root,artifact,data,expectedChecksum:sha(JSON.stringify(data))});
 }finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
}
test('one artifact validator serves extraction and installed-content verification',()=>fixture(async f=>{
 const installed=join(f.root,'installed');
 await unpackAccepted({...f,commit,destination:installed});
 const data=await readAcceptedArtifact({...f,commit});
 assert.equal(await verifyInstalledArtifact(data,installed),commit);
 await writeFile(join(installed,'shared/example.js'),'changed');
 await assert.rejects(verifyInstalledArtifact(data,installed),/ARTIFACT_INSTALLED_CONTENT_INVALID/);
}));
test('external expected digest and accepted commit reject replacement and invalid identity',()=>fixture(async f=>{
 for(const patch of [{commit:'bad'},{expectedChecksum:'bad'},{commit:'b'.repeat(40)},{expectedChecksum:'0'.repeat(64)}]){
  await assert.rejects(readAcceptedArtifact({...f,commit,...patch}),/ARTIFACT_/);
 }
 const changed={...f.data,applicationCommit:'b'.repeat(40)};
 await writeFile(f.artifact,JSON.stringify(changed));
 await assert.rejects(readAcceptedArtifact({...f,commit}),/ARTIFACT_CHECKSUM_MISMATCH/);
}));
test('missing and malformed metadata fail rather than resolving another identity',()=>fixture(async f=>{
 await assert.rejects(readAcceptedArtifact({...f,artifact:join(f.root,'missing'),commit}),{code:'ENOENT'});
 for(const body of ['{',JSON.stringify({format:1,applicationCommit:commit,files:null}),JSON.stringify({format:1,applicationCommit:'bad',files:[]})]){
  await writeFile(f.artifact,body);
  await assert.rejects(readAcceptedArtifact({artifact:f.artifact,expectedChecksum:sha(body),commit}));
 }
}));
test('installed junctions cannot redirect a checksum-matching packaged file',()=>fixture(async f=>{
 const installed=join(f.root,'installed'),outside=join(f.root,'outside');
 await mkdir(installed);await mkdir(outside);await writeFile(join(outside,'example.js'),Buffer.from(f.data.files[0].bytes,'base64'));
 await symlink(outside,join(installed,'shared'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(verifyInstalledArtifact(f.data,installed),/ARTIFACT_INSTALLED_CONTENT_INVALID/);
}));

test('unlisted installed files cannot override packaged dependency resolution',()=>fixture(async f=>{
 const installed=join(f.root,'installed');await unpackAccepted({...f,commit,destination:installed});
 await mkdir(join(installed,'node_modules'));await writeFile(join(installed,'node_modules','extra.js'),'injected');
 await assert.rejects(verifyInstalledArtifact(f.data,installed),/ARTIFACT_INSTALLED_CONTENT_INVALID/);
}));
