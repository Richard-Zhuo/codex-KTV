import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createCipheriv } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, stat, rename } from 'node:fs/promises';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { protectActivationPath } from '../production/activation-receipt.js';
import { windowsDirectoryAcl } from '../production/wecom-smoke-config.js';
async function protectTestParent(path) {
  if (process.platform === 'win32') await protectActivationPath(path, (await windowsDirectoryAcl(path)).current, true);
}
import { canonical, digest, schemaSpec, verifyArtifact, durableWrite } from './format.js';
import { encryptArtifact, withDecryptedArtifact } from './encryption.js';

const keyId = 'synthetic-portable-key-v1';
const files = ['manifest.json', 'data.json', 'manifest.sha256'];
async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), 'ktv-b4-unit-'));
  const key = randomBytes(32), marker = 'SYNTHETIC-PRIVATE-' + randomUUID();
  const provider = { async resolve(request) { return request.keyId === keyId ? { keyId, key } : null; } };
  try {
    await protectTestParent(root);
    const directory = join(root, 'source'); await mkdir(directory);
    const spec = await schemaSpec(), tables = Object.fromEntries(spec.tables.map(name => [name, { columns: ['synthetic'], rows: [] }]));
    const stateChecksum = digest(marker);
    tables.ledger_heads = { columns: ['ledger_id', 'revision', 'state_checksum', 'state_json'], rows: [['synthetic-ledger', 7, stateChecksum, marker]] };
    tables.production_bootstrap_events = { columns: ['store_id', 'ledger_id', 'environment'], rows: [['synthetic-store', 'synthetic-ledger', 'test']] };
    const data = Buffer.from(canonical({ backupFormatVersion: 1, tables }));
    const manifest = Buffer.from(canonical({ backupFormatVersion: 1, backupId: randomUUID(), createdAt: '2026-10-20T12:00:00.000000Z',
      engine: 'InnoDB', mysqlVersion: '8.4.11', schema: spec.manifest, migrationVersion: Object.keys(spec.manifest.migrations).at(-1),
      storeId: 'synthetic-store', ledgerId: 'synthetic-ledger', applicationCommit: '4f2bf25a7d13088069a006559f33f749d95e7108',
      source: { environment: 'test', database: 'synthetic_test', serverUuid: randomUUID() },
      ledgerHeads: [{ ledgerId: 'synthetic-ledger', revision: 7, checksum: stateChecksum }], dataBytes: data.length, dataChecksum: digest(data) }));
    const expectedChecksum = digest(manifest), bytes = [manifest, data, Buffer.from(expectedChecksum + '\n')];
    for (let i = 0; i < files.length; i++) await durableWrite(join(directory, files[i]), bytes[i]);
    const identity = { expectedChecksum, storeId: 'synthetic-store', ledgerId: 'synthetic-ledger' };
    const seal = { directory, ...identity, keyId, keyProvider: provider };
    const open = { ...identity, expectedKeyId: keyId, keyProvider: provider, temporaryParent: root };
    await work({ root, key, marker, provider, directory, identity, seal, open, bytes });
  } finally {
    key.fill(0);
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('ktv-b4-unit-'));
    await rm(root, { recursive: true, force: true });
  }
}
function headerOf(envelope) { return JSON.parse(envelope.subarray(12, 12 + envelope.readUInt32BE(8)).toString()); }
function replaceHeader(envelope, change) {
  const header = headerOf(envelope); change(header);
  const bytes = Buffer.from(canonical(header)), length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  return Buffer.concat([envelope.subarray(0, 8), length, bytes, envelope.subarray(12 + envelope.readUInt32BE(8))]);
}
async function rejected(f, envelope, options = {}, code) {
  let called = false;
  await assert.rejects(withDecryptedArtifact({ ...f.open, envelope, ...options }, () => { called = true; }), error => {
    assert.match(error.code, /^B4_[A-Z0-9_]+$/); assert.equal(error.message, error.code);
    assert.equal(error.cause, undefined); assert.ok(!error.message.includes(f.marker));
    if (code) assert.equal(error.code, code); return true;
  });
  assert.equal(called, false);
  assert.deepEqual((await readdir(f.root)).filter(name => name.startsWith('b4-auth-')), []);
}

