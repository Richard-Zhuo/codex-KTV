import test from 'node:test';
import assert from 'node:assert/strict';
import { createMySqlEmployeeStore } from './mysql-store.js';

function connection({ transaction = true, database = 'jbhh_ktv_test' } = {}) {
  const sql = [];
  return {
    sql,
    async query(statement) {
      sql.push(statement);
      return [[{ database_name: database }]];
    },
    async execute(statement) {
      sql.push(statement);
      if (statement === 'DO 0') return [{ serverStatus: transaction ? 1 : 0 }];
      return [[
        { employee_id: 'employee-a', display_name: 'A', principal_id: 'principal-a' },
        { employee_id: 'employee-b', display_name: 'B', principal_id: null }
      ]];
    }
  };
}

test('active roster read uses current transaction and returns only stable attribution fields', async () => {
  const store = createMySqlEmployeeStore({
    pool: { getConnection() { assert.fail('must use caller transaction'); } },
    database: 'jbhh_ktv_test'
  });
  const current = connection();
  assert.deepEqual(await store.listActiveInTransaction(current), [
    { employeeId: 'employee-a', displayName: 'A',
      principalId: 'principal-a', enabled: true },
    { employeeId: 'employee-b', displayName: 'B',
      principalId: null, enabled: true }
  ]);
  assert.match(current.sql.at(-1), /WHERE enabled = 1.*FOR SHARE/);
  await assert.rejects(store.listActiveInTransaction(connection({ transaction: false })),
    /active transaction/);
  await assert.rejects(store.listActiveInTransaction(connection({ database: 'wrong' })),
    /目标不一致/);
});
