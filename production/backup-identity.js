import {realpath,lstat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRuntimeConfig,windowsFileAcl,validateFileAcl} from './runtime-config.js';
import {readExternalSecret} from './secret-file.js';
import {externalDirectory,fail} from '../backup/format.js';
import {readAcceptedArtifact,verifyInstalledArtifact} from '../shared/release-artifact.js';

async function protectedFile(path,sid){
 const actual=await realpath(path);
 if(actual!==path||!(await lstat(path)).isFile()||(await lstat(path)).isSymbolicLink())throw Error('IDENTITY_PATH_DENIED');
 await externalDirectory(dirname(actual));
 validateFileAcl(await windowsFileAcl(actual),sid);
 return actual;
}
// No caller-selected commit/root, ambient identity, Git, or runtime secret reads.
export async function readBackupIdentity({configFile,config,env}){
 try{
  const runtime=await readRuntimeConfig(config.runtimeConfigFile,env);
  await protectedFile(configFile,runtime.serviceAccountSid);
  if(JSON.stringify(await readExternalSecret(configFile))!==JSON.stringify(config))throw Error('IDENTITY_CONFIG_CHANGED');
  const artifact=await protectedFile(config.releaseArtifactFile,runtime.serviceAccountSid);
  const data=await readAcceptedArtifact({artifact,expectedChecksum:config.releaseArtifactChecksum,commit:runtime.applicationCommit});
  const required=['backup/cli.js','production/backup-identity.js','production/runtime-config.js','production/schema-manifest.json','shared/release-artifact.js'];
  if(required.some(path=>!data.files.some(file=>file.path===path)))throw Error('IDENTITY_PACKAGE_INCOMPLETE');
  const root=await externalDirectory(fileURLToPath(new URL('../',import.meta.url)));
  const applicationCommit=await verifyInstalledArtifact(data,root);
  const current=await readRuntimeConfig(config.runtimeConfigFile,env);
  if(current.applicationCommit!==applicationCommit||current.serviceAccountSid!==runtime.serviceAccountSid||
    JSON.stringify(await readExternalSecret(configFile))!==JSON.stringify(config))throw Error('IDENTITY_CONFIG_CHANGED');
  return applicationCommit;
 }catch{throw fail('BACKUP_RELEASE_IDENTITY_REJECTED');}
}
