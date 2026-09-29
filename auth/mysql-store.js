// MySQL persistence port for Stage 2B. All multi-row auth writes use one connection.
const tableNames = ['auth_accounts', 'auth_credentials', 'auth_grants', 'auth_sessions', 'auth_events'];

export class AuthCommitOutcomeUnknown extends Error {
  constructor(cause) {
    super('认证事务提交结果不明；不得假定会话已创建', { cause });
    this.name = 'AuthCommitOutcomeUnknown';
  }
}

export function createMySqlAuthStore({ pool, database }) {
  if (!pool || typeof pool.getConnection !== 'function' ||
      typeof database !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(database)) {
    throw TypeError('MySQL auth store 配置无效');
  }
  const quote = String.fromCharCode(96);
  const names = Object.fromEntries(tableNames.map(name =>
    [name, quote + database + quote + '.' + quote + name + quote]));
  const accounts = names.auth_accounts;
  const credentials = names.auth_credentials;
  const grants = names.auth_grants;
  const sessions = names.auth_sessions;
  const events = names.auth_events;

  const transactionPort = connection => ({
    async insertAccount({ principalId, loginIdentifier, credential }) {
      await connection.execute('INSERT INTO ' + accounts +
        ' (principal_id) VALUES (?)', [principalId]);
      await connection.execute('INSERT INTO ' + credentials +
        ' (principal_id, login_identifier, password_algorithm, password_params_version, salt, derived_key) VALUES (?, ?, ?, ?, ?, ?)',
      [principalId, loginIdentifier, credential.algorithm, credential.paramsVersion,
        credential.salt, credential.derivedKey]);
    },

    async findCredentialForLogin(loginIdentifier) {
      const [[row]] = await connection.execute(
        'SELECT a.principal_id, a.enabled, a.credential_version, c.password_algorithm, c.password_params_version, c.salt, c.derived_key FROM ' +
        credentials + ' c JOIN ' + accounts +
        ' a ON a.principal_id = c.principal_id WHERE c.login_identifier = ? FOR UPDATE',
        [loginIdentifier]);
      if (!row) return null;
      return { principalId: row.principal_id, enabled: row.enabled === 1,
        credentialVersion: String(row.credential_version),
        credential: { algorithm: row.password_algorithm,
          paramsVersion: row.password_params_version, salt: row.salt, derivedKey: row.derived_key } };
    },

    async lockAccount(principalId) {
      const [[row]] = await connection.execute(
        'SELECT principal_id, enabled, credential_version FROM ' + accounts +
        ' WHERE principal_id = ? FOR UPDATE', [principalId]);
      return row && { principalId: row.principal_id, enabled: row.enabled === 1,
        credentialVersion: String(row.credential_version) };
    },

    async insertSession({ sessionId, principalId, digest, credentialVersion,
      idleSeconds, absoluteSeconds }) {
      const [result] = await connection.execute('INSERT INTO ' + sessions +
        ' (session_id, principal_id, token_digest, credential_version, idle_expires_at, absolute_expires_at) ' +
        'VALUES (?, ?, ?, ?, LEAST(DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND), ' +
        'DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND)), DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND))',
      [sessionId, principalId, digest, credentialVersion, idleSeconds, absoluteSeconds, absoluteSeconds]);
      if (result.affectedRows !== 1) throw Error('session 写入未完成');
    },

    async findSessionByDigestForUpdate(digest) {
      const [[row]] = await connection.execute(
        'SELECT s.session_id, s.principal_id, s.credential_version AS session_version, ' +
        's.revoked_at, a.enabled, a.credential_version AS account_version, ' +
        '(s.idle_expires_at > UTC_TIMESTAMP(6)) AS idle_valid, ' +
        '(s.absolute_expires_at > UTC_TIMESTAMP(6)) AS absolute_valid ' +
        'FROM ' + sessions + ' s JOIN ' + accounts +
        ' a ON a.principal_id = s.principal_id WHERE s.token_digest = ? FOR UPDATE',
        [digest]);
      if (!row) return null;
      return { sessionId: row.session_id, principalId: row.principal_id,
        sessionVersion: String(row.session_version), accountVersion: String(row.account_version),
        enabled: row.enabled === 1, revoked: row.revoked_at !== null,
        idleValid: Number(row.idle_valid) === 1, absoluteValid: Number(row.absolute_valid) === 1 };
    },

    async touchSession(sessionId, idleSeconds) {
      const [result] = await connection.execute('UPDATE ' + sessions +
        ' SET last_seen_at = UTC_TIMESTAMP(6), idle_expires_at = LEAST(absolute_expires_at, ' +
        'DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND)) WHERE session_id = ?',
      [idleSeconds, sessionId]);
      if (result.affectedRows !== 1) throw Error('session 续期未完成');
    },

    async listGrants(principalId) {
      const [rows] = await connection.execute(
        'SELECT permission_id FROM ' + grants + ' WHERE principal_id = ? ORDER BY permission_id',
        [principalId]);
      return rows.map(row => row.permission_id);
    },

    async findSessionByIdForUpdate(sessionId) {
      const [[row]] = await connection.execute(
        'SELECT session_id, principal_id, revoked_at FROM ' + sessions +
        ' WHERE session_id = ? FOR UPDATE', [sessionId]);
      return row && { sessionId: row.session_id, principalId: row.principal_id,
        revoked: row.revoked_at !== null };
    },

    async revokeSession(sessionId) {
      const [result] = await connection.execute('UPDATE ' + sessions +
        ' SET revoked_at = UTC_TIMESTAMP(6) WHERE session_id = ? AND revoked_at IS NULL',
        [sessionId]);
      return result.affectedRows === 1;
    },

    async listUnrevokedSessions(principalId) {
      const [rows] = await connection.execute(
        'SELECT session_id FROM ' + sessions +
        ' WHERE principal_id = ? AND revoked_at IS NULL FOR UPDATE', [principalId]);
      return rows.map(row => row.session_id);
    },

    async disableAccount(principalId) {
      const [result] = await connection.execute('UPDATE ' + accounts +
        ' SET enabled = 0, disabled_at = UTC_TIMESTAMP(6) WHERE principal_id = ? AND enabled = 1',
        [principalId]);
      if (result.affectedRows !== 1) throw Error('账号停用未完成');
    },

    async replaceCredential(principalId, credential) {
      const [updated] = await connection.execute('UPDATE ' + credentials +
        ' SET password_algorithm = ?, password_params_version = ?, salt = ?, derived_key = ?, ' +
        'updated_at = UTC_TIMESTAMP(6) WHERE principal_id = ?',
      [credential.algorithm, credential.paramsVersion, credential.salt, credential.derivedKey,
        principalId]);
      if (updated.affectedRows !== 1) throw Error('凭据更新未完成');
      await connection.execute('UPDATE ' + accounts +
        ' SET credential_version = credential_version + 1 WHERE principal_id = ?', [principalId]);
    },

    async addGrant(principalId, permissionId) {
      const [rows] = await connection.execute(
        'SELECT permission_id FROM ' + grants +
        ' WHERE principal_id = ? AND permission_id = ?', [principalId, permissionId]);
      if (rows.length) return false;
      await connection.execute('INSERT INTO ' + grants +
        ' (principal_id, permission_id) VALUES (?, ?)', [principalId, permissionId]);
      return true;
    },

    async removeGrant(principalId, permissionId) {
      const [result] = await connection.execute('DELETE FROM ' + grants +
        ' WHERE principal_id = ? AND permission_id = ?', [principalId, permissionId]);
      return result.affectedRows === 1;
    },

    async appendEvent({ principalId = null, sessionId = null, eventType, reasonCode = null }) {
      const [result] = await connection.execute('INSERT INTO ' + events +
        ' (principal_id, session_id, event_type, reason_code) VALUES (?, ?, ?, ?)',
      [principalId, sessionId, eventType, reasonCode]);
      if (result.affectedRows !== 1) throw Error('认证审计未写入');
    }
  });

  async function runTransaction(work) {
    if (typeof work !== 'function') throw TypeError('auth transaction 回调无效');
    const connection = await pool.getConnection();
    let begun = false;
    let commitAttempted = false;
    let destroy = false;
    try {
      const [[target]] = await connection.query('SELECT DATABASE() AS database_name');
      if (target.database_name !== database) throw Error('auth 数据库目标不一致');
      await connection.beginTransaction();
      begun = true;
      const result = await work(transactionPort(connection));
      commitAttempted = true;
      await connection.commit();
      begun = false;
      return result;
    } catch (error) {
      if (commitAttempted) {
        destroy = true;
        throw new AuthCommitOutcomeUnknown(error);
      }
      if (begun) {
        try { await connection.rollback(); } catch { destroy = true; }
      }
      throw error;
    } finally {
      if (destroy) connection.destroy();
      else connection.release();
    }
  }

  return Object.freeze({ runTransaction });
}
