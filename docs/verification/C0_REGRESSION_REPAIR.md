# C0 final regression repair evidence

Baseline: codex/c0-financial-core at c83a674b676058fb2946d417fc99fafa4de0ee2a; main/origin/main 27aba1946d2411b9e2a27139e681d23954e7e546. No merge, push or deployment.

## Original official result

Frozen Node24.19.0, unchanged rehearsal/regression.js, S1_RUN=synthetic-only, STAGE5E_RUN=synthetic-only. 2648/2681 pass; 33 fail, zero skip/cancelled, exit1. The original external full-regression.tap is retained unchanged. Parent cascades are not separate defects.

## Four root-cause groups

| Group | Classification | Failed TAP results | Parent cascades |
|---|---|---:|---:|
| A | stale assertion contract | 6 | 1 |
| B | fixed-port harness collision | 2 | 0 |
| C | missing trusted drawer fixture | 24 | 1 |
| D | historical package identity fixture | 1 | 0 |

## All original failure results

| TAP | Test | Direct cause | Cascade | Group/type | File | Minimum repair |
|---:|---|---|---|---|---|---|
| 41 | attributes: rounding.self.excess remains an additional policy fact, not an approve permission or self-review permission | Legacy 45-action count/list omits six accepted financial actions | NO | A/TEST | auth/policy-attributes.integration.js | Assert explicit current command/grant contract; retain denial/default-role boundaries |
| 8 | MySQL 8.4 InnoDB auth integration in jbhh_ktv_test | Cascade from stale trusted-action count subtest | YES | A/TEST | auth/mysql-auth.integration.test.js | Assert explicit current command/grant contract; retain denial/default-role boundaries |
| 118 | C1-B: internal core does not expose staff HTTP commands | Old internal-only expectation contradicts accepted C3-A HTTP allowlist | NO | A/TEST | cashout-cancel.test.js | Assert explicit current command/grant contract; retain denial/default-role boundaries |
| 352 | C1-A: partial refunds reduce net receipts/adjustable balance, never billing credit/debt | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | financial-adjustments.test.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 353 | C1-A: direct execution replay preserves exact result and fingerprint/actor conflicts do not write | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | financial-adjustments.test.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 354 | C1-A: refundPayment request -> other approval -> original applicant execution exactly once | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | financial-adjustments.test.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 356 | C1-A: pending/approved requests reserve money, rejection releases it | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | financial-adjustments.test.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 357 | C1-A: rejection is audited without adjustment and frees the reservation | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | financial-adjustments.test.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 358 | C1-A: unqualified actor/approver and demo path cannot use financial authority | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | financial-adjustments.test.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 364 | C1-A: explicit refund funding CURRENT_DRAWER | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | financial-adjustments.test.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 368 | C1-A: actual execution at 2026-10-15T21:59:59.000000Z | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | financial-adjustments.test.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 369 | C1-A: actual execution at 2026-10-15T22:00:00.000000Z | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | financial-adjustments.test.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 371 | C1-A: serialized concurrent refundPayment / refundPayment | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | financial-adjustments.test.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 372 | C1-A: serialized concurrent refundPayment / reversePayment | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | financial-adjustments.test.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 376 | C1-A: unknown transaction error rolls back adjustment and request consumption | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | financial-adjustments.test.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 378 | C1-A: core commands deliberately have no employee HTTP exposure | Old internal-only expectation contradicts accepted C3-A HTTP allowlist | NO | A/TEST | financial-adjustments.test.js | Assert explicit current command/grant contract; retain denial/default-role boundaries |
| 382 | C1-A: partial reversal rejects and approved intent cannot be changed at execution | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | financial-adjustments.test.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 383 | C1-A: concurrent applications cannot reserve the same remaining money twice | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | financial-adjustments.test.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 384 | C1-A: concurrent executions consume the same approved request once | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | financial-adjustments.test.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 385 | C1-A: existing settle uses reversed billing credit, while refund does not create another amount to settle | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | financial-adjustments.test.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 511 | C2-A owned MySQL handover cash integration | Owned child fixture binds parent regression port 33313 | NO | B/HARNESS | ledger/trusted-cash-drawer.integration.test.js | OS-assigned loopback port for packages:false; retain ownership checks and cleanup |
| 512 | C1-B owned MySQL cashOut and cancellation integration | Owned child fixture binds parent regression port 33313 | NO | B/HARNESS | ledger/trusted-cashout-cancel.integration.test.js | OS-assigned loopback port for packages:false; retain ownership checks and cleanup |
| 474 | C1-A SQL refundPayment: atomic facts/result/audit, reconnect replay and original preservation | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | ledger/trusted-financial-adjustments.integration.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 476 | C1-A SQL refundPayment: approval is not execution, original applicant consumes once | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | ledger/trusted-financial-adjustments.integration.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 478 | C1-A SQL reservations block direct operations and rejection releases them | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | ledger/trusted-financial-adjustments.integration.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 480 | C1-A SQL real two-connection race refundPayment/refundPayment | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | ledger/trusted-financial-adjustments.integration.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 481 | C1-A SQL real two-connection race refundPayment/reversePayment | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | ledger/trusted-financial-adjustments.integration.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 483 | C1-A SQL failure after snapshot UPDATE rolls back fact/result/audit and leaves key retryable | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | ledger/trusted-financial-adjustments.integration.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 484 | C1-A SQL consumed request rolls back with financial fact when audit write fails | CURRENT_DRAWER refund fixture has no trusted opening count; rejected before expected fact/request | NO | C/FIXTURE | ledger/trusted-financial-adjustments.integration.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 514 | MySQL trusted clean vertical slice in jbhh_ktv_test | Cascade from seven failing financial SQL subtests | YES | C/FIXTURE | ledger/trusted-clean.integration.test.js | Generate valid opening drawer through trusted application, then seed test prehistory |
| 516 | trusted-enabled commands are independent from all other eligible and demo actions | Legacy 45-action count/list omits six accepted financial actions | NO | A/TEST | ledger/trusted-clean.test.js | Assert explicit current command/grant contract; retain denial/default-role boundaries |
| 1418 | Stage5E fresh MySQL cutover, business, faults, recovery and owned cleanup | Current six financial grants inserted into pinned historical package; principal validation throws, snapshot 500 | NO | D/FIXTURE | rehearsal/integration.test.js | Load permission and policy-attribute authority from validated historical package |
| 1572 | 权限定义基线：40 个唯一权限，岗位集合与关键角色不变 | Legacy 39-grant assertion omits six explicit financial grants | NO | A/TEST | shared.test.js | Assert explicit current command/grant contract; retain denial/default-role boundaries |

