# S3-A production restore contract and read-only preflight

S3-A and S3-B are on the accepted main baseline. S3-C Phases C1, C2 and C3 are local owned-fixture-only candidates. Production restore execution remains disabled by the Stage 5B `restoreDatabase` guard and the S3-B production CLI guard. This document does not authorize a real production inspection, freeze, import, cutover or resume.

## S3-C Phase C1 internal candidate

C1 is an owned isolated MySQL verification path, not a production restore command. It requires the immutable protected plan and execution journal, exact plan-bound FROZEN old database and VERIFYING candidate, same server identity and verified structured backup. It reads both databases and the operational alert state without dispatching business, voucher, device or alert work. It classifies critical unresolved provider outcomes as blockers and records noncritical manual followups separately. A protected `c1-verification.json` holds only operation/plan/backup binding, old and candidate data digests, alert-state digest, safe finding codes, classification and eligibility.

A positive C1 result does not authorize cutover. Its validity depends on rechecking the protected plan, backup and live old/candidate/journal/alert facts before any future C2 action; changes invalidate the saved PASS. C1 leaves the old database FROZEN and candidate VERIFYING. Generic verify/resume remains barred for the plan-bound candidate, and the production CLI remains hard disabled. C2, service lifecycle, pointer switch, READY_FOR_RESUME and resume are outside C1.

## S3-C Phase C2 internal candidate

C2 remains an owned isolated fixture path. Before cutover it reopens the protected plan, backup and C1 evidence and rechecks the same operation, server, plan digest, old FROZEN and candidate VERIFYING control rows, official schema, old/candidate data digests and alert-state digest. A persisted C1 PASS alone is insufficient. The target is the plan-bound candidate; the operator cannot select a database or operation at switch time.

The managed runtime must finish draining HTTP work, business/device workers and the operational loop, and close its database pool before any pointer mutation. C2 then durably records a protected `CUTOVER_INTENT` bound to the operation, plan digest, backup SHA, old and target databases and server UUID. Only then may its dedicated updater atomically replace the existing protected secrets file with a version differing solely in `database.name`. It requires the expected old value, validates the original and temporary file ACL before writing secret bytes, checks the final ACL and contents, and never prints protected fields. The journal advances to `CUTOVER_SWITCHED` only after reloading and revalidating the actual target pointer and recovery facts. Filesystem journal and secrets replacement are distinct operations, not one transaction.

`CUTOVER_INTENT` with the old pointer does not count as a completed switch. The same operation may revalidate and finish it while the runtime stays stopped. If the pointer already names the same plan target while the journal remains `CUTOVER_INTENT`, C2 can reconcile to `CUTOVER_SWITCHED` only after the full same-operation recheck. A different operation, unrelated pointer or changed C1 fact fails closed. Normal production startup and preflight check both cutover and plan-bound execution journals before starting services, workers or the operational loop; the runtime also rechecks before listening. An orphan execution journal without its protected plan blocks startup. They remain blocked throughout this pre-resume window. Ordinary NORMAL startup without an active cutover remains available.

C2 stops with old DB FROZEN, candidate DB VERIFYING, the protected pointer on the candidate, and zero managed normal writers. It does not change either recovery mode, restart runtime, allow employee traffic, dispatch providers, reach READY_FOR_RESUME, resume or implement a real production cutover. The public production restore CLI remains hard disabled; only the private owned-fixture capability reaches this core. Future C3 must explicitly establish the safe resume boundary.

## S3-C Phase C3 internal candidate

C3 remains reachable only through the private owned isolated MySQL fixture capability. Before the first candidate state mutation it reopens the protected plan, backup, C1 evidence and C2 cutover state, verifies the old plan-bound FROZEN database, the plan-bound VERIFYING candidate, the candidate pointer, unchanged business/alert evidence, invalidated restored sessions and a fully stopped managed runtime. It persists an identity-bound protected `READY_INTENT` before the dedicated candidate VERIFYING to READY_FOR_RESUME transaction. A saved C1 PASS is not permanent authorization. Generic Stage 5B verify/resume still rejects the plan-bound candidate.

The READY transaction records the current operation's prepared data digest and old database identity in the candidate recovery facts. The normal runtime remains blocked. Dedicated resume repeats the protected plan, backup, pointer, old/candidate, C1 and alert checks, then persists `RESUME_INTENT` before its trusted candidate transaction changes READY_FOR_RESUME to NORMAL. Only after rereading the same-operation NORMAL state does the external journal become `RESUMED`. Filesystem and MySQL are not treated as one transaction. `RESUME_INTENT` with READY can retry after revalidation; NORMAL with intent can only complete the same-operation journal, without another database transition. Different operations conflict.

