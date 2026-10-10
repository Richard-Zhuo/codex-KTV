# S1 candidate consolidation and regression reconciliation

Date: 2026-10-10. Scope: S1 formal first-install software path only. Human re-acceptance is pending. Production readiness remains NO.

## Candidate and provenance

- Accepted main and origin/main: `eb0931196ac797e95b785d2a1ee30ed02f6c8a2b`.
- Candidate branch: `codex/p0-1-prod-blocker-s1-initialization`, created from that exact commit in the managed `p0-1-mysql-ledger` worktree. No pre-existing dirty files were present there when S1 began.
- Separate historical checkout `D:/iwen-codex/codex-KTV` is `codex/core-refactor` at `ca726b2dbd431b8dc6eed17ad07b25cd0785f8d6`. Its pre-existing modified `docs/CURRENT_STAGE.md`, `docs/REQUIREMENTS.md`, and two untracked files were not included or modified by S1. Overlap: NO.
- S1 changes are the formal initializer, CLI, readiness/rehearsal integration, relevant synthetic fixtures/tests, and linked S1 documentation. No reset, stash, merge, push, deployment or real initialization.

## Test discovery delta

The historical accepted TAP file outside Git records 2173 total, 2173 pass, 0 fail, 0 skip, exit 0. It ran the exact command `node --test --test-isolation=none --test-reporter=tap` under the owned MySQL 8.4.11/InnoDB fixture.

The earlier direct command without that fixture recorded 1352 total, 1332 pass, 0 fail, 20 skip. Baseline and that run both discovered all 1335 old top-level tests; the direct run added two S1 top-level tests and removed none. Its 823 missing nested assertions came from seven gated roots: trusted-clean 688, auth 45, employee roster 38, production bootstrap 20, ledger 20, Stage 5B recovery drill 7, and Stage 5B backup/restore 5. The 20 skips were environment gated: five MySQL core/bootstrap, eight Stage 5B backup/recovery, one Stage 5C, three Stage 5D, two Stage 5E, and one new S1. Accepted baseline had zero skips. There was no test deletion.

The first fixture-enabled candidate run exposed five failing assertions and one skipped new S1 suite. The failures identified a strict readiness check encountering two synthetic heads retained by a prior bootstrap test, and two existing runtime fixtures lacking a formal S1 receipt or matching restore provenance. Those fixtures were corrected within their owned disposable databases; the readiness rule now accepts a changed database name only with verified recovery control and source provenance. Focused real MySQL regression then passed 24/24 with zero skips. The S1 suite was explicitly enabled for the final run.

A repeat on local commit `c1ead21` ran all 2185 tests but had one Stage 5E crash-recovery failure: the synthetic process was killed while a separate Fake alert delivery could still be in flight. The production alert readiness gate correctly stayed blocked on the pending delivery, while the lease-recovery test expected immediate readiness. Isolated rerun passed. The test now waits for its own synthetic alert outbox to reach delivered state before injecting the process crash, keeping the real alert gate and lease assertions intact. A focused run with this barrier passed 1/1. The complete regression rerun after the barrier passed 2185/2185, 0 fail, 0 skip, exit 0, with all fixture resources absent.

## Final verification

- CWD: repository root of the candidate worktree. Node: v24.19.0.
- Harness: `STAGE5E_RUN=synthetic-only`, `S1_RUN=synthetic-only`, unique external `STAGE5E_TAP_LOG`, then `node rehearsal/regression.js`. The launcher owns MySQL on loopback 33313, sets `LEDGER_MYSQL_TEST_URL` and fixture identity, and spawns the exact full command `node --test --test-isolation=none --test-reporter=tap` from the repository root. S1 uses a separate serial owned fixture on 33315.
- Pre-commit TAP: `%TEMP%/s1-final-full-c2da958a67a648c18afdda87496a1dab.tap`. Post-barrier TAP: `%TEMP%/s1-barrier-full-12d7f41b032b4a418085f08055d4ad40.tap`. Both recorded **2185 total / 2185 pass / 0 fail / 0 skip / exit 0**. The intervening uncorrected repeat is documented above and is not counted as a pass. Cleanup of the successful rerun reported runtime processes, MySQL process, databases, accounts and fixture root absent; SQL cleanup true.
- Discovery comparison: 1335 accepted top-level tests versus 1337 candidate; no old top-level test missing. The two added top-level tests and ten nested assertions are all S1; 2173 + 12 = 2185.
- S1 isolated real MySQL: 12/12, including two separate concurrent CLI processes with exactly one head and one receipt, dry-run zero writes, wrong target/confirmation, existing data/head, copied receipt refusal, trusted stock/approval and lost-acknowledgement replay.
- Existing production/restore/runtime real MySQL focused: 24/24. Stage 5E cutover/fault/recovery/cleanup integration: 1/1, zero skip.
- Syntax checks and `git diff --check`: pass. `npm test` was attempted, but PowerShell reported `npm` is not recognized; no npm test result is claimed.

## High-risk audit

Manual source and behavior review of the S1 diff found no remaining known P0 or P1 in this scope. It is not an independent review.

- Existing head or business rows: no reset, replacement or reinitialization. Exact same formal head/receipt/target/plan is read-only replay; conflicting or unaudited heads refuse.
- Wrong target: plan, runtime config, actual connection database and server UUID must match. Apply requires the exact target and plan digest confirmation, not a generic yes flag. Dry-run starts a read-only transaction and leaves no head, audit, revision or inventory effect.
- Concurrency and crash: database named lock plus unique head/receipt make concurrent CLI apply single-authority. Ledger head and receipt share a transaction. After lost commit response, the same plan reports already initialized. Trusted stock and approval replay use their original operation keys and produce no duplicate effect or revision.
- Inventory: `null` means not initialized and is never converted to zero by bootstrap. The existing authenticated trusted stock/consumableStock and approveInventory commands enforce principal, permission, operation key, expected revision, audit and effects. Partial opening inventory keeps readiness blocked. Ambiguous older identical stock-review replay returns no guessed request ID.
- Normal traffic: ledger and inventory readiness blockers come from database facts. The production API and device worker remain gated while incomplete. The CLI is the separate controlled initialization capability.
- Stage 5E preparation invokes S1 rather than direct initial ledger INSERT. Its fresh cutover, business, fault/recovery and cleanup test passed.

P0 = 0; P1 = 0; P2 = 0 remaining known in the reviewed S1 candidate. Real operator acceptance, real staff inventory values, production environment, provider and deployment remain outside this software verification.
