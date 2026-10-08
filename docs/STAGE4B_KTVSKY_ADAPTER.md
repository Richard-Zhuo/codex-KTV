# Stage 4B KTVSky adapter and safe validation

## Basis and boundaries

Stage 4B accepted HEAD 60c853f is main/origin/main. The Stage 4B.1 semantics fix is a local candidate requiring human acceptance. No Stage 4C, employee-open integration or deployment is included.

Observed public frontend endpoints: POST /h5/login {telno,password}, GET /h5/search?telno=..., POST /h5/mac_control. Login uses a top-level token; requests carry X-TOKEN. HTTP 401/403 and observed body codes 30010/30011 invalidate the session. These are observed contracts, not an official provider guarantee.

## HTTP and authentication

The provider origin is pinned to https://lknewcms.ktvsky.com. Only explicit testOnly mode allows loopback mock HTTP/HTTPS. TLS verification is always enabled; redirects and automatic retries are forbidden. Connection and whole-request deadlines apply, and responses are bounded (256 KiB by default). Diagnostics contain only endpoint category, generated request ID, HTTP status and generic code, never bodies, headers, secrets or exception causes.

KTVSKY_TELNO / KTVSKY_PASSWORD are read through a server credential provider. Tokens, account scope and Cookies are private in-memory state, never workflow evidence. Cookies obey origin, path, Secure and expiry/deletion rules. Concurrent logins share one request. The local five-minute cache is conservative client policy, not a verified provider TTL. Re-authentication occurs on a later explicit call after a 30-second cooldown, with at most three login attempts per instance. It never replays a mutation.

## Read and mutation semantics

Reads require explicit store scope and exact external device identity, never names. Unknown/duplicate devices, store mismatch, malformed state and unsupported values fail closed. alive===1 and status===1 map to online/open. Numeric opentime is only observedCountdownValue with UNVERIFIED unit; no targetEndAt is guessed.

closeRoom sends one POST {mac,status:0,telno}. openRoom sends one POST {mac,status:1,opentime:countdownSeconds,telno}, preserving the supplied value. There is no setCountdown. Default enabled=false and default mutation policy denies before credentials or HTTP. productionEnabled remains false, including safe-validation configurations.

A control HTTP 200 / code 200 yields ACKNOWLEDGED, acknowledged=true, settled=false, retrySafe=false. It proves receipt of a response, not execution or causality. The same step identity can never be resent. A device remains blocked until a query STARTED AFTER ACK observes its desired state; a read started before ACK cannot release that interlock.

Transport loss, timeout, unknown response and auth rejection preserve UNKNOWN. Queries return current state only (settled=false, stepResult=UNKNOWN, retrySafe=false); they cannot release a genuinely unresolved mutation, even if the state happens to match. Definitive auth responses retain AUTH_REQUIRED diagnostics. No raw provider details cross the DTO boundary.

## Production workflow prerequisite

The internal application remains disconnected from employee open. It uses the existing trusted order, DB clock, immutable mapping, session revalidation, claim/lease and fenced evidence transactions.

- Initial ONLINE + CLOSED: PRECONDITION_SATISFIED, mutationDispatched=false; skip close and advance to OPEN.
- Initial ONLINE + OPEN: claim CLOSE and recheck state. If now CLOSED, skip close; otherwise send close once.
- Close ACK: persist closeAcknowledged, stay at CLOSE / DEVICE_VERIFYING and query only on later ticks. Fresh ONLINE + CLOSED yields DESIRED_STATE_CONFIRMED and advances to OPEN; settled remains false and causality UNVERIFIED.
- ACK but OPEN/offline/failed read: keep waiting/querying; never re-close or open blindly. Expired query claims continue query-only.
- Open ACK also waits at OPEN / DEVICE_VERIFYING. It still requires online/open AND the exact targetEndAt evidence before the final VERIFY step; observed numeric opentime is not invented target proof.
- Truly uncertain mutation: DEVICE_UNKNOWN and query-only. Existing scoped settled APPLIED, or settled NOT_APPLIED + retrySafe, requirements remain unchanged. Fake simulator proof is explicitly synthetic.
- Every fresh claim revalidates auth and checks the order, mapping and trusted session deadline. Provider calls hold no SQL locks. Workflow progress never creates orders, payments, inventory movements or ledger revisions.

## Safe validation configuration and CLI

devices/ktvsky-safety.js owns immutable strict configuration and branded safety policies. Mutation requires all of: KTVSKY_LIVE_CONTROL_ENABLED exactly "true"; explicit enabled internalRoomId/provider/externalDeviceId mapping; matching approved, unoccupied safeTarget with human authorization reference and a window of at most 15 minutes. Approval is checked again after authentication immediately before dispatch. Server configuration is trusted operator input, not an employee/browser claim.

