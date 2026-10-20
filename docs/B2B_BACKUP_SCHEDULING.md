# B2-B controlled periodic scheduling

## Scope and safety

The existing Windows SCM service creates one internal scheduler in production/start.js.
production/runtime.js starts it after the normal startup attempt, including LIVENESS_ONLY
when the database/readiness is unavailable. Existing recovery startup interlocks are
preserved. No HTTP request, stdin backup command, external executable or new service is
introduced. No production configuration is changed by this candidate.

The optional protected runtime.json policy is backupSchedule. Its default is:

~~~json
{"enabled": false, "intervalMinutes": 15, "timeZone": "Asia/Shanghai", "retryLimit": 0}
~~~

Only those four fields are accepted. enabled must be an explicit boolean if the object is
present; the other fields may be omitted but cannot change the fixed values. Malformed
configuration fails startup without executing backups. Enabling scheduling also requires
B2-A backupExecution.enabled=true. These switches are included in the existing runtime
fingerprint when supplied; omission preserves the prior fingerprint contract.

Production enablement is NOT authorized. Plaintext backup staging remains; B3 retention,
B4 encryption, B5 independent copies and B6 recovery are outside this change. Local verified
success does not prove offsite availability, RPO<=60 minutes or RTO<=240 minutes.

## Scheduling contract

- All day at Shanghai :00/:15/:30/:45. UTC epoch quarter-hours are the same boundaries;
  calculations never use the host's timezone. Injected clock/timer ports support tests.
- First start and restart wait for the next strictly future boundary, including when
  starting exactly on a boundary. There is no immediate backup on installation/start.
- Before a trigger, persist the next future cursor using the existing operational store.
  A delayed timer records the skipped range and can run only the latest due slot. A restart
  records missed slots since the persisted cursor, but runs none of those historical slots.
  A previously running observation is recorded as interrupted, never assumed successful.
- No cursor exists before first enablement, so earlier history is unknown. A backward clock
  retains the persisted future watermark; no previously claimed slot is replayed. Clock
  jumps and storage failures can delay backups; real Windows clock behavior still needs
  isolated service acceptance.
- One active scheduler call skips new overlapping slots. B2-A also retains its module-wide
  exclusion across executors in the same Node process. This is not a distributed lock or
  a guarantee across different service instances, processes or independent log directories.
- Retry limit is exactly zero. Failure, timeout, unexpected rejection and busy/disabled/
  stopped refusal are recorded; ordinary execution failure waits for the next planned slot.
  Schedule persistence/clock/logging errors fail closed, stop the timer and fence B2-A until
  process restart. No automatic retry queue or crash catch-up exists.

## Execution and facts

Every trigger calls the unchanged B2-A runOnce() with no arguments. Fixed paths, native
supervisor, original CLI/S4 checks, execution timeout, Job containment, verifyArtifact and
reportBackup are unchanged. Scheduler code cannot supply commands, identities or paths.
Only B2-A BACKUP_VERIFIED maps to VERIFIED; timeout maps to TIMED_OUT, admission refusals
to SKIPPED, and other outcomes to FAILED. The scheduler never writes backup success receipts.

The existing operational-state.json observations.backupSchedule holds a bounded cursor and
latest schedule observation, not a new backup ledger. It shares the existing operational
writer lock, which can be reserved before HTTP readiness and reused when monitoring starts.
The existing log records TRIGGERED/RUNNING/VERIFIED/FAILED/TIMED_OUT/SKIPPED, missed ranges,
interruption and stop using only fixed codes and timestamps/counts. Existing backup mailbox
facts remain the authority for lastSuccessAt/lastResult; receipts accumulated before
monitoring activation are consumed by its existing poll. The read-only monitoring snapshot
adds backup.schedule. scheduledAt identifies the slot of the displayed observation; an
older run completing after newer skips retains its own slot, while nextRunAt retains the
future cursor. A disabled configuration projects DISABLED even with an old cursor.

Service draining synchronously fences future timer callbacks and delegates cancellation to
B2-A. It waits for schedule writes and B2-A cleanup before releasing operational resources.
Activation/start failures stop scheduling before releasing its writer. Process crashes remain
contained by the existing SCM host Job; actual SCM/SID/deployment ACL acceptance is NOT VERIFIED.

## Evidence and stopping point

Focused commands and environment notes are in DEVELOPMENT_ENVIRONMENT.md; current author
evidence is in CURRENT_STAGE.md. Mock clocks do not wait fifteen minutes. Temporary files,
loopback HTTPS and synthetic/native lifecycle tests do not install a service or use a real
production database. B2-A's original executor, CLI, S4 validators and native host source
remain unchanged. This candidate requires independent B2-B acceptance before integration;
no merge, push, production backup or deployment is included.
