// Dedicated synthetic entry. Never imported by a production bootstrap; never accepts an injected store.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { canonical, digest, durableWrite, externalDirectory } from '../backup/format.js';
import { assertSyntheticBackupEncryption } from '../backup/encryption-policy.js';
import { isProductionEnvironment } from '../shared/deployment-environment.js';
import { createOperationalStore } from '../operations/store.js';
import { acquireOperationalWriter } from '../operations/writer-lock.js';
import { syntheticArchiveScope, syntheticArchiveTrustId, discoverSyntheticArchives } from '../backup/archive-discovery.js';
import { publishSyntheticCheckpoint, recoverSyntheticCheckpoint, checkpointDeadline } from '../backup/archive-checkpoint.js';
import { retrieveSyntheticOffsiteUnit } from '../backup/offsite-unit.js';
import { protectPipelineTestDirectory } from './encrypted-pipeline-fixture.js';
import { windowsDirectoryAcl } from '../production/wecom-smoke-config.js';
import { validateRuntimeFileAclStructure } from '../production/runtime-config.js';

const sessions = new WeakMap();
const equal = (a, b) => canonical({ value: a }) === canonical({ value: b });
const fail = () => Object.assign(Error('SYNTHETIC_HANDOFF_REJECTED'), { code: 'SYNTHETIC_HANDOFF_REJECTED' });
function contextCheck(context) {
  if (!context || Object.keys(context).some(k => !['bootstrap', 'reader', 'writer', 'anchor', 'issuer'].includes(k))) throw fail();
  syntheticArchiveScope(context.bootstrap);
}
function admit(args) {
  // Do not allow args.env to hide a production host. No environment flag can brand a real store.
  if (isProductionEnvironment(process.env)) throw fail();
  assertSyntheticBackupEncryption(args);
}
async function checkRoot(args, root) {
  admit(args);
  if (typeof root !== 'string' || root !== resolve(root) || dirname(root) !== await realpath(tmpdir()) ||
      !/^ktv-b3a2-[A-Za-z0-9_-]+$/.test(basename(root)) || await externalDirectory(root) !== root || await realpath(root) !== root) throw fail();
  if ((await lstat(root)).isSymbolicLink()) throw fail();
  if (process.platform === 'win32') {
    const acl = await windowsDirectoryAcl(root); validateRuntimeFileAclStructure(acl, acl.current);
  } else { const s = await lstat(root); if (s.uid !== process.getuid() || s.mode & 0o077) throw fail(); }
}
async function marker(root) {
  const path = join(root, 'synthetic-handoff.json'), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2048 || await realpath(path) !== path) throw fail();
  const bytes = await readFile(path), value = JSON.parse(bytes.toString('utf8'));
  if (canonical(value) !== bytes.toString('utf8') || Object.keys(value).sort().join(',') !== 'archiveScope,archiveTrustId,scope,tokenHash,version' ||
      value.version !== 1 || !/^synthetic-handoff-[a-f0-9-]{36}$/.test(value.scope) || !/^[a-f0-9]{64}$/.test(value.tokenHash)) throw fail();
  return value;
}
export async function createSyntheticHandoffStore(args, context, options = {}) {
  let root;
  try {
    admit(args); contextCheck(context);
    root = await mkdtemp(join(await realpath(tmpdir()), 'ktv-b3a2-'));
    await protectPipelineTestDirectory(root);
    const token = randomBytes(32).toString('base64url');
    await durableWrite(join(root, 'synthetic-handoff.json'), canonical({ version: 1,
      scope: 'synthetic-handoff-' + randomUUID(), tokenHash: digest(token),
      archiveScope: syntheticArchiveScope(context.bootstrap), archiveTrustId: syntheticArchiveTrustId(context.bootstrap) }));
    return await openSyntheticHandoffStore(args, { root, token }, context, options);
  } catch { throw fail(); }
}
// Reopen only a separately retained, randomly scoped synthetic fixture; never adopt production state.
export async function openSyntheticHandoffStore(args, descriptor, context, { fault = async () => {} } = {}) {
  let release;
  try {
    contextCheck(context);
    const { root, token } = descriptor ?? {};
    await checkRoot(args, root);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw fail();
    const m = await marker(root);
    if (!timingSafeEqual(Buffer.from(m.tokenHash, 'hex'), Buffer.from(digest(token), 'hex'))) throw fail();
    const scope = syntheticArchiveScope(context.bootstrap);
    if (scope.storeId !== args.storeId || scope.ledgerId !== args.ledgerId || !equal(scope, m.archiveScope) ||
        syntheticArchiveTrustId(context.bootstrap) !== m.archiveTrustId) throw fail();
    release = await acquireOperationalWriter(root, m.scope);
    const base = await createOperationalStore(root, m.scope, {
      prepareTemporary: async () => { await checkRoot(args, root); await fault('beforeStateWrite'); },
      verifyState: async () => { await checkRoot(args, root); await fault('afterStateReplace'); }
    });
    const info = { args: structuredClone(args), root, marker: m, base, context, fault, scope,
      closed: false, uncertain: false, cache: null, members: new Map(), serial: Promise.resolve() };
    const check = async () => {
      if (info.closed || info.closing) throw fail();
      await checkRoot(info.args, root);
      if (!equal(await marker(root), m) || syntheticArchiveTrustId(context.bootstrap) !== m.archiveTrustId ||
          !equal(syntheticArchiveScope(context.bootstrap), m.archiveScope)) throw fail();
    };
    const update = async work => {
      await check();
      let prepared = false;
      try { return await base.update(async s => { const result = await work(s); prepared = true; return result; }); }
      catch (error) {
        if (prepared) info.uncertain = true;
        if (!prepared && ['OFFSITE_REFERENCE_LIMIT', 'OFFSITE_HANDOFF_FENCED'].includes(error?.code))
          throw Object.assign(Error(error.code), { code: error.code });
        throw fail();
      }
    };
    const refresh = async (full = false) => {
      await check();
      const point = await checkpointDeadline(() => context.anchor.getLatest(scope), 30000);
      if (!equal(point, info.cache) || full) {
        if (point) {
          const verified = await recoverSyntheticCheckpoint(info.args, { ...context, timeoutMs: 30000 });
          // A1 verified these exact bytes; recover the signed reference sizes without changing its result contract.
          const ref = verified.point.locator;
          const exact = await checkpointDeadline(() => context.reader.getExact({ ...ref }), 30000);
          if (exact?.objectId !== ref.objectId || exact.version !== ref.version || !Buffer.isBuffer(exact.bytes) ||
              exact.bytes.length !== ref.size || digest(exact.bytes) !== ref.version) throw fail();
          const references = new Map(JSON.parse(exact.bytes.toString('utf8')).payload.entries.map(e => [e.unitId, e]));
          info.cache = structuredClone(verified.point);
          info.members = new Map(verified.entries.map(e => [e.completion.unitId,
            { ...e, archive: structuredClone(references.get(e.completion.unitId)) }]));
        } else { info.cache = null; info.members = new Map(); }
      }
      const handoffs = base.read().observations.offsite?.handoffs ?? {};
      for (const [id, h] of Object.entries(handoffs)) {
        if (h.checkpoint && (!info.cache || info.cache.sequence < h.checkpoint.sequence ||
            info.cache.sequence === h.checkpoint.sequence && !equal(info.cache, h.checkpoint))) throw fail();
        if (h.phase === 'RELEASED' || h.phase === 'CHECKPOINT_CONFIRMED') {
          const entry = info.members.get(id);
          if (!entry || !equal(h.archive, entry.archive)) throw fail();
        }
      }
    };
    info.check = check; info.update = update; info.refresh = refresh;
    const capability = Object.freeze({ type: 'synthetic-handoff' });
    sessions.set(capability, info);
    const store = Object.freeze({
      read: () => base.read(),
      async update(work) {
        await check(); if (info.uncertain) throw fail();
        await refresh();
        return update(async s => {
          const before = structuredClone(s), proposed = structuredClone(s); const value = await work(proposed);
          const a = before.observations.offsite ?? { attempts: {} }, b = proposed.observations.offsite;
          if (!b || !equal(a.handoffs ?? {}, b.handoffs ?? {}) ||
              Object.keys(a.attempts).some(id => !Object.hasOwn(b.attempts, id)) || Object.keys(b.attempts).length > 128 ||
              Object.keys(b.attempts).some(id => info.members.has(id) && !equal(b.attempts[id], a.attempts[id]))) throw fail();
          const outside = v => { const copy = structuredClone(v); delete copy.observations.offsite; return copy; };
          if (!equal(outside(before), outside(proposed))) throw fail();
          // Do not let a retained callback object mutate the store after the checks/persistence.
          s.observations.offsite = structuredClone(b);
          return value;
        });
      }
    });
    const session = Object.freeze({ capability, store, descriptor: Object.freeze({ root, token }),
      reconcile() {
        const work = info.serial.then(async () => {
          try {
            await check(); await base.reload(); await refresh(true);
            validateReceipts(base.read()); info.uncertain = false;
          } catch { throw fail(); }
        });
        info.serial = work.catch(() => {}); return work;
      },
      close() {
        if (info.closePromise) return info.closePromise;
        info.closing = true;
        info.closePromise = (async () => {
          await info.serial; await base.flush(); info.closed = true;
          try { await release?.(); release = null; } catch { throw fail(); }
        })();
        return info.closePromise;
      } });
    await session.reconcile();
    return session;
  } catch { try { await release?.(); } catch {} throw fail(); }
}
function validateReceipts(s) {
  const state = s.observations.offsite;
  if (!state) return;
  if (Object.keys(state.attempts).length > 128 || Object.keys(state.handoffs ?? {}).length > 512) throw fail();
  for (const [id, h] of Object.entries(state.handoffs ?? {})) {
    if (h.version !== 1 || !['INTENT', 'ARCHIVE_VERIFIED', 'CHECKPOINT_CONFIRMED', 'RELEASED'].includes(h.phase) ||
        h.fact?.unitId !== id || h.phase === 'RELEASED' && (!h.archive || !h.checkpoint || Object.hasOwn(state.attempts, id)) ||
        h.phase !== 'RELEASED' && !equal(state.attempts[id], h.fact)) throw fail();
  }
}
function bound(fact, unit) {
  const c = unit.completion;
  if (fact.status !== 'OFFSITE_VERIFIED' || !fact.verifiedLocator || !equal(fact.locator, fact.verifiedLocator) ||
      !equal(fact.candidateLocator, fact.verifiedLocator) || !equal(c.objects, fact.objects) ||
      c.unitId !== fact.unitId || c.backupId !== fact.backupId || c.snapshotNotBefore !== fact.snapshotNotBefore) throw fail();
}
export async function handoffSyntheticUnit(capability, unitId) {
  const info = sessions.get(capability);
  if (!info) throw fail();
  const work = info.serial.then(async () => {
    try {
      await info.check(); if (info.uncertain) throw fail();
      if (typeof unitId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(unitId)) throw fail();
      await info.refresh(true);
      let h = info.base.read().observations.offsite?.handoffs?.[unitId];
      if (h?.phase === 'RELEASED') {
        validateReceipts(info.base.read());
        return Object.freeze({ code: 'SYNTHETIC_HANDOFF_RELEASED', unitId, alreadyReleased: true, physicalDeletion: false });
      }
      if (!h) {
        const fact = info.base.read().observations.offsite?.attempts?.[unitId];
        if (!fact || fact.status !== 'OFFSITE_VERIFIED' || !fact.verifiedLocator) throw fail();
        const unit = await retrieveSyntheticOffsiteUnit(info.args, { reader: info.context.reader, locator: fact.verifiedLocator });
        bound(fact, unit);
        await info.update(s => {
          const state = s.observations.offsite;
          if (!equal(state.attempts[unitId], fact) || Object.keys(state.handoffs ?? {}).length >= 512) throw fail();
          (state.handoffs ??= {})[unitId] = { version: 1, phase: 'INTENT', fact: structuredClone(fact), archive: null, checkpoint: null };
        });
        await info.fault('afterIntent');
        h = info.base.read().observations.offsite.handoffs[unitId];
      }
      const unit = await retrieveSyntheticOffsiteUnit(info.args, { reader: info.context.reader, locator: h.fact.verifiedLocator });
      bound(h.fact, unit);
      let archive = h.archive;
      if (!archive) {
        const signed = info.context.issuer.issue({ locator: h.fact.verifiedLocator, completion: unit.completion });
        archive = { unitId, objectId: signed.objectId, version: digest(signed.bytes), size: signed.bytes.length };
        const ack = await checkpointDeadline(() => info.context.writer.putIfAbsent(signed), 30000);
        if (ack?.objectId !== archive.objectId || ack.version !== archive.version) throw fail();
      }
      const { unitId: _id, ...ref } = archive;
      const verified = await discoverSyntheticArchives(info.args, { ...info.context,
        enumerator: { listPage: async () => ({ status: 'OK', entries: [ref], nextCursor: null }) } });
      if (verified.entries[0]?.completion.unitId !== unitId) throw fail();
      await info.update(s => {
        const current = s.observations.offsite.handoffs[unitId];
        if (!equal(current.fact, h.fact) || current.archive && !equal(current.archive, archive)) throw fail();
        Object.assign(current, { phase: 'ARCHIVE_VERIFIED', archive });
      });
      await info.fault('afterArchive');
      await publishSyntheticCheckpoint(info.args, { ...info.context, entries: [archive], timeoutMs: 30000 });
      await info.fault('afterCheckpoint');
      await info.refresh(true);
      const member = info.members.get(unitId);
      if (!member || member.objectId !== archive.objectId || member.version !== archive.version || !equal(member.completion, unit.completion)) throw fail();
      const checkpoint = structuredClone(info.cache);
      await info.update(s => Object.assign(s.observations.offsite.handoffs[unitId], { phase: 'CHECKPOINT_CONFIRMED', archive, checkpoint }));
      await info.fault('beforeRelease');
      await info.refresh(true);
      await info.update(s => {
        const state = s.observations.offsite, current = state.handoffs[unitId];
        if (current.phase !== 'CHECKPOINT_CONFIRMED' || !equal(current.fact, state.attempts[unitId]) ||
            !equal(current.archive, archive) || !equal(current.checkpoint, checkpoint)) throw fail();
        // Only this privately branded, independently verified receipt can authorize removing one active reference.
        delete state.attempts[unitId]; current.phase = 'RELEASED';
        validateReceipts(s);
      });
      await info.fault('afterRelease');
      return Object.freeze({ code: 'SYNTHETIC_HANDOFF_RELEASED', unitId, alreadyReleased: false, physicalDeletion: false });
    } catch { return Object.freeze({ code: 'SYNTHETIC_HANDOFF_UNCONFIRMED', unitId: typeof unitId === 'string' ? unitId : null }); }
  });
  info.serial = work.catch(() => {}); return work;
}