test('B4-A: format1 exact bytes survive encrypted file roundtrip and original verification, without plaintext/key in envelope', async () => fixture(async f => {
  await verifyArtifact(f.directory, f.identity);
  const keyBefore = Buffer.from(f.key), envelope = await encryptArtifact(f.seal);
  assert.equal(envelope.includes(Buffer.from(f.marker)), false);
  assert.equal(envelope.includes(f.key), false); assert.equal(envelope.includes(Buffer.from(f.key.toString('hex'))), false);
  assert.deepEqual(Object.keys(headerOf(envelope)).sort(), ['algorithm', 'envelopeVersion', 'keyId', 'nonce']);
  const encryptedFile = join(f.root, 'backup.b4'); await durableWrite(encryptedFile, envelope);
  let borrowed;
  const result = await withDecryptedArtifact({ ...f.open, envelope: await readFile(encryptedFile) }, async ({ directory, checksum }) => {
    borrowed = directory; const verified = await verifyArtifact(directory, f.identity);
    assert.equal(checksum, f.identity.expectedChecksum); assert.equal(verified.manifest.backupFormatVersion, 1);
    for (let i = 0; i < files.length; i++) assert.deepEqual(await readFile(join(directory, files[i])), f.bytes[i]);
    return { code: 'SYNTHETIC_FORMAT1_VERIFIED' };
  });
  assert.deepEqual(result, { code: 'SYNTHETIC_FORMAT1_VERIFIED' });
  await assert.rejects(stat(borrowed), { code: 'ENOENT' });
  assert.deepEqual(f.key, keyBefore); await verifyArtifact(f.directory, f.identity);
}));

test('B4-A: repeated identical plaintext uses fresh random nonces and distinct ciphertext', async () => fixture(async f => {
  const nonces = new Set(), ciphertexts = new Set();
  for (let i = 0; i < 24; i++) { const envelope = await encryptArtifact(f.seal); nonces.add(headerOf(envelope).nonce); ciphertexts.add(digest(envelope)); }
  assert.equal(nonces.size, 24); assert.equal(ciphertexts.size, 24);
}));

test('B4-A: wrong key is rejected before any staging directory or callback exists', async () => fixture(async f => {
  const envelope = await encryptArtifact(f.seal), wrongKey = randomBytes(32);
  try { await rejected(f, envelope, { keyProvider: { resolve: () => ({ keyId, key: wrongKey }) } }, 'B4_AUTHENTICATION_FAILED'); }
  finally { wrongKey.fill(0); }
}));

const corruptions = {
  ciphertext: e => { const b = Buffer.from(e); b[12 + b.readUInt32BE(8)] ^= 1; return b; },
  tag: e => { const b = Buffer.from(e); b[b.length - 1] ^= 1; return b; },
  nonce: e => replaceHeader(e, h => { h.nonce = Buffer.alloc(12).toString('base64'); }),
  version: e => replaceHeader(e, h => { h.envelopeVersion = 2; }),
  algorithm: e => replaceHeader(e, h => { h.algorithm = 'aes-256-cbc'; }),
  keyId: e => replaceHeader(e, h => { h.keyId = 'other-key'; }),
  unknownMetadata: e => replaceHeader(e, h => { h.extra = 'untrusted'; }),
  invalidNonce: e => replaceHeader(e, h => { h.nonce = '!'.repeat(16); }),
  magic: e => { const b = Buffer.from(e); b[0] ^= 1; return b; },
  headerLength: e => { const b = Buffer.from(e); b.writeUInt32BE(0xffffffff, 8); return b; },
  truncatedHeader: e => e.subarray(0, 15),
  truncatedCiphertext: e => e.subarray(0, -40),
  truncatedTag: e => e.subarray(0, -1),
  trailingBytes: e => Buffer.concat([e, Buffer.from('junk')]),
  empty: () => Buffer.alloc(0)
};
for (const [name, corrupt] of Object.entries(corruptions)) {
  test('B4-A: reject ' + name + ' corruption without releasing plaintext', async () => fixture(async f => {
    await rejected(f, corrupt(await encryptArtifact(f.seal)));
  }));
}

test('B4-A: renamed key metadata still fails authentication even if provider authorizes the same bytes under both IDs', async () => fixture(async f => {
  const envelope = replaceHeader(await encryptArtifact(f.seal), h => { h.keyId = 'other-key'; });
  await rejected(f, envelope, { expectedKeyId: 'other-key', keyProvider: { resolve: () => ({ keyId: 'other-key', key: f.key }) } }, 'B4_AUTHENTICATION_FAILED');
}));

