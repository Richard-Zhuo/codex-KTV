import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, validateTarget, TEMPLATES } from './plan.js';
import { runBootstrapCli } from './bootstrap-cli.js';
import { readExternalSecret } from './secret-file.js';
import { mkdtemp,mkdir,writeFile,symlink,unlink,rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapIdentities } from './bootstrap.js';
import { bootstrapMappings } from './mapping.js';
import { fileURLToPath } from 'node:url';
export const person={principalId:'10000000-0000-4000-8000-000000000001',employeeId:'20000000-0000-4000-8000-000000000001',displayName:'Synthetic person',loginIdentifier:'synthetic-bootstrap',enabled:true,template:'BOOKING_STAFF',permissions:[],policyAttributes:[]};
export const plan={configVersion:'synthetic-v1',environment:'test',database:'jbhh_ktv_test',storeId:'synthetic-store',ledgerId:'synthetic-ledger',approved:true,people:[person]};
test('bootstrap templates expand explicit permissions without approval shortcuts',()=>{
  const p=validatePlan(plan).people[0]; assert.deepEqual(p.permissions,['room.reserve','staff.record']);
  for(const template of Object.values(TEMPLATES)) for(const forbidden of ['backend.view','review.self','rounding.approve','credit.approve','payment.settle']) {
    if(forbidden==='payment.settle'&&template===TEMPLATES.NIGHT_OPERATOR)continue;
    assert.equal(template.includes(forbidden),false);
  }
});
test('bootstrap rejects unknown grants, attributes, duplicate identities and embedded credentials',()=>{
  for(const permission of ['*','all','admin.*','unknown'])assert.throws(()=>validatePlan({...plan,people:[{...person,permissions:[permission]}]}),{code:'BOOTSTRAP_UNKNOWN_CAPABILITY'});
  assert.throws(()=>validatePlan({...plan,people:[{...person,policyAttributes:['boss']}]}),{code:'BOOTSTRAP_UNKNOWN_CAPABILITY'});
  assert.throws(()=>validatePlan({...plan,people:[person,{...person,principalId:'10000000-0000-4000-8000-000000000002'}]}),{code:'BOOTSTRAP_DUPLICATE_BINDING'});
  assert.throws(()=>validatePlan({...plan,people:[{...person,password:'excluded'}]}),{code:'BOOTSTRAP_INVALID_FIELDS'});
});
test('bootstrap target separates production and dedicated test',()=>{
  const raw='mysql://localhost/jbhh_ktv_test',confirmation='jbhh_ktv_test/synthetic-store/synthetic-ledger';
  validateTarget(plan,raw,confirmation,{LEDGER_MYSQL_TEST_URL:raw});
  for(const key of ['NODE_ENV','KTV_HTTP_ENV','KTV_DEPLOYMENT_ENV'])for(const value of ['production','Production',' production ','prod','live','unknown',''])assert.throws(()=>validateTarget(plan,raw,confirmation,{LEDGER_MYSQL_TEST_URL:raw,[key]:value}));
  assert.throws(()=>validateTarget({...plan,environment:'production'},raw,confirmation));
  assert.throws(()=>validateTarget(plan,raw,'wrong',{LEDGER_MYSQL_TEST_URL:raw}));
});
test('secret file refuses repository and relative paths',async()=>{
  await assert.rejects(readExternalSecret(fileURLToPath(new URL('../package.json',import.meta.url))),{code:'BOOTSTRAP_SECRET_FILE_DENIED'});
  await assert.rejects(readExternalSecret('relative.json'),{code:'BOOTSTRAP_SECRET_FILE_DENIED'});
});
test('CLI error diagnostics omit input and arbitrary exception details',async()=>{
  const output=[]; const logger={log:v=>output.push(v),error:v=>output.push(v)};
  const secretMarker=String.fromCharCode(115,101,99,114,101,116);
  assert.equal(await runBootstrapCli(['--bad',secretMarker],{},logger),1);
  assert.equal(output.length,1);assert.equal(output[0].includes(secretMarker),false);
  assert.equal(JSON.parse(output[0]).code,'BOOTSTRAP_INVALID_ARGUMENTS');
});


test('secret resolution rejects Git files through Windows junctions and dot-dot aliases',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ktv-audit-path-')),repo=join(dir,'checkout'),external=join(dir,'external'),alias=join(dir,'alias');
  const file=join(repo,'private.json'),safe=join(external,'safe.json');
  try {
    await mkdir(repo);await mkdir(join(repo,'.git'));await mkdir(external);await writeFile(file,'{"synthetic":true}');await writeFile(safe,'{"synthetic":true}');
    await symlink(repo,alias,process.platform==='win32'?'junction':'dir');
    assert.deepEqual(await readExternalSecret(safe,repo),{synthetic:true});
    for(const path of [file,join(alias,'private.json'),join(external,'..','checkout','private.json')])await assert.rejects(readExternalSecret(path,repo),{code:'BOOTSTRAP_SECRET_FILE_DENIED'});
  }finally{if(process.platform==='win32')await rmdir(alias);else await unlink(alias);await unlink(file);await unlink(safe);await rmdir(join(repo,'.git'));await rmdir(repo);await rmdir(external);await rmdir(dir);}
});

test('pool failures omit driver details from programmatic bootstrap errors',async()=>{
  const raw='mysql://localhost/jbhh_ktv_test',secretMarker='synthetic-private-driver-diagnostic';
  const args={pool:{getConnection:async()=>{throw Error(secretMarker);}},plan,databaseUrl:raw,confirmation:'jbhh_ktv_test/synthetic-store/synthetic-ledger',initiatedBy:'synthetic-operator',env:{LEDGER_MYSQL_TEST_URL:raw}};
  for(const run of [bootstrapIdentities,bootstrapMappings])await assert.rejects(run(run===bootstrapIdentities?args:{...args,plan:{...plan,people:undefined,mappings:[]}}),e=>e.code==='BOOTSTRAP_FAILED'&&!String(e.stack).includes(secretMarker));
});