The startup interlock opens only for the completed protected journal, exact candidate pointer, same MySQL identity, old FROZEN control, candidate NORMAL control bound to the operation, official schema and production readiness. It does not assume NORMAL alone proves recovery completion. The pre-resume data, alert and zero-session checks apply before resume; legitimate new business records, sessions and alerts after NORMAL do not invalidate later startup. The old database stays FROZEN. Once normal business writes reach the candidate, a simple pointer switch back to the old database is not a safe rollback and no rollback subsystem is included. The owned rehearsal shows one managed candidate writer and no old writer. Real production restore/cutover/resume remains hard disabled; no provider replay or real deployment is authorized by C3.

## S3-B Phase 1 internal candidate

The local S3-B Phase 1 candidate produces PREPARED plan format v2. Its `backupLocator` is the trusted direct-child name under the configured protected backup root and is included in `planDigest`; execution cannot supply a new artifact path or change the target identity. Format v1 remains valid for read-only inspection and is refused by the execution preflight. The backup artifact format is unchanged.

Before any freeze mutation, the executor rereads the protected plan, rechecks its ACL and canonical digest, resolves the bound locator, and repeats backup, application/schema, active DB, target absence and same-server checks. The first plan read may select a journal phase but is not execution authority: the mutation uses only the immutable validated preflight result after exact comparison with that first read. Drift refuses the freeze without a DB mutation. The protected execution journal is separate from immutable PREPARED plan storage. A durable FREEZE_INTENT never proves the database is frozen; a same-operation FROZEN row with the matching operation ID, plan digest, backup SHA, store, ledger and target can be reconciled to journal FROZEN. Another operation cannot overwrite it. Phase 1 does not create a candidate database.

S3-B's synthetic core requires a verified owned isolated MySQL fixture capability. The ordinary production CLI explicitly rejects S3-B freeze and restore actions with `RESTORE_PRODUCTION_DISABLED`. Phase 2 creation/import and all real production execution remain disabled at this checkpoint.

## S3-B Phase 2 internal candidate

Only the owned isolated MySQL fixture capability can invoke `restorePreparedCandidate`; the ordinary production CLI still rejects candidate restoration with `RESTORE_PRODUCTION_DISABLED`. The preflight reopens the protected v2 PREPARED plan, verifies its canonical digest, backup locator/path/ACL/SHA/manifest, same server, active database and nonexistent target, then proves the active recovery_control is FROZEN for the exact operation, digest, backup SHA, store, ledger and target. It repeats preflight after durably recording journal RESTORING intent and immediately before CREATE. No operator-supplied target, backup path, operation ID or force flag exists.

CREATE uses the generated plan target without IF NOT EXISTS. It creates recovery_control first and stores the current operation in RESTORING before the remaining official schema. The same `schemaSpec`, verified migration statements and table order used by Stage 5B TEST restore drive parameterized structured row import; backup data is never executed as SQL. Historical recovery_control rows are skipped. DDL is not transactionally reversible; DML import, normalized per-table row/digest comparison, session revocation and the candidate VERIFYING update use one InnoDB transaction. The existing recovery events are imported as historical rows and a current operation event is added. Foreign-key checks must remain enabled. The candidate journal advances to VERIFYING only after the candidate transaction commits, then execution stops.

The candidate's trusted `recovery_control.facts.reason` is `plan-bound-candidate-restore`. The Stage 5B trusted generic `verifyRecovery` and `resumeRecovery` reject this candidate with `RECOVERY_PLAN_BOUND_CANDIDATE_BLOCKED` before any database mutation, including a backup with zero active sessions and a candidate already marked READY_FOR_RESUME. Generic Stage 5B recovery remains available for ordinary restores. Advancement beyond VERIFYING for an S3-B candidate requires a future dedicated S3-C path; generic recovery is not that path.

A RESTORING journal with no candidate can retry the same operation only after full preflight. Once CREATE succeeds or candidate existence is uncertain, any failure marks the journal FAILED_AMBIGUOUS when possible; a later attempt refuses reuse even if a candidate disappeared. If the process dies between DB and filesystem transitions, journal/DB disagreement cannot be treated as success. No automatic DROP, cleanup, cutover, runtime DB switch, READY_FOR_RESUME or resume is exposed. Ordinary business/device gates refuse candidate writes in RESTORING and VERIFYING. Only the isolated fixture's own verified cleanup removes synthetic databases after tests.

## V1 boundary

V1 is same host, same port and same MySQL `@@server_uuid`, with an active production database and a **different, newly allocated database that does not yet exist**. The candidate name is generated as `jbhh_ktv_recovery_` plus the lowercase 32 hex digits of a UUIDv4. Operators cannot supply a recovery operation ID or target database identifier. `create-plan` generates a fresh canonical UUIDv4 in trusted application code; `inspect` has no persisted operation ID. In-place replacement, cross-server/new-machine recovery and recovery when the MySQL instance itself is unavailable are deferred. The current production database must be readable for S3-A to prove the formal bootstrap receipt, ledger identity, revision and NORMAL mode. If it is unreadable, report current head and data-loss window UNKNOWN and refuse plan creation.

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

