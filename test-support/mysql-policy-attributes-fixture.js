// Only fixture-owned auth tables may be altered. The caller verifies the dedicated DB first.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export const policyAttributeTables = ['auth_policy_attributes'];
export async function applyPolicyAttributeMigration(connection, created) {
  const source = await readFile(new URL('../database/migrations/004_mysql_auth_policy_attributes.sql', import.meta.url), 'utf8');
  const statements = source.split(/\r?\n/).filter(line => !line.trim().startsWith('--'))
    .join('\n').split(';').map(part => part.trim()).filter(Boolean);
  assert.equal(statements.length, 3);
  for (const sql of statements) {
    await connection.query(sql);
    if (sql.startsWith('CREATE TABLE auth_policy_attributes ')) created.push('auth_policy_attributes');
  }
  return statements;
}
