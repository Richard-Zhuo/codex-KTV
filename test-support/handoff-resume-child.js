// Controlled synthetic restart/crash worker. Receipts/tokens arrive over stdin, never argv.
import { loadSyntheticArchiveBootstrap } from '../backup/archive-discovery.js';
import { createSyntheticArchiveDirectory } from './synthetic-archive-directory.js';
import { openSyntheticCheckpointAnchor } from './synthetic-checkpoint-anchor.js';
import { openSyntheticHandoffStore, handoffSyntheticUnit } from './synthetic-safe-handoff.js';
let session;
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const bootstrap = await loadSyntheticArchiveBootstrap(input.args, input.offlineTrust);
  const remote = await createSyntheticArchiveDirectory(input.args, input.remoteRoot);
  const anchor = await openSyntheticCheckpointAnchor(input.args, { ...input.anchor, bootstrap, reader: remote.reader });
  session = await openSyntheticHandoffStore(input.args, input.descriptor, { bootstrap, reader: remote.reader, writer: remote.writer, anchor }, {
    fault: async phase => { if (input.action === 'crash-before-release' && phase === 'beforeRelease') process.exit(78); }
  });
  const result = await handoffSyntheticUnit(session.capability, input.unitId);
  if (result.code !== 'SYNTHETIC_HANDOFF_RELEASED') throw Error('HANDOFF_UNCONFIRMED');
  process.stdout.write(JSON.stringify({ code: result.code,
    activeCount: Object.keys(session.store.read().observations.offsite.attempts).length, physicalDeletion: false }));
} catch { process.stderr.write('SYNTHETIC_HANDOFF_REJECTED'); process.exitCode = 1; }
finally { await session?.close(); }
