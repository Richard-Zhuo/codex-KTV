// Public offline trust handoff only; no locatorFile, original state, cache or private material.
import { loadSyntheticArchiveBootstrap, discoverSyntheticArchives } from '../backup/archive-discovery.js';
import { createSyntheticArchiveDirectory } from './synthetic-archive-directory.js';
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const bootstrap = await loadSyntheticArchiveBootstrap(input.args, input.offlineTrust);
  const remote = await createSyntheticArchiveDirectory(input.args, input.remoteRoot);
  const result = await discoverSyntheticArchives(input.args, { bootstrap, reader: remote.reader, enumerator: remote.enumerator });
  process.stdout.write(JSON.stringify({ code: result.code, entries: result.entries.map(e => ({
    unitId: e.completion.unitId, backupId: e.completion.backupId, checksum: e.completion.binding.checksum })),
    directoryCompleteness: result.directoryCompleteness, rollbackProtection: result.rollbackProtection,
    readyForSlotRelease: result.readyForSlotRelease }));
} catch { process.stderr.write('ARCHIVE_DISCOVERY_REJECTED'); process.exitCode = 1; }
