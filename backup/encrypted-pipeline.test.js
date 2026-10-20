import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, stat, rename, symlink, link, open } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { backupEncryptionPolicy, createConfiguredBackup, runEncryptedBackup, inspectEncryptedBackupResidues } from './encrypted-pipeline.js';
import { encryptArtifact, withDecryptedArtifact } from './encryption.js';
import { canonical, durableWrite } from './format.js';
import { runBackupCli } from './cli.js';
import { withPipelineFixture, createSyntheticFormat1 } from '../test-support/encrypted-pipeline-fixture.js';

const run = f => runEncryptedBackup(f.args, f.options, f.ports);
const failed = result => { assert.equal(result.complete, false); assert.notEqual(result.code, 'BACKUP_ENCRYPTED_VERIFIED'); };

test('B4-B policy is default off and rejects malformed or secret-bearing configuration', () => {
  assert.deepEqual(backupEncryptionPolicy(), { enabled: false });
  for (const value of [null, true, {}, { enabled: 'true' }, { enabled: false, keyId: 'x' },
    { enabled: true, keyId: 'x', stagingDirectory: 'relative' }, { enabled: true, keyId: '../x', stagingDirectory: 'C:/synthetic' },
    { enabled: true, keyId: 'x', stagingDirectory: 'C:/synthetic', key: 'forbidden' }]) {
    assert.throws(() => backupEncryptionPolicy(value), { code: 'BACKUP_ENCRYPTION_CONFIG_INVALID' });
  }
});

test('B4-B omitted/disabled encryption preserves the original one-shot creation entry', async () => withPipelineFixture(async f => {
  let calls = 0; const create = async args => { calls++; assert.equal(args, f.args); return { code: 'BACKUP_VERIFIED' }; };
  for (const encryption of [undefined, { enabled: false }]) assert.deepEqual(await createConfiguredBackup(f.args, { encryption }, { create }), { code: 'BACKUP_VERIFIED' });
  assert.equal(calls, 2); assert.deepEqual(await readdir(f.staging), []);
}));

test('B4-B denies production, absent opt-in, wrong source selector and missing key with no fallback', async () => withPipelineFixture(async f => {
  for (const changes of [{ environment: 'production' }, { env: { ...f.args.env, NODE_ENV: 'production' } },
    { env: { ...f.args.env, STAGE5E_RUN: undefined } }, { databaseUrl: 'mysql://other@127.0.0.1/jbhh_ktv_test' }]) {
    await assert.rejects(runEncryptedBackup({ ...f.args, ...changes }, f.options, f.ports), { code: 'BACKUP_ENCRYPTION_SYNTHETIC_ONLY' });
  }
  await assert.rejects(runEncryptedBackup(f.args, { encryption: f.options.encryption }, f.ports), { code: 'BACKUP_ENCRYPTION_KEY_REQUIRED' });
  await assert.rejects(runEncryptedBackup(f.args, {}, f.ports), { code: 'BACKUP_ENCRYPTION_DISABLED' });
  assert.deepEqual(await readdir(f.staging), []); assert.deepEqual(await readdir(f.published), []);
}));

test('B4-B create→format1→encrypt→authenticate→exclusive publish→clean is fully recorded', async () => withPipelineFixture(async f => {
  const result = await createConfiguredBackup(f.args, f.options, f.ports);
  assert.equal(result.code, 'BACKUP_ENCRYPTED_VERIFIED'); assert.equal(result.complete, true);
  assert.equal(result.ciphertext, 'PUBLISHED'); assert.equal(result.plaintext, 'ABSENT'); assert.equal(result.resultRecorded, true);
  assert.deepEqual(await readdir(result.directory), ['backup.b4']);
  const report = (await inspectEncryptedBackupResidues(f.staging))[0];
  assert.deepEqual(report, { requestId: result.requestId, phase: 'COMPLETE', ciphertext: 'PUBLISHED', plaintext: 'ABSENT', incomplete: false });
  const envelope = await readFile(join(result.directory, 'backup.b4'));
  await withDecryptedArtifact({ envelope, expectedKeyId: f.keyId, keyProvider: f.options.keyProvider, temporaryParent: f.staging,
    expectedChecksum: result.checksum, storeId: f.args.storeId, ledgerId: f.args.ledgerId }, async ({ directory }) => {
      const data = JSON.parse(await readFile(join(directory, 'data.json'), 'utf8')); assert.equal(data.backupFormatVersion, 1);
    });
  const job = join(f.staging, 'b4-run-' + result.requestId);
  const records = (await readdir(job)).filter(name => name.endsWith('.json'));
  assert.equal((await readdir(job)).some(name => name.endsWith('.pending')), false);
  for (const name of records) assert.equal(JSON.parse(await readFile(join(job, name), 'utf8')).version, 2);
  await assert.rejects(stat(join(job, 'source')), { code: 'ENOENT' });
  await assert.rejects(stat(join(job, 'ciphertext.tmp')), { code: 'ENOENT' });
  assert.equal(JSON.stringify(result).includes(f.key.toString('hex')), false);
}));

