# Stage 4B KTVSky adapter and safe validation

## Basis and boundaries

Stage 4A accepted 8e03fb0 was fast-forwarded into main, passed 1917/1917 (0 fail, 0 skip), fetched without drift and normally pushed. Stage 4B is local and must not merge or push before human acceptance. No deployment or employee open integration is included.

Observed public frontend endpoints: POST /h5/login {telno,password}, GET /h5/search?telno=..., POST /h5/mac_control. Login uses top-level token, requests carry X-TOKEN, and provider Set-Cookie is secret. HTTP 401/403 and observed body codes 30010/30011 invalidate the session. This is not an official guarantee or a fresh live account verification.

## HTTP and authentication (Commit 1)

The provider origin is pinned to https://lknewcms.ktvsky.com. Only explicit testOnly mode allows loopback mock HTTP/HTTPS. TLS verification is always enabled, redirects and automatic retries are forbidden, connection and whole-request deadlines apply, and responses are bounded (256 KiB by default). Logs contain only provider, endpoint category, generated request ID, HTTP status and generic code; no URL/query, request/response body, headers, exception cause or secret.

KTVSKY_TELNO / KTVSKY_PASSWORD are read through a server credential provider. Tokens, account scope and Cookie values are private in-memory state, never workflow evidence or logs. Cookies obey origin, path, Secure and expiry/deletion rules. Concurrent logins share one request. The local five-minute cache is a conservative client policy, not a verified provider TTL. Re-authentication is explicit on a later call after a 30-second cooldown, with at most three login attempts per adapter instance. A mutation is never replayed after re-authentication.

## Read and mutation semantics

Reads require explicit store scope and exact external device identity, not names. Unknown/duplicate devices, store mismatch, malformed state and unsupported values fail closed. alive===1 and status===1 map to online/open. Numeric opentime is reported only as observedCountdownValue with UNVERIFIED unit; no targetEndAt is guessed.

closeRoom maps to one POST {mac,status:0,telno}. openRoom maps to one POST {mac,status:1,opentime:countdownSeconds,telno}, with the application value unchanged. There is no setCountdown method. Default enabled=false and default mutation policy denies before credentials or HTTP. productionEnabled always remains false in Stage 4B, including isolated safe-validation configurations.

A code=200 control response is acknowledgement only, not proof of settled effect. Transport ambiguity returns DEVICE_UNKNOWN; definite auth responses return AUTH_REQUIRED within UNKNOWN evidence; read/auth transport failures use PROVIDER_UNAVAILABLE. No raw provider diagnostics cross the DTO boundary. An attempted step is reserved before asynchronous dispatch, and cannot be resent by the same instance, even after query or re-auth.

queryRoomState provides current observation only: settled=false, stepResult=UNKNOWN, retrySafe=false. It cannot manufacture scoped APPLIED/NOT_APPLIED proof from on/off state. Existing Stage 4A recovery must stay UNKNOWN while authoritative settled proof is unavailable.

## Acceptance cases and stops

Success evidence is captured local mock HTTP method/path/headers/body plus sanitized DTO assertions, not an HTTP 200 alone. Tests cover default denial, missing credentials, ONLINE/OFFLINE/missing/duplicate devices, wrong store, one combined POST, unchanged countdown, auth cache/expiry/cooldown/budget, 401/403/30010/30011, response bounds, redirects, TLS connect deadlines, Cookie scope and secret-free diagnostics. Automated tests never need live internet.

No real credentials or explicit safe target are available. Live mutation validation is blocked by the safe test target. Unit, rounding, min/max, zero behavior, effect latency, duplicates and authoritative recovery remain separate safe verification gates. Fake simulator settled proof is synthetic; mock-backed real adapter tests explicitly expect weaker UNKNOWN evidence rather than pretending parity of proof.

KTVSKY REAL ADAPTER = IMPLEMENTED, DISABLED.
KTVSKY READ CONTRACT = VERIFIED AGAINST MOCK; prior live read discovery remains evidence in KTVSKY_CAPABILITY_DISCOVERY.md.
KTVSKY MUTATION CONTRACT = IMPLEMENTED FROM OBSERVED FRONTEND.
LIVE MUTATION VALIDATION = BLOCKED BY SAFE TEST TARGET.
KTVSKY PRODUCTION CONTROL is not ready.

