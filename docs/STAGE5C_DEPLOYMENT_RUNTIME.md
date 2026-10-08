# Stage 5C production runtime contract

## Target and scope

Target: Windows x64, Node 24.19.x, MySQL 8.4.x InnoDB (this checkout verifies 8.4.11). No Linux, container, IIS or reverse proxy is implemented. Native .NET Framework ServiceBase host runs the Node process in a kernel Job Object; no additional production package is installed.

This stage implements deployment boundaries and isolated validation. It does not install a system service, change firewall/DNS/certificate trust, reboot Windows, deploy a production instance, initialize real staff/inventory/mappings, configure real backups, enable KTVSky, or begin Stage5D. A service registration template is not evidence of an installed service.

## Single production entry and configuration

The entry is production/start.js. server.js is development/static composition and refuses production HTTP startup. All of NODE_ENV, KTV_HTTP_ENV and KTV_DEPLOYMENT_ENV must equal production. Unknown/missing values fail closed. No implicit production, demo fallback, debug auth or FakeGateway is permitted.

Copy deployment/production.example.json to an absolute Git-external protected file; replace every placeholder. Its sibling secret file is deployment/secrets.example.json with placeholders replaced outside Git. The only runtime argument is --config-file ABSOLUTE_CONFIG_PATH. No password, token or Cookie belongs in argv or shell history. Run from any working directory.

File values are authoritative. Ambient database/provider/cookie variables do not override them. NODE_OPTIONS and NODE_TLS_REJECT_UNAUTHORIZED are refused by direct startup and removed by the service host. The host sets the three canonical production environment values. KTVSky live-control is always false in this stage; required-device mode is not ready while its real adapter is disabled. No fallback to FakeGateway exists.

Config fixes store/ledger IDs, IANA timezone, business-date cutover and session-rule version. Business clock remains trusted dbNow. Configure OS/NTP synchronization, without turning OS or browser time into business authority. Application commit and a secret-free configuration fingerprint identify each start. An operator must verify that the configured commit matches the controlled release; the runtime does not fetch or update Git.

## HTTPS and private remote access

Node terminates TLS directly (minimum TLS1.2). A matching, unexpired certificate and private key are required; malformed/mismatched keys or certificates expiring within one day fail startup. Production origin must be one explicit non-localhost HTTPS origin, including its port. Bind only loopback or a private IPv4 address; never 0.0.0.0.

Clients use authenticated HTTPS over the private LAN/VPN. Firewall rules must restrict that listener to the approved private/VPN networks. Neither VPN installation nor public ingress is configured here. Staff / and admin /admin share the exact same auth boundary. No secret admin URL or IP auth bypass exists.

Plain HTTP cannot reach this TLS listener. Every accepted request must have exactly one Host matching the configured origin. Forwarded and X-Forwarded-Proto/Host/Port are rejected; no proxy is trusted. State-changing endpoints retain exact Origin and existing session-bound HMAC-SHA256 CSRF evidence. Session cookies remain HttpOnly, Secure, SameSite=Strict, Path=/. Development cookie overrides cannot enter this production entry.

MySQL is loopback/private only; non-loopback database connections require CA-validated TLS. Use a dedicated database account limited to SELECT/INSERT/UPDATE/DELETE on the one database. Schema changes use a separate controlled operator account. Never expose 3306 to the internet for remote business use.

## Secrets and ACL

One Git-external protected JSON file supplies DB credentials, TLS certificate/private key, optional server-only KTVSky telno/password and reserved future backup encryption/signing keys. Reserved keys are not active backup encryption. Existing random session tokens and per-session CSRF HMAC retain their existing auth contract; no additional session secret store or auth system is introduced.

Existing secret-file realpath checks reject relative paths, repository paths, Git parents and junctions leading into Git. Both config and secret file must have a protected DACL, a trusted owner (service SID, SYSTEM or Administrators), current service SID matching config, service read access, and no other Allow ACE. Windows ACL is obtained through the .NET Windows access-control API using a bounded PowerShell subprocess; inability to inspect fails startup.

directoryAclReviewed=true is a required explicit operator attestation: automatically checking the two files cannot prove safe parent directory replacement rights, application directory ownership, log directory confidentiality, backup directory ACL or service registration privileges. Review those ACLs manually before production. Real deployment ACL review remains NOT DONE; isolated test files verify the automated file checks only.

Service account: dedicated NT SERVICE\\JbhhKtv virtual account; never Administrator or LocalSystem. Grant read/execute on Node and application, read on protected config/secrets, write on external logs. App files must not be writable by this account. Backup operator access is separate. Rotate credentials/certificates by stopping, replacing protected files, preflight and controlled restart.

## Startup, readiness and recovery

No auto-migration, reset, fixture, bootstrap or provider request runs at startup. Startup validates configuration/Node/TLS/secrets/ACL, then schema migrations001-011 and exact InnoDB schema, store/ledger identity, current initialization receipts/catalog/inventory and recovery mode. Schema mismatch needs controlled operator migration with verified backup first.

GET /health/live reports the responding process. GET /health/ready reports safe readiness codes, app commit/schema/fingerprint and requestId. No credentials, DB URL, device inventory, secret paths or stacks are exposed. Health has no auth but is confined to the private TLS listener.

DB unavailable or paused recovery can remain alive with readiness=false. All API access is blocked while unready; static pages can show the existing safe unavailable state. Readiness rechecks current DB facts rather than trusting a startup cache. Read-only readiness queries have a two-second deadline per query; exhausted pool acquisition fails closed. Concurrent checks share one in-flight probe. DB failure never switches to browser/demo storage.

