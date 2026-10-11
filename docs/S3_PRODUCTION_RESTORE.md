# S3-A production restore contract and read-only preflight

Status at this candidate: S3-A contract/preflight implemented. Production restore execution remains disabled by the unchanged Stage 5B `restoreDatabase` guard. This document does not authorize a real production inspection, freeze, import, cutover or resume.

## V1 boundary

V1 is same host, same port and same MySQL `@@server_uuid`, with an active production database and a **different, newly allocated database that does not yet exist**. The candidate name is generated as `jbhh_ktv_recovery_` plus the lowercase 32 hex digits of a UUIDv4. Operators cannot supply a target database identifier. In-place replacement, cross-server/new-machine recovery and recovery when the MySQL instance itself is unavailable are deferred. The current production database must be readable for S3-A to prove the formal bootstrap receipt, ledger identity, revision and NORMAL mode. If it is unreadable, report current head and data-loss window UNKNOWN and refuse plan creation.

The selected backup must be an explicit Git-external, protected **direct child** of the configured backup directory. The parent, artifact directory and each of the three artifact files need a protected Windows ACL allowing only the configured service SID, SYSTEM and Administrators; the current SID needs read access. The protected journal directory needs Modify and ObjectInherit for that SID. This tight S3-A policy does not claim that Stage 5B automatically hardens old backup artifacts; protect and review them separately before using them for a plan. No Downloads or arbitrary path is accepted.

## Configuration and trust

The existing Stage 5C protected runtime config may add:

```json
{
  "recovery": {
    "journalDirectory": "<ABSOLUTE_GIT_EXTERNAL_PROTECTED_DIRECTORY>",
    "operatorDbSecretsFile": "<ABSOLUTE_GIT_EXTERNAL_PROTECTED_FILE>"
  }
}
```

Its existing `monitoring.backupDirectory`, `storeId`, `ledgerId`, `applicationCommit`, `serviceAccountSid` and protected DB secret remain authoritative. The separate operator file has only:

```json
{"databaseUrl":"mysql://<READ_ONLY_METADATA_USER>:<SECRET>@<SAME_HOST>:<SAME_PORT>/"}
```

Keep the password out of the shell and Git. The file follows the existing protected external-file ACL and is read only by the configured service SID. Its host/port must equal the active runtime DB host/port. The operator file path must be Git-external. The operator account must have an explicit global `SHOW DATABASES` grant so `information_schema.SCHEMATA` can prove candidate nonexistence; role-inherited or ambiguous grants fail closed in v1. S3-A needs no CREATE/DROP/INSERT/UPDATE privilege for this account. The active runtime account is used only to read the current production receipts, ledger head and recovery mode.

The backup's separately supplied manifest SHA-256, verified format/data, exact store/ledger, production source/database/server UUID, exact bundled schema/migration, MySQL 8.4 and exact application commit must all agree. The commit equality is an intentionally conservative fail-closed v1 rule. SHA-256 is integrity, not source authentication; protected backup storage and the independently retained checksum remain operator trust boundaries. S5 handles offsite copies, encryption and stronger key management.

## Entry points and side effects

```text
node recovery/production-restore-cli.js inspect --config-file ABSOLUTE_PROTECTED_RUNTIME_CONFIG --artifact-dir ABSOLUTE_APPROVED_ARTIFACT --checksum INDEPENDENT_MANIFEST_SHA256 --operation-id UUIDV4
node recovery/production-restore-cli.js create-plan --config-file ABSOLUTE_PROTECTED_RUNTIME_CONFIG --artifact-dir ABSOLUTE_APPROVED_ARTIFACT --checksum INDEPENDENT_MANIFEST_SHA256 --operation-id SAME_UUIDV4
node recovery/production-restore-cli.js inspect-plan --config-file ABSOLUTE_PROTECTED_RUNTIME_CONFIG
```

`inspect` reads configuration, artifact, ACL and current MySQL metadata; it writes neither DB nor journal. It shows backup ID/time/age, backup and current revisions, and a revision gap when known. The backup timestamp is not an exact snapshot instant or PITR coordinate. It never selects a backup automatically. `create-plan` repeats every check and only writes an external PREPARED plan. It does not freeze, create a database, import rows, revoke sessions, pause workers, change runtime configuration or resume. `inspect-plan` only reads and validates the protected plan. These commands deliberately have no restore action.

The generated plan binds recoveryOperationId, exact backup identity/hash, production source server/database, store/ledger, schema/migration, application commit, current and target host/port/server/database, operator SID, timestamps, revisions and loss classification. Its digest is a later confirmation fingerprint, never a way to override a failed gate. It stores no DB password, TLS key, WeCom/KTVSky credential or token.

A persistent `active-plan.claim` is created exclusively before the plan is written. The plan is written to an empty same-directory temp file, ACL hardened before bytes, synced, atomically renamed to `active-plan.json`, then ACL checked. A crash can leave a claim or temp file; either prevents a second plan until separate operator review. Do not delete an uncertain claim automatically. S3-B/C must add reviewed transitions and eventual archival; S3-A has only PREPARED.

The external journal is needed when a database is unavailable. Future `recovery_events` are additional evidence, not the sole authority. S3-B will add freeze/import, S3-C verification/cutover/resume, and a later review must exercise the same path on isolated production-like MySQL. The existing production readiness server-UUID check is unchanged.

## Stop rules

Do not run this new CLI against real production until its protected files, operator account, backup ACLs and S3-A candidate have been separately reviewed. Do not use the Stage 5B TEST restore entry to import a production backup. No `--force`, `--skip` or direct active-database target exists. An unreadable current database, unknown source identity, missing metadata visibility, changed commit/schema, old-format artifact, unsafe ACL/path, existing target or active claim blocks planning.
