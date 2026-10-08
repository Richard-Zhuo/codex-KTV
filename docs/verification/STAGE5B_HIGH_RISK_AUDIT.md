# Stage 5B high-risk recovery audit (2026-10-09)

## Candidate and disposition

Audited candidate: 176bf7e879c564807882647a6fc6b8291790ee32, parent 6442e6a42efb8b5f8d068beedc1e17ee9c32e7f4; base main and locally recorded origin/main b188df811926bf4d6cf6c535d1a186ff270e699c.

Disposition: **FIXED, NEEDS HUMAN RE-ACCEPTANCE**. One audit-fix commit above the candidate; no merge, fetch, push, Stage5C branch or deployment. No real initialization or provider operation.

## Independent findings

| Axis | Severity | Finding | Fix and evidence |
| --- | --- | --- | --- |
| Standards | P1 | Recovery CLI used inherited object lookup. constructor invoked Object(config), allowing private database URL/password output. | Map allowlist before reading config; synthetic external-config regression rejects constructor, __proto__, toString and hasOwnProperty with one safe code. The candidate returned exit0 for constructor; fixed result exit1 without config output. |
| Spec | P1 | Resume read business tables without locks; an independent UPDATE could commit after a table scan, crossing the final digest check. | Explicit REPEATABLE READ and full-table FOR SHARE reads through commit, covering current rows and insert ranges. Revalidate schema after acquiring locks. Real MySQL child pauses after employees read; UPDATE employees and INSERT auth_events now time out rather than crossing the check. Candidate allowed UPDATE. |
| Spec | P1 | Restore finished schema before durably writing RESTORING. Crash at the final DDL left complete schema and absent control interpreted NORMAL. | Execute unchanged official recovery_control DDL and insert RESTORING before remaining official business DDL. SIGKILL after final recovery_events DDL now leaves RESTORING, HTTP503, guarded writes blocked and zero provider calls. Candidate left NORMAL; it contained no imported accounts/business rows, so no actual financial/device side effect was demonstrated. |
| Spec | P2 | Second successful resume returned RECOVERY_NOT_VERIFIED. | Matching verified NORMAL target returns RECOVERY_ALREADY_NORMAL with no new recovery event or other side effect. |

Found P0=0, P1=3, P2=1; all findings fixed. Independent read-only Standards and Spec reviewers rechecked their fixes and reported no unresolved P0/P1. The primary agent executed runtime evidence; reviewers did not run database operations. This is not human re-acceptance.

## Crash safety and transaction boundaries

recovery/audit.integration.test.js forks a real Node process and forcibly terminates it. Restore schema preparation crash retains RESTORING. A verify process killed after UPDATE auth_sessions rolls back all three old active sessions and remains VERIFYING; retry revokes all three, recording recovery-cutover reason and database timestamp. FROZEN, RESTORING, VERIFYING and READY_FOR_RESUME each survive application termination/restart; fresh processes deny HTTP writes, transaction guards and provider dispatch. Explicit resume alone transitions a verified target to NORMAL.

The guard is durable MySQL state. An absent row is NORMAL only under the fresh migrated database contract; missing schema/read errors fail closed. Restore creates its paused row before any business DDL. A crash before that row can only leave incomplete schema, which cannot satisfy formal schema readiness.

Fresh production migration order remains001-011. Restore bootstraps the official011 control table first for operational safety, then uses every remaining unchanged official migration statement; schema-manifest verification remains derived from those migrations. No artifact SQL or second schema definition is introduced.

DDL can commit partially. Business/auth import is a separate single transaction. Failed DML leaves zero imported business rows and durable FAILED, while partial schema is retained for manual investigation/disposal. Neither failure mode automatically drops/wipes/retries a target.

verify and resume lock authoritative tables only during recovery; ordinary backup stays one nonlocking consistent READ ONLY snapshot. After NORMAL, legitimate writes and R+1 are allowed; the prepared digest is not a permanent write restriction. Repeated resume is a no-op even after normal data changes. Privileged SQL after NORMAL remains an operational trust boundary.

## Artifact and snapshot evidence