devices/ktvsky-validation.example.json is deliberately empty. Copy it OUTSIDE Git; account/password are not config fields. Keep secrets in the server credential provider/environment. Actual mappings and approval metadata must not be committed.

Manual CLI: node tools/ktvsky-validate.js --config <external-config-path> --action query --room <confirmed-room-id>. Supported actions: auth/query/close/open; optional --countdown-seconds and --target-end-at. No password/token/Cookie arguments. auth/query do not require the live gate; missing credentials return AUTH_REQUIRED.

Mutation requires one stable, operator-owned KTVSKY_VALIDATION_JOURNAL_DIR OUTSIDE Git, shared by all validation processes for the same store/provider/device. Do not vary it to bypass pending work. Safe open accepts only 60 or 300 seconds; the next authorized V06 plan uses 300. Gateway positive-integer support does not establish the real provider unit.

## Durable validation journal and recovery

Before control dispatch, validation preflights the exact device and online state and fsyncs a device-scoped UNKNOWN intent. Version 2 journals retain previous records in history, including the complete original version 1 record when formally recovered. No raw device/account, password, token, Cookie, CSRF data, response or business snapshot is stored. This is an operator validation interlock, not a business ledger; MySQL migrations 001..008 are unchanged.

A short exclusive file lock protects read/compare/write; replacement uses a synced temporary file and atomic rename. No provider call holds that lock. Concurrent claims cannot dispatch twice. Malformed records, abandoned locks, or exhausted history bounds fail closed; locks are never automatically expired into permission to retry.

A persisted ACK can advance to DESIRED_STATE_CONFIRMED after a fresh desired-state query. Open validation additionally requires observedCountdownValue equal to its requested value; this is an observation, not proof of seconds or provider settlement. ACK while the old state remains is pending and query-only across restarts. UNKNOWN is ALWAYS pending; a new action, process or workflow identity cannot replace it.

Already CLOSED close validation records PRECONDITION_SATISFIED without a control request. Opening an already OPEN test room is rejected rather than resetting its countdown. Each invocation dispatches at most one mutation; confirmation never automatically chains the next mutation.

There is no general clear/reset/retry command. recoverAcknowledgedClose is a narrow, offline operator recovery API for the legacy pre-existing-CLOSED close case. It requires the original workflow, manually verified external archived evidence file and SHA-256 digest, valid safety configuration, exactly one close ACK (HTTP/code 200), unique matching device suffix, ordered pre/post ONLINE+CLOSED observations, no transport failure and no other mutation/retry. The exact v1 UNKNOWN record must match the device scope and workflow. It preserves that record in history and records ACKNOWLEDGED, preExistingDesiredState=true, causalEffect=UNVERIFIED, settled=false and the evidence digest. It cannot recover a v2 UNKNOWN, missing ACK, timeout, different identity, rejected provider response, or a mere current CLOSED read. The digest binds the reviewed operator archive; it is not provider-signed proof. Do not modify or delete the archive or journal manually.

## Prior V06 evidence and next gate

The first live round (2026-10-08, separate from this fix) sent one close against an already CLOSED room. It received HTTP/code 200, and pre/post reads both showed alive=1, status=0, opentime=0. No open was sent. This is an acknowledged redundant close with pre-existing desired state and UNVERIFIED causal effect, not a control timeout/disconnect. The earlier login timeout occurred before control dispatch and must not be misclassified as mutation ambiguity.

The original close-evidence.json and v1 UNKNOWN journal remain unchanged in this fix. Archive SHA-256: d920291aa9241fa6d7d7e34ef107b0c717bb513f91b8635e17346f02179d9edc. The new recovery method is tested using synthetic archives only; actual recovery awaits acceptance and explicit operator execution. A new workflow remains blocked while that original UNKNOWN exists.

After human acceptance and renewed target/window confirmation: formally recover the archived acknowledged preclosed case, query V06; if ONLINE+CLOSED skip close, explicitly open once with 300, query OPEN/opentime/alive, then only after confirmation explicitly close once and query CLOSED. Maximum two actual controls. Timeout/disconnect stops further mutations and permits queries only. Observed value 300 alone does not prove countdown progression/seconds; unit and behavior remain PARTIAL until equivalent real evidence is accepted.

KTVSKY REAL ADAPTER = IMPLEMENTED, DISABLED.
KTVSKY READ CONTRACT = VERIFIED AGAINST MOCK, with limited prior live observations.
KTVSKY MUTATION CONTRACT = IMPLEMENTED FROM OBSERVED FRONTEND.
LIVE TRANSITION / COUNTDOWN VALIDATION = NOT YET VERIFIED.
Stage 4C remains blocked. This fix sends no real provider request.
