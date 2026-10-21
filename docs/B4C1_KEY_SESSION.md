# B4-C1: synthetic key sessions and independent recovery materials

## Scope

Owner base: db5d0e25415c09a6e8da6a8d9cd9b5d6658f4f18. This is a synthetic-only
composition of the accepted B4-A provider and B4-B pipeline, not production key management.
No cloud adapter, remote registry, cloud IAM, production key, CLI enablement or scheduler
change. Original AES-GCM envelope, format1, S4, B2 and TEST-only restore stay unchanged.
Owner reports B4-A/B4-B independent acceptance and Git closure; C1 is author development
only, pending separately authorized independent acceptance. This stage does not implement B4-C2.

## Small adapter contract

`backup/key-session.js` uses replaceable injected capabilities:

- `keyService.generate(binding)` returns `{keyId, key, wrappingKeyId, wrappedKey}`.
  `key` is a fresh cryptographically random 32-byte Buffer; ownership transfers to the session.
  `wrappedKey` is opaque encrypted material, not a plaintext DEK; wrappingKeyId selects its
  retained wrapping-key version. Adapter responses/errors never go to ordinary logs.
- `registry.register(record)` is create-only and must confirm storage of the exact record,
  never overwrite or infer an earlier ambiguous request succeeded. Return
  `{status:'CONFIRMED', keyId, registrationDigest}` where the digest is SHA256 of the canonical
  record. This confirmation is a trusted adapter result, not caller-provided authority.
- `registry.get(binding)` returns the original registered record only for an authorized
  historical reader. Missing, conflicting, pending or uncertain records must reject.
- `keyService.recover(record)` unwraps only for an authorized recovery identity and returns
  `{keyId, key}`; the same ownership rule applies. The service must authenticate the binding
  and wrapping-key version before exposing the DEK.

Binding is `{keyId,storeId,ledgerId,checksum}`. `checksum` is the already verified original
format1 manifest checksum, covering its unique backupId and all manifest content. The
registered record is `{version:1,binding,wrappingKeyId,wrappedKey}`; it is independent key
metadata, not a new backup format or a second business ledger. The B4-A envelope still
contains only its existing keyId and authenticated header. Retain the matching registry,
wrapping-key version/recovery material and original checksum/identity with the ciphertext.
A keyId alone does not authorize retrieval or establish a trusted checksum.

`withRegisteredBackupKey` validates the response, awaits exact registration confirmation,
then borrows a current-session B4-A keyProvider. Current-session encrypt/decrypt serves only
this backup and B4-B's authenticated pre-publication verification. It does not grant historical
registry/KMS reads. `withHistoricalBackupKey` uses separate read/unwrap capabilities, checks
exact binding and returns a decrypt-only provider during its callback. Closed sessions reject
all resolutions and zero owned key buffers. This is not a guarantee of erasing all runtime,
OS swap, crash dump or physical disk copies; no secure-erasure claim is made.

`runSyntheticKeyBackup` generates a random UUID keyId for every invocation. After B4-B creates
and verifies original format1, its encrypt boundary obtains a fresh DEK and confirms registry
storage before invoking B4-A. B4-B itself performs real authentication, validation, exclusive
publication, journal publication and cleanup. Only its original snapshot creator is injectable
for synthetic data. No publication/authentication/journal bypass is exposed by the C1 wrapper.
The wrapper adds nonsecret keyId/keyRegistration to the unchanged B4-B result facts.

## Failure and residual evidence

Provider and registry calls have bounded deadlines (default 5000ms; configurable 1..60000ms).
Denial, exceptions, missing/malformed material, mismatched registration digest, timeout or
unknown result prevent the session from becoming usable; upstream error details are replaced
with fixed codes. Late key responses are discarded and their transferred buffers zeroed.
A timeout is uncertainty, not cancellation or proof that remote registration did not occur.
There is no automatic retry, overwrite, deletion of registry evidence or plaintext fallback.
A late/committed registration with no confirmed response can leave an orphan encrypted-DEK
record. It must not be treated as evidence that a backup was published or completed.

Registration happens after source validation so it binds the exact backup. Its failure may
retain original plaintext in B4-B's protected staging, with complete=false, keyRegistration=
UNCONFIRMED and the original FAILED/incomplete journal. The original residue gate blocks
subsequent work until reviewed. A registration failure before entering the pipeline has no
backup-success result. C1 does not alter B4-B pending, sync/close, publication or cleanup rules.
Ordinary deletion is not secure erasure; Windows disk protection, crashes, dump/swap handling
and real recovery procedures still require production deployment acceptance.

## Test-only implementation and evidence boundary

`test-support/synthetic-key-service.js` is deliberately a local simulation. The fixture is
its authorization authority and creates distinct backup/recovery/denied clients.
`createSyntheticRecoveryAuthority({now})` keeps grants in a private WeakMap; only its trusted
fixture-held issuer can issue a frozen opaque token for a copied keyId set and an absolute
expiry. Services bind that issuer at construction and accept tokens through client(role,token).
A static recovery role, forged/copied token, foreign issuer, missing grant, invalid clock,
out-of-scope keyId or time >= expiry rejects. Scope/expiry cannot be changed on the token.
Registry reads and DEK unwraps check before work and again before returning; failed unwrap
output buffers are zeroed. Once an authorized DEK has already been transferred, this is not
a mechanism to recall arbitrary caller memory. Backup can generate/register but cannot read
or unwrap history even with a recovery token; recovery cannot generate/register. No client
receives an issuer or a clock-setting API. The trusted synthetic recovery child bootstraps
its issuer from fixture-held recovery material and grants only the selected keyId briefly;
it does not accept grants from stdin. This is not real cloud IAM. Never wire it to production.

The mock uses random AES-256-GCM-wrapped DEKs authenticated against the entire binding and
wrapping-key version. This does not modify/re-audit B4-A. Registry files contain encrypted
material only, under a fixture-owned protected external directory, using safe keyId-derived
names, exclusive pending writes/sync/close and exclusive hard-link publication. Existing
records are never replaced. Pending evidence rejects historical reads; failures preserve
it for review. Runtime confirmation is not proof of real power-loss durability or a remote
service's consistency. All file paths and cleanup belong to disposable synthetic fixtures.

Tests model independently retained encrypted records/ciphertext and synthetic recovery
material. They destroy the source fixture and original service/master copy, recreate retained
records in another protected directory, and spawn a clean Node process. Only the authorized
synthetic recovery material travels through stdin, never argv, environment, Git or logs.
The child uses separate mock recovery capabilities and B4-A decrypt plus original format1
verification. Wrong recovery material fails. This proves the local interface/process boundary,
not real cross-server disaster recovery, offsite storage, RPO/RTO or cloud authorization.

Focused commands and current author evidence: [Development environment](DEVELOPMENT_ENVIRONMENT.md).
Production encryption, backup scheduling and production restore remain disabled. Real KMS,
remote registry, IAM, key rotation/history custody and authorized retrieval are not implemented.