for (const stage of ['create', 'encrypt', 'decrypt', 'publish', 'cleanup']) {
  test('B4-B ' + stage + ' failure never reports full success and retained plaintext is discoverable', async () => withPipelineFixture(async f => {
    const ports = { ...f.ports, [stage]: async () => { throw Error('SYNTHETIC_SENSITIVE_ERROR_' + f.key.toString('hex')); } };
    const result = await runEncryptedBackup(f.args, f.options, ports); failed(result);
    assert.equal(result.resultRecorded, true);
    assert.equal(result.ciphertext === 'PUBLISHED', stage === 'cleanup');
    assert.equal(result.plaintext, stage === 'create' ? 'ABSENT' : 'REMAINS');
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_SENSITIVE_ERROR'), false);
    const reports = await inspectEncryptedBackupResidues(f.staging);
    assert.equal(reports[0].phase, 'FAILED'); assert.equal(reports[0].incomplete, true);
    await assert.rejects(run(f), { code: 'BACKUP_ENCRYPTION_RESIDUE_REQUIRES_REVIEW' });
    if (stage !== 'cleanup') assert.deepEqual(await readdir(f.published), stage === 'publish' ? ['one-backup'] : []);
  }));
}

test('B4-B invalid key material and corrupted encrypted candidate cannot publish or fall back to plaintext', async () => withPipelineFixture(async f => {
  const result = await runEncryptedBackup(f.args, { ...f.options, keyProvider: { resolve: () => ({ keyId: f.keyId, key: randomBytes(16) }) } }, f.ports);
  failed(result); assert.equal(result.code, 'BACKUP_ENCRYPTION_ENCRYPT_FAILED'); assert.deepEqual(await readdir(f.published), []);
}));

test('B4-B authentication failure after writing ciphertext prevents publication', async () => withPipelineFixture(async f => {
  const result = await runEncryptedBackup(f.args, f.options, { ...f.ports, encrypt: async args => {
    const bytes = await encryptArtifact(args); bytes[bytes.length - 1] ^= 1; return bytes;
  } });
  failed(result); assert.equal(result.code, 'BACKUP_ENCRYPTION_VALIDATION_FAILED');
  assert.equal(result.plaintext, 'REMAINS'); assert.deepEqual(await readdir(f.published), []);
}));

test('B4-B partial source creation remains protected, recorded and never automatically deleted', async () => withPipelineFixture(async f => {
  let source;
  const result = await runEncryptedBackup(f.args, f.options, { ...f.ports, create: async args => {
    source = args.outputDirectory; await mkdir(source); await writeFile(join(source, 'data.json'), 'SYNTHETIC-PARTIAL'); throw Error('INTERRUPTED');
  } });
  failed(result); assert.equal(result.plaintext, 'REMAINS'); assert.equal(await readFile(join(source, 'data.json'), 'utf8'), 'SYNTHETIC-PARTIAL');
  assert.equal((await inspectEncryptedBackupResidues(f.staging))[0].incomplete, true);
}));

test('B4-B existing legal backup is never overwritten or removed on publication collision', async () => withPipelineFixture(async f => {
  await createSyntheticFormat1(f.args, 'EXISTING-BACKUP');
  const before = await readFile(join(f.args.outputDirectory, 'manifest.json'));
  const result = await run(f); failed(result); assert.equal(result.code, 'BACKUP_ENCRYPTION_PUBLICATION_FAILED');
  assert.deepEqual(await readFile(join(f.args.outputDirectory, 'manifest.json')), before);
  assert.equal(result.plaintext, 'REMAINS');
}));

