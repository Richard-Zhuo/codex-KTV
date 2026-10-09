# Stage 5D Monitoring / Alerting / Runbook

Base: human-accepted main/origin/main e57af99dd49a46771ff20dd495f71f22d9db97ff. Delivery branch: codex/p0-1-stage5d-monitoring-runbook. Local review candidate only; no merge, push, deployment, real initialization, alerts or KTVSky operation. Formal employee/owner/technical instructions: [OPERATIONS_RUNBOOK](OPERATIONS_RUNBOOK.md).

## OBSERVABILITY GAP ANALYSIS

| Existing source | Existing evidence | Stage 5D addition |
|---|---|---|
| runtime-log.js | One allowlisted/redacted structured logger, requestId | Same sink receives fixed operational contract, size rotation and stderr fallback |
| health/live, health/ready | Liveness, bounded SQL readiness, recovery gates | Readiness transitions, DB incident and root-cause suppression |
| auth_events and login limiter | Trusted auth audit, credential/session state | Separate hashed account/source counters and bounded failure window |
| device workflow state/evidence | SQL claim/lease, UNKNOWN query recovery | Read-only persisted evidence monitoring; no provider health mutation |
| recovery_control/events | Freeze, verify, explicit resume | Entered/ready/resumed notifications; existing checker failure signal |
| backup CLI/artifacts | Verified consistent backup, checksum and recovery tooling | Verified success/failure mailbox, last success/failure, overdue; no scheduler |
| native Windows host | Owned child, crash/restart boundary | Persisted running marker and crash-loop incident |
| protected external directories/TLS | Runtime config, ACL and real HTTPS | Capacity/writability probes, loaded public certificate expiry/SAN summary |
| admin server-filtered snapshot | backend.view checked through current session | Safe operational projection, ordinary staff response unchanged |

## Authority and event contract

MySQL migrations 001–011 remain the sole business/schema authority. There is no new SQL migration. Incident/outbox state is an independent checksummed JSON file in the protected Git-external log directory. It is not a ledger, auth store, backup or domain rule source.

Operational records use fixed timestamp, severity, eventType/code, safe relevant request/principal/operation/workflow/room IDs, fixed message/action/runbook. INFO = important normal transition; WARN = attention needed while relevant work may continue; ERROR = unavailable function/action needed; CRITICAL = availability, money/data or recovery safety affected. Definitions live in operations/contract.js. Unknown messages, exceptions, headers, request/provider bodies and paths are never serialized. Normal 401/403/409/422 business responses do not open system incidents.

Snapshot checksum/schema/inventory failures detected by existing readiness become DATA_INVARIANT_FAILURE; business readiness already refuses writes. Existing recovery CLI inspect/verify can report fixed invariant signals through an optional protected operationalDirectory. No automatic repair, freeze bypass, delete or restore is introduced.

## Configuration and timing

The protected runtime config accepts an exact monitoring object. Missing config or backupDirectory is a readiness/preflight blocker. No real channel is selected. alertingRequired=true with none/local transport blocks readiness; preflight explicitly reports REAL_ALERT_CHANNEL_NOT_CONFIGURED as degraded when not required. Real transport remains unavailable in the formal production composition. Fake transport can only be supplied by isolated constructor-based tests.

| Setting | Synthetic default / bound |
|---|---|
| intervalMs | 10000; configurable 1000–60000, serial non-overlapping cycles |
| probeTimeoutMs | 2500; maximum 10000 |
| native SQL query/connect deadline | 2000 ms, no readiness connection queue |
| readiness work | Shared in-flight source check; deadline returns safe not-ready without accumulating SQL probes |
| offlineMs / verificationMs | 120000 / 120000; derived from continuous status entry, not last polling update |
| backupMaxAgeMs | 86400000; no verified backup counts as overdue |
| TLS warn/error/critical | 30 / 14 / 7 days; ordered configurable thresholds, invalid date/SAN is critical |
| minFreeBytes | 1 GiB; actual statfs free capacity, independent log/backup writability |
| auth window/failures | 15 min / 5; account/source hashes distinct, at most 1000 retained buckets and 100 pending observations |
| incident history | 30 days, 500 resolved; max 512 OPEN, pending delivery references protected |
| log rotation | 10 MiB each / 10 generated files; same redaction before every write |
| dispatch | At most 4 deliveries/cycle, probe deadline per send, max 3 attempts |
| retry backoff | 30 s, 60 s, exhausted after third failure; no high-speed loop |
| reminder | At most 3 per incident, no sooner than hourly, none while delivery pending |

These are synthetic defaults, not owner-approved production policy. All probes read facts; filesystem probes create/remove only a generated temporary probe in the allowed directory. There is no live provider query or mutation from monitoring.

## Lifecycle, persistence and delivery

