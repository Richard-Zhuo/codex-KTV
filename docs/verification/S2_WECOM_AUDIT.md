# S2 WeCom candidate synthetic verification and high-risk audit

Base: accepted main/origin/main 6b713f52accda8b3292959ed4fea8b2690c2b78f. Candidate branch: codex/p0-1-prod-blocker-s2-wecom-alerts. Scope is the real-alert transport blocker only. No production deployment, credential installation, real WeCom request, KTVSky mutation, merge or push occurred.

## Self-audit

| Risk | Candidate control and evidence |
|---|---|
| Secret or token leakage | Stage 5C protected secret file and ACL validation are reused; token stays in process memory. Fixed error codes omit raw provider body, URL and errmsg. Safe logger allowlist and redaction tests cover output. |
| Wrong recipient / recovery drift | Routing follows severity policy. Recipients and text are stored with each outbox delivery before send; accepted recipients are stored with the incident. Recovery uses accepted plus possibly notified recipients. A removed historical user must remain on the explicit protected recovery allowlist. |
| Crash after provider acceptance | Pre-send uncertain marker persists. A synthetic process-crash test proves later RESOLVED still targets the original owner when success persistence was interrupted. |
| False success | HTTP 200 alone never succeeds without errcode zero. Partial invalid/unlicensed recipients preserve accepted subset and mark the delivery failed. |
| Unbounded retry / token stampede | Existing outbox owns three attempts and 30/60-second backoff. Token cache refresh is singleflight; confirmed invalid token permits one controlled resend only. |
| Silent local/Fake fallback | Formal production entry constructs only the validated WeCom client when configured. Required missing channel remains blocked. |
| Business rollback coupling | The independent operational store remains outside the MySQL business transaction. A guarded real-MySQL test exercises committed order/payment/inventory followed by synthetic WeCom rate limit. |
| Accidental startup smoke | Preflight validates protected configuration and reads SQL facts without sending a WeCom message. Startup does not generate a synthetic test message. |
| Mobile ordering and duplicate claims | Local stale pending work is superseded. The provider duplicate check is enabled, but provider acceptance and phone display are distinct; exactly-once and strict mobile order are not claimed. |

This is author self-audit, not independent review. No P0/P1 source finding remains identified in this audit. The provider's real phone delivery and current owner credential setup remain unverified and are a separate human gate.

## Evidence

Focused synthetic WeCom/operations/production configuration suite: 29/29 PASS, 0 fail, 0 skip, exit 0. Frozen-candidate full comparable regression: 2200/2200 PASS, 0 fail, 0 skip, exit 0, using node --test --test-isolation=none --test-reporter=tap inside rehearsal/regression.js. Its guarded fixture cleanup reported runtime processes, MySQL process, databases, accounts and root all absent. The accepted S1 baseline was 2185/2185; 15 additional tests are present in this candidate. The Stage 5E synthetic rehearsal passed in this run. TAP evidence is in a Git-external temporary file named ktv-s2-frozen-20261010212805.tap; this name is evidence only and no secret values are recorded here. npm test was attempted and the command is unavailable on this host; direct Node results are separate evidence. Stage 5E and S1 use the repository's owned disposable MySQL 8.4.11/InnoDB launcher. No real WeCom call is part of any automated test.