## Safe validation boundary (Commit 2)

devices/ktvsky-safety.js owns strict versioned configuration and immutable safety policies. A real client cannot substitute a permissive callback for a validated policy. All three factors are mandatory before any mutation: KTVSKY_LIVE_CONTROL_ENABLED exactly "true"; an enabled explicit internalRoomId/provider/externalDeviceId mapping; and an approved, unoccupied safeTarget matching room, device and store. Approval must name a human authorization reference and a time window no longer than 15 minutes. It is checked again after asynchronous authentication immediately before dispatch. Server configuration is trusted operator input, not an employee/browser claim. No mapping is derived from room names or provider order.

devices/ktvsky-validation.example.json is deliberately empty (no account, device or safe target). Copy it OUTSIDE the repository, fill schemaVersion=1, storeId, mappings and safeTarget only after human authorization. Each mapping has internalRoomId, provider="ktvsky", externalDeviceId and enabled. safeTarget has internalRoomId, externalDeviceId, storeId, approved, unoccupied, approvalReference, approvedAt and expiresAt. Account/password are never configuration fields: provide KTVSKY_TELNO and KTVSKY_PASSWORD using server environment/secrets. Actual mappings and approval metadata must not be committed.

tools/ktvsky-validate.js is a server-side manual tool, not a browser adapter or HTTP employee command. Its arguments are --config (absolute external JSON), --action (auth/query/close/open), --room (explicit internalRoomId), --countdown-seconds and --target-end-at. It does not accept password/token/cookie flags. Example read-only invocation:

    node tools/ktvsky-validate.js --config <external-config-path> --action query --room <confirmed-room-id>

auth/query do not require the live-control gate; no credentials means AUTH_REQUIRED. Mutation additionally requires KTVSKY_VALIDATION_JOURNAL_DIR to name one stable, operator-owned directory OUTSIDE Git, shared by every validation process for that provider/store/device. Do not vary the directory between invocations. open validation accepts exactly 60 seconds (a deliberately narrow test policy); the gateway itself preserves any positive integer application countdown without recalculating from wall time. Seconds, targetEndAt, UTC/IANA business-session computation and provider unit verification remain distinct facts.

## Durable ambiguity and validation limits

Before any control request, validation preflights exact store/device existence and online state, atomically creates a device-scoped UNKNOWN file (exclusive create), and flushes it to disk. It contains schema version, a hashed scope, original workflow/step identity and minimal intent only. It contains no raw device/account/password, token, Cookie, CSRF data, full provider response or business snapshot. This is a manual-validation safety interlock, not a second business ledger or schema authority; MySQL migrations 001..008 remain unchanged.

A concurrent process cannot win the same claim. A partial/corrupt record fails closed. A new process, changed requested action or new workflow still loads the original claim and only queries. The gateway also blocks another step for the same unresolved device within its instance. Auth rejection, connection reset, timeout and a success acknowledgement all preserve UNKNOWN pending evidence. A later successful login or on/off read cannot authorize resending, clearing the journal or chaining close -> open. Logs and CLI output expose only allowlisted summaries and correlation identity.

There is intentionally no automatic journal reset/clear/retry command. Current observed KTVSky reads lack scoped settled APPLIED or NOT_APPLIED + retrySafe proof. Therefore the tool stops after one ambiguous control and queries; the full live close -> query -> open -> query sequence is NOT yet verified or automatically enabled. Do not remove a pending record or change its scope to force continuation. First establish authoritative provider recovery evidence and obtain human acceptance of the next controlled step. Synthetic Fake proof is not evidence about KTVSky.

Automated evidence covers all three missing factors, occupied/expired/mismatched target, approval expiry during auth, exact sixty-second validation, offline/missing device, redaction, process restart, connection loss, concurrent claims, corrupt records and shared Fake/real combined-open intent. Provider contract tests run only against a local mock. This run performed no real credential login or account API read, and no real device mutation. Public JavaScript reinspection is not live provider validation. Stage 4C and employee open remain blocked on a separately authorized safe mutation and authoritative recovery verification.
