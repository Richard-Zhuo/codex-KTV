# Stage 5B backup / restore / recovery

## Authority inventory

MySQL migrations001-011 define twenty InnoDB tables. ledger_heads.state_json owns catalog, inventory/effect ledger, orders/sale-line snapshots/payments/credit/repayment/rounding/handover. ledger_operations and ledger_success_audit own replay/revision evidence. Existing auth tables own accounts/scrypt hashes/grants/attributes/sessions/events; employees and employee_events own attribution/bindings. Voucher tables retain provider operation facts. room_control_workflows owns claims/attempts/ACK/query evidence in checksummed JSON; room_device_mappings owns explicit targets. production_bootstrap_events owns initialization receipts. Migration011 adds operational recovery_control/recovery_events only, with no seeds. There is no browser/localStorage backup or second business storage model.

## Backup contract - format1

backup/cli.js backup uses mysql2 and one REPEATABLE READ, WITH CONSISTENT SNAPSHOT, READ ONLY transaction across every table. All engines and SHOW CREATE TABLE digests must match the official schema before and after reads. DDL/migrations must not run during backup; ordinary InnoDB business writes continue. No long business write freeze or table locks are requested. Metadata locks are released before artifact disk writes. Current bounded implementation supports logical data up to128MiB; larger stores require a separately selected streaming/database-native strategy, not a silent partial dump.

Git-external artifact directory must be new, under an existing non-Git parent, after realpath resolution. data.json contains typed lossless values (binary base64, SQL date/time strings retaining microseconds, null distinct from0). SQL JSON values remain JSON text. Deterministic serialization uses sorted object keys and code-unit row ordering, LF endings. manifest.json identifies format, UTC snapshot time, source server UUID/database/environment/store/ledger, MySQL version, schema migration source/DDL digests, head revisions/checksums, application Git commit and data checksum/bytes. manifest.sha256 plus the operator's separately supplied expected checksum verifies manifest integrity. SHA-256 checks integrity, not cryptographic authorship; keep the expected digest in trusted operator records.

Artifacts contain sensitive business data, auth credential hashes and session token digests. They never include connection URLs/passwords, provider private files, plaintext passwords, raw tokens/Cookies or TLS keys. No arbitrary filesystem/config directories are collected. Use an access-controlled external backup directory. POSIX mode0700/0600 is requested; Windows ACL confidentiality is not certified by those mode bits. Encryption/key management is not invented here and remains a deployment blocker, together with off-machine copies, scheduling and retention.

## Restore contract

Restore supports same-version format1/schema001-011 into a separate empty TEST database, with explicit --restore-to-new-db, target server UUID/database/store/ledger/checksum acknowledgment and initiator. Production restore/cutover remains disabled in this stage. Production read-only backup is supported by design but not executed. Target names must start jbhh_ktv_restore_; source names cannot be overwritten. Existing non-empty targets are rejected. Never DROP/wipe a target or disable FK checks. Official migration statements create schema; artifact SQL is never executed. Row INSERT values are parameterized and columns checked against actual schema. All data imports are one transaction, with recovery_control permanently created first; source NORMAL control is never copied onto target. Failed imports roll back business rows and leave FAILED mode/schema for explicit operator disposal/recreation. DDL can commit partially; such incomplete schema is unusable and must never be marked ready.

Artifact checksum, version and expected store checks precede opening any target connection. Restore verifies server identity/version and empty target under a per-target advisory lock. The result is VERIFYING, not service-ready. Existing recovery event history is retained; the new restore event identifies source and digest without secrets. No source writes occur during restore.

## CLI

Use a Git-external private config containing databaseUrl, environment, storeId, ledgerId, serverUuid and initiatedBy. No password/token/Cookie argv flags exist. Outputs use safe codes/target facts only; arbitrary driver errors are masked.

- node backup/cli.js backup --config-file ABSOLUTE_PRIVATE_CONFIG --output-dir ABSOLUTE_NEW_DIRECTORY --confirm SERVER_UUID/DATABASE/STORE/LEDGER
- node backup/cli.js restore --config-file ABSOLUTE_PRIVATE_TARGET_CONFIG --artifact-dir ABSOLUTE_ARTIFACT --checksum TRUSTED_MANIFEST_SHA256 --confirm SERVER_UUID/TARGET_DATABASE/STORE/LEDGER/SHA256 --restore-to-new-db

Never use the production staff proposal for a drill. Only synthetic test identities, isolated MySQL and FakeGateway are authorized for Stage5B.

## Delivery

Commit1 implements the verified backup/restore boundary and tests. Commit2 adds recovery verification, transaction write freeze, session invalidation, worker pause/resume and the complete synthetic drill. Neither commit may be pushed or merged before human acceptance.

## Recovery protocol

`recovery/gate.js` reads the persisted singleton control. No row means NORMAL on an already migrated database; a missing table/failed read fails closed. All `/api/*` requests receive 503 `recovery_in_progress` plus requestId while paused. Static HTML/modules remain available. The existing staff UI displays its unavailable state and exposes no business controls; there is no demo fallback or new local business state.

Formal HTTP composition injects the same connection-bound guard into ledger, auth, employee and voucher transactions. The guard takes a shared recovery-control lock before business/head/auth locks and holds it through commit/rollback. A request that passed preliminary HTTP checks cannot write after freeze. Freeze takes the database-scoped dispatch advisory lock, drains an active provider step, takes the exclusive control lock, drains in-flight guarded SQL transactions, then commits FROZEN plus operator audit. Backup itself never takes this freeze.

