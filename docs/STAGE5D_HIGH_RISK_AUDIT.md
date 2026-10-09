# Stage 5D high-risk audit — 2026-10-09

## Scope and disposition

Original candidate a8ad51a33aec96d43e14b8d246156c1e060c1fe9 on codex/p0-1-stage5d-monitoring-runbook; stable base e57af99dd49a46771ff20dd495f71f22d9db97ff. User's final monitoring audit only, with minimal fixes allowed. No real alert, deployment, initialization, provider control, merge, fetch or push. One local audit-fix commit follows the original candidate; its hash is in the final report.

Verdict: FIXED, NEEDS HUMAN RE-ACCEPTANCE. Original P0=0/P1=6; fixed6, remaining P0/P1=0 after independent source recheck and runtime evidence described below. The raw-message issue demonstrates a logging API gap, not an observed real credential disclosure.

## Standards axis — independent review

1. P1 stale replacement runtime: state was cached before writer ownership, allowing predecessor's later incidents/attempts to be overwritten. Reload checksummed state after acquiring ownership, before any runtime write.
2. P1 contradictory readiness sources: raw DB readiness could resolve a required-channel incident and next HTTP health check reopened it. Both paths now combine the same operational blockers; current snapshot also checks them.
3. P1 raw message in safe logger: arbitrary plain-object message could contain an unconfigured token. Operational message/action/runbook must now exactly match the fixed event definition; unknown raw messages are dropped.

Recheck found no remaining P0/P1 in changed hunks. Duplicated readiness policy was a P2 judgement call; only the demonstrated divergence was corrected, without general refactoring.

## Spec axis — independent review

1. P1 retry budget persisted after send: crashes before recording result permitted unlimited physical attempts. Each attempt and backoff are atomically reserved before calling transport; final attempt is durably exhausted even if process dies during send. Same deliveryId/sequence survives.
2. P1 no-policy overdue: absent production backup policy could still produce a CRITICAL overdue from the default age. Missing policy now remains an explicit blocker/incident; policy=NOT_CONFIGURED and overdue=null. Configured policy still detects overdue.
3. P1 partial mailbox starved monitor loop: final filename was visible before report completed; parsing failure could prevent every later source forever. Publish with temp/fsync/close/rename; process valid reports independently and isolate each collector's failure boundary.

Recheck found no remaining P0/P1 in fixes. Nonblocking P2: invalid reports are retained for evidence and only50 names are read each cycle. At least50 invalid sorted-first reports can delay later valid reports; monitoring explicitly degrades and unrelated probes continue. Technical staff must preserve and inspect those exact generated reports, then move confirmed invalid reports to a protected external incident folder with service stopped. Never delete business/audit data to clear the signal. No automatic cleanup of invalid evidence is introduced.

## Verification

- New regression first failed original candidate:6 failures/7 tests, proving all five original runtime defects and raw-message gap.
- Final focused command: node --test --test-isolation=none --test-reporter=tap operations/audit.test.js operations/audit.integration.test.js operations/lifecycle.test.js operations/runtime.test.js operations/drills.integration.test.js production/runtime.integration.test.js production/runtime.test.js recovery/cli.test.js
- Focused32 total/32 pass/0 fail/0 skip/exit0.
- Actual three separate Node processes were killed during physical send; attempts1/2/3 persisted, fourth send did not occur.
- Real MySQL8.4.11/InnoDB: three trusted retail transactions commit order/payment/inventory before throw/timeout/negative ACK. Committed head stays byte-equivalent after alert failure; other telemetry transitions do not change revision.
- Existing DB disconnect/native-host crash/restart/original-resolution drill passed, plus current backend.view revocation denies next admin snapshot and staff never receives operations.
- Nested arrays/objects, casing variants, raw token/DB error text are absent from logs/events/incidents/outbox/admin/Fake payload.
- Recurrence creates a new incident, rooms/workflows remain distinct, abort preserves atomic state, active/pending survive retention, serial polls do not overlap, planned stops do not increment crashes, crash-loop survives fresh runtimes.

- Full on the final repaired working tree: node --test --test-isolation=none --test-reporter=tap;2157 total/2157 pass/0 fail/0 skip/0 cancelled/exit0;223510.0365ms. Real MySQL8.4.11/InnoDB on owned loopback33313. Full after merge=NOT RUN because audit findings require NO MERGE/NO PUSH and human re-acceptance. Full TAP retained outside Git at C:/Users/KAMABOKO/AppData/Local/Temp/ktv-stage5d-audit-full.tap.
- Browser re-acceptance: PASS for this fix's narrow admin incident projection/lifecycle scope, actual Edge154 HTTPS with a temporary locally trusted CA; no certificate-warning bypass, network mock or real alert/provider was used. Capture df638e7590ab2,45 requests/16 operations, no dropped evidence.
- Actual DOM login and official POST /api/v1/auth/login returned200 (n41); GET /api/v1/auth/session200 (n42); GET /api/v1/admin/snapshot200 (n43) displayed BACKUP_FAILURE OPEN, incident2db95d50-4b71-4f31-85c1-5ae74e29af96. A verified isolated MySQL backup reported success; actual DOM refresh then session200 (n44)/snapshot200 (n45) displayed the same incident RESOLVED and BACKUP_OVERDUE RESOLVED. Revision remained0. Short-lived synthetic TLS correctly remains its own TLS_EXPIRING OPEN incident.
- Runtime: no uncaught exception, unhandled rejection or module failure. Console retained expected unauthenticated session401, three login401 caused by initial synthetic credential preparation ordering (corrected before successful login), existing nonblocking favicon404 and separately attributed extension chrome-extension://invalid/ failure. This is not a claim of zero console entries or a new whole-UI acceptance.
- Evidence retained outside Git: C:/Users/KAMABOKO/AppData/Local/Temp/ktv-stage5d-audit-browser-1791553818966/browser-evidence.json plus active/resolved DOM observations, console and safe operation projection. Browser session stopped; fixture/users/database cleaned; temporary CA absent from CurrentUser Root; synthetic credential/control files removed. Transport CONFIGURED in this fixture refers only to injected FakeAlertTransport, not a real delivery channel.
- npm test attempted this run: exit1 because npm is not recognized in this environment; direct Node focused/full results are separate evidence.

- Final cleanup verified test database tables=0, synthetic restore databases=0, synthetic fixture SQL users=0; only the owned MySQL33313 process was shut down normally. No MySQL84 or production service was changed.

## Operational authority and boundaries

No migration added: MySQL migrations001–011 remain the sole business schema authority. Operational state is separate protected local telemetry; DB outage is persisted locally at outage time, not claimed to be stored in unavailable MySQL. Recommendations are text only, never automatic restore/payment/device control. Public health endpoints expose safe fixed readiness metadata only; authenticated admin data remains protected.

Same-host total outage detection=NOT SOLVED. EXTERNAL HEARTBEAT / HOST-UPTIME MONITOR=NOT CONFIGURED; this remains a14-day offsite production blocker. REAL ALERT CHANNEL=NOT CONFIGURED; REAL DEPLOYMENT=NOT EXECUTED; KTVSKY LIVE PRODUCTION CONTROL=OFF. PRODUCTION READY=NO;14-DAY OFFSITE MVP READY=NO. Stage5E not started.
