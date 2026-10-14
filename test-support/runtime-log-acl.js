import {mkdir} from 'node:fs/promises';
import {basename,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {canonicalProtectedPath} from '../recovery/production-authorization-context.js';
import {protectActivationPath,validateActivationAcl} from '../production/activation-receipt.js';
import {validateRuntimeFileAclStructure} from '../production/runtime-config.js';
import {windowsDirectoryAcl} from '../production/wecom-smoke-config.js';
import {assertFixtureEnvironment} from './destructive-safety.js';

// Only a fresh log directory in the existing disposable Stage5B fixture boundary.
export async function provisionSyntheticRuntimeLogDirectory(path,sid){
 assertFixtureEnvironment();
 const parent=dirname(path);
 if(resolve(path)!==path||basename(path)!=='logs'||dirname(parent)!==resolve(tmpdir())||!basename(parent).startsWith('ktv-stage5b-'))throw Error('SYNTHETIC_LOG_DIRECTORY_SCOPE_INVALID');
 await canonicalProtectedPath(parent,{directory:true});
 await mkdir(path);
 await canonicalProtectedPath(path,{directory:true});
 const before=await windowsDirectoryAcl(path);
 if(before.current!==sid)throw Error('SYNTHETIC_RUNTIME_IDENTITY_MISMATCH');
 await protectActivationPath(path,sid,true);
 const acl=await windowsDirectoryAcl(path);
 validateRuntimeFileAclStructure(acl,sid);
 validateActivationAcl(acl,sid,{directory:true,producer:true});
 return acl;
}
