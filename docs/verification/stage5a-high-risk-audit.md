# Stage 5A high-risk audit - 2026-10-08

Candidate audited: 37a2542504580f9ee405f59221ee1dfd65ebc8c3. Base main/origin/main remains f64e4752a483b7b316aa86777bea006269c80024. Scope is production identity/bootstrap/readiness only. No real staff, production mapping/inventory, provider operation, deployment or Stage 5B was executed.

## Findings and disposition

- P0 (1): destructive fixture protection matched only literal lowercase production. Case/whitespace/aliases passed the environment guard. Fixed by a shared strict environment parser; all three keys reject production and every unknown/noncanonical value before fixture SQL. A missing immediate guard before the device migration regression's DROP is also corrected.
- P1 (1): a previously bootstrapped identity could silently receive extra known grants from a changed plan. Real MySQL reproduced adding backend.view. Fixed by comparing normalized identity/permission/attribute receipts and current rows before any writes. Initial compatible partial rows remain supported; completed plans cannot rebind, expand or repair missing grants. Runtime authority remains auth grants and policy attributes, never receipt/template names.
- P1 (1): HTTP startup ignored KTV_DEPLOYMENT_ENV=production with explicit development HTTP mode. An in-memory load of the original candidate created the API without the production readiness gate. Fixed by the same shared parser; this conflicting configuration now fails before pool creation.
- P2 (1): bootstrap audit had only one occurrence timestamp. Both bootstrap tools now persist source and UTC transaction-work startedAt/completedAt in facts; schema 010 is unchanged.
- P2 (1): programmatic connection-acquisition errors escaped bootstrap's safe error contract (the CLI already masked errors). Both tools now acquire connections inside the redaction boundary; synthetic secret-bearing errors are suppressed.

All five findings are fixed in the audit-fix candidate. Verdict remains FIXED, NEEDS HUMAN RE-ACCEPTANCE; main merge and push are forbidden for this result.

## Evidence

The initial negative run failed the changed-grant and environment tests on the original behavior. Final focused 38/38, separate real MySQL 21/21 and full 2091/2091 passed, fail 0, skip 0, exit 0. No post-merge test applies. npm test was attempted but is unavailable; direct Node results are the acquired execution evidence. CURRENT_STAGE records this run. Tests use only synthetic identities in owned MySQL 8.4.11/InnoDB, loopback port33313, jbhh_ktv_test. The data directory and empty test database were checked before fixture execution. Raw logs remain outside Git.

- Dry-run and refused requests compare SHA-256 fingerprints of every cell in every table, sorted independently of row order. These in-memory fingerprints avoid exposing credential rows in assertion output. Both empty and populated dry-runs preserve all eighteen tables, including auth and bootstrap audits, bindings and mappings.
- First apply creates the expected account, employee, binding and three distinct grants. Concurrent same-plan reruns preserve all non-execution-audit rows and credential bytes, returning already_satisfied. Mapping reruns preserve one target and existing business revision.
- Known new grants, grant removal, changed principal/employee, unknown permissions/wildcards/attributes and wrong store all refuse. Wrong-store interception records zero mutation SQL. Initial fresh-store binding uses the explicit database/store/ledger acknowledgment; subsequent store identity is checked against persisted receipts. No store identity is inferred from room names.
- A real transaction inserted two synthetic employees/accounts before an injected driver failure; every table's contents matched the pre-run state after rollback. Driver error text deliberately contained a synthetic secret; the thrown error did not disclose it.
- Real scrypt version1, 32-byte salt/key, no plaintext in audit. Wrong password leaves credentials unchanged; correct own-password change increments version, records audit, revokes sessions and denies an old-session trusted write at revision0. Account disable after initial authentication similarly denies the transaction-bound write.
- An external ordinary path is accepted; relative paths, repository paths, dot-dot aliases and an actual Windows junction into a Git checkout are refused after realpath resolution. File symlink creation was attempted but Windows returned EPERM; no file-symlink runtime PASS is claimed. The same realpath boundary handles links.
- Migration010 fresh install, an existing001-009 schema with a preserved audit sentinel upgraded to010, repeat ER_TABLE_EXISTS_ERROR, missing010, extra table and changed-column schema refusal are tested. Migration never seeds identities or modifies schema during bootstrap.
- Each of the three environment keys is exercised with production, mixed case, surrounding whitespace, prod/live/staging/unknown and empty values. Fixture lock and policy-loader spies observe SQL count0. Static inspection finds guards on all five fixture entry/cleanup paths, policy loaders, historical browser recovery and device migration DROP.
- Readiness 503 contains only safe machine code/message/requestId; no worker/API delegate executes. CLI initialization and diagnostics access MySQL directly, independently of this gate. Required mappings check every room; disabled production provider remains a blocker. Null stock blocks, zero is accepted, catalog checks do not mutate state or prices.

## Retained human gates

Six-person proposal stays approved=false and all accounts disabled; tests provision only synthetic UUIDs. Backend/approval/self-review/policy attributes remain NEEDS OWNER DECISION. Real staff initialization, real mapping, opening inventory, backup/restore drill and deployment are not executed. KTVSky live production control stays OFF. PRODUCTION READY = NO. Next planned stage remains Stage 5B Backup / Restore / Recovery Drill, not started.
