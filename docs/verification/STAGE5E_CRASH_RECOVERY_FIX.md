# Stage 5E crash-recovery audit fix — 2026-10-10

Status: FIXED, NEEDS HUMAN RE-ACCEPTANCE. Local Stage 5E branch only; no merge/push.

## Root cause and original evidence

TEST HARNESS BUG. Original candidate: 5e2c33eee0390117c17e0e88d4f150374075ed90.
The original full run had 2172 tests / 2171 pass / 1 fail / 0 skip / exit 1.
Failure: rehearsal/integration.test.js, "Stage5E fresh MySQL cutover, business, faults, recovery and owned cleanup";
runtimeCrashAndHostLoss -> post-crash query recovery. The inner wait was 20000 ms;
the outer integration timeout was 240000 ms. Failure occurred after successful
old-process exit, new-process readiness and session recovery, not at spawn/DB/cleanup.

The workflow persisted an in-flight query claim with the production 30000 ms lease.
Crashing between query claim and evidence commit leaves that claim valid. The new
worker correctly refuses to steal it. The harness incorrectly expected ACTIVE
within 20 seconds regardless of the remaining lease. A historical green run does
not disprove this timing-dependent test defect.

Five independent original-condition runs passed (recovery 605, 807, 808, 805,
602 ms; total 44.56, 42.45, 38.88, 35.45, 42.51 seconds). These alone do not classify
the failure as transient. A targeted crash during a persisted query claim reproduced
the same 20-second timeout: old PID 4044 exited, new PID 17168 was ready 987 ms
later, session recovered, lease remaining was 28960 ms. With no code/clock changes,
the workflow recovered at lease expiry in 29597 ms. One open, no duplicate side
effects and business revision 41 -> 41. A deterministic committed regression was
also run red before the fix (1 fail / 0 skip).

Original TAP copy (Git-external): stage5e-crash-original-20261010.tap,
SHA256 F602043E168AD5AAA6AA7445ECE13913A4EA5AE375F78A90A244231DB26F3421.
Targeted timing evidence: stage5e-crash-lease-probe-20261010.json.

## Minimal repair

Only rehearsal code changes. No domain, production lease, worker, schema, HTTP,
payment/replay, settlement, clean or employee UI changes.

- launcher.js: Fake child readiness waits for the new process runtime_started event,
  not an early listening/health response during operational startup. Per-spawn output
  and state are reset and late output from the old child cannot satisfy the new wait.
  During initial repetitions one login got 503 before recovery began; it was retained
  as a startup prerequisite race and the consecutive pass counter was restarted.
- runtime-child.js: an explicit FakeGateway query barrier holds the claimed query
  until abort/process death, allowing deterministic crash timing.
- crash-recovery.js: only after a registered owned child has exited and a different
  registered child is live, read the crashed claims and advance the owned synthetic
  clock to their persisted lease boundary. Never clear claims, write workflow state,
  shorten production leases or infer provider success.
- scenarios.js: record persisted workflow state after the awaited crash and use
  that boundary before the unchanged 20000 ms query-recovery wait.
- crash-recovery.integration.test.js: real isolated MySQL 8.4.11/InnoDB, actual
  SIGKILL/restart, persisted lease fencing before expiry, query first after expiry,
  same workflow/order/principal/operation/fingerprint, one open, no payment/inventory/
  order changes, unchanged revision and owned cleanup. Live-child clock advance rejects.

## Current-run verification

Focused deterministic crash recovery: 5/5 consecutive PASS, each 1 test / 0 fail /
0 skip / exit 0. Recovery times: 605, 604, 604, 603, 606 ms.
Total command durations including fresh MySQL/artifact/bootstrap/cleanup: 36.707, 36.762, 36.854, 33.755, 34.921 seconds.
Full regression: node --test --test-isolation=none --test-reporter=tap, launched
through rehearsal/regression.js with STAGE5E_RUN=synthetic-only and fresh owned MySQL.
2173 total / 2173 pass / 0 fail / 0 skip / exit 0; duration 381466.2072 ms.
Both the new deterministic regression and the original full Stage5E integration
executed (neither skipped). All three owned fixture roots/processes/databases/accounts
were removed, including the outer suite fixture.

Final isolated verification after the full suite: 1 total / 1 pass / 0 fail /
0 skip / exit 0; command duration 34642.0577 ms, test duration 34489.7159 ms.
Old PID 26600 -> new PID 16356; HTTPS port 59434, owned MySQL port 33315.
The unexpired claim fenced the new process; crossing its persisted deadline via the
synthetic clock recovered in 602 ms. Revision 41 -> 41; same order/workflow/actor,
mutation retries 0; payment/inventory/order state unchanged. Owned cleanup passed.

Git-external evidence in the Windows user Temp directory:
- stage5e-crash-stable-run1-20261010.tap through run5 (five consecutive green runs).
- stage5e-crash-audit-full-20261010.tap and its runner log (full suite and outer cleanup).
- stage5e-crash-final-isolated-20261010.tap (post-suite isolated test and cleanup).

npm test was attempted after JavaScript edits; npm is unavailable. The supported
Node test command is used with the existing explicitly owned synthetic MySQL harness.

## Browser and cleanup

Human-accepted FINAL BROWSER PAYMENT / SETTLEMENT / CLEAN = PASS is retained.
Record d17e2cc406c94 (Edge 155): 10 + 168 yuan, same-key recovery without duplicate
payment, settlement, clean, admin state/revision cross-check and logout. No browser
module was changed by this fix; repeating that business flow is unnecessary.

Temporary CA 187705BC54B3BE3A9DA978ACE894718B0FBA888E was deleted through certutil
with exact full thumbprint; matching CurrentUser/Root certificate count is 0.
Original browser fixture and both original regression fixtures are absent; no old
33313/33315/56947 listener or test driver/MySQL/runtime process existed before the
independent reproduction. New fixtures have unique owned roots and are cleaned in finally.
Final exact CA count remains 0. No listeners remain on 33313, 33315, 56947 or the
final test HTTPS port 59434; no matching rehearsal runtime/MySQL/debug-driver
process remains. This turn's temporary debug driver scripts were removed; TAP/JSON
evidence is retained outside Git. An older 08:08 fixture directory,
ktv-stage5e-470720fbef33d117, still exists with an ownership marker but no running
process. It is not one of this turn's fixtures; its provenance was not established,
so it was preserved instead of deleting unknown prior data.
Shared BrowserSkill/browser resources are not terminated.

This is synthetic rehearsal evidence, not real production readiness. Real
initialization/deployment/provider control remain unexecuted. No Stage 5F.
