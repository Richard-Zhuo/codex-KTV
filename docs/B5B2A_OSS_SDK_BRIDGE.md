# B5-B2A: official OSS SDK bridge, offline only

## Contract and boundary

Owner permits the SDK dependency/bridge and offline evidence only. ali-oss is pinned exactly
to6.23.0 in package.json and the existing pnpm-lock.yaml. Tested with Node24.19.0. This is
not real OSS/IAM/TLS/atomicity/WORM acceptance, an independent review or production approval.

createOfflineOssSdkBridge(args, {config, readCredentials, writeCredentials?}) constructs
separate actual SDK clients and supplies ONLY B1's existing SDK operations to the unchanged
createOssOffsiteAdapter. It does not reimplement putIfAbsent/getExact, publication, state or
recovery. Read-only mode exposes no writer. Identical credential IDs are rejected to catch
accidental role reuse; different IDs are NOT proof of independent real IAM authorization.

Credentials are supplied only in memory, never loaded from environment/files or returned.
No real credential is used in evidence. No STS refresh/custody/provider is implemented. The
bridge hides SDK instances/options, exposes no logger and rejects SDK debug activation.
Production selectors from the actual host, insecure TLS override and non-synthetic args
reject construction/operations. Existing B4 admission remains mandatory. No production
bootstrap, scheduler, backup/restore or slot-release wiring is added.

The fixed offline transport throws OSS_NETWORK_DISABLED. Configuration cannot replace it;
there is no client/urllib/transport injection or allowNetwork option. A future live transport
requires new Owner authorization and a reviewed code change. No real PUT/GET/DELETE occurs.
Tests replace only this module using Node's explicit test-module mock facility; the SDK's
construction, V4 signing, request headers, XML/error parsing and B1 checks remain real code.

## Non-sensitive configuration and validate-only

Only region, bucket, endpoint, prefix and optional timeoutMs are accepted. Endpoint must
be exactly https://<region>.aliyuncs.com and region must use the oss-cn-... form. This first
bridge excludes custom/CNAME/IP/internal/accelerated endpoints and extra SDK options.
Prefix retains B1's one-to-four restricted path segments; timeout1..60000ms, default5000.
Offline validation checks pairing/format, not that a region/Bucket actually exists or is approved.

SDK options are explicit secure:true, authorizationV4:true, retryMax:0, no proxy, fixed Bucket
and endpoint. Both clients use the same bounded config but distinct credentials. No silent
V1, HTTP, SDK retry or native versionId fallback is provided.

Supply non-sensitive JSON over stdin (example values are NOT provisioned/approved resources):

~~~powershell
'{"region":"oss-cn-hangzhou","bucket":"synthetic-b5b2a","endpoint":"https://oss-cn-hangzhou.aliyuncs.com","prefix":"synthetic/bridge/"}' | node backup/oss-sdk-validate.js --validate-only
~~~

The command constructs SDK clients with fixed explicitly synthetic dummy values, never
requests credentials, calls SDK operations, resolves DNS or contacts OSS. Output contains
only fixed SDK/contract flags including networkEnabled:false and productionEnabled:false.
Unknown arguments/fields (including credentials), oversized/invalid stdin or unsafe host
settings reject with a fixed non-secret error. No live command mode exists.

## Preserved B1/B5 contracts

The original adapter still queries Bucket version state before each PUT: never-enabled
only; Enabled/Suspended/unknown/query failure reject. Each PUT retains
x-oss-forbid-overwrite:true and Content-MD5, never object HEAD-then-PUT. SHA256 remains B5's
version. Identical conflicts and uncertain submissions require independent exact readback;
permission denial, missing/wrong bytes or failed verification cannot become success.
Real administrator versioning races, concurrency, identity enforcement and delete protection
remain future non-production/cloud acceptance gates. WORM is not configured or locked.
B5 still alone owns completion-last publication, OFFSITE_VERIFIED, snapshot/RPO and128cap.

## Evidence and stop point

Focused commands/current author totals live in DEVELOPMENT_ENVIRONMENT.md / CURRENT_STAGE.md.
A socket/DNS trap verifies default bridge send attempts cannot reach a network API; separate
CLI children validate without credentials. The in-memory transport models atomicity only.
SDK dependency metadata audit is not independent security acceptance or real OSS evidence.
Original B3/B4/B5/S4 source/security gates are unchanged. No physical recovery-material deletion.
Real independent trust anchor, real OSS, WORM/IAM, production slot release and readiness remain
unimplemented/unverified/disabled as applicable. Stop after candidate; do not auto-review,
merge, push, test live OSS or deploy.

## Official sources used

- SDK source6.23.0: https://github.com/ali-sdk/ali-oss/tree/v6.23.0
- V4 initialization: https://help.aliyun.com/zh/oss/initialization-10
- PutObject/header/versioning contract: https://help.aliyun.com/zh/oss/developer-reference/putobject