OPEN → RESOLVED, stable incidentId. Fingerprint uses scope/type/component/category/room/workflow; changing requestId cannot multiply an ongoing incident. Repeated observation updates lastSeen, only a higher severity creates an escalation delivery. DB outage suppresses new cascading generic readiness incidents; an existing readiness incident resolves only when actual readiness returns. Restoration is correlated to the original incident and sends DATABASE_RESTORED / READINESS_RESTORED / PROVIDER_RESTORED / RECOVERY_RESUMED as applicable.

File updates are serialized, checksummed, fsynced to an exclusive temporary file then atomically replaced. One runtime writer per dedicated directory is enforced by a PID/scope lock; only a confirmed-dead writer lock may be reclaimed. Corrupt/scope-mismatched state refuses startup; it is never silently reset. Abrupt termination leaves the running marker. Next process records PROCESS_FAILURE; 3 unexpected exits in 10 min produce CRITICAL PROCESS_CRASH_LOOP. Healthy observations resolve restart/fatal incidents; crash-loop resolves only after its window subsides.

Incidents and notification outbox are committed together. Delivery is after persistence and outside all business/auth/domain transactions. FakeAlertTransport and optional local structured sink implement send(payload) → accepted. Local sink never pretends to be a remote production channel. Failure logs a fixed local ALERT_DELIVERY_FAILED, retains bounded retry; it cannot roll back a business commit. A timed-out hanging send is not retried within that process. Stable deliveryId is the receiver idempotency key across restart; delivery is at least once. Recovery supersedes unsent/exhausted opening, escalation and reminder deliveries. Each incident carries a persisted monotonic delivery sequence; FakeAlertTransport ignores duplicate/older sequences. A future real receiver must deduplicate deliveryId and reject older incident sequences, including late completion of timed-out sends. No real receiver is implemented here.

No real transport leaves the outbox pending, explicitly NOT_CONFIGURED. Pending cap1024/state7MiB fail visibly rather than silently discarding incidents. Exhausted notifications remain visible in safe local state for technical handling. Retention removes only resolved operational history/completed outbox entries; pending deliveries and OPEN incidents are retained. No business or auth audit tables are touched. Rotation only deletes the sink's exact generated ktv-time-UUID.jsonl regular files; it never deletes operational-state, backups or unrelated files.

## Backup/checker reporting

Optional operationalDirectory on the existing backup/recovery CLI points to the same protected external log directory. Backup CLI reports success only after BACKUP_VERIFIED, never from an attempted job or a provider ACK. Failure updates last failure/result and preserves last verified success. Runtime serially consumes safe fixed-shape report files after persistence; replay is idempotent. Operator inspect/verify failure similarly reports DATA_INVARIANT_FAILURE without raw report/body. A later explicit successful verification clears that recovery-checker incident. No production schedule runs in Stage 5D.

The runtime polls actual persisted workflow evidence, caps each scan at 500 rows and never infers resolution for an unobserved workflow. Provider auth evidence is the safe AUTH_REQUIRED machine code; a later explicit provider state/ACK can resolve it. Monitor state never advances workflow or ledger revision.

## Visibility and failure boundaries

GET /api/v1/admin/snapshot includes view.operations only after the existing transaction-bound current backend.view check. Active incidents plus bounded resolved history, DB/recovery/worker, runtime readiness, backup age/status and certificate days/validity are safe projections. It has no credential, SQL, raw exception, secret path or provider body. GET /api/v1/store/snapshot remains employee-focused and contains no operational summary.

A DB outage also prevents authenticated admin reads: the existing 503/health boundary and protected service output are then the observation route. Logging failure emits a fixed CRITICAL signal to stderr and triggers controlled shutdown. Incident persistence failure is explicit degraded/not-ready, never a silent healthy state. Whole-host failure cannot alert from that same host; an independent monitor host/service remains an owner decision.

## Verification

Automated sources: operations/lifecycle.test.js, runtime.test.js, drills.integration.test.js; existing production/runtime.integration.test.js; recovery/cli.test.js. Drills use owned loopback33313 MySQL8.4.11/InnoDB, real native-host process crash/restart, synthetic accounts/TLS, FakeGateway/FakeAlertTransport. No live channel or real device is contacted. Current run evidence and final browser result are recorded in CURRENT_STAGE and the implementation report; historical baseline2131 is not a fresh test result.

High-risk review checks storm/dedup, durable restart/resolve, unchanged business head and inventory effects, bounded delivery failure, secrets, UNKNOWN query-only recovery, backup timestamp integrity and cleanup scope. Employee procedures never authorize SQL, offline queue, a second payment, certificate bypass or automatic repair.

## Remaining gates

Real channel/provider/recipients and response duties; production backup schedule/retention/off-site/encryption/key management; actual external monitoring host/service; real deployment, human initialization and production cutover. KTVSky live production control OFF. PRODUCTION READY=NO; 14-DAY OFFSITE MVP READY=NO. Next only Stage5E Production Cutover Rehearsal; do not start it automatically.