for (const [name, provider, code] of [
  ['missing', null, 'B4_KEY_UNAVAILABLE'],
  ['unknown', { resolve: () => null }, 'B4_KEY_UNAVAILABLE'],
  ['wrong ID', { resolve: () => ({ keyId: 'other-key', key: randomBytes(32) }) }, 'B4_KEY_ID_MISMATCH'],
  ['short key', { resolve: () => ({ keyId, key: randomBytes(16) }) }, 'B4_KEY_INVALID'],
  ['string key', { resolve: () => ({ keyId, key: 'not-a-binary-key' }) }, 'B4_KEY_INVALID']
]) {
  test('B4-A: reject ' + name + ' key provider on encryption and decryption', async () => fixture(async f => {
    const envelope = await encryptArtifact(f.seal);
    await assert.rejects(encryptArtifact({ ...f.seal, keyProvider: provider }), { code });
    await rejected(f, envelope, { keyProvider: provider }, code);
  }));
}

test('B4-A: expected key identifier must be explicit and valid', async () => fixture(async f => {
  const envelope = await encryptArtifact(f.seal);
  for (const expectedKeyId of [undefined, '', '../key', 'x'.repeat(65)]) await rejected(f, envelope, { expectedKeyId }, 'B4_KEY_ID_INVALID');
  await rejected(f, envelope, { expectedKeyId: 'different-key' }, 'B4_KEY_ID_MISMATCH');
}));

test('B4-A: authenticated but invalid format1 never reaches consumer; original checksum and store checks remain required', async () => fixture(async f => {
  const envelope = await encryptArtifact(f.seal);
  await rejected(f, envelope, { expectedChecksum: '0'.repeat(64) }, 'B4_FORMAT1_REJECTED');
  await rejected(f, envelope, { storeId: 'different-store' }, 'B4_FORMAT1_REJECTED');
  const forgedHeader = replaceHeader(envelope, h => { h.nonce = randomBytes(12).toString('base64'); });
  const end = 12 + forgedHeader.readUInt32BE(8), aad = forgedHeader.subarray(0, end);
  const cipher = createCipheriv('aes-256-gcm', f.key, Buffer.from(headerOf(forgedHeader).nonce, 'base64'), { authTagLength: 16 });
  cipher.setAAD(aad);
  // An authorized key holder can authenticate nonsense; framing/format1 must still refuse it.
  const invalid = Buffer.concat([aad, cipher.update(Buffer.from('invalid format1')), cipher.final(), cipher.getAuthTag()]);
  await rejected(f, invalid, {}, 'B4_PAYLOAD_INVALID');
}));

test('B4-A: malformed source is refused before key resolution; unencrypted format1 validation is unchanged', async () => fixture(async f => {
  await verifyArtifact(f.directory, f.identity);
  await writeFile(join(f.directory, 'data.json'), 'truncated');
  let calls = 0;
  await assert.rejects(encryptArtifact({ ...f.seal, keyProvider: { resolve() { calls++; return { keyId, key: f.key }; } } }), { code: 'B4_FORMAT1_REJECTED' });
  assert.equal(calls, 0);
  await assert.rejects(verifyArtifact(f.directory, f.identity), { code: 'BACKUP_CHECKSUM_MISMATCH' });
}));

test('B4-A: provider and consumer failures expose fixed codes only, never success or sensitive causes', async () => fixture(async f => {
  const secretError = () => { throw new Error(f.marker + f.key.toString('hex')); };
  await assert.rejects(encryptArtifact({ ...f.seal, keyProvider: { resolve: secretError } }), error => error.code === 'B4_KEY_UNAVAILABLE' && error.message === error.code && !error.cause);
  const envelope = await encryptArtifact(f.seal);
  await rejected(f, envelope, { keyProvider: { resolve: secretError } }, 'B4_KEY_UNAVAILABLE');
  await assert.rejects(withDecryptedArtifact({ ...f.open, envelope }, secretError), error => error.code === 'B4_CONSUMER_FAILED' && error.message === error.code && !error.cause);
  assert.deepEqual((await readdir(f.root)).filter(name => name.startsWith('b4-auth-')), []);
}));