test('B4-B hard-link publication rejects an existing filename atomically and never replaces it', async () => withPipelineFixture(async f => {
  const result = await runEncryptedBackup(f.args, f.options, { ...f.ports, publish: async (source, target) => {
    await durableWrite(target, 'EXISTING-SYNTHETIC'); await link(source, target);
  } });
  failed(result); assert.equal(await readFile(join(f.args.outputDirectory, 'backup.b4'), 'utf8'), 'EXISTING-SYNTHETIC');
  assert.equal(result.ciphertext, 'VERIFIED');
}));

test('B4-B damaged published bytes are UNKNOWN, never a verified publication', async () => withPipelineFixture(async f => {
  const result = await runEncryptedBackup(f.args, f.options, { ...f.ports, publish: async (source, target) => {
    await link(source, target); await writeFile(target, 'SYNTHETIC-DAMAGE');
  } });
  failed(result); assert.equal(result.ciphertext, 'UNKNOWN'); assert.equal(result.plaintext, 'REMAINS');
}));

test('B4-B linked source cannot make cleanup follow or delete an outside sentinel', async () => withPipelineFixture(async f => {
  const sentinel = join(f.root, 'keep'); await mkdir(sentinel); await durableWrite(join(sentinel, 'data.json'), 'KEEP-SYNTHETIC');
  const result = await runEncryptedBackup(f.args, f.options, { ...f.ports, publish: async (candidate, target) => {
    await link(candidate, target); const source = join(f.staging, (await readdir(f.staging))[0], 'source');
    await rename(source, source + '-retained'); await symlink(sentinel, source, process.platform === 'win32' ? 'junction' : 'dir');
  } });
  failed(result); assert.equal(result.plaintext, 'UNKNOWN'); assert.equal(await readFile(join(sentinel, 'data.json'), 'utf8'), 'KEEP-SYNTHETIC');
}));

test('B4-B hard-linked plaintext is not unlinked by the narrow source cleaner', async () => withPipelineFixture(async f => {
  const retained = join(f.root, 'retained.json');
  const result = await runEncryptedBackup(f.args, f.options, { ...f.ports, publish: async (candidate, target) => {
    await link(candidate, target); const source = join(f.staging, (await readdir(f.staging))[0], 'source', 'data.json'); await link(source, retained);
  } });
  failed(result); assert.equal(result.plaintext, 'REMAINS'); assert.ok((await readFile(retained)).length > 0);
}));

test('B4-B record failure before creating source is visible as an unrecorded/incomplete job', async () => withPipelineFixture(async f => {
  const result = await runEncryptedBackup(f.args, f.options, { ...f.ports, record: async () => { throw Error('DISK_FULL'); } });
  failed(result); assert.equal(result.resultRecorded, false); assert.equal(result.plaintext, 'ABSENT');
  assert.equal((await inspectEncryptedBackupResidues(f.staging))[0].phase, 'UNKNOWN');
}));

test('B4-B final record failure cannot turn valid ciphertext and absent plaintext into full success', async () => withPipelineFixture(async f => {
  const result = await runEncryptedBackup(f.args, f.options, { ...f.ports, record: async (job, sequence, state) => {
    if (state.phase === 'COMPLETE') throw Error('DISK_FULL');
    await durableWrite(join(job, 'state-' + String(sequence).padStart(4, '0') + '.json'), canonical(state));
  } });
  failed(result); assert.equal(result.ciphertext, 'PUBLISHED'); assert.equal(result.plaintext, 'ABSENT'); assert.equal(result.resultRecorded, true);
  assert.equal((await inspectEncryptedBackupResidues(f.staging))[0].incomplete, true);
}));

