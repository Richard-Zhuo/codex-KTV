// Isolated recovery: public trust, separately retained anchor credentials and remote only; stdin, never argv.
import { loadSyntheticArchiveBootstrap, syntheticArchiveScope } from '../backup/archive-discovery.js';
import { recoverSyntheticCheckpoint } from '../backup/archive-checkpoint.js';
import { createSyntheticArchiveDirectory } from './synthetic-archive-directory.js';
import { openSyntheticCheckpointAnchor } from './synthetic-checkpoint-anchor.js';
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const bootstrap = await loadSyntheticArchiveBootstrap(input.args, input.offlineTrust);
  const { reader } = await createSyntheticArchiveDirectory(input.args, input.remoteRoot);
  const anchor = await openSyntheticCheckpointAnchor(input.args, { ...input.anchor, bootstrap, reader,
    fault: async phase => { if (input.action === 'crash-beforeCommit' && phase === 'beforeCommit') process.exit(77); } });
  if (input.action === 'crash-beforeCommit') {
    await anchor.compareAndSet(syntheticArchiveScope(bootstrap), input.expected, input.next);
    throw Error('EXPECTED_CRASH_NOT_REACHED');
  }
  const result = await recoverSyntheticCheckpoint(input.args, { bootstrap, reader, anchor });
  process.stdout.write(JSON.stringify({ code: result.code, sequence: result.point.sequence,
    units: result.entries.map(e => e.completion.unitId), coverage: result.coverage,
    directoryCompleteness: result.directoryCompleteness, rollbackProtection: result.rollbackProtection,
    readyForSlotRelease: result.readyForSlotRelease, activitySlotsReleased: result.activitySlotsReleased,
    physicalDeletion: result.physicalDeletion }));
} catch { process.stderr.write('ARCHIVE_CHECKPOINT_REJECTED'); process.exitCode = 1; }
