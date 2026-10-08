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