test('B4-B residue inspection rejects junctions/malformed journals without touching their targets', async () => withPipelineFixture(async f => {
  const sentinel = join(f.root, 'outside'); await mkdir(sentinel); await durableWrite(join(sentinel, 'keep'), 'KEEP');
  await symlink(sentinel, join(f.staging, 'b4-run-00000000-0000-4000-8000-000000000000'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await inspectEncryptedBackupResidues(f.staging); assert.equal(result[0].plaintext, 'UNKNOWN');
  assert.equal(await readFile(join(sentinel, 'keep'), 'utf8'), 'KEEP');
}));

test('B4-B overlapping stage/publication paths are rejected without creating a job', async () => withPipelineFixture(async f => {
  await assert.rejects(runEncryptedBackup({ ...f.args, outputDirectory: join(f.staging, 'forbidden') }, f.options, f.ports), { code: 'BACKUP_ENCRYPTION_PATH_DENIED' });
  assert.deepEqual(await readdir(f.staging), []);
}));

test('B4-B CLI preserves S4 admission before any encrypted pipeline execution, with no key argv or bypass', async () => withPipelineFixture(async f => {
  const configFile = join(f.root, 'backup.json'); await durableWrite(configFile, JSON.stringify({ environment: 'test', encryption: f.options.encryption }));
  const output = [], logger = { log: value => output.push(value), error: value => output.push(value) };
  const code = await runBackupCli(['backup', '--config-file', configFile, '--output-dir', f.args.outputDirectory], f.args.env, logger, { keyProvider: f.options.keyProvider });
  assert.equal(code, 1); assert.ok(output.some(value => value.includes('BACKUP_RELEASE_IDENTITY_REJECTED')));
  assert.deepEqual(await readdir(f.staging), []); assert.deepEqual(await readdir(f.published), []);
  assert.equal(output.join('').includes(f.key.toString('hex')), false);
}));

test('B4-B real process interruption leaves a discoverable CREATING record and source, with no published success', async () => withPipelineFixture(async f => {
  const source = "import {runEncryptedBackup} from " + JSON.stringify(new URL('./encrypted-pipeline.js', import.meta.url).href) +
    ";import {createSyntheticFormat1} from " + JSON.stringify(new URL('../test-support/encrypted-pipeline-fixture.js', import.meta.url).href) +
    ";import {randomBytes} from 'node:crypto';let text='';for await(const b of process.stdin)text+=b;const p=JSON.parse(text);const key=randomBytes(32);await runEncryptedBackup(p.args,{encryption:p.encryption,keyProvider:{resolve:()=>({keyId:p.encryption.keyId,key})}},{create:async args=>{await createSyntheticFormat1(args);process.stdout.write('SOURCE_STAGED\\n');await new Promise(()=>{setInterval(()=>{},1000);});}});";
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stderr.on('data', b => { stderr += b; });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', b => { stdout += b; if (stdout.includes('SOURCE_STAGED')) resolve(); });
    child.once('error', reject); child.once('exit', () => reject(Error('CHILD_EXIT_BEFORE_STAGE ' + stderr)));
  });
  child.stdin.end(JSON.stringify({ args: f.args, encryption: f.options.encryption }));
  try { await ready; const closed = once(child, 'exit'); child.kill('SIGKILL'); await closed; }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  const reports = await inspectEncryptedBackupResidues(f.staging);
  assert.equal(reports[0].phase, 'CREATING'); assert.equal(reports[0].plaintext, 'REMAINS'); assert.equal(reports[0].incomplete, true);
  assert.deepEqual(await readdir(f.published), []); assert.equal(stderr, '');
}));

// Fault only this test process's FileHandle operations; always restore the native methods.
async function withRecordSyncHook(f, beforeSync, work) {
  const probe = await open(join(f.root, 'record-handle-probe'), 'wx');
  const prototype = Object.getPrototypeOf(probe), originalWrite = prototype.writeFile, originalSync = prototype.sync;
  await probe.close(); const records = new WeakMap();
  prototype.writeFile = async function (bytes, ...args) {
    try { const state = JSON.parse(bytes.toString()); if (state.requestId && state.phase) records.set(this, state); } catch {}
    return Reflect.apply(originalWrite, this, [bytes, ...args]);
  };
  prototype.sync = async function (...args) {
    const state = records.get(this); if (state) await beforeSync(state);
    return Reflect.apply(originalSync, this, args);
  };
  try { return await work(); }
  finally { prototype.writeFile = originalWrite; prototype.sync = originalSync; }
}

