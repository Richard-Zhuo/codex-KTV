import test from 'node:test';
import assert from 'node:assert/strict';
import { createMySqlEmployeeStore } from './mysql-store.js';
import { EmployeeRosterError, EmployeeCommitOutcomeUnknown } from './errors.js';

const id = '00000000-0000-4000-8000-000000000001';
function fixture({ target = 'jbhh_ktv_test', failSql = false, failCommit = false, failRollback = false, duplicate = false } = {}) {
  const calls = [];
  const connection = {
    async query(sql) { calls.push(['query',sql]); return [[{database_name: target}]]; },
    async execute(sql, params) {
      calls.push(['sql',sql,params]);
      if (failSql || duplicate) throw Object.assign(Error('synthetic SQL failure'), { code: duplicate ? 'ER_DUP_ENTRY' : 'SQL_FAULT' });
      if (sql.startsWith('SELECT employee_id')) return [[{employee_id:id,display_name:'Synthetic',enabled:1,principal_id:null,created_at:'DB-created',updated_at:'DB-updated'}]];
      if (sql.startsWith('SELECT principal_id')) return [[{principal_id:id,enabled:1}]];
      return [{affectedRows:1}];
    },
    async beginTransaction() { calls.push(['begin']); },
    async commit() { calls.push(['commit']); if (failCommit) throw Error('synthetic lost COMMIT'); },
    async rollback() { calls.push(['rollback']); if (failRollback) throw Error('synthetic lost ROLLBACK'); },
    release() { calls.push(['release']); }, destroy() { calls.push(['destroy']); }
  };
  const pool = { async getConnection() { calls.push(['connection']); return connection; } };
  return { store:createMySqlEmployeeStore({pool,database:'jbhh_ktv_test'}),calls };
}

test('employee MySQL store rejects implicit database or unsafe identifiers', () => {
  for (const config of [{}, {pool:{},database:'jbhh_ktv_test'}, {pool:{getConnection(){}},database:'x;DROP'}, {pool:{getConnection(){}}}]) {
    assert.throws(() => createMySqlEmployeeStore(config), TypeError);
  }
});

test('employee store checks actual selected database before BEGIN or writes', async () => {
  const f = fixture({target:'unknown'});
  await assert.rejects(f.store.runTransaction(() => assert.fail('must not run')), /目标不一致/);
  assert.deepEqual(f.calls.map(row=>row[0]), ['connection','query','release']);
});

test('employee store reads without transaction lifecycle and returns immutable UTC record', async () => {
  const f = fixture(), employee = await f.store.readEmployee(id);
  assert.equal(employee.employeeId,id); assert.equal(employee.principalId,null); assert.equal(employee.createdAt,'DB-created');
  assert.equal(Object.isFrozen(employee),true);
  assert.deepEqual(f.calls.map(row=>row[0]), ['connection','query','sql','release']);
  assert.ok(f.calls[2][1].includes("DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ')"));
});

test('employee state and metadata audit share one connection and one commit; timestamps use DB UTC', async () => {
  const f = fixture();
  const result = await f.store.runTransaction(async tx => {
    await tx.lockAccount(id); await tx.lockEmployee(id); await tx.setPrincipal(id,id);
    await tx.appendEvent({employeeId:id,actorPrincipalId:id,eventType:'principal-linked',beforePrincipalId:null,afterPrincipalId:id});
    return {employeeId:id};
  });
  assert.deepEqual(result,{employeeId:id});
  assert.equal(f.calls.filter(row=>row[0]==='connection').length,1); assert.equal(f.calls.filter(row=>row[0]==='begin').length,1);
  assert.equal(f.calls.filter(row=>row[0]==='commit').length,1); assert.ok(!f.calls.some(row=>row[0]==='rollback'));
  const updates = f.calls.filter(row=>row[0]==='sql'&&row[1].startsWith('UPDATE'));
  assert.ok(updates[0][1].includes('updated_at = UTC_TIMESTAMP(6)'));
  const audit = f.calls.find(row=>row[0]==='sql'&&row[1].includes('INSERT INTO')&&row[1].includes('employee_events'));
  assert.deepEqual(audit[2],[id,id,'principal-linked',null,id]); assert.ok(!audit[1].includes('occurred_at'));
});

test('employee SQL failure rolls back; unknown exception is not converted into a normal rejection', async () => {
  const f = fixture({failSql:true});
  await assert.rejects(f.store.runTransaction(tx=>tx.setPrincipal(id,id)), error=>error.code==='SQL_FAULT'&&!(error instanceof EmployeeRosterError));
  assert.deepEqual(f.calls.map(row=>row[0]),['connection','query','begin','sql','rollback','release']);
  const unknown = fixture(), error = Error('program fault');
  await assert.rejects(unknown.store.runTransaction(()=>{throw error;}), value=>value===error);
  assert.ok(unknown.calls.some(row=>row[0]==='rollback'));
});

test('only unique principal collision on association UPDATE has a typed roster conflict', async () => {
  const f = fixture({duplicate:true});
  await assert.rejects(f.store.runTransaction(tx=>tx.setPrincipal(id,id)), error=>error instanceof EmployeeRosterError&&error.code==='EMPLOYEE_PRINCIPAL_ALREADY_LINKED');
  assert.ok(f.calls.some(row=>row[0]==='rollback'));
});

test('employee ambiguous COMMIT destroys connection and includes proposed employee ID for reconciliation', async () => {
  const f = fixture({failCommit:true});
  await assert.rejects(f.store.runTransaction(()=>({employeeId:id})), error=>error instanceof EmployeeCommitOutcomeUnknown&&error.employeeId===id);
  assert.ok(f.calls.some(row=>row[0]==='destroy')); assert.ok(!f.calls.some(row=>['rollback','release'].includes(row[0])));
});

test('employee rollback failure destroys connection and preserves original unknown exception', async () => {
  const f = fixture({failRollback:true}), error = Error('original fault');
  await assert.rejects(f.store.runTransaction(()=>{throw error;}), value=>value===error);
  assert.ok(f.calls.some(row=>row[0]==='destroy')); assert.ok(!f.calls.some(row=>row[0]==='release'));
});
