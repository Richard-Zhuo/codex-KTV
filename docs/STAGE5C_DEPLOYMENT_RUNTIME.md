# Stage 5C production runtime

## Deployment target audit

The accepted baseline25c95f1 uses native Node24.19.0 HTTP/static serving and mysql2 locked by pnpm-lock.yaml. Formal schema is MySQL8.4/InnoDB migrations001-011. Static assets resolve against import.meta.url; secrets already use Git-external realpath/junction protection. Existing worker start/stop and recovery guards are reusable. The baseline lacks TLS, OS service supervision, separated health/readiness and bounded shutdown.

Target: Windows, Node24.19.x pinned, local/private MySQL8.4 only. Application terminates TLS directly; no reverse proxy or forwarded-header trust. Access is private network/VPN only. Both employee / and admin /admin use the same HTTPS/auth boundary. No public MySQL, RDP business entry, self-update or automatic migration.

## Runtime foundation

Single production entry: node ABSOLUTE_APP/production/start.js --config-file ABSOLUTE_EXTERNAL_CONFIG. NODE_ENV, KTV_HTTP_ENV and KTV_DEPLOYMENT_ENV must all be production. It never falls back to demo. Config/secret files are external, size bounded and realpath checked using Stage5A guards. Production file ACL checks require protected DACL, expected current service SID, trusted owner and no broad allow rules. Parent-directory protection needs explicit operator review.

One protected secret JSON is authoritative over ambient DB/provider environment variables. It contains database credentials and TLS certificate/private key; optional provider credentials and reserved future backup key fields never enable those features. Existing CSRF HMAC is keyed by each server-issued session token; no second session store/global auth secret is invented. Reserved backup keys do not implement encryption/signatures.

Health: /health/live indicates process responding; /health/ready checks official schema, DB/store/ledger, reviewed identities, inventory/mappings, recovery NORMAL and backup-policy gate. It returns safe blocker codes/version/fingerprint only. Required device mode stays blocked while production provider is disabled. DB loss blocks APIs without local fallback.

A fresh process recomputes readiness. Recovery states remain paused until the existing explicit operator resume. Shutdown immediately enters DRAINING, rejects new API work, stops/drains worker, waits bounded in-flight requests, closes HTTP and pool, then flushes logs. Deadline15s; exceeding it causes safe failure and process termination by the entry/service host. SIGINT/SIGTERM and a private service stdin STOP channel share this path. No HTTP stop/admin bypass exists.

Logs are structured, allowlisted and written outside Git. Arbitrary error properties, headers, bodies, stack, secret paths and known secret values are not logged. Every production request receives a server-created requestId reused by API/recovery errors.

## Scope

Stage5C is a local development candidate: no push, merge, real deployment, real initialization, production backup/restore or provider operation. TLS transport hardening, native Windows service templates/preflight and isolated production-like/browser smoke follow in subsequent linear commits.

No new production dependency is added. A small Windows ServiceBase host will use the installed .NET Framework and SCM; no startup-folder/task/login requirement.
