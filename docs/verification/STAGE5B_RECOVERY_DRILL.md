# Stage 5B recovery drill evidence

Date: 2026-10-09 Asia/Shanghai (database timestamps below use UTC). Candidate branch: codex/p0-1-stage5b-backup-recovery. Accepted base: b188df811926bf4d6cf6c535d1a186ff270e699c. Commit1: 6442e6a42efb8b5f8d068beedc1e17ee9c32e7f4. This record describes the submitted working-tree implementation before Commit2; the backup manifest records the actual committed HEAD at capture time. No backup artifact or credential/hash dump is committed.

## Real MySQL scope

Owned loopback MySQL 8.4.11/InnoDB on port33313, source jbhh_ktv_test, separate unique jbhh_ktv_restore_drill_* target. All accounts/employees/orders/mappings are synthetic. FakeGateway only. The harness checks datadir ownership, takes the common fixture lock, refuses existing source tables, and removes only its own tables/targets/artifacts after verification. Nothing is sent to KTVSky; production live control remains OFF.

## Full scenario and evidence

- Build two principals/employees, including a disabled account, exact grants/policy attributes/scrypt credential versions and binding events. Seed synthetic opening inventory1000 and one uncounted count=null.
- Through trusted commands create eight orders: settled room with multiple payments and rounding, ordinary active room, approved credit with approved repayment, retail, and four device-controlled orders. Preserve five payment identities/timestamps/actors and nine inventory effects. Create handover facts.
- Backup at revision23 using a single repeatable-read snapshot; schema001-011/twenty tables and SHA-256 verify. A separate backup test commits a concurrent source command during table export and proves no torn snapshot.
- After the snapshot, the original worker completes an OPEN that was not in the backup. Commit a further source command at revision24. Freeze/drain, close the old application's source connection pool and prove it is unavailable. This is application connection-loss simulation, not physical disk/server failure. A separate inspection connection remains for proving the source unchanged by restore.
- Restore to an empty separate database, preserving eighteen business/auth tables cell-for-cell. No DDL or INSERT targets the source. The restore target is VERIFYING. Formal HTTP composition reads the target; static / is200, auth/session/login and commands are503 recovery_in_progress. Guarded trusted writes, login and actual worker ticks cannot dispatch.
- Readonly checker accepts original data and rejects duplicate/overlapping orders, broken room reference, invalid inventory count, duplicate payment IDs and broken workflow relationship. A changed restored workflow blocks verify and remains VERIFYING. A postverification employee change blocks explicit resume until the exact verified data is restored.
- Verify revokes one old session with recovery-cutover audit; old raw session no longer authenticates. Fence all four nonterminal workflow claims and increment their versions. READY_FOR_RESUME still denies writes/login. Explicit resume switches NORMAL.
- Fresh synthetic login works. First new trusted command commits23->24 with audit. Replay historical sale operationKey K with the same authenticated actor/request returns the exact original terminal result; state/revision/operation/audit digests do not change. T2 source transaction is absent from restored operations.
- Actual restored worker ticks: ACK pending, genuine UNKNOWN and OPEN-after-previous-CLOSE-ACK reconcile by query with zero new open/close. Offline WAITING_DEVICE dispatches zero; once online with synthetic safe proof, the same workflow/order proceeds to ACTIVE with one legal combined OPEN. No duplicate order/payment/inventory effect or ledger revision is produced by worker progress.

## Browser smoke: real Edge154

browser-skill Agent Window, session bblt, capture d4540bf88801a; isolated formal page http://127.0.0.1:4185/. Captured request d4540bf88801a:n47: GET /api/v1/auth/session ->503 application/json, error.code=recovery_in_progress, with requestId.

Observed real DOM: title 金碧辉煌 · 门店助手; heading 暂时无法连接; detail 无法读取正式营业状态; generic server error with correlation ID; only reconnect control. No room/order business controls or demo/localStorage business fallback appeared. This is recovery-page smoke evidence, not repeat acceptance of Stage3B/3C UI or authenticated cutover behavior.

Runtime evidence: no observed uncaught exception/unhandled rejection/module failure. Expected auth/session503 console entry; favicon.ico404; chrome-extension://invalid error separately attributed to extension. No application changes were made for favicon/extension errors. An attempted reconnect click was not dispatched because PowerShell consumed the unquoted ref; no reconnect success is claimed. Capture stopped/exported outside Git and Agent Window closed. The synthetic server/fixture was then removed.

## High-risk implementation audit

Targeted implementation self-review, not a claim of a separate independent human audit. Final unresolved P0=0, P1=0 within this test-only scope.

