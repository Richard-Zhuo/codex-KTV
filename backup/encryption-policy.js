// B4-B policy/admission stays lightweight so default-disabled CLI keeps its original dependency graph.
import { isAbsolute } from 'node:path';
import { isProductionEnvironment } from '../shared/deployment-environment.js';
const fail = code => Object.assign(new Error(code), { code });

export function backupEncryptionPolicy(value) {
  if (value === undefined) return Object.freeze({ enabled: false });
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean' ||
      Object.keys(value).some(k => !['enabled', 'keyId', 'stagingDirectory'].includes(k)) ||
      (!value.enabled && Object.keys(value).length !== 1) ||
      (value.enabled && (Object.keys(value).length !== 3 || typeof value.keyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.keyId ?? '') ||
        typeof value.stagingDirectory !== 'string' || !isAbsolute(value.stagingDirectory)))) throw fail('BACKUP_ENCRYPTION_CONFIG_INVALID');
  return Object.freeze({ ...value });
}
export function assertSyntheticBackupEncryption(args) {
  const env = args.env ?? process.env;
  if (isProductionEnvironment(env) || env.STAGE5E_RUN !== 'synthetic-only' || args.environment !== 'test' ||
      args.databaseUrl !== env.LEDGER_MYSQL_TEST_URL) throw fail('BACKUP_ENCRYPTION_SYNTHETIC_ONLY');
}
