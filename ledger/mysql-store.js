// Transitional MySQL 8.4 / InnoDB adapter for the frozen Stage 1A ledger port.
// The caller owns the mysql2 promise Pool and must select an already migrated database.
import { decodeLedgerJson, decodeLedgerSnapshot, encodeLedgerJson, encodeLedgerSnapshot } from './mysql-snapshot.js';

const fingerprintPattern = /^[0-9a-f]{64}$/;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function safeRevision(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || String(number) !== String(value)) {
    throw Error('账本 revision 无效，停止写入');
  }
  return number;
}

function checkedHead(row, ledgerId) {
  if (!row || row.ledger_id !== ledgerId) throw Error('账本快照不存在，停止写入');
  const state = decodeLedgerSnapshot(row.state_json, String(row.state_checksum));
  if (!Number.isSafeInteger(row.state_schema_version) || row.state_schema_version < 1 ||
      state.version !== row.state_schema_version || !Array.isArray(state.processed) ||
      !Array.isArray(state.orders) || !Array.isArray(state.rooms) || !plainObject(state.inventory)) {
    throw Error('账本快照版本或结构损坏，停止写入');
  }
  return { ledgerId, revision: safeRevision(row.revision), state };
}

function checkedOperation(row, ledgerId, operationKey) {
  if (!row) return null;
  const result = decodeLedgerJson(row.terminal_result);
  if (row.ledger_id !== ledgerId || row.operation_key !== operationKey ||
      typeof row.actor_principal_id !== 'string' || !row.actor_principal_id ||
      typeof row.action !== 'string' || !row.action || row.fingerprint_version !== 1 ||
      typeof row.fingerprint !== 'string' || !fingerprintPattern.test(row.fingerprint) ||
      result.ledgerId !== ledgerId || result.actorId !== row.actor_principal_id ||
      result.operationKey !== operationKey || result.status !== row.terminal_status) {
    throw Error('账本操作记录损坏，停止写入');
  }
  const expectedRevision = safeRevision(row.expected_revision);
  const observedRevision = safeRevision(row.observed_revision);
  const committedRevision = row.committed_revision === null ? null : safeRevision(row.committed_revision);
  if (result.status === 'committed') {
    if (committedRevision !== observedRevision + 1 || result.previousRevision !== observedRevision ||
        result.revision !== committedRevision || result.requestFingerprint !== row.fingerprint) {
      throw Error('账本成功终态损坏，停止写入');
    }
  } else if (['revision-conflict', 'business-rejected'].includes(result.status)) {
    if (committedRevision !== null || result.expectedRevision !== expectedRevision ||
        result.currentRevision !== observedRevision) throw Error('账本拒绝终态损坏，停止写入');
  } else {
    throw Error('账本终态类型无效，停止写入');
  }
  return {
    ledgerId, actorId: row.actor_principal_id, operationKey, action: row.action,
    requestFingerprint: row.fingerprint, expectedRevision, result, committedRevision
  };
}

export class LedgerCommitOutcomeUnknown extends Error {
  constructor(ledgerId, operationKey, cause) {
    super('数据库提交结果不明；先查询原 operationKey，不得自动换键重提', { cause });
    this.name = 'LedgerCommitOutcomeUnknown';
    this.code = 'LEDGER_COMMIT_OUTCOME_UNKNOWN';
    this.ledgerId = ledgerId;
    this.operationKey = operationKey;
  }
}