| Risk | Evidence / result |
| --- | --- |
| Source overwrite | Test-only target prefix, source inequality, exact server/store/ledger/checksum acknowledgment, nonempty refusal. Restore never targets source. PASS |
| SQL before checksum | Tampered/truncated/future-schema/migrationVersion/embedded-store artifacts reject even with an invalid target URL, before connector use. PASS |
| Wrong store | Manifest identity plus embedded bootstrap receipts and head metadata checked before SQL; exact cells checked again before cutover. PASS |
| Old sessions valid | Existing revoked_at semantics, auth events and fresh login requirement. PASS |
| Revision reset / key lost | R23 preserved, new commandR24, historical sale replay unchanged. PASS |
| Payment identity regenerated | Exact restored cell/state comparison includes IDs, occurredAt, actors, methods and amounts. PASS |
| Inventory null coerced | Exact restored state preserves null and stock/effect history. PASS |
| UNKNOWN / ACK resend | Restored worker query-only, mutation counts0. PASS |
| Previous CLOSE ACK reused for OPEN | Implementation audit found this dangerous recovery-preparation gap; fixed to recognize ACK only for current step. Original source OPEN after backup, restored query succeeds with no new mutation. PASS |
| Worker before verification | Formal default guard and actual paused worker tick produce zero provider calls. PASS |
| Freeze races | Explicit advisory lock plus SQL control lock drain concurrent provider dispatch and an open guarded transaction before FROZEN confirmation. PASS |
| Invariant failure / half-import | Restored-cell mismatch stays VERIFYING; SQL import failure rolls back business rows and remains FAILED/nonempty. No automatic wipe. PASS |

Privileged direct SQL/administrative CLIs and cross-server fencing remain operator responsibilities. Production restore is disabled. Windows ACL/encryption/offsite scheduling/retention/cutover are not tested or configured, and are production gates rather than inferred passes.

## Tests

Focused final command:

```text
node --test --test-isolation=none --test-reporter=tap backup/format.test.js backup/mysql-backup.integration.test.js recovery/gate.test.js recovery/drill.integration.test.js
18 total /18 pass /0 fail /0 skip /exit0
```

Commit1 combined schema/bootstrap/backup focused run:35/35,0fail,0skip,exit0. npm test was attempted and unavailable (command not found). It is not treated as test success.

Final full regression: node --test --test-isolation=none --test-reporter=tap; 2109 total, 2109 pass, 0 fail, 0 skip, exit0; duration145.554 seconds. Full TAP logs, raw browser export and generated artifacts remain outside Git.

## Final observed drill timing (UTC)

```json
{
  "result": "PASS",
  "mysqlVersion": "8.4.11",
  "source": "jbhh_ktv_test",
  "target": "jbhh_ktv_restore_drill_muzq7kwv",
  "backupRevision": 23,
  "resumedRevision": 24,
  "backupChecksum": "5420ea6a15c460e878d608a5f5c7a678d6c150566fc34befd7f5967fab57ed24",
  "counts": {
    "accounts": 2,
    "employees": 2,
    "orders": 8,
    "payments": 5,
    "inventoryEffects": 9,
    "operations": 23,
    "workflows": 4
  },
  "oldSessionsInvalidated": 1,
  "workflowsFenced": 4,
  "marks": {
    "backupStart": "2026-10-08T16:03:39.920Z",
    "backupComplete": "2026-10-08T16:03:39.964Z",
    "freezeStart": "2026-10-08T16:03:40.036Z",
    "failureSimulatedAt": "2026-10-08T16:03:40.050Z",
    "restoreStart": "2026-10-08T16:03:40.063Z",
    "restoreComplete": "2026-10-08T16:03:40.753Z",
    "verificationStart": "2026-10-08T16:03:40.843Z",
    "verificationComplete": "2026-10-08T16:03:40.891Z",
    "resumeReady": "2026-10-08T16:03:40.891Z",
    "resumedAt": "2026-10-08T16:03:40.954Z"
  },
  "backupCreatedAt": "2026-10-08T16:03:39.923331Z",
  "observedRpoMs": 127,
  "observedRtoMs": 855,
  "deviceMutations": {
    "ack": 0,
    "unknown": 0,
    "waitingAfterSafeProof": 1,
    "previousCloseAck": 0
  },
  "noLiveProvider": true
}
```

Observed RPO127ms is the backup snapshot to simulated failure interval; T2 data is intentionally absent. RTO855ms is freeze start to resume-ready, with actual explicit resume at918ms after freeze. Restore took690ms and verification48ms for this small local synthetic dataset. This is not a production SLA, capacity benchmark, physical disaster test or assurance of production cutover safety.
