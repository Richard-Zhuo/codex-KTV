# Stage 5D operational monitoring contract

Base: human-accepted Stage 5C e57af99. Only local branch codex/p0-1-stage5d-monitoring-runbook. No deployment, real initialization, real alerts, provider requests, merge or push.

## OBSERVABILITY GAP ANALYSIS

| Existing authority | Reused evidence | Missing before Stage 5D |
|---|---|---|
| production/runtime-log.js | Allowlisted JSON, requestId, lifecycle/readiness transitions | Unified severity/codes, rotation, fallback |
| /health/live and /health/ready | Live process vs read-only schema/bootstrap/recovery readiness | Scheduled transitions and linked recovery |
| auth_events and login limiters | Formal login outcomes and limits | Bounded account/source abuse aggregation |
| room_control_workflows | Durable provider evidence, UNKNOWN and verification | Delayed OFFLINE/VERIFYING incidents, query-only resolution |
| recovery_control/events | Frozen writes and explicit resume | Operational recovery notifications |
| backup tooling/manifests | Verified snapshot time/checksum, restore audit | Last success/failure and age monitoring |
| native service host | Windows Job containment and SCM restart | Persisted unexpected-exit/crash-loop evidence |

No second business/audit log is introduced. Unified operational events flow through the existing safe logger. Operational state is a bounded, checksummed, atomically replaced Git-external file beside runtime logs. It remains writable when MySQL is unavailable; no new SQL migration is required. Business SQL remains migrations 001-011. A dedicated log directory belongs to exactly one runtime instance. Operational state never increments ledger revision and never replaces auth, payment, inventory, device or recovery facts.

## Contract

INFO: important normal transition. WARN: attention while operation can continue. ERROR: function unavailable/action required. CRITICAL: overall availability, recovery ability or data safety affected. All event types/messages/actions originate in operations/contract.js, never raw exceptions or request bodies. Safe identifiers only; arbitrary operation keys are hashed. No credential, Cookie, token, raw SQL URL, full request/provider body or secret filesystem path enters event/incident/alert projection.

An incident has a stable UUID, deterministic scope/type/context fingerprint, OPEN/RESOLVED lifecycle and linked notifications. Repeated observations update lastSeenAt; they do not create notifications. Escalation is a transition. Pending notifications retain their incident even after normal history retention. Defaults are synthetic operating proposals, not owner-approved production thresholds.

No business error (ordinary 401/403/409/422) is an operational incident. DEVICE_UNKNOWN never dispatches provider mutations. Monitoring has no automatic restore/delete/ledger repair capability.