## Stage5E isolated diagnosis

The original integration independently reproduced 500 != 503 in 56.655 seconds, without the full-suite parent. A reduced login/snapshot probe returned owner=500 and operator/limited/viewer=200. A same-restored-database differential removed only the six unsupported synthetic fixture grants: order.cancel, cash.out, payment.reverse, payment.refund, financial.direct, financial.approve. The same owner session then returned200. The historical createTrustedPrincipal independently rejects the unsupported grant list with TypeError. This is a fixture authority mismatch, not a reason to relax production grants or accept500. The failed request itself took24ms in the sanitized runtime log; the approximately57-second enclosing duration includes environment/package/initialization/formal-start setup, not proof of timeout or suite throughput.

Two preliminary diagnostic probes are also retained: one changed the source DB rather than its restored copy, and another was rejected by the DB-target guard. Neither is counted as successful evidence; the final correctly bound differential passed. All owned fixtures report sqlCleanup=true and absent processes/databases/accounts/roots.

The snapshot contract remains200 when readable and503 for the existing temporary-not-ready condition. No status assertion or timeout was changed.

## Narrow repairs and verification

- Old tests now check the explicit financial command set and retain trusted/default-deny checks. Six new financial permissions still have empty default role grants.
- Only non-packaged synthetic fixtures may request port0. OS-selected loopback ports retain actual port, datadir and UUID ownership checks; packaged runtime and production port policy are unchanged. Focused execution keeps its parent bound to33313 while the child fixtures run and clean up.
- Opening drawer snapshots are generated by a synthetic authenticated handover command, with an asserted committed result. No handover fields/signatures are hand-written, and the original no-drawer fixture remains available for negative tests.
- The new owned MySQL test runs original payment -> refund request -> other-person approval -> original-applicant execution -> cash count -> projectFinancialReport. It checks original payment preservation, zero money facts before execution, same-key replay, one refund, one drawer outflow, independent current balance versus period changes, real occurredAt, next count not double-counted, and broken-chain null amounts.

## Current run results

Latest affected-case focused evidence:248/248 (170 assertion/drawer,76 owned MySQL/auth/port/cross-module,1 original Stage5E scenario,1 final historical authority login test), all zero skip/cancelled. The initial repaired Stage5E combined run passed the original scenario but failed the newly extended authority test because that test omitted f.source login-password binding. That test-only setup was corrected and its separate final run passed; both outputs remain retained. Original Stage5E duration135767.7403ms; final authority test33369.7039ms. Scoped npm test was attempted and unavailable.

Official single rerun PASS: 2696/2696; fail/skip/cancelled=0/0/0, exit0, duration735315.7177ms. Frozen Node24.19.0; S1_RUN=synthetic-only and STAGE5E_RUN=synthetic-only; STAGE5E_TAP_LOG points to the external full-regression-repaired.tap. Command: frozen node.exe rehearsal/regression.js; unchanged child args --test --test-isolation=none --test-reporter=tap. Stage5E original scenario PASS133526.324ms, historical identity/config/date authority PASS33360.6887ms; ENOENT absent. Parent owned fixture id03de37965aa15be5 cleaned with sqlCleanup=true, processes/databases/accounts/root absent.

Total increases by15 from the original2681: the two former startup failures now run their14 original child cases, plus the one new refund/reporting child case. No discovery filters or skips were introduced. The 13 changed JS files have identical SHA256 before and after the full run.

Latest focused evidence248/248 and the refund/reporting chain PASS; original33 failures classified and all four root-cause groups closed. No open P0/P1/P2 in this bounded repair. This permits only main merge review after the single local repair commit and clean-tree verification. No merge, push or production deployment.

External evidence directory: ktv-c0-regression-repair-90ca080d5f44481d9ed477716def8311. Retain original-33-classification.json, stage5e-initial.tap, stage5e-snapshot-probe.log, stage5e-authority-bound-differential.log, assertion-drawer-focused.tap, mysql-repaired-focused.tap, stage5e-repaired-focused.tap, authority-focused-final.tap, full-run-input.json, full-regression-repaired.tap, full-launcher-output.txt and full-exit.txt. Preliminary probe/setup failures are retained separately and never counted as passing evidence.