test('B4-B P2: COMPLETE sync EIO leaves detectable uncertainty and blocks the next run', async () => withPipelineFixture(async f => {
  let injected = false;
  const result = await withRecordSyncHook(f, async state => {
    if (state.phase === 'COMPLETE') { injected = true; throw Object.assign(Error('SYNTHETIC_SYNC_FAILURE'), { code: 'EIO' }); }
  }, () => run(f));
  assert.equal(injected, true); failed(result); assert.equal(result.code, 'BACKUP_ENCRYPTION_RECORD_FAILED');
  assert.equal(result.resultRecorded, false); assert.equal(result.ciphertext, 'PUBLISHED'); assert.equal(result.plaintext, 'ABSENT');
  const report = (await inspectEncryptedBackupResidues(f.staging))[0];
  assert.equal(report.incomplete, true); assert.notEqual(report.phase, 'COMPLETE');
  const job = join(f.staging, 'b4-run-' + result.requestId), names = await readdir(job);
  const pending = names.filter(name => name.endsWith('.json.pending'));
  assert.equal(pending.length, 1);
  assert.equal(JSON.parse(await readFile(join(job, pending[0]), 'utf8')).phase, 'COMPLETE');
  await assert.rejects(stat(join(job, pending[0].slice(0, -8))), { code: 'ENOENT' });
  assert.deepEqual(await readdir(result.directory), ['backup.b4']);
  await assert.rejects(run(f), { code: 'BACKUP_ENCRYPTION_RESIDUE_REQUIRES_REVIEW' });
}));

test('B4-B P2: record publication collision preserves existing legal record bytes', async () => withPipelineFixture(async f => {
  let target, existing;
  const result = await withRecordSyncHook(f, async state => {
    if (state.phase !== 'CREATING' || target) return;
    target = join(f.staging, 'b4-run-' + state.requestId, 'state-0000.json');
    existing = canonical({ ...state, code: 'BACKUP_EXISTING_RECORD' });
    await durableWrite(target, existing);
  }, () => run(f));
  failed(result); assert.equal(result.resultRecorded, false);
  assert.equal(await readFile(target, 'utf8'), existing);
  assert.equal((await inspectEncryptedBackupResidues(f.staging))[0].incomplete, true);
  await assert.rejects(run(f), { code: 'BACKUP_ENCRYPTION_RESIDUE_REQUIRES_REVIEW' });
  assert.equal(await readFile(target, 'utf8'), existing);
}));

test('B4-B P2: interrupted record publication retains pending evidence even beside COMPLETE', async () => withPipelineFixture(async f => {
  const result = await run(f); assert.equal(result.complete, true);
  const job = join(f.staging, 'b4-run-' + result.requestId), records = (await readdir(job)).filter(name => name.endsWith('.json')).sort();
  const complete = join(job, records.at(-1)), bytes = await readFile(complete);
  await link(complete, complete + '.pending');
  const report = (await inspectEncryptedBackupResidues(f.staging))[0];
  assert.equal(report.incomplete, true); assert.notEqual(report.phase, 'COMPLETE');
  await assert.rejects(run(f), { code: 'BACKUP_ENCRYPTION_RESIDUE_REQUIRES_REVIEW' });
  assert.deepEqual(await readFile(complete), bytes); assert.deepEqual(await readdir(result.directory), ['backup.b4']);
}));

test('B4-B P2: legacy COMPLETE remains preserved but cannot prove successful sync', async () => withPipelineFixture(async f => {
  const result = await run(f); assert.equal(result.complete, true);
  const artifact = await readFile(join(result.directory, 'backup.b4')), job = join(f.staging, 'b4-run-' + result.requestId);
  const records = (await readdir(job)).filter(name => name.endsWith('.json')), before = new Map();
  // Model the unchanged pre-fix writer's records only inside this owned synthetic fixture.
  for (const name of records) { const path = join(job, name), state = JSON.parse(await readFile(path, 'utf8')); state.version = 1;
    const bytes = canonical(state); await writeFile(path, bytes); before.set(path, bytes); }
  const report = (await inspectEncryptedBackupResidues(f.staging))[0];
  assert.equal(report.incomplete, true); assert.notEqual(report.phase, 'COMPLETE');
  await assert.rejects(run(f), { code: 'BACKUP_ENCRYPTION_RESIDUE_REQUIRES_REVIEW' });
  for (const [path, bytes] of before) assert.equal(await readFile(path, 'utf8'), bytes);
  assert.deepEqual(await readFile(join(result.directory, 'backup.b4')), artifact);
}));