- One REPEATABLE READ consistent snapshot captures source identity receipts, ledger heads, operations, business/auth rows and device workflows. Schema source/DDL must match official manifests before and after capture; concurrent migrations remain forbidden.
- Existing concurrent-write regression commits R+1 after the backup head read; artifact stays entirely at R.
- Payload SHA-256 is stored in the manifest; independently supplied manifest SHA binds metadata and payload checksum. Tests alter order amount, payment time, inventory null, grant, operationKey and workflow independently; all reject before even parsing an invalid target URL. Manifest modification, truncation, unknown format/schema/migration and wrong store are also refused.
- Canonical object keys, code-unit row ordering, LF and lossless SQL strings/binary/null avoid locale/timezone serialization changes.
- createdAt is a database UTC tool recording timestamp near transaction start, not an exact snapshot instant, binlog coordinate or PITR guarantee.
- Size-limit regression injects a >128MiB serialized snapshot into the isolated backup reader. It returns BACKUP_SIZE_LIMIT with no artifact directory or completed manifest.
- Existing destination refuses overwrite. Runtime Windows junction resolving inside Git is rejected after realpath; repository output is denied.
- Actual synthetic artifact excludes the generated plaintext credential, raw authenticated session token and database URL. Derived password hash/salt and session digests are expected sensitive contents. No provider/private filesystem files are collected.
- SHA-256 is integrity checking, not cryptographic authenticity. Protected storage and a separately protected expected digest are necessary; signing/encryption policy remains unresolved.

## Recovery drill and business preservation

The full real MySQL8.4.11/InnoDB drill was rerun on the owned loopback33313 instance only: eight synthetic orders, five payments, nine inventory effects, twenty schema tables, twenty-three original operations and four device workflows.

All eighteen preserved tables match artifact cells before verification. Complete ledger snapshot equality preserves payment IDs/times/actors/amounts/methods, order/session/businessDate/pricePlan/target facts, employee bindings/auth/grants and inventory count=null. Preparation changes only recovery/session/workflow operational evidence, not ledger revision. First trusted write after restore advances23->24. Historical K replays the original result with no audit/state changes; same K with changed payload returns idempotency-conflict.

ACK/UNKNOWN/historical-CLOSE-before-OPEN workflows issue zero new mutations after restoration. Offline workflow first queries with zero mutations, then uses settled retry-safe proof before one FakeGateway OPEN on the same workflow/order. Orders and inventory effects are not repeated. Existing claim/version/attempt tests remain in full regression; no real KTVSky gateway is contacted.

Freeze drains an active provider dispatch and an in-flight guarded SQL transaction. The startup race test delays recovery state loading and proves neither HTTP delegation nor worker scheduling/provider activity starts before FROZEN is resolved. Source table hashes stay unchanged during target restore/preparation/resume except the authorized earlier T2 and source freeze.

## Migration011

Only recovery_control/recovery_events operational tables; no NORMAL seed and no business data migration. Fresh001-011 is exercised by each fixture. Explicit001-010->011 regression preserves ledger/account facts. Repeating CREATE refuses ER_TABLE_EXISTS_ERROR; partial DDL is retained and completed only by explicit test fixture action, without silently dropping business data. Schema authority is still versioned MySQL migrations001-011.

## Verification

Focused command:

    node --test --test-isolation=none --test-reporter=tap backup/format.test.js backup/mysql-backup.integration.test.js recovery/cli.test.js recovery/gate.test.js recovery/audit.integration.test.js recovery/drill.integration.test.js

Focused:27 total,27 pass,0 fail,0 skip,exit0. This includes live isolated MySQL tests and real child-process termination, not source review alone.

Full command:

    node --test --test-isolation=none --test-reporter=tap

Full result:2118 total,2118 pass,0 fail,0 skip,exit0 (163991.9231ms). No after-merge run applies because findings prohibit merging.

npm test was attempted; npm is unavailable in this environment. Direct Node full regression is the formal command. Logs and sanitized drill evidence are external to Git under the current user's TEMP directory; no backup payload, secret file or generated runtime data is committed.

Prior timing/browser evidence in STAGE5B_RECOVERY_DRILL.md is historical. New drill timing is a small local synthetic observation, never a production RPO/RTO guarantee. No browser/UI PASS is claimed by this backend audit.

## Remaining gates

Production restore disabled; production backup policy unconfigured. Scheduling, retention, off-machine/off-site copies, at-rest encryption/key management, capacity beyond128MiB and Windows ACL verification remain unresolved. Mode bits are not certified Windows confidentiality.

Real production backup/restore, staff/account bootstrap, inventory initialization, room mapping initialization, provider operations and deployment: NOT EXECUTED. KTVSky live production control remains OFF.

Stage5C is only the next planned phase after human acceptance and Git closeout; no Stage5C work or branch began. PRODUCTION READY=NO;14-DAY OFFSITE MVP READY=NO.