Formal room-control runtime enables recovery protection by default. The legacy explicit testOnly fixtures can omit it; the Stage5B drill explicitly enables it. Guarded dispatch holds the database advisory lock across claim, provider call and evidence commit, checking mode first. Guarded room-control SQL also checks mode. Startup in VERIFYING/READY_FOR_RESUME does not schedule the worker. A manually requested tick cannot dispatch while paused. KTVSky productionEnabled remains false.

`inspect` is a READ ONLY, consistent-snapshot checker. It validates exact official schema, store identity, head checksum/schema/revision, contiguous committed operation/audit chain, result identities, orders/room exclusivity, payment amounts/IDs/actors/times, inventory count/null/effect records, employees/grants/credential formats and device/order references. It returns only blockers/counts/mode, not a full state or credentials. No new business rules or prices are calculated for restore; existing `total`/`outstanding` helpers validate settled balances.

`verify` locks the VERIFYING control and requires the restored eighteen business/auth tables to match the artifact cell-for-cell before preparation. It runs the checker, revokes all unrevoked sessions using the existing revoked_at semantics and records auth/recovery events with database UTC time. Every nonterminal workflow has its old claim cleared and version incremented. Only an ACK for the **current** CLOSE/OPEN step remains an ACK observation. All other uncertain/nonterminal steps are forced to query first, including OPEN preceded by a historical CLOSE ACK. No provider is called by verification. These deliberate operational changes are separate from preserved order/payment/inventory/revision facts.

Verification stores a digest of the prepared eighteen tables and sets READY_FOR_RESUME. This mode still denies login, writes and provider dispatch. `resume` requires a second explicit `/RESUME` acknowledgment and rechecks the prepared digest under the control lock; changed data or a nonverified mode refuses. Only then does it set NORMAL and audit the operator. It does not change application configuration, initialize real data or enable any provider gate.

## Operator sequence and stopping points

1. During normal operation take/verify an online backup, retain its expected manifest SHA-256 separately in trusted operator records, and copy it according to the future production storage policy.
2. Before recovery cutover freeze the old source, stop/drain its application and workers, and establish sole-writer ownership. If the old source is unreachable, an operator must establish that it cannot continue serving writes before cutover. These tools do not claim cross-server fencing or an automatic failover service.
3. Restore only to an explicitly acknowledged separate empty TEST target. A failed/partial target remains unusable; investigate and explicitly dispose/recreate it. Never retry by automatically wiping it.
4. Boot the candidate application against the target in VERIFYING, with provider production control OFF. Run inspect, investigate blockers, then verify. All old browser sessions are revoked. Exact restored historical values must survive; do not repair a failed checker by rewriting business facts.
5. Review READY_FOR_RESUME evidence and explicitly resume. Restart the **target** application (or explicitly start its guarded runtime) after NORMAL. A runtime that booted paused does not silently auto-start on a database mode change. Keep the old application stopped/source frozen.
6. Require a new login. Query-only reconciliation must precede any restored pending device mutation. UNKNOWN without settled proof remains UNKNOWN; elapsed lease alone is not permission to resend. Confirm first new command is R+1 and historical operationKey replay has no new effect.

These are operator steps for the isolated drill, not permission to run a production cutover. The control tables guard cooperating application paths; privileged direct SQL is an operational trust boundary. Stage5A bootstrap/mapping administrative CLIs are not permitted during recovery. No source unlock shortcut is provided; a mistakenly frozen source requires an explicit separately reviewed abort plan.

Additional private-file CLI entries:

- `node recovery/cli.js freeze --config-file ABSOLUTE_SOURCE_CONFIG --confirm SERVER_UUID/SOURCE_DATABASE/STORE/LEDGER`
- `node recovery/cli.js inspect --config-file ABSOLUTE_TARGET_CONFIG --artifact-dir ABSOLUTE_ARTIFACT --checksum SHA256 --confirm SERVER_UUID/TARGET_DATABASE/STORE/LEDGER/SHA256`
- `node recovery/cli.js verify --config-file ABSOLUTE_TARGET_CONFIG --artifact-dir ABSOLUTE_ARTIFACT --checksum SHA256 --confirm SERVER_UUID/TARGET_DATABASE/STORE/LEDGER/SHA256`
- `node recovery/cli.js resume --config-file ABSOLUTE_TARGET_CONFIG --checksum SHA256 --confirm SERVER_UUID/TARGET_DATABASE/STORE/LEDGER/SHA256/RESUME`

Same-version restore is intentionally restricted to TEST artifacts/targets. Importing a production backup or automatic production cutover is disabled; future production recovery requires a reviewed storage, key, access and cutover policy. Old schema artifacts are rejected instead of silently migrated.

## Scope and remaining production gates

No new dependency/framework, production account, real inventory count, production mapping, provider secret handling, live mutation, deployment or backup schedule is added. Encryption/key management, Windows backup ACL verification, off-machine/off-site copies, retention, scheduled backup failure handling and a production cutover drill remain open. Restored HTTP/worker gates require migration011 before formal startup. The source and restore databases in verification are isolated synthetic resources, removed after tests.

Delivery evidence: [Stage5B recovery drill](verification/STAGE5B_RECOVERY_DRILL.md). Implementation/test success remains a human-review candidate; neither Stage5B commit is merged or pushed.
