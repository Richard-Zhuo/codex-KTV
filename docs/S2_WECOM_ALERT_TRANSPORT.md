# S2 WeCom self-built application alert transport

## Pre-production standalone phone smoke CLI

This tool is separate from the formal production runtime and does not relax its DB, TLS, service account or readiness gates. It reuses the S2 WeCom client, safe formatter, incident and outbox. No business server, database, ledger, inventory, device worker or KTVSky is started.

Protected JSON: C:\ProgramData\JbhhKtv\private\wecom-smoke.json. Pre-create a protected state directory at C:\ProgramData\JbhhKtv\private\wecom-smoke-state. Both locations must be outside Git. The JSON has exactly these fields:

~~~json
{
  "configVersion": 1,
  "storeLabel": "<DISPLAY_STORE_NAME>",
  "corpId": "<ENTER_LOCALLY>",
  "agentId": 0,
  "secret": "<ENTER_LOCALLY>",
  "criticalRecipients": ["<OWNER_USER_ID_ENTER_LOCALLY>"],
  "warnRecipients": ["<SAME_OWNER_USER_ID_ENTER_LOCALLY>"]
}
~~~

The shown 0 is an invalid placeholder; replace agentId with the actual positive integer before validation. The sole user ID must be the same in both arrays; all/broadcast/department, empty lists and multiple recipients are refused. Do not put access_token in the file. Edit the protected file locally without placing credentials in shell history, chat or Git. The token stays in process memory. The protected state holds the synthetic incident/outbox and recipient snapshot, never the Secret or token.

The smoke ACL policy requires disabled inheritance on the config file and state directory; owner must be the current interactive operator, SYSTEM, or Administrators. Allow ACEs may grant only those three SIDs. The current operator must have file read and a state-directory Modify Allow ACE (FileSystemRights mask 197055) with ObjectInherit. This covers child creation, read/write and deletion for atomic replacement; the Windows integration test also exercises first write, replacement, reload and cleanup. The writer creates each temporary file inside that directory, disables its inheritance while preserving only the approved inherited ACEs, verifies its ACL before writing state bytes, then fsyncs, closes, atomically renames and verifies the final file ACL. Both temporary and authoritative state are protected. A crashed temporary file is ignored as state and safely removed under the writer lock on the next send command. Existing operational-state.json must itself pass the protected file ACL policy. The static rights check does not create a probe file during --validate-only. Users, Authenticated Users and Everyone Allow ACEs are rejected. The production Stage 5C policy still requires its formal service account SID and is unchanged. The smoke does not require NT SERVICE\JbhhKtv to exist.

Commands from the app root, in a local operator PowerShell session:

~~~powershell
node production/wecom-smoke-cli.js --config-file "C:\ProgramData\JbhhKtv\private\wecom-smoke.json" --validate-only
node production/wecom-smoke-cli.js --config-file "C:\ProgramData\JbhhKtv\private\wecom-smoke.json" --send-open
# Only after the owner confirms the OPEN message on the intended phone:
node production/wecom-smoke-cli.js --config-file "C:\ProgramData\JbhhKtv\private\wecom-smoke.json" --send-resolved --open-phone-confirmed
~~~

Validation checks the protected config and state directory, schema, ACL and recipient policy. It never obtains a token or calls the provider. OPEN sends one synthetic WARN, records its incident, delivery ID, sequence and recipient in protected outbox state, then stops. A definite provider rejection can be reviewed and retried with the same command after the existing 30/60-second backoff; at most three attempts. A timeout, connection reset, ambiguous HTTP/response failure or crash with uncertain acceptance reports SMOKE=INCONCLUSIVE and PROVIDER_RESULT=UNKNOWN. Only an explicit provider rejection is reported as REJECTED. It preserves the same incident, delivery ID, sequence, recipient and message, and a repeat smoke command refuses automatic resend. The operator must check the phone and existing state first. An UNKNOWN OPEN does not qualify for RESOLVED under this smoke contract, even if the phone appears to have received it; complete a new separately controlled smoke after resolving the ambiguity. Provider acceptance does not prove phone receipt. Only after human phone confirmation should the RESOLVED command run. RESOLVED uses the same incident and recipient with a later sequence; if delivery fails, the same RESOLVED command can retry the pending delivery. A completed step refuses replay. The two messages clearly identify themselves as channel tests, not business faults. CLI exit code 0 means provider accepted, 1 means blocked or rejected, and 2 means inconclusive/unknown; neither success nor unknown claims exactly-once phone delivery.

The state directory is deliberately distinct from production operational state. Protect and inspect the file/directory ACLs locally before sending. Do not share console captures containing a live account identifier. CLI output contains fixed status, recipient count and synthetic incident/delivery IDs; it never prints the Corp ID, User ID, Secret, access token, raw provider response or request URL. Automated tests inject synthetic HTTP only and never contact WeCom.

Status: local S2 candidate only. The final pre-send safety audit passes on synthetic evidence (2220/2220 full regression); the operator must rerun --validate-only against the existing protected directory because its ACL now requires Modify with ObjectInherit. S1 is accepted and merged at 6b713f52accda8b3292959ed4fea8b2690c2b78f. S2 needs human acceptance and a separately approved real phone smoke. S3-S5 remain open. Production ready: NO. 14-day offsite MVP ready: NO.

## Boundary

