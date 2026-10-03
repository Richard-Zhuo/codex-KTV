import { EmployeeRosterError, EmployeeCommitOutcomeUnknown } from './errors.js';
import { createTransactionBoundEmployeeResolver } from './employee-resolver.js';

const dateFormat = "'%Y-%m-%dT%H:%i:%s.%fZ'";
export function createMySqlEmployeeStore({ pool, database }) {
  if (typeof pool?.getConnection !== 'function' || typeof database !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(database)) throw TypeError('MySQL employee store 配置无效');
  const quote = String.fromCharCode(96);
  const table = name => quote + database + quote + '.' + quote + name + quote;
  const employees = table('employees'), events = table('employee_events'), accounts = table('auth_accounts');
  const selectEmployee = 'SELECT employee_id, display_name, enabled, principal_id, ' +
    'DATE_FORMAT(created_at, ' + dateFormat + ') AS created_at, DATE_FORMAT(updated_at, ' + dateFormat +
    ') AS updated_at FROM ' + employees + ' WHERE employee_id = ?';
  const employeeRow = row => row ? Object.freeze({ employeeId: row.employee_id, displayName: row.display_name,
    enabled: row.enabled === 1, principalId: row.principal_id, createdAt: row.created_at, updatedAt: row.updated_at }) : null;

  async function assertDatabase(connection) {
    const [[target]] = await connection.query('SELECT DATABASE() AS database_name');
    if (target.database_name !== database) throw Error('employee 数据库目标不一致');
  }

  const port = connection => ({
    async locateEmployee(employeeId) {
      const [[row]] = await connection.execute(selectEmployee, [employeeId]);
      return employeeRow(row);
    },
    async lockAccount(principalId) {
      const [[row]] = await connection.execute('SELECT principal_id, enabled FROM ' + accounts +
        ' WHERE principal_id = ? FOR UPDATE', [principalId]);
      return row ? { principalId: row.principal_id, enabled: row.enabled === 1 } : null;
    },
    async lockEmployee(employeeId) {
      const [[row]] = await connection.execute(selectEmployee + ' FOR UPDATE', [employeeId]);
      return employeeRow(row);
    },
    async insertEmployee({ employeeId, displayName }) {
      const [result] = await connection.execute('INSERT INTO ' + employees +
        ' (employee_id, display_name) VALUES (?, ?)', [employeeId, displayName]);
      if (result.affectedRows !== 1) throw Error('员工写入未完成');
    },
    async setPrincipal(employeeId, principalId) {
      let result;
      try {
        [result] = await connection.execute('UPDATE ' + employees +
          ' SET principal_id = ?, updated_at = UTC_TIMESTAMP(6) WHERE employee_id = ?', [principalId, employeeId]);
      } catch (error) {
        // This UPDATE changes only the nullable unique principal key, never employee_id.
        if (error.code === 'ER_DUP_ENTRY') throw new EmployeeRosterError('EMPLOYEE_PRINCIPAL_ALREADY_LINKED');
        throw error;
      }
      if (result.affectedRows !== 1) throw Error('员工关联更新未完成');
    },
    async disableEmployee(employeeId) {
      const [result] = await connection.execute('UPDATE ' + employees +
        ' SET enabled = 0, updated_at = UTC_TIMESTAMP(6) WHERE employee_id = ? AND enabled = 1', [employeeId]);
      if (result.affectedRows !== 1) throw Error('员工停用未完成');
    },
    async appendEvent({ employeeId, actorPrincipalId, eventType, beforePrincipalId, afterPrincipalId }) {
      const [result] = await connection.execute('INSERT INTO ' + events +
        ' (employee_id, actor_principal_id, event_type, before_principal_id, after_principal_id) VALUES (?, ?, ?, ?, ?)',
        [employeeId, actorPrincipalId, eventType, beforePrincipalId, afterPrincipalId]);
      if (result.affectedRows !== 1) throw Error('员工审计未写入');
    }
  });

  // Internal capability: caller must have an active transaction.
  // Current shared employee read; no auth/principal lookup or lifecycle ownership.
  function bindEmployeeResolver(connection) {
    if (typeof connection?.execute !== 'function' || typeof connection?.query !== 'function' ||
        typeof connection.getConnection === 'function') throw TypeError('必须提供当前 MySQL connection，不能提供 pool');
    return createTransactionBoundEmployeeResolver({ port: {
      async lockEmployeeForAttribution(employeeId) {
        // DO 0 is read-only; its OK packet reports the active transaction bit.
        const [status] = await connection.execute('DO 0');
        if (!Number.isInteger(status.serverStatus) || !(status.serverStatus & 1)) throw Error('employee resolver 必须位于调用方已开启的事务内');
        await assertDatabase(connection);
        const [[row]] = await connection.execute('SELECT employee_id, display_name, enabled FROM ' + employees + ' WHERE employee_id = ? FOR SHARE', [employeeId]);
        return row ? { employeeId:row.employee_id, displayName:row.display_name, enabled:row.enabled === 1 } : null;
      }
    } });
  }

  async function runTransaction(work) {
    if (typeof work !== 'function') throw TypeError('employee transaction 回调无效');
    const connection = await pool.getConnection();
    let begun = false, commitAttempted = false, destroy = false, result;
    try {
      await assertDatabase(connection);
      await connection.beginTransaction(); begun = true;
      result = await work(port(connection));
      commitAttempted = true; await connection.commit(); begun = false;
      return result;
    } catch (error) {
      if (commitAttempted) {
        destroy = true;
        throw new EmployeeCommitOutcomeUnknown(error, result?.employeeId || result?.employee?.employeeId || null);
      }
      if (begun) { try { await connection.rollback(); } catch { destroy = true; } }
      throw error;
    } finally { if (destroy) connection.destroy(); else connection.release(); }
  }

  async function readEmployee(employeeId) {
    const connection = await pool.getConnection();
    try {
      await assertDatabase(connection);
      const [[row]] = await connection.execute(selectEmployee, [employeeId]);
      return employeeRow(row);
    } finally { connection.release(); }
  }
  return Object.freeze({ runTransaction, readEmployee, bindEmployeeResolver });
}
