# Historical Stage 5D implementation evidence — 2026-10-09

Superseded for acceptance by [high-risk audit and minimal fixes](STAGE5D_HIGH_RISK_AUDIT.md). Results below apply to the original implementation candidate.

## Candidate and scope

Local branch codex/p0-1-stage5d-monitoring-runbook, accepted stable base e57af99dd49a46771ff20dd495f71f22d9db97ff. No merge, push, deployment, real initialization, real alert or provider operation. Implementation evidence awaits human acceptance.

Existing local commits: e2da08c18737c8dba54c25ea88e0b8f48b6a2118 (incident foundation), c424f0eafa1edd8a5e0214d7a1caa5dae6ad1569 (alert/runtime/admin integration). The following linear local commit contains the runbook, actual native-host/MySQL drills and final recovery corrections. Its hash is reported after committing; this file does not embed its own hash.

## Automated verification

Focused command:

```text
node --test --test-isolation=none --test-reporter=tap operations/lifecycle.test.js operations/runtime.test.js operations/drills.integration.test.js production/runtime.integration.test.js recovery/cli.test.js
```

Final focused:19 total,19 pass,0 fail,0 skip,exit0. npm test was attempted but npm is unavailable; no npm result is claimed.

Required full command:

```text
node --test --test-isolation=none --test-reporter=tap
```

Final full run:2148 total,2148 pass,0 fail,0 skip,exit0; duration215520.69ms. Executed after final JavaScript changes.

## Isolated drills

| Drill | Actual action/evidence | Result |
|---|---|---|
| A DB outage | Lock only synthetic DB account; kill only its owned connections. Readiness/command503. Repeated probes produce one incident and Fake notification. Unlock restores readiness and resolves original ID. | PASS |
| B DEVICE_UNKNOWN | Trusted synthetic open commits once. Fake applies open then loses response. Query recovery becomes ACTIVE, incident resolves, mutation count does not increase; head/inventory unchanged by telemetry. | PASS; retry0 |
| C crash/restart | Kill actual native-host child during DB outage; restart with DB still unavailable. Same incident ID survives; PROCESS_FAILURE recorded. DB recovery resolves original; revision/checksum unchanged. | PASS |
| D backup failure | Actually create/verify isolated backup, then attempt unavailable destination. Failure opens incident and preserves last verified-success timestamp. | PASS |
| E certificate | Isolated certificate near two days expiry triggers CRITICAL. Unit tests cover30/14/7-day escalation/recovery without changing system clock. | PASS |
| Delivery failure | Bounded failure/backoff/exhaustion, hanging send not resent in process. Recovery supersedes stale retries; persisted sequence rejects older/duplicate delivery. Required channel failure blocks visibly. | PASS |
| Scope/secrets | Current backend.view removal denies admin; staff has no operations. Logs/incidents/payload omit synthetic secrets, paths, raw errors. Rotation protects unrelated files. | PASS |

Owned loopback33313 MySQL8.4.11/InnoDB, generated restore databases, synthetic accounts/TLS, FakeGateway and FakeAlertTransport only. No production data or KTVSky operation. After the final run, test-schema tables=0, generated stage5c restore databases=0 and fixture users=0 were verified before shutting down the task-owned33313 MySQL instance. Browser harness/synthetic credential/control files were removed; redacted evidence retained.

## Real Edge HTTPS smoke

Browser-skill record d9c5f20bdb64e, Edge154, isolated https://ktv-smoke.127.0.0.1.sslip.io:59943/admin. Performed on Stage5D working candidate based on c424f0e; later changes correct alert ordering/readiness lifecycle and add tests/docs, without changing inspected admin UI. No exact-final-commit rerun or whole Stage5C browser acceptance is claimed.

- n37 formal POST /api/v1/auth/login200; n38 GET /api/v1/auth/session200.
- n39 GET /api/v1/admin/snapshot200: safe view.operations and visible OPEN BACKUP_FAILURE.
- Actual verified isolated backup, then real DOM refresh.
- n41 GET /api/v1/admin/snapshot200: same incident df1dd0ea-bd9f-4a45-9591-0c5ee1a341f7 visibly RESOLVED, last verified backup time present, revision remains0.
- No uncaught exception, unhandled rejection or module failure. Expected initial401; existing favicon.ico404 is non-blocking; chrome-extension://invalid/ failure is extension-only.
- Rendered operational summary has no password/token/Cookie/SQL/provider body/internal path.
- Browser session stopped and capture exported. Temporary CA DB4E3F2580B4FB6DE54B7A8C394EA3DAC07A9E4B removed; user confirmed and Windows CurrentUser Root absence verified.

External evidence: active-observation.json, resolved-observation.json, resolved-operations.json, snapshot-requests.json, browser-evidence.json in task-generated ktv-stage5d-browser directory. No evidence/runtime artifacts committed.

## Targeted high-risk review

Author review; no independent reviewer claimed. Checked storm/dedup, restart loss, ledger revision/rollback isolation, secrets, UNKNOWN retries, verified backup timestamps, resolution and cleanup scope. Two recovery risks found and regression-tested: delayed opening alert after RESOLVED, false generic READINESS_RESTORED during DB outage. Fixed with superseded stale delivery, monotonic sequence and resolving readiness only when actually ready.

Remaining P0=0/P1=0 within this review. P2: favicon404. Future real receiver must deduplicate deliveryId and reject older incident sequences. Whole-host outage requires an independent monitor; internal monitoring cannot send while host is down.

## Remaining gates

REAL ALERT CHANNEL=NOT CONFIGURED; REAL DEPLOYMENT=NOT EXECUTED; PRODUCTION CUTOVER=NOT DONE. No real staff/inventory/mapping initialization. KTVSKY LIVE PRODUCTION CONTROL=OFF. PRODUCTION READY=NO;14-DAY OFFSITE MVP READY=NO. Next Stage5E Production Cutover Rehearsal after human acceptance; not started.
