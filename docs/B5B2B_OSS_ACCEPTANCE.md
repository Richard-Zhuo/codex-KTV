# B5-B2B: manual non-production OSS acceptance entry

## Scope and existing capability

B5-B2A is Owner-accepted/merged/closed at 427c8bdd9ca6335cd78a41f49121e1ae7a263f2d.
Its fixed offline transport, validate-only command, independent SDK identities and B1
create-only/exact-read semantics already existed. Missing capabilities were a separately
approved manual network session, bounded probe scope and durable sanitized probe evidence.
This change adds only those seams. No second OSS adapter, operational store or backup
publication path is added. B3/B4/B5 state, OFFSITE_VERIFIED, RPO and128-cap are untouched.

## Authorization and isolation

The original createOfflineOssSdkBridge and oss-sdk-validate.js stay unconditionally offline.
Importing the new entry performs no request/config/credential read. Only the dedicated
oss-acceptance.js --run-nonproduction --config-file entry, Node24.19.0 and actual NODE_ENV=test
may request approval. Production selectors, unsafe TLS overrides, NODE_OPTIONS and debug
logging are rejected, including at each network operation. No environment flag or config
allowNetwork field enables this entry. Noninteractive service/redirected stdin is rejected.

Before any cloud credential load, an operator in a real terminal must type exactly the
phrase displayed for the approved Region, Bucket and prefix. It creates an opaque one-use
in-process permit with a five-minute lifetime. Ordinary objects and configuration cannot
forge it. This models a trusted local operator acting under a separate Owner decision;
it is not remote Owner authentication, real IAM verification or a production trust anchor.
Arbitrary hostile code controlling the operator process is outside that boundary.

The operator must independently confirm a dedicated NON-PRODUCTION Bucket. The name guard
ktv-oss-acceptance-... is an additional restriction, not proof of cloud ownership or purpose.
No present authorization permits actual execution: independent entry acceptance, Owner
non-production configuration and a fresh explicit real-OSS run authorization are still required.

## Fixed scope and SDK reuse

- Fixed keys: probe and race under oss-acceptance/<UUID>/; exactly two possible objects.
- Only two deterministic synthetic bodies containing that run UUID; maximum1KiB each.
- Maximum5 PUT attempts and24 total requests per permit, shared by both identities.
- Only GET ?versioning= on the approved Bucket, conditional PUT and exact object GET.
- No HEAD, DELETE, list, copy, arbitrary bodies, third key, alternate host, Bucket-policy
  modification, protection change, proxy or redirects. Host/copy-source and unexpected
  SDK options/headers are rejected before transport.
- The same locked ali-oss6.23.0 bridge still provides HTTPS/V4, retryMax:0, request-level
  x-oss-forbid-overwrite, strict same-bytes version XML admission and B1 SHA256 getExact.
- The locked SDK's own urllib dependency is used only after permit consumption. Responses
  are consumed as bounded streams (1KiB successful object GET;8KiB version/error response)
  with five-second request/body limits, then normalized to the SDK's existing response shape.
- Write and verification clients use distinct credential IDs and request capabilities.
  The writer needs GetBucketVersioning and restricted PutObject; the independent reader
  needs only GetObject for those test keys. Actual RAM policy isolation is NOT VERIFIED.

## Future operator files and command (not authorized to run now)

Use protected LOCAL Windows drive paths outside every Git repository. No UNC/device path,
symlink/junction traversal or inherited public access is accepted. Reuse the existing
external-secret reader and protected current-operator/SYSTEM/Administrators ACL validation
for config and the two separate credential files plus their containing directories.
The evidence directory has the corresponding protected writer ACL. No ACL is changed by
this entry. Real Windows ACL setup is a later non-production prerequisite, not mock evidence.

Non-sensitive config schema (all fields required, extra fields rejected):

~~~json
{
  "configVersion": 1,
  "purpose": "nonproduction-oss-acceptance",
  "region": "oss-cn-hangzhou",
  "bucket": "ktv-oss-acceptance-owner-test",
  "endpoint": "https://oss-cn-hangzhou.aliyuncs.com",
  "prefix": "oss-acceptance/e7dd29ba-5a7a-4cb8-9625-f18d659e42ce/",
  "readCredentialsFile": "C:/OwnerOssAcceptance/read.json",
  "writeCredentialsFile": "C:/OwnerOssAcceptance/write.json",
  "evidenceFile": "C:/OwnerOssAcceptance/oss-acceptance-e7dd29ba-5a7a-4cb8-9625-f18d659e42ce.jsonl"
}
~~~

These are illustrative, unprovisioned values. Each secret file accepts accessKeyId,
accessKeySecret and optional stsToken only. Do not put credentials in config, environment,
command arguments, Git, logs or this conversation. Prefer short-lived restricted test
credentials prepared by Owner outside this development task. No refresh/custody service is added.

After all future gates, the manual invocation is:

~~~powershell
$env:NODE_ENV='test'
node backup/oss-acceptance.js --run-nonproduction --config-file C:/OwnerOssAcceptance/config.json
~~~

The original credential-free offline validation remains:

~~~powershell
'{"region":"oss-cn-hangzhou","bucket":"ktv-oss-acceptance-owner-test","endpoint":"https://oss-cn-hangzhou.aliyuncs.com","prefix":"oss-acceptance/e7dd29ba-5a7a-4cb8-9625-f18d659e42ce/"}' | node backup/oss-sdk-validate.js --validate-only
~~~

## Evidence and unknown results

The manual probe executes first creation, identical retry, conflicting bytes, concurrent
conflicting creation and independent exact readback. An expected rejection alone does NOT
prove conflict: actual sanitized HTTP409 observations are required for repeated/conflicting
and concurrent writes. A permission rejection or a server overwriting both concurrent
requests cannot pass. An uncertain committed write can pass only after B1's independent
exact read confirms the expected bytes; otherwise the session is UNCONFIRMED.

An exclusively created JSONL evidence file is opened before credential loading and requests;
it is never overwritten, deleted or automatically retried. Records are synced and include
scope/run UUID, fixed limits, stage/outcome, content references and only operation/status
observations. They exclude credentials, Tokens, raw requests/responses/errors and secret paths.
Partial files/no final result remain incomplete; RESULT=UNCONFIRMED can mean remote objects
exist and requires manual review. Evidence write/sync/close failure cannot produce a successful
CLI exit. PROBES_PASSED records observed probe facts, not OFFSITE_VERIFIED or production readiness.

Rerun requires another explicit Owner/operator approval. Preserve the same UUID/prefix and
bodies for unknown-result inspection; use another protected evidence directory (fixed basename)
to retain prior evidence. No automatic cleanup, new object naming or DELETE is performed.

## Evidence limits and stop point

Only offline mocked credential files/ACL/terminal and in-memory HTTP streams are exercised
in this phase, while the official SDK signing/XML/error and original B1 checks execute.
DNS/socket traps enforce zero real connections. Real OSS TLS, Bucket version state, concurrent
atomicity, IAM, WORM/delete protection, credential custody and cloud cost are NOT VERIFIED.
A never-versioned Bucket and independently restricted identities must be verified in a future
Owner-authorized run. No WORM configuration or lock is installed here.

New live execution capability requires a separate independent security acceptance before
any real-OSS test. No production backup/encryption/restore/slot release, physical deletion,
cloud provisioning, merge/push/deploy or next phase is enabled or authorized by this delivery.
