# S2 WeCom self-built application alert transport

Status: local S2 candidate only. S1 is accepted and merged at 6b713f52accda8b3292959ed4fea8b2690c2b78f. S2 needs human acceptance and a separately approved real phone smoke. S3-S5 remain open. Production ready: NO. 14-day offsite MVP ready: NO.

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
      "agentId": 123456,
      "secret": "REPLACE_IN_PROTECTED_FILE_ONLY",
      "storeLabel": "Jin Bi Hui Huang KTV",
      "criticalRecipients": ["REPLACE_WITH_OWNER_USER_ID"],
      "warnRecipients": ["REPLACE_WITH_OWNER_USER_ID"],
      "recoveryRecipients": []
    }
  }
}
~~~

recoveryRecipients is optional and is only an explicit allowlist for previously notified people who were removed from new-alert routing. Keep a retired recipient there until every incident that notified them has resolved and its recovery delivery has completed. A missing approved historical recipient causes visible delivery failure; the system never reroutes a recovery notice to a new person.

Initial routing uses the owner's one existing User ID in both lists. Add the owner's wife to criticalRecipients only after her account and intended alert duty are approved. Do not add all staff. The label is display-only and never becomes the store identity. The live secret, Corp ID, Agent ID, recipient IDs, and access token must not enter Git or chat. The existing Stage 5C file realpath and Windows ACL checks apply; the secret is also included in logger redaction.

Configuration syntax, secret presence, file ACL and transport construction are checked at startup. Startup and preflight do not send a test message or prove provider reachability or phone delivery. A missing/invalid selected secret block blocks startup/preflight; required none or local still yields ALERT_CHANNEL_REQUIRED. There is no Fake/local fallback in the formal production composition. After configured delivery attempts fail, the frozen Stage 5D ALERT_DELIVERY_UNAVAILABLE gate applies while the process remains alive.

## Message and recipient semantics

Only fixed operational event definitions and allowlisted safe context enter the text. The content includes store label, severity/state, event code/component, fixed summary/action/runbook, optional safe room/workflow reference, incident ID, sequence, delivery ID, and event time. Supplied raw message/action/body text is ignored. A recovery message uses the same incident ID and a later sequence.

CRITICAL/ERROR target criticalRecipients; WARN targets warnRecipients. An outbox delivery persists its selected recipients and complete safe text before the network request. Retry and process restart reuse both. The incident persists recipients accepted by the provider. Partial invalid/unlicensed recipients leave the delivery visibly failed while preserving the accepted subset. The outbox marks a targeted delivery uncertain before the network request. If the process crashes after provider acceptance but before local success persistence, resolution carries the persisted recipient snapshot into the possibly notified set. A timeout or connection reset also records possibly notified recipients; recovery targets the union of accepted and possibly notified recipients. This is conservative because provider acceptance is unknown. Historical recovery targets must remain explicitly allowed by current routing or recoveryRecipients.

HTTP 200 alone is insufficient: errcode must be zero, and partial-recipient fields are checked. Logs use fixed error codes, bounded provider numeric codes, incident/delivery ID and attempt; no provider errmsg, raw response, token-bearing URL, body, stack, Cookie, password, or customer details are logged. The response is size bounded, JSON parsed safely, redirects refused, and requests have a fixed HTTPS origin and deadline.

## Operator preparation and acceptance

The owner has already created the WeCom organization and self-built app. Before a real smoke, the operator must place Corp ID, Agent ID, application Secret and the approved User ID in the protected files, verify the app can message that user, review the file/directory ACLs, run preflight, and review the redacted configuration without exposing values. Secret rotation means replacing the protected file, rerunning preflight, and controlled restart. Preserve still-authorized recovery recipients while changing routing. No credential is requested in chat.

After human approval for real sending, generate a dedicated synthetic operational incident, verify one phone receives OPEN, resolve the same incident, and verify RESOLVED with the same incident ID and a later sequence. Check recipient, application, severity, delivery ID and absence of secrets/private data. Record provider acceptance separately from visible phone delivery. Do not use a real order, payment, inventory change, or KTVSky mutation as the smoke trigger.

Verification and high-risk self-audit: [S2 synthetic audit](verification/S2_WECOM_AUDIT.md).

S2 is critical notification delivery only. It does not build PWA, WeCom workbench UI, OAuth, mini program, native app, chatbot, inbox, approval or a notification platform.