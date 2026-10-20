# B2-A trusted service single-backup execution

## Scope and internal boundary

The existing Windows SCM JbhhKtv virtual-account service remains the only production host.
production/start.js constructs createServiceBackupExecution and attaches its capability only
to the internal runtime. Trusted future service logic may call runtime.backupExecution.runOnce()
with no arguments. No HTTP action, stdin backup command, alternate executable, user-selected
config, commit, scheduler, automatic startup backup, retry or recovery action is added.

The original backup/cli.js, S4 deployment/identity admission, format1 and restore guards are
unchanged. The public factory's optional dependency ports support isolated tests only;
production/start.js supplies none. There is no environment/config test override.

## Protected configuration

Omitting backupExecution means disabled. An explicit runtime config may contain:

~~~json
"backupExecution": {"enabled": false, "timeoutMs": 300000}
~~~

Only enabled and timeoutMs are allowed. Enabled must be a Boolean; execution timeout defaults
to 300000ms and accepts 1000 through 600000ms. These are execution safety bounds, not a
backup interval or a claim that RPO is met. An explicitly present policy participates in
the runtime configuration fingerprint; absent policies preserve the old fingerprint shape.

Enabled execution uses the existing monitoring.backupDirectory as an already-existing
Git-external parent. It requires the SCM-bound runtime/Node/entry and its adjacent backup.json,
matching production/store/ledger selectors, and the existing backup source confirmation.
If backup.json specifies operationalDirectory it must equal the runtime log directory.
No production example or real protected configuration is changed by this candidate.
A future approved deployment must compile this candidate's existing host source; an older
host without --backup-child fails the execution instead of falling back to a different launcher.

## Execution and containment

1. Claim one process-local service run before asynchronous admission. A second trigger,
   including another executor in the same service process, returns BACKUP_EXECUTION_BUSY.
2. Reuse readBackupDeployment and readExternalSecret. Derive paths from the executing
   module and fixed SCM registration; create a fresh UUID output child name.
3. Start the SCM-bound native host using an argument array and shell=false. Its
   --backup-child mode derives the original backup CLI and sibling backup.json, fixes
   the action to backup, and uses no alternate credentials. A narrow environment omits
   NODE_OPTIONS, ambient DB credentials and test selectors.
4. Before starting the CLI, the native host joins a nested kill-on-close Job. Its process
   tree also remains in the outer service Job. The CLI performs its full original S4 checks.
5. Require observed supervisor closure, zero exit, bounded UTF-8 result, matching output,
   source and identity, and the original verifyArtifact check. Incomplete artifacts cannot
   yield BACKUP_VERIFIED. Output/driver/native exception text is never logged.
6. Commit completion synchronously after verification. The original CLI publishes its
   existing local-core report when configured; otherwise the executor publishes the verified
   fact through reportBackup. A stop after committed completion does not relabel it as timeout.
   A failed/cancelled executor publishes failure without erasing last verified backup history.
   A prior CLI core-success report is not a promise that the outer execution completed.
7. Timeout or stop kills the per-run supervisor and waits for closure. A 3-second cleanup
   grace after cancellation escalates unconfirmed termination to service-process exit;
   the existing outer host exits on Node failure, closing its Job and fencing descendants.
   DRAINING immediately blocks new triggers before other asynchronous shutdown work.

No artifact is automatically removed or overwritten. No retention, encryption, offsite
copy, production restore enablement or change to business facts occurs.

## Evidence boundary

backup-execution.test.js uses explicit ports and synthetic files for state/failure races.
backup-execution-native.test.js compiles the existing host into an owned temporary directory
and tests actual Windows processes, nested Jobs, UTF-8/path quoting, crash cleanup and the
untouched real CLI's S4 refusal. Its synthetic CLI exercises native lifecycle only.

These tests do not install SCM services or prove the registered virtual-account token,
administrator deployment anchors, installed service ACLs, reboot behavior or cloud deployment.
REAL SCM VALIDATION remains NOT VERIFIED. The existing S4 packaged test separately replaces
only its documented SCM/admin-anchor observations on owned MySQL; it is not real SCM evidence.
Current results belong to CURRENT_STAGE.md; commands belong to DEVELOPMENT_ENVIRONMENT.md.
