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
