// Test fixture DDL isolation only; production command concurrency uses InnoDB row locks.
// The setup connection owns this lock until end(), including on fixture failure.
export async function acquireMySqlFixtureLock(connection) {
  const [[target]] = await connection.query('SELECT DATABASE() AS database_name');
  if (target.database_name !== 'jbhh_ktv_test') throw Error('拒绝在非专用测试库获取 fixture 锁');
  const [[row]] = await connection.execute('SELECT GET_LOCK(?, 10) AS acquired',
    ['jbhh_ktv_test.integration-fixture']);
  if (Number(row.acquired) !== 1) throw Error('专用测试库 fixture 正在使用，停止本次测试');
}