test('B4-A: independent process/environment decrypts a transported file with the same authorized key, without host-bound secrets', async () => fixture(async f => {
  const envelope = await encryptArtifact(f.seal), other = join(f.root, 'other-server'); await mkdir(other); await protectTestParent(other);
  const transported = join(other, 'transported.b4'); await durableWrite(transported, envelope);
  const childSource = "import {withDecryptedArtifact} from " + JSON.stringify(new URL('./encryption.js', import.meta.url).href) + ";import {readFile} from 'node:fs/promises';let input='';for await(const c of process.stdin)input+=c;let key;try{const p=JSON.parse(input);key=Buffer.from(p.key,'base64');const result=await withDecryptedArtifact({...p.identity,envelope:await readFile(p.file),expectedKeyId:p.keyId,temporaryParent:p.parent,keyProvider:{resolve:()=>({keyId:p.keyId,key})}},async value=>({code:'SYNTHETIC_OTHER_SERVER_VERIFIED',checksum:value.checksum}));process.stdout.write(JSON.stringify(result));}catch{process.stderr.write('SYNTHETIC_CHILD_FAILED');process.exitCode=1;}finally{key?.fill(0);}";
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], { cwd: other, windowsHide: true,
    env: { ...process.env, COMPUTERNAME: 'SYNTHETIC-OTHER-SERVER' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  child.stdin.end(JSON.stringify({ key: f.key.toString('base64'), identity: f.identity, file: transported, parent: other, keyId }));
  const [code] = await once(child, 'exit'); assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { code: 'SYNTHETIC_OTHER_SERVER_VERIFIED', checksum: f.identity.expectedChecksum });
  assert.equal(stdout.includes(f.key.toString('base64')), false); assert.equal(stderr, '');
  assert.deepEqual((await readdir(other)).sort(), ['transported.b4']);
}));


test('B4-A: authenticated future format1 schema is still rejected by the original verifier', async () => fixture(async f => {
  const source = await encryptArtifact(f.seal), header = headerOf(source);
  header.nonce = randomBytes(12).toString('base64');
  const metadata = Buffer.from(canonical(header)), size = Buffer.alloc(4); size.writeUInt32BE(metadata.length);
  const aad = Buffer.concat([source.subarray(0, 8), size, metadata]);
  const manifest = JSON.parse(f.bytes[0]); manifest.backupFormatVersion = 999;
  const mb = Buffer.from(canonical(manifest)), checksum = digest(mb);
  const payload = Buffer.concat([mb, f.bytes[1], Buffer.from(checksum + '\n')].flatMap(bytes => {
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); return [length, bytes];
  }));
  const cipher = createCipheriv('aes-256-gcm', f.key, Buffer.from(header.nonce, 'base64'), { authTagLength: 16 }); cipher.setAAD(aad);
  const envelope = Buffer.concat([aad, cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  await rejected(f, envelope, { expectedChecksum: checksum }, 'B4_FORMAT1_REJECTED');
}));

test('B4-A: truncated ciphertext file fails authentication and leaves its original backup intact', async () => fixture(async f => {
  const envelope = await encryptArtifact(f.seal), file = join(f.root, 'damaged.b4');
  await durableWrite(file, envelope.subarray(0, -1));
  await rejected(f, await readFile(file), {}, 'B4_AUTHENTICATION_FAILED');
  await verifyArtifact(f.directory, f.identity);
}));

test('B4-A: duplicate metadata keys are rejected rather than ambiguously authenticated', async () => fixture(async f => {
  const envelope = await encryptArtifact(f.seal), oldSize = envelope.readUInt32BE(8);
  const json = envelope.subarray(12, 12 + oldSize).toString('utf8');
  const duplicate = Buffer.from(json.replace('{', '{"envelopeVersion":1,'));
  const length = Buffer.alloc(4); length.writeUInt32BE(duplicate.length);
  await rejected(f, Buffer.concat([envelope.subarray(0, 8), length, duplicate, envelope.subarray(12 + oldSize)]), {}, 'B4_ENVELOPE_INVALID');
}));

test('B4-A: cleanup failure cannot return a false success or delete an unexpected replacement', async () => fixture(async f => {
  const envelope = await encryptArtifact(f.seal), moved = join(f.root, 'moved-authenticated-stage');
  await assert.rejects(withDecryptedArtifact({ ...f.open, envelope }, async ({ directory }) => {
    await rename(directory, moved); return { code: 'WOULD_BE_FALSE_SUCCESS' };
  }), { code: 'B4_CLEANUP_FAILED' });
  assert.ok((await stat(moved)).isDirectory()); await verifyArtifact(f.directory, f.identity);
}));


test('B4-A: an unprotected caller staging parent is refused without leaving plaintext', async () => fixture(async f => {
  const parent = join(f.root, 'unprotected-parent'); await mkdir(parent);
  if (process.platform !== 'win32') {
    const { chmod } = await import('node:fs/promises'); await chmod(parent, 0o777);
  }
  await rejected(f, await encryptArtifact(f.seal), { temporaryParent: parent }, 'B4_STAGE_FAILED');
  assert.deepEqual(await readdir(parent), []);
}));
