// Synthetic files only. No database connection or production identity substitution.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { canonical, digest, durableWrite, schemaSpec } from '../backup/format.js';
import { protectActivationPath } from '../production/activation-receipt.js';
import { windowsDirectoryAcl } from '../production/wecom-smoke-config.js';
export async function protectPipelineTestDirectory(path) {
  if (process.platform === 'win32') await protectActivationPath(path, (await windowsDirectoryAcl(path)).current, true);
}
export async function createSyntheticFormat1(args, marker = 'SYNTHETIC-PIPELINE-DATA') {
  const spec = await schemaSpec(), tables = Object.fromEntries(spec.tables.map(name => [name, { columns: ['synthetic'], rows: [] }]));
  const checksum = digest(marker);
  tables.ledger_heads = { columns: ['ledger_id', 'revision', 'state_checksum'], rows: [[args.ledgerId, 1, checksum]] };
  tables.production_bootstrap_events = { columns: ['store_id', 'ledger_id', 'environment'], rows: [[args.storeId, args.ledgerId, 'test']] };
  const data = Buffer.from(canonical({ backupFormatVersion: 1, tables }));
  const manifest = { backupFormatVersion: 1, backupId: randomUUID(), createdAt: '2026-10-21T00:00:00.000000Z', engine: 'InnoDB', mysqlVersion: '8.4.11',
    schema: spec.manifest, migrationVersion: Object.keys(spec.manifest.migrations).at(-1), storeId: args.storeId, ledgerId: args.ledgerId,
    applicationCommit: args.applicationCommit, source: { environment: 'test', database: 'jbhh_ktv_test', serverUuid: args.serverUuid },
    ledgerHeads: [{ ledgerId: args.ledgerId, revision: 1, checksum }], dataChecksum: digest(data), dataBytes: data.length };
  const bytes = Buffer.from(canonical(manifest)), hash = digest(bytes);
  await mkdir(args.outputDirectory, { mode: 0o700 });
  await durableWrite(join(args.outputDirectory, 'data.json'), data);
  await durableWrite(join(args.outputDirectory, 'manifest.json'), bytes);
  await durableWrite(join(args.outputDirectory, 'manifest.sha256'), hash + '\n');
  return { code: 'BACKUP_VERIFIED', directory: args.outputDirectory, checksum: hash, createdAt: manifest.createdAt };
}
export async function withPipelineFixture(work) {
  const root = await mkdtemp(join(tmpdir(), 'ktv-b4b-unit-')), key = randomBytes(32), keyId = 'synthetic-b4b-key';
  try {
    await protectPipelineTestDirectory(root);
    const staging = join(root, 'staging'), published = join(root, 'published');
    for (const path of [staging, published]) { await mkdir(path, { mode: 0o700 }); await protectPipelineTestDirectory(path); }
    const databaseUrl = 'mysql://synthetic@127.0.0.1:33313/jbhh_ktv_test';
    const args = { databaseUrl, environment: 'test', storeId: 'synthetic-store', ledgerId: 'synthetic-ledger', serverUuid: randomUUID(),
      applicationCommit: '702a9c454f42e0f6f4a09d99a23b9bbfcb8f4ff0', outputDirectory: join(published, 'one-backup'),
      env: { STAGE5E_RUN: 'synthetic-only', NODE_ENV: 'test', KTV_HTTP_ENV: 'test', KTV_DEPLOYMENT_ENV: 'test', LEDGER_MYSQL_TEST_URL: databaseUrl } };
    const options = { encryption: { enabled: true, keyId, stagingDirectory: staging }, keyProvider: { resolve: () => ({ keyId, key }) } };
    const ports = { create: input => createSyntheticFormat1(input) };
    await work({ root, key, keyId, staging, published, args, options, ports });
  } finally {
    key.fill(0);
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ktv-b4b-unit-')) throw Error('TEST_CLEANUP_SCOPE');
    await rm(root, { recursive: true, force: true });
  }
}
