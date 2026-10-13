import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import mysql from 'mysql2/promise';
import {createRuntimeReaderCore} from '../recovery/runtime-reader-core.js';
import {readRuntimeDeploymentForRecovery} from '../recovery/runtime-boundary.js';
import {validateRuntimeConfig,validateRuntimeFileAclStructure,runtimeConfigFingerprint} from '../production/runtime-config.js';
import {windowsRecoveryIdentity} from '../recovery/production-authorization-context.js';
import {fixtureRoot} from './protected-windows-fixture.js';
import {evidenceFixtureId,runWindowsEvidence,safeWindowsEvidenceError} from './run-s3d-windows-evidence.js';
const exec=promisify(execFile),operator='S-1-5-21-11-22-33-1001',service='S-1-5-80-1-2-3-4-5',admin='S-1-5-32-544';
const env={NODE_ENV:'production',KTV_HTTP_ENV:'production',KTV_DEPLOYMENT_ENV:'production'};
const helper=fileURLToPath(new URL('./bootstrap-protected-windows-fixture.ps1',import.meta.url));
const runner=fileURLToPath(new URL('./run-s3d-windows-evidence.js',import.meta.url));
const forbidden=/S3D_(?:RUNTIME_PASSWORD|PROVIDER)_SENTINEL|-----BEGIN (?:RSA )?PRIVATE KEY-----/;

test('shared Option A core keeps admission, strict ACL, projection and fingerprint semantics without MySQL',async t=>{
 const root=await mkdtemp(join(tmpdir(),'s3d-reader-unit-'));
 const configPath=join(root,'runtime.json'),secretPath=join(root,'secrets.json'),policyPath=join(root,'policy.json');
 const config={configVersion:1,applicationCommit:'a'.repeat(40),publicOrigin:'https://ktv.example.invalid:8443',listenHost:'127.0.0.1',port:8443,
  storeId:'synthetic-store',ledgerId:'synthetic-ledger',timeZone:'Asia/Shanghai',businessDateCutoff:'12:00',sessionRuleVersion:'opening-hours-v1',deviceControlMode:'disabled',liveControlEnabled:false,
  secretsFile:secretPath,logDirectory:root,serviceAccountSid:service,backupPolicyConfigured:false,directoryAclReviewed:true,networkModel:'private-vpn',monitoring:{backupDirectory:root},recovery:{journalDirectory:root,operatorDbSecretsFile:join(root,'operator.json')}};
 let actor={sid:operator,elevated:true},operatorAce=false;
 const fileAcl=async path=>({protected:true,current:actor.sid,owner:admin,rules:[{sid:path===policyPath?operator:service,type:'Allow',rights:1},{sid:admin,type:'Allow',rights:2032127},...(operatorAce?[{sid:operator,type:'Allow',rights:1}]:[])]});
 const directoryAcl=async()=>({protected:true,current:actor.sid,owner:admin,rules:[{sid:admin,type:'Allow',rights:2032127,inheritance:'ObjectInherit'}]});
 const core=createRuntimeReaderCore({policyPath,env,identity:async()=>actor,fileAcl,directoryAcl});
 const secret={database:{host:'127.0.0.1',port:33313,name:'synthetic_candidate',user:'synthetic_runtime',password:'S3D_RUNTIME_PASSWORD_SENTINEL',ca:'SYNTHETIC_PUBLIC_CA'},tls:{certificate:'synthetic',privateKey:'-----BEGIN PRIVATE KEY-----synthetic'},ktvsky:{password:'S3D_PROVIDER_SENTINEL'}};
 t.mock.method(mysql,'createConnection',()=>assert.fail('reader must not connect MySQL'));
 t.mock.method(mysql,'createPool',()=>assert.fail('reader must not create MySQL pool'));
 try{
  await writeFile(configPath,JSON.stringify(config));await writeFile(secretPath,JSON.stringify(secret));
  await writeFile(policyPath,JSON.stringify({policyVersion:1,approvedOperatorSid:operator,runtimeServiceSid:service,runtimeConfigFile:configPath}));
  const deployment=await core.deployment(configPath),pointer=await core.pointer(configPath);
  assert.equal(deployment.configFingerprint,runtimeConfigFingerprint(config));
  assert.deepEqual(Object.keys(pointer).sort(),['ca','host','name','port']);
  assert.equal(forbidden.test(JSON.stringify({deployment,pointer})),false,'projection must not contain secret material');
  actor={sid:operator,elevated:false};await assert.rejects(()=>core.deployment(configPath),{code:'AUTHORIZATION_OPERATOR_DENIED'});
  actor={sid:'S-1-5-21-11-22-33-1002',elevated:true};await assert.rejects(()=>core.deployment(configPath),{code:'AUTHORIZATION_OPERATOR_DENIED'});
  actor={sid:operator,elevated:true};operatorAce=true;await assert.rejects(()=>core.pointer(configPath),{code:'RUNTIME_ACL_DENIED'});operatorAce=false;
  await writeFile(secretPath,JSON.stringify({database:{name:'bad'}}));await assert.rejects(()=>core.pointer(configPath),{code:'AUTHORIZATION_POINTER_INVALID'});
  await writeFile(secretPath,'x'.repeat(65537));await assert.rejects(()=>core.pointer(configPath),{code:'AUTHORIZATION_PATH_DENIED'});
 }finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(root.includes('s3d-reader-unit-'));await rm(root,{recursive:true,force:true});}
});