export function createMySqlLedgerStore({ pool, ledgerId, database }) {
  if (typeof pool?.getConnection !== 'function' || typeof ledgerId !== 'string' ||
      !ledgerId || ledgerId.trim() !== ledgerId || ledgerId.length > 64 ||
      typeof database !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(database)) {
    throw TypeError('MySQL 账本连接、标识或数据库名无效');
  }
  const quote = String.fromCharCode(96);
  const table = name => quote + database + quote + '.' + quote + name + quote;
  const heads = table('ledger_heads');
  const operations = table('ledger_operations');
  const audit = table('ledger_success_audit');
  const headSql = 'SELECT ledger_id, revision, state_schema_version, state_json, state_checksum FROM ' + heads + ' WHERE ledger_id = ?';
  const operationSql = 'SELECT ledger_id, operation_key, actor_principal_id, action, fingerprint, fingerprint_version, expected_revision, observed_revision, terminal_status, terminal_result, committed_revision FROM ' + operations + ' WHERE ledger_id = ? AND operation_key = ?';

  const loadOperation = async (connection, operationKey) => {
    const [rows] = await connection.execute(operationSql, [ledgerId, operationKey]);
    return checkedOperation(rows[0], ledgerId, operationKey);
  };

  const read = async () => {
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.execute(headSql, [ledgerId]);
      return checkedHead(rows[0], ledgerId);
    } finally {
      connection.release();
    }
  };

  const runAtomic = async work => {
    if (typeof work !== 'function') throw TypeError('账本事务回调无效');
    const connection = await pool.getConnection();
    let begun = false;
    let commitAttempted = false;
    let destroy = false;
    let proposed = null;
    let databaseTime = null;
    let databaseTimeRaw = null;
    try {
      await connection.beginTransaction();
      begun = true;
      const [rows] = await connection.execute(headSql + ' FOR UPDATE', [ledgerId]);
      const head = checkedHead(rows[0], ledgerId);
      const transaction = {
        read: async () => structuredClone(head),
        findOperationResult: operationKey => loadOperation(connection, operationKey),
        commitTimestamp: async () => {
          if (databaseTime === null) {
            const [timeRows] = await connection.execute("SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%d %H:%i:%s.%f') AS db_time");
            databaseTimeRaw = timeRows[0]?.db_time;
            if (typeof databaseTimeRaw !== 'string' ||
                !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(databaseTimeRaw)) {
              throw Error('数据库时间无效，停止提交');
            }
            databaseTime = databaseTimeRaw.replace(' ', 'T') + 'Z';
          }
          return databaseTime;
        },
        commit: async change => {
          if (proposed) throw Error('同一事务不能记录两个终态');
          if (change.ledgerId !== ledgerId || change.expectedRevision !== head.revision ||
              change.revision !== head.revision + 1 || !Number.isSafeInteger(change.revision) ||
              change.committedRevision !== change.revision || !plainObject(change.state) ||
              !Number.isSafeInteger(change.state.version) || change.state.version < 1 ||
              change.result?.status !== 'committed' || change.result?.revision !== change.revision ||
              change.result?.previousRevision !== head.revision ||
              change.result?.ledgerId !== ledgerId || change.result?.actorId !== change.actorId ||
              change.result?.operationKey !== change.operationKey ||
              change.result?.requestFingerprint !== change.requestFingerprint ||
              change.audit?.kind !== 'command.succeeded' || change.audit?.ledgerId !== ledgerId ||
              change.audit?.actorId !== change.actorId || change.audit?.operationKey !== change.operationKey ||
              change.audit?.action !== change.action ||
              change.audit?.requestFingerprint !== change.requestFingerprint ||
              change.audit?.previousRevision !== head.revision || change.audit?.revision !== change.revision ||
              databaseTime === null || change.result?.committedAt !== databaseTime ||
              change.audit?.occurredAt !== databaseTime || !fingerprintPattern.test(change.requestFingerprint)) {
            throw Error('原子提交版本、归属、快照或数据库时间无效');
          }
          proposed = { kind: 'committed', change: structuredClone(change) };
        },
        recordTerminal: async change => {
          if (proposed) throw Error('同一事务不能记录两个终态');
          if (change.ledgerId !== ledgerId || change.observedRevision !== head.revision ||
              change.committedRevision !== null ||
              !['revision-conflict', 'business-rejected'].includes(change.result?.status) ||
              change.result?.ledgerId !== ledgerId || change.result?.actorId !== change.actorId ||
              change.result?.operationKey !== change.operationKey ||
              change.result?.expectedRevision !== change.expectedRevision ||
              change.result?.currentRevision !== head.revision ||
              !fingerprintPattern.test(change.requestFingerprint)) {
            throw Error('拒绝终态归属、指纹或版本无效');
          }
          proposed = { kind: 'rejected', change: structuredClone(change) };
        }
      };
      const response = await work(transaction);
      if (!proposed) {
        await connection.rollback();
        begun = false;
        return structuredClone(response);
      }
      const change = proposed.change;
      if (proposed.kind === 'committed') {
        const snapshot = encodeLedgerSnapshot(change.state);
        const [updated] = await connection.execute(
          'UPDATE ' + heads + ' SET revision = ?, state_schema_version = ?, state_json = ?, state_checksum = ?, updated_at = ? WHERE ledger_id = ? AND revision = ?',
          [change.revision, change.state.version, snapshot.json, snapshot.checksum, databaseTimeRaw, ledgerId, head.revision]
        );
        if (updated.affectedRows !== 1) throw Error('账本 revision 并发冲突，停止提交');
      }
      const [inserted] = await connection.execute(
        'INSERT INTO ' + operations + ' (ledger_id, operation_key, actor_principal_id, action, fingerprint, expected_revision, observed_revision, terminal_status, terminal_result, committed_revision, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, UTC_TIMESTAMP(6)))',
        [ledgerId, change.operationKey, change.actorId, change.action, change.requestFingerprint,
          change.expectedRevision, head.revision, change.result.status, encodeLedgerJson(change.result),
          change.committedRevision, databaseTimeRaw]
      );
      if (inserted.affectedRows !== 1) throw Error('账本操作结果未写入，停止提交');
      if (proposed.kind === 'committed') {
        const [audited] = await connection.execute(
          'INSERT INTO ' + audit + ' (ledger_id, operation_key, actor_principal_id, action, fingerprint, before_revision, after_revision, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [ledgerId, change.operationKey, change.actorId, change.action, change.requestFingerprint,
            head.revision, change.revision, databaseTimeRaw]
        );
        if (audited.affectedRows !== 1) throw Error('成功审计未写入，停止提交');
      }
      const saved = await loadOperation(connection, change.operationKey);
      if (!saved || saved.actorId !== change.actorId || saved.requestFingerprint !== change.requestFingerprint) {
        throw Error('账本操作结果读回不一致，停止提交');
      }
      commitAttempted = true;
      await connection.commit();
      begun = false;
      return structuredClone(saved.result);
    } catch (error) {
      if (commitAttempted) {
        destroy = true;
        throw new LedgerCommitOutcomeUnknown(ledgerId, proposed?.change.operationKey, error);
      }
      if (begun) {
        try { await connection.rollback(); } catch { destroy = true; }
      }
      throw error;
    } finally {
      if (destroy) connection.destroy();
      else connection.release();
    }
  };

  return { ledgerId, read, runAtomic };
}