The production entry selects wecom-app only when the protected runtime config requests it and the protected secret block validates. operations/wecom.js owns two fixed WeCom API calls: GET /cgi-bin/gettoken and POST /cgi-bin/message/send at https://qyapi.weixin.qq.com. The provider URL cannot come from an event. This first release sends text only.

The existing independent incident/outbox lifecycle owns deliveryId, sequence, stale pending suppression, up to three attempts, and 30/60-second backoff. The WeCom client only refreshes a confirmed invalid token and resends the same attempt once. A business commit is never coupled to a notification request. Alert failure does not undo an order, payment, inventory update, or device result.

The token is cached only in server memory with expiry margin and a shared in-flight refresh. A confirmed token-invalid response permits one controlled refresh/resend. Request timeout, connection reset after send, or process crash may leave acceptance unknown. Retrying the stable delivery can duplicate a phone notification. WeCom duplicate checking is enabled for 1800 seconds, but neither exactly-once delivery nor strict phone display order is guaranteed.

## Protected configuration

The Git-external runtime config retains monitoring.alertingRequired as the only required/not-required flag. Select monitoring.alertTransport = wecom-app. The Stage 5C protected secret file adds the exact block below, alongside existing database and tls blocks. All values shown are placeholders.

~~~json
{
  "alerting": {
    "wecom": {
      "corpId": "REPLACE_WITH_CORP_ID",
      "agentId": 0,
      "secret": "REPLACE_IN_PROTECTED_FILE_ONLY",
      "storeLabel": "Jin Bi Hui Huang KTV",
      "criticalRecipients": ["REPLACE_WITH_OWNER_USER_ID"],
      "warnRecipients": ["REPLACE_WITH_OWNER_USER_ID"]
    }
  }
}
~~~

The protected incident and outbox snapshots authorize the same incident's historical recipients for a pending retry or recovery, even if new-alert routing changes after a restart. The transport validates the persisted delivery and recipient union; it never substitutes a new recipient. If the WeCom account is deleted or cannot receive the message, the delivery fails visibly and readiness degrades.

Initial routing uses the owner's one existing User ID in both lists. Add the owner's wife to criticalRecipients only after her account and intended alert duty are approved. Do not add all staff. The label is display-only and never becomes the store identity. The live secret, Corp ID, Agent ID, recipient IDs, and access token must not enter Git or chat. The existing Stage 5C file realpath and Windows ACL checks apply; the secret is also included in logger redaction.

Configuration syntax, secret presence, file ACL and transport construction are checked at startup. Startup and preflight do not send a test message or prove provider reachability or phone delivery. A missing/invalid selected secret block blocks startup/preflight; required none or local still yields ALERT_CHANNEL_REQUIRED. There is no Fake/local fallback in the formal production composition. After configured delivery attempts fail, the frozen Stage 5D ALERT_DELIVERY_UNAVAILABLE gate applies while the process remains alive.

## Message and recipient semantics

Only fixed operational event definitions and allowlisted safe context enter the text. The content includes store label, severity/state, event code/component, fixed summary/action/runbook, optional safe room/workflow reference, incident ID, sequence, delivery ID, and event time. Supplied raw message/action/body text is ignored. A recovery message uses the same incident ID and a later sequence.

CRITICAL/ERROR target criticalRecipients; WARN targets warnRecipients. An outbox delivery persists its selected recipients and complete safe text before the network request. Retry and process restart reuse both. The incident persists recipients accepted by the provider. Partial invalid/unlicensed recipients leave the delivery visibly failed while preserving the accepted subset. The outbox marks a targeted delivery uncertain before the network request. If the process crashes after provider acceptance but before local success persistence, resolution carries the persisted recipient snapshot into the possibly notified set. A timeout or connection reset also records possibly notified recipients; recovery targets the union of accepted and possibly notified recipients. This is conservative because provider acceptance is unknown. Historical recovery recipients come only from the same persisted incident's accepted or possibly notified union, with the outbox snapshot stable across retry.

HTTP 200 alone is insufficient: errcode must be zero, and partial-recipient fields are checked. Logs use fixed error codes, bounded provider numeric codes, incident/delivery ID and attempt; no provider errmsg, raw response, token-bearing URL, body, stack, Cookie, password, or customer details are logged. The response is size bounded, JSON parsed safely, redirects refused, and requests have a fixed HTTPS origin and deadline.

## Operator preparation and acceptance

The owner has already created the WeCom organization and self-built app. Before a real smoke, the operator must place Corp ID, Agent ID, application Secret and the approved User ID in the protected files, verify the app can message that user, review the file/directory ACLs, run preflight, and review the redacted configuration without exposing values. Secret rotation means replacing the protected file, rerunning preflight, and controlled restart. Preserve still-authorized recovery recipients while changing routing. No credential is requested in chat.

After human approval for real sending, generate a dedicated synthetic operational incident, verify one phone receives OPEN, resolve the same incident, and verify RESOLVED with the same incident ID and a later sequence. Check recipient, application, severity, delivery ID and absence of secrets/private data. Record provider acceptance separately from visible phone delivery. Do not use a real order, payment, inventory change, or KTVSky mutation as the smoke trigger.

Verification and high-risk self-audit: [S2 synthetic audit](verification/S2_WECOM_AUDIT.md).

S2 is critical notification delivery only. It does not build PWA, WeCom workbench UI, OAuth, mini program, native app, chatbot, inbox, approval or a notification platform.