# B5-B1: injected OSS adapter candidate

## Scope and use

Code and isolated synthetic tests only. No OSS SDK dependency is installed, client is
constructed, credential is loaded, or cloud endpoint is selected by this module. The trusted
future bootstrap supplies ali-oss v6.23.0-compatible clients, bucket and a restricted prefix.
This candidate does not add a CLI, scheduler or production configuration/enablement route.
Existing S4/B2 identity, B4 encryption/key contracts and B5-A publication/RPO stay unchanged.

createOssOffsiteAdapter(args, {readClient, writeClient?, bucket, prefix, timeoutMs?}) returns
reader.getExact and, only with writeClient, writer.putIfAbsent. A fresh read-only client can
retrieve with only independently retained bucket/prefix/objectId/SHA256; no local cache or
native version mapping is needed. SDK clients must use the same bucket, secure:true and
retryMax:0. Writer and verifier must be separately constructed clients. The adapter checks
these options on calls; client construction, endpoint/account trust and disabling SDK
debug/request dumps remain trusted-bootstrap responsibilities, not caller credentials.

## Create and exact-read contract

The target Bucket must NEVER have enabled versioning. Before each PUT, GetBucketVersioning
must return HTTP200 and an explicitly returned empty/undefined versionStatus; Enabled,
Suspended, missing/unknown status or query failure rejects before upload. This read-only
configuration query is not an object HEAD/existence check. It cannot eliminate an
administrator changing versioning concurrently: real policy controls and that race remain
cloud acceptance prerequisites.

Every PUT sends a Buffer and headers x-oss-forbid-overwrite:'true', Content-Type and
Content-MD5; there is no overwrite/delete/list/policy method. The MD5 is an OSS transport
check, not a substitute for B5-A SHA256. Existing identical content is independently read
and compared; conflicts reject. Timeout/network/5xx/unknown submission can succeed only
after exact independent readback. Definite authorization/request failures reject; no
automatic PUT retry occurs. A late PUT can leave ciphertext after an unconfirmed result;
it never retroactively changes that result. Explicit retry uses the same immutable key.

GET uses prefix+restricted objectId, returns bytes in memory, and has no file destination,
Range, transformation or native versionId option. Only HTTP200 Normal object responses,
no native-version header (including 'null'), identity/no content encoding, valid full size
and matching SHA256 are accepted. No ETag/versionId is treated as SHA256. Results/errors
contain no SDK request, response, cause, endpoint, credentials or plaintext key. No logger
is invoked. Partial responses, links, mismatches and inaccessible content fail closed.
Both operations retain B4's synthetic-only admission on construction and every call.

## SDK and service evidence (read 2026-10-22)

- [Official PutObject](https://help.aliyun.com/zh/oss/developer-reference/putobject):
  service-side forbid-overwrite is ineffective for enabled/suspended versioning.
- [ali-oss v6.23.0 object.js](https://github.com/ali-sdk/ali-oss/blob/v6.23.0/lib/object.js):
  Buffer put forwards options.headers through _objectRequestParams to request.
- [HTTP request assembly](https://github.com/ali-sdk/ali-oss/blob/v6.23.0/lib/common/utils/createRequest.js):
  request headers are preserved into the signed HTTP request. No undocumented
  forbidOverwrite boolean is assumed.
- [SDK GET](https://github.com/ali-sdk/ali-oss/blob/v6.23.0/lib/common/object/get.js) and
  [version query](https://github.com/ali-sdk/ali-oss/blob/v6.23.0/lib/common/bucket/getBucketVersioning.js):
  response shapes and option positions are checked against these exact sources.
- [SDK request](https://github.com/ali-sdk/ali-oss/blob/v6.23.0/lib/client.js):
  retryMax:0 disables the SDK request retry wrapper. SDK debug can include sensitive
  headers/errors: it must not be enabled by a future real-client bootstrap.

Source inspection plus injected SDK-call assertions prove the intended client contract;
they do not prove actual OSS server atomicity, SDK installation/signing, TLS, IAM or WORM.
No vendor source or SDK dependency is vendored. This candidate uses only runtime synthetic
bytes and in-memory OSS models, never production data or credentials.

## Evidence and remaining gates

Focused author evidence and exact command live in DEVELOPMENT_ENVIRONMENT.md. Integration
tests reuse the original trusted synthetic producer and B5-A publisher; all four payloads,
last completion marker and independent exact reads remain mandatory. The adapter adds a
readback for each PUT: a new successful unit needs five PUT, five Bucket-version queries and
fourteen GET before retries (B5-A's original nine reads plus five write confirmations).
B5-A still owns OFFSITE_VERIFIED, failure facts, snapshot time,128-reference cap and RPO.

Real OSS connection/atomicity/WORM/IAM and cross-server recovery are NOT VERIFIED.
B3 capacity is still a production blocker. No real storage protection, private-key custody,
production encryption/offsite scheduling/restore, B5-B2 or B6 is enabled or implemented.
Stop after author candidate; independent acceptance requires Owner authorization.
