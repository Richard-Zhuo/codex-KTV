// Test-only process boundary. Real owned MySQL/root identity is required before callbacks.
import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {issueOwnedCandidateCapability} from '../recovery/production-candidate.js';
import {createOwnedAuthorizationHarness} from '../recovery/production-authorization.js';
import {canonicalProtectedPath} from '../recovery/production-authorization-context.js';
const f={root:process.env.STAGE5E_FIXTURE_ROOT,names:{id:process.env.STAGE5E_FIXTURE_ID,database:'jbhh_ktv_test'},
 identity:{server_uuid:process.env.STAGE5E_FIXTURE_UUID},port:33313,dbUrl:()=>process.env.LEDGER_MYSQL_TEST_URL};
try{
 const capability=await issueOwnedCandidateCapability(f);
 const [file,action]=process.argv.slice(2);
 if(dirname(await canonicalProtectedPath(file))!==join(f.root,'artifacts'))throw Error('SCOPE');
 const value=JSON.parse(await readFile(file,'utf8'));
 const facts=async()=>({...value,
  checkDirectory:p=>canonicalProtectedPath(p,{directory:true}),
  checkFile:p=>canonicalProtectedPath(p)});
 const engine=await createOwnedAuthorizationHarness({capability,facts,harden:async()=>{}});
 const result=action==='authorize'?await engine.authorize({confirm:async({challenge})=>challenge}):
  action==='revoke'?await engine.revoke():null;
 if(!result)throw Error('ACTION');
 console.log(JSON.stringify(result));
}catch(error){console.log(JSON.stringify({code:/^AUTHORIZATION_/.test(error.code??'')?error.code:'OWNED_PROCESS_FAILED'}));process.exitCode=1;}