The backup generator creates a canonical lowercase UUIDv4 `backupId`; missing, non-string and malformed IDs are rejected by the format verifier. The backup's separately supplied manifest SHA-256, verified format/data, exact store/ledger, production source/database/server UUID, exact bundled schema/migration, MySQL 8.4 and exact application commit must all agree. The commit equality is an intentionally conservative fail-closed v1 rule. SHA-256 is integrity, not source authentication; protected backup storage and the independently retained checksum remain operator trust boundaries. S5 handles offsite copies, encryption and stronger key management.

## Entry points and side effects

```text
node recovery/production-restore-cli.js inspect --config-file ABSOLUTE_PROTECTED_RUNTIME_CONFIG --artifact-dir ABSOLUTE_APPROVED_ARTIFACT --checksum INDEPENDENT_MANIFEST_SHA256
node recovery/production-restore-cli.js create-plan --config-file ABSOLUTE_PROTECTED_RUNTIME_CONFIG --artifact-dir ABSOLUTE_APPROVED_ARTIFACT --checksum INDEPENDENT_MANIFEST_SHA256
node recovery/production-restore-cli.js inspect-plan --config-file ABSOLUTE_PROTECTED_RUNTIME_CONFIG
```

`inspect` reads configuration, artifact, ACL and current MySQL metadata; it writes neither DB nor journal. It shows backup ID/time/age, backup and current revisions, and a revision gap when known. The backup timestamp is not an exact snapshot instant or PITR coordinate. It never selects a backup automatically or presents an operation ID as a durable plan. The old `--operation-id` option is rejected. `create-plan` generates the operation ID, repeats every eligibility check, then performs a final full read-only binding check after taking the persistent claim and before writing PREPARED. A changed backup path/hash/manifest, server identity, target existence or other bound fact fails with `PRODUCTION_RESTORE_PLAN_PRECONDITION_CHANGED`; no active PREPARED plan is written. `create-plan` only writes an external PREPARED plan. It does not freeze, create a database, import rows, revoke sessions, pause workers, change runtime configuration or resume. `inspect-plan` only reads and validates the protected plan. These commands deliberately have no restore action.

The generated plan binds recoveryOperationId, exact backup identity/hash, production source server/database, store/ledger, schema/migration, application commit, current and target host/port/server/database, operator SID, timestamps, revisions and loss classification. Its digest is a later confirmation fingerprint, never a way to override a failed gate. It stores no DB password, TLS key, WeCom/KTVSky credential or token.

A persistent `active-plan.claim` is created exclusively before the plan is written. The plan is written to an empty same-directory temp file, ACL hardened before bytes, synced, atomically renamed to `active-plan.json`, then ACL checked. A crash or failed final binding check can leave a claim or temp file; either prevents a second plan until separate operator review. Do not delete an uncertain claim automatically. S3-B/C must add reviewed transitions and eventual archival; S3-A has only PREPARED.

Before any future S3-B/S3-C production restore execution, **before any database mutation**, the executor must perform these checks in order:

1. Read the PREPARED plan from the protected recovery journal and validate the journal and plan ACL against the existing protected-state contract.
2. Recompute `planDigest` from the plan content using the current canonical plan serialization (excluding the persisted `planDigest` field). Require exact equality with the persisted `planDigest`. On mismatch, fail closed with `PLAN_DIGEST_MISMATCH` or an equivalent safe error; **DB MUTATION = NO**. Human confirmation cannot override a mismatch.
3. Only after the digest passes, revalidate the backup protected path, backup SHA-256 against the PREPARED plan SHA, manifest and backup identity, `storeId`, `ledgerId`, application/schema compatibility, current MySQL `@@server_uuid`, target database allocation/state, and that the target database differs from the active production database.
4. Only after every check passes may the future executor perform its first database mutation.

A PREPARED plan is a previously validated recovery intent, **not permanent execution authorization**. Execution must revalidate plan integrity, backup binding, server identity and target state. `planDigest` detects plan-content drift or tampering relative to the persisted protected plan contract; it is neither cryptographic provenance proof nor a backup authenticity signature. It cannot replace ACL checks, backup SHA-256, manifest validation, server identity or target-state validation. No `--force`, `--skip-plan-digest`, `--ignore-plan-drift`, `--skip-hash` or `--ignore-target-change` bypass is permitted. This is a future execution invariant, not an S3-A restore implementation.

The external journal is needed when a database is unavailable. Future `recovery_events` are additional evidence, not the sole authority. S3-B will add freeze/import, S3-C verification/cutover/resume, and a later review must exercise the same path on isolated production-like MySQL. The existing production readiness server-UUID check is unchanged.

## Stop rules

Do not run this new CLI against real production until its protected files, operator account, backup ACLs and S3-A candidate have been separately reviewed. Do not use the Stage 5B TEST restore entry to import a production backup. No `--force`, `--skip` or direct active-database target exists. An unreadable current database, unknown source identity, missing metadata visibility, changed commit/schema, old-format artifact, unsafe ACL/path, existing target or active claim blocks planning.
