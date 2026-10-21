import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let received;
mock.module('../production/backup-identity.js', { exports: {
  // Match the real S4 parameter/default contract, stopping before any installed resources.
  readBackupIdentity: async input => {
    const { env = process.env } = input;
    received = { explicitEnv: input.env, hasEnv: Object.hasOwn(input, 'env'), effectiveEnv: env };
    throw Error('SYNTHETIC_PRIVATE_S4_STOP');
  }
} });
const { produceSyntheticOffsiteUnit } = await import('./offsite-unit.js');
const databaseUrl = 'mysql://synthetic@127.0.0.1:33313/jbhh_ktv_test';
const args = { databaseUrl, environment: 'test', env: { STAGE5E_RUN: 'synthetic-only',
  NODE_ENV: 'test', KTV_HTTP_ENV: 'test', KTV_DEPLOYMENT_ENV: 'test', LEDGER_MYSQL_TEST_URL: databaseUrl } };
const identity = identityEnv => ({ configFile: 'SYNTHETIC_UNUSED_CONFIG', config: {}, identityEnv });
const rejected = error => error.code === 'BACKUP_OFFSITE_REJECTED' && error.message === 'BACKUP_OFFSITE_REJECTED';

test('B5 P2 env: explicit identity environment reaches S4 instead of process environment', async () => {
  received = null;
  const identityEnv = { SYNTHETIC_S4_MARKER: 'owned-explicit-identity' };
  await assert.rejects(produceSyntheticOffsiteUnit(args, { releaseIdentity: identity(identityEnv) }), rejected);
  assert.equal(received.hasEnv, true);
  assert.equal(received.explicitEnv?.SYNTHETIC_S4_MARKER, identityEnv.SYNTHETIC_S4_MARKER);
  assert.equal(received.effectiveEnv === process.env, false);
});

test('B5 P2 env: undefined identity environment preserves the real S4 default', async () => {
  received = null;
  await assert.rejects(produceSyntheticOffsiteUnit(args, { releaseIdentity: identity(undefined) }), rejected);
  assert.equal(received.explicitEnv === undefined, true);
  // Compare booleans, never serialize the process environment into test diagnostics.
  assert.equal(received.effectiveEnv === process.env, true);
});

test('B5 P2 env: missing identity field still rejects before S4', async () => {
  received = null;
  const releaseIdentity = identity(undefined); delete releaseIdentity.identityEnv;
  await assert.rejects(produceSyntheticOffsiteUnit(args, { releaseIdentity }), rejected);
  assert.equal(received, null);
});