FROZEN/RESTORING/VERIFYING/READY_FOR_RESUME/FAILED remain persistent business-write and worker barriers. Use existing recovery operator protocol, explicit resume and controlled runtime restart. No second maintenance state machine exists. A missing backup-policy attestation blocks readiness; this Boolean does not prove off-site copies, encryption or retention have been configured.

## Lifecycle and service template

SIGINT, SIGTERM, fatal exception/rejection, and the private service-host stdin stop pipe enter DRAINING. New API work is rejected; queued readiness must recheck DRAINING before delegation. A server-owned dispatch fence is checked both after application status lookup and after adapter reauthentication, immediately before the control POST. Worker stop cancels further items in its batch, waits for the current evidence transaction, then the runtime waits for bounded HTTP work, closes HTTP/pool and flushes logs.

Shutdown is bounded at15 seconds plus up to1 second log flush. Host waits20 seconds then terminates its owned child. Provider calls retain their existing abort/UNKNOWN semantics and durable claims; shutdown never retries a mutation. A crash leaves persisted evidence for query-first recovery. The kernel Job kills descendants when the host exits, preventing orphan Node processes during restart.

Compile deployment/KtvServiceHost.cs using the Windows .NET Framework64 v4.0.30319 csc.exe with System.ServiceProcess.dll reference, /target:exe /platform:x64, an absolute source path and a Git-external controlled output path. Registration uses deployment/register-service.ps1 with absolute -HostExe -NodeExe -EntryFile -ConfigFile paths. It refuses replacing an existing service. Registration is an explicit future administrator deployment action and does not start the service.

The template selects delayed automatic startup and SCM restart delays30/60/300 seconds, reset after3600 seconds. Future authorized operations use Start-Service JbhhKtv, Stop-Service JbhhKtv and Get-Service JbhhKtv. No logged-in user, IDE, browser, Startup folder, terminal window or automatic git pull is required. This stage validates the real compiled host in its isolated console mode, including OS-process crash cleanup and fresh restart; installed SCM/reboot behavior remains an operator acceptance gate.

## HTTP resource limits and diagnostics

Maximum command JSON is1MiB; login remains16KiB. Production oversized JSON yields413/payload_too_large. Header timeout5s, request timeout15s, keep-alive5s, socket inactivity15s,64 connections,64 headers,100 requests per socket. These are transport bounds, not business amount rules.

Login attempts are bounded by source (socket address;60/minute) and source+account (12/15minutes), plus the existing failed-account limiter (5/15minutes). Maps cap2048 keys and expire entries; no permanent lockout or trusted X-Forwarded-For. Failure uses stable429/rate_limited.

CSP permits same-origin modules, existing inline styles and data images, denies script injection/object/frame embedding; nosniff, no-referrer, frame DENY and permissions policy accompany it. HSTS max-age31536000 applies only to this production TLS entry, without includeSubDomains/preload. Development server does not set HSTS.

Git-external JSONL logs allow only safe event/code/status/requestId/duration/version/fingerprint/blocker fields. Unknown exception objects, messages, headers, request bodies, URL credentials and paths are omitted, and known configured secrets are scrubbed. Each HTTP request receives a fresh server UUID used by error/log correlation. No raw password/session/CSRF/Cookie/token enters the log. Fatal exceptions cause shutdown. Log rotation, disk quota, alerting and central monitoring remain Stage5D gates; files are one per process start.

## Preflight and controlled packaging

Read-only command: node production/preflight.js --config-file ABSOLUTE_CONFIG_PATH, with the three production environment values explicit. Blockers yield nonzero exit. It never initializes or migrates a database. Without actual production config it reports RUNTIME_CONFIG_REQUIRED, not an invented successful production inspection. Real staff/inventory/mappings/backup policy remain uninitialized/unconfirmed.

Package a reviewed immutable release containing server.js, runtime root JS business modules, shared/, ui/, http/, auth/, ledger/, employees/, vouchers/, devices/, production/ (excluding tests), recovery/ runtime modules, backup/format.js and its runtime imports, database/migrations/, production/schema-manifest.json, HTML/CSS, package.json and pnpm-lock.yaml; include deployment templates separately as operator tools. Preserve relative module layout. Audit transitive imports and serve only the existing exact static asset allowlist.

Exclude *.test.js, test-support/, .git/worktrees, .pnpm-store, local evidence, logs, real backups, credentials/config files and development temp files. Install only the locked production dependencies with pnpm install --prod --frozen-lockfile --ignore-scripts on the target/build staging host. No latest-version installation, self update, startup DDL or secret-file bundling. Node/MySQL patch upgrades require deliberate validation.

## Acceptance and stop conditions

Synthetic integration uses only the existing owned MySQL33313 harness, a restored synthetic DB, a least-privilege synthetic DB user, protected external test config/TLS, disabled provider, and compiled native host. Its isolated initialization/backup-policy flags are not real production facts. It verifies HTTPS login/snapshot/clean/replay/restart/logout, paused recovery, unavailable DB and safe logs. Existing full recovery drill verifies WAIT/verificationPending/UNKNOWN workflow persistence and query-first recovery; worker stop regression verifies no next batch mutation starts.

Final HEAD must additionally receive actual Edge HTTPS smoke: login, employee/admin, trusted command, reload/session, logout, HTTP unavailable and no demo fallback. A Node HTTP smoke cannot substitute for this browser evidence. Test TLS uses an ephemeral self-signed certificate and does not change OS trust.

High-risk audit covers secret leakage, alternate HTTP startup, FakeGateway/debug fallback, readiness/worker gates, shutdown/duplicate dispatch, DB exposure and destructive tools. No real deployment, cutover or KTVSky mutation is authorized.

References: Node HTTPS and HTTP APIs; Microsoft ServiceBase, Job Objects and sc.exe failure actions. Actual commands and current evidence are maintained in DEVELOPMENT_ENVIRONMENT.md and CURRENT_STAGE.md.
