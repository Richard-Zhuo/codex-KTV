import { assertFixtureEnvironment } from './destructive-safety.js';
// Only fixture-owned auth tables may be altered. The caller verifies the dedicated DB first.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export const policyAttributeTables = ['auth_policy_attributes'];
export async function applyPolicyAttributeMigration(connection, created) {
  assertFixtureEnvironment();
  const source = await readFile(new URL('../database/migrations/004_mysql_auth_policy_attributes.sql', import.meta.url), 'utf8');
  const statements = source.split(/\r?\n/).filter(line => !line.trim().startsWith('--'))
    .join('\n').split(';').map(part => part.trim()).filter(Boolean);
  assert.equal(statements.length, 3);
  for (const sql of statements) {
    await connection.query(sql);
    if (sql.startsWith('CREATE TABLE auth_policy_attributes ')) created.push('auth_policy_attributes');
  }
  await applyExpenseApprovalAttributeMigration(connection);
  await applyCreditApprovalAttributesMigration(connection);
  return statements;
}

// Alters only the already fixture-owned auth metadata after 004; no additional tables.
export async function applyExpenseApprovalAttributeMigration(connection) {
  assertFixtureEnvironment();
  const source = await readFile(new URL('../database/migrations/005_mysql_expense_approval_attribute.sql', import.meta.url), 'utf8');
  const statements = source.split(/\r?\n/).filter(line => !line.trim().startsWith('--'))
    .join('\n').split(';').map(part => part.trim()).filter(Boolean);
  assert.equal(statements.length, 2);
  for (const sql of statements) await connection.query(sql);
  return statements;
}

// Expands only the two named CHECKs on already-owned metadata after 005.
export async function applyCreditApprovalAttributesMigration(connection) {
  assertFixtureEnvironment();
  const source = await readFile(new URL('../database/migrations/006_mysql_credit_approval_attributes.sql', import.meta.url), 'utf8');
  const statements = source.split(/\r?\n/).filter(line => !line.trim().startsWith('--'))
    .join('\n').split(';').map(part => part.trim()).filter(Boolean);
  assert.equal(statements.length, 2);
  for (const sql of statements) await connection.query(sql);
  return statements;
}
