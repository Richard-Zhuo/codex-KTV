import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, validateTarget, TEMPLATES } from './plan.js';
import { runBootstrapCli } from './bootstrap-cli.js';
import { readExternalSecret } from './secret-file.js';
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
  assert.throws(()=>validateTarget(plan,raw,confirmation,{LEDGER_MYSQL_TEST_URL:raw,NODE_ENV:'production'}));
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

