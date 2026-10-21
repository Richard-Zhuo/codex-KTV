// TEST SUPPORT ONLY: separately retained local state models an independent Owner custodian.
// Filesystem integrity/availability of this root is an external assumption, not production anti-rollback.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { open, readdir, readFile, lstat, realpath, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonical, digest, externalDirectory, durableWrite } from '../backup/format.js';
import { assertSyntheticBackupEncryption } from '../backup/encryption-policy.js';
import { syntheticArchiveScope, syntheticArchiveTrustId } from '../backup/archive-discovery.js';
import { verifySyntheticCheckpoint, assertCheckpointExtension, checkCheckpointPoint } from '../backup/archive-checkpoint.js';
import { acquireOperationalWriter } from '../operations/writer-lock.js';
import { windowsDirectoryAcl } from '../production/wecom-smoke-config.js';
import { validateRuntimeFileAclStructure } from '../production/runtime-config.js';

const fail = () => Object.assign(Error('SYNTHETIC_ANCHOR_REJECTED'), { code: 'SYNTHETIC_ANCHOR_REJECTED' });
const equal = (a, b) => canonical({ value: a }) === canonical({ value: b });
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
async function rootCheck(args, directory) {
  assertSyntheticBackupEncryption(args);
  const root = resolve(directory);
  if (root !== directory || await externalDirectory(root) !== root || await realpath(root) !== root) throw fail();
  const s = await lstat(root);
  if (!s.isDirectory() || s.isSymbolicLink()) throw fail();
  if (process.platform === 'win32') {
    const acl = await windowsDirectoryAcl(root); validateRuntimeFileAclStructure(acl, acl.current);
  } else if (s.uid !== process.getuid() || s.mode & 0o077) throw fail();
  return root;
}
async function readJson(root, name) {
  const path = join(root, name), s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 8192 || await realpath(path) !== path) throw fail();
  const bytes = await readFile(path);
  if (bytes.length !== s.size) throw fail();
  const value = JSON.parse(bytes.toString('utf8'));
  if (canonical(value) !== bytes.toString('utf8')) throw fail();
  return value;
}
// Initialization is an isolated test-controller operation, never a producer configuration option.
export async function initializeSyntheticCheckpointAnchor(args, { directory, bootstrap } = {}) {
  try {
    const root = await rootCheck(args, directory);
    if ((await readdir(root)).length) throw fail();
    const custodianCredential = randomBytes(32).toString('base64url'), readerCredential = randomBytes(32).toString('base64url');
    const policy = { version: 1, anchorId: randomBytes(32).toString('hex'), scope: syntheticArchiveScope(bootstrap),
      trustId: syntheticArchiveTrustId(bootstrap), custodianHash: digest(custodianCredential), readerHash: digest(readerCredential) };
    await durableWrite(join(root, 'policy.json'), canonical(policy));
    return { anchorId: policy.anchorId, custodianCredential, readerCredential };
  } catch { throw fail(); }
}
export async function openSyntheticCheckpointAnchor(args, { directory, bootstrap, anchorId, credential, reader,
  timeoutMs = 5000, fault = async () => {} } = {}) {
  try {
    const scope = syntheticArchiveScope(bootstrap), trustId = syntheticArchiveTrustId(bootstrap);
    if (!hash(anchorId) || typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential)) throw fail();
    const credentialHash = digest(credential);
    const root = await rootCheck(args, directory);
    async function admit(requestScope, write = false) {
      await rootCheck(args, root);
      if (!equal(requestScope, scope)) throw fail();
      const p = await readJson(root, 'policy.json');
      if (Object.keys(p).sort().join(',') !== 'anchorId,custodianHash,readerHash,scope,trustId,version' ||
          p.version !== 1 || p.anchorId !== anchorId || p.trustId !== trustId || !equal(p.scope, scope) ||
          !hash(p.custodianHash) || !hash(p.readerHash) || p.custodianHash === p.readerHash) throw fail();
      const matches = h => timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(credentialHash, 'hex'));
      if (!(matches(p.custodianHash) || !write && matches(p.readerHash))) throw fail();
    }
    async function latest(requestScope) {
      await admit(requestScope);
      await fault('beforeRead');
      const names = await readdir(root);
      if (names.length > 4098 || names.some(n => n !== 'policy.json' && n !== 'operational-writer.lock' && !/^commit-[0-9]{6}\.json$/.test(n))) throw fail();
      const commits = names.filter(n => n.startsWith('commit-')).sort();
      let previous = null;
      for (let i = 0; i < commits.length; i++) {
        if (commits[i] !== 'commit-' + String(i + 1).padStart(6, '0') + '.json') throw fail();
        const record = await readJson(root, commits[i]);
        if (Object.keys(record).sort().join(',') !== 'anchorId,point,scope,version' || record.version !== 1 ||
            record.anchorId !== anchorId || !equal(record.scope, scope)) throw fail();
        checkCheckpointPoint(record.point, scope);
        if (record.point.sequence !== i + 1 || record.point.previous !== (previous?.locator.version ?? null)) throw fail();
        previous = record.point;
      }
      await fault('afterRead');
      return structuredClone(previous);
    }
    await admit(scope);
    return Object.freeze({
      async getLatest(requestScope) {
        try { return await latest(requestScope); } catch { throw fail(); }
      },
      async compareAndSet(requestScope, expected, next) {
        let release;
        try {
          requestScope = structuredClone(requestScope); expected = structuredClone(expected); next = structuredClone(next);
          await admit(requestScope, true);
          // Reuse existing process ownership; overlapping processes reject instead of inventing a distributed lock.
          release = await acquireOperationalWriter(root, digest(canonical({ anchorId, scope })));
          const current = await latest(requestScope);
          checkCheckpointPoint(next, scope);
          // Unknown-result retries may confirm exactly the previously committed value, never a rollback.
          if (equal(current, next)) {
            if (expected !== null) checkCheckpointPoint(expected, scope);
            if (next.sequence !== (expected?.sequence ?? 0) + 1 || next.previous !== (expected?.locator.version ?? null)) throw fail();
            await verifySyntheticCheckpoint(args, { bootstrap, reader, point: next, timeoutMs });
            return { code: 'CONFIRMED' };
          }
          if (!equal(current, expected) || next.sequence !== (current?.sequence ?? 0) + 1 ||
              next.previous !== (current?.locator.version ?? null) || next.sequence > 4096) throw fail();
          const previous = current ? await verifySyntheticCheckpoint(args, { bootstrap, reader, point: current, timeoutMs }) : null;
          const verified = await verifySyntheticCheckpoint(args, { bootstrap, reader, point: next, timeoutMs });
          assertCheckpointExtension(previous, verified);
          await admit(requestScope, true);
          const pending = join(root, 'pending-' + randomUUID());
          const target = join(root, 'commit-' + String(next.sequence).padStart(6, '0') + '.json');
          // Final records become visible only after their bytes have synced and closed.
          const handle = await open(pending, 'wx', 0o600);
          try {
            await handle.writeFile(canonical({ version: 1, anchorId, scope, point: structuredClone(next) }));
            await fault('beforeRecordSync'); await handle.sync();
          } finally { await handle.close(); }
          await fault('beforeCommit');
          await link(pending, target); // exclusive: never replace any existing commit
          const s = await lstat(pending);
          if (!s.isFile() || s.isSymbolicLink() || await realpath(pending) !== pending) throw fail();
          await unlink(pending); // only our temporary link, never recovery materials
          await fault('afterCommit');
          if (!equal(await latest(requestScope), next)) throw fail();
          return { code: 'CONFIRMED' };
        } catch { throw fail(); }
        finally {
          try { await release?.(); } catch { throw fail(); }
        }
      }
    });
  } catch { throw fail(); }
}