test('production wrappers bind the fixed policy and ignore injected fixture options and env selectors',async()=>{
 const identity=await windowsRecoveryIdentity();assert.equal(identity.elevated,false);
 const source=await readFile(new URL('../recovery/runtime-boundary.js',import.meta.url),'utf8');
 assert.ok(source.includes('createRuntimeReaderCore({policyPath:RECOVERY_POLICY_FILE})'));
 const evidence=await readFile(new URL('./run-s3d-windows-evidence.js',import.meta.url),'utf8');
 assert.ok(evidence.includes("from '../recovery/runtime-reader-core.js'"));
 await assert.rejects(()=>readRuntimeDeploymentForRecovery('C:\\untrusted\\runtime.json',{
  policyPath:'C:\\untrusted\\policy.json',fixtureId:'a'.repeat(32),identity:{sid:identity.sid,elevated:true}}),{code:'AUTHORIZATION_OPERATOR_DENIED'});
 const {stdout}=await exec(process.execPath,['--input-type=module','-e',`import {readRuntimeDeploymentForRecovery} from './recovery/runtime-boundary.js';
 try{await readRuntimeDeploymentForRecovery('C:/untrusted/runtime.json');console.log('UNEXPECTED_PASS');}catch(e){console.log(e.code);}`],
 {cwd:fileURLToPath(new URL('../',import.meta.url)),windowsHide:true,env:{...process.env,RECOVERY_POLICY_PATH:'C:\\untrusted\\policy.json',TEST_POLICY:'C:\\untrusted\\policy.json',ALLOW_SYNTHETIC:'true'}});
 assert.equal(stdout.trim(),'AUTHORIZATION_OPERATOR_DENIED');
});

test('evidence selector accepts exactly FixtureId and rejects traversal, UNC, arbitrary roots and ProgramData',async()=>{
 assert.equal(evidenceFixtureId(['--fixture-id','a'.repeat(32)]),'a'.repeat(32));
 for(const id of ['','..\\outside','../outside','C:\\ProgramData\\JbhhKtv','\\\\server\\share','A'.repeat(32),'a'.repeat(31)])
  assert.throws(()=>evidenceFixtureId(['--fixture-id',id]),{code:'FIXTURE_ID_INVALID'});
 for(const args of [[],['--root','C:\\ProgramData'],['--fixture-id','a'.repeat(32),'--policy','x'],['--fixture-id','a'.repeat(32),'--elevated']])
  assert.throws(()=>evidenceFixtureId(args),{code:'FIXTURE_ARGUMENTS_INVALID'});
 await assert.rejects(()=>runWindowsEvidence('a'.repeat(32),{root:'C:\\ProgramData'}),{code:'FIXTURE_ARGUMENTS_INVALID'});
});

test('evidence requires a real owned marker and never creates a missing fixture',async t=>{
 t.mock.method(mysql,'createConnection',()=>assert.fail('evidence must not connect MySQL'));
 await assert.rejects(()=>runWindowsEvidence('f'.repeat(32)),{code:'AUTHORIZATION_PATH_DENIED'});
});

test('evidence failures and actual command output redact messages, stack and sentinel values',async()=>{
 for(const value of ['S3D_RUNTIME_PASSWORD_SENTINEL','S3D_PROVIDER_SENTINEL','-----BEGIN PRIVATE KEY-----synthetic']){
  assert.equal(forbidden.test(safeWindowsEvidenceError({message:value,stack:value,code:value})),false);
  try{await exec(process.execPath,[runner,'--fixture-id',value],{windowsHide:true});assert.fail('invalid selector accepted');}
  catch(error){assert.equal(error.code,1);assert.equal(forbidden.test(error.stdout+error.stderr),false);assert.equal(JSON.parse(error.stdout).CODE,'FIXTURE_ID_INVALID');}
 }
});

// Preserve the same 25-test pre-UAC discovery while allowing a one-case first check.
import './s3d-windows-descriptor.case.js';
