# B5-A: synthetic complete offsite recovery units

## Scope and behavior cases

Owner base: d845611a582e0b6f0135d153c6dc560e0b4e1f90. B4-A/B/B4-C1/C2
are Owner-accepted and Git-closed. B5-A is author development only, pending independent
acceptance. No production CLI, B2 execution/schedule, S4 identity, format1, encryption
or wrapping algorithm changes. No provider, IAM, B3 deletion, B5-B or B6 implementation.

Admission: existing synthetic-only policy, trusted S4 release identity, a genuine complete
C1/B4 result, confirmed registration and absent plaintext. Resource readiness: owned
protected temporary roots, Node24.19.x and ephemeral RSA test keys. Resource readiness
alone does not prove any upload, restore or production guarantee.

- One original snapshot -> original format1 verification/registration/encryption/publication
  -> one nonsecret recovery handoff. No recreated snapshot or historical DEK access.
- Complete materials independently read/hash/bind -> create-only completion -> exact
  read-back plus materials verification -> OFFSITE_VERIFIED. Upload acknowledgement alone
  is insufficient. Any failure/timeout/unknown result leaves OFFSITE_UNCONFIRMED.
- Same unit repeated -> identical bytes verified/reused; conflicting bytes reject.
  A valid prior object or local B4 success is never replaced/deleted.
- Original ciphertext/staging/registry/release files removed -> a new process reads all
  retained remote materials and can use separately supplied synthetic private material
  through existing C1/C2 and format1 verification. This is not B6 database restore.
- Only a known conservative snapshot lower bound advances the recovery point; a late
  older completion or revalidation of an old unit cannot refresh its data timestamp.

## Producer and complete unit

backup/key-session.js adds syntheticRecoveryMaterial(result), backed by a private WeakMap.
Only the genuine successful result is eligible; copying success fields does not mint a
handoff. Before the existing encrypt call, the original manifest bytes/checksum are
captured alongside the exact confirmed encrypted-DEK registration record. No data.json,
DEK, provider, recovery private key or new ordinary log is included in that handoff.
C1 session disposal remains unchanged. The ordinary local result shape is unchanged.

backup/offsite-unit.js produceSyntheticOffsiteUnit calls the original C1/B4 composition
once and obtains the handoff after B4's full completion. The separately injected release
identity is checked by the unchanged real S4 readBackupIdentity; accepted release bytes
are re-read/pinned with readAcceptedArtifact. No product identity bypass is added.

Each stable unitId is C1's per-backup unique keyId. The four immutable payloads are:

1. ciphertext: exact verified backup.b4 and its B4 artifact checksum.
2. envelope: canonical exact C1 registered record (its SHA256 is the registration digest).
3. manifest: exact original format1 manifest, verified checksum, backupId, source/identity,
   schema/migrations, applicationCommit and createdAt. Metadata is not business rows.
4. release: the full original S4-pinned accepted artifact bytes, including packaged
   application/dependencies, lock metadata, Node version and schema/migration files.
   Existing packageAccepted artifact encoding is preserved, not rewritten.

The release checks require Node24.19.x package metadata, retained recovery entrypoints,
lock bytes/checksum, dependency package entries and matching schema migrations. The trusted
accepted packager/installed S4 boundary remains the authority for the release as a whole;
B5 does not build a replacement package, install or execute its contents. Node/OS installation,
dependency usability on a new machine and real deployment remain B6/production acceptance
prerequisites. The positive synthetic S4 seam uses an approved fixture bundle; its dependency
package is explicitly synthetic. It is not evidence of a complete runnable server installation.

Completion v1 carries backupId, keyId, store/ledger/manifest binding, wrappingKeyId,
applicationCommit, conservative snapshotNotBefore or null, and role/object/version/size/SHA256
references for every payload. It is offsite coordination metadata, not a new backup/data format.
No private key is uploaded. Final locator (exact completion object/version/size/hash/unitId)
must be independently retained from an authorized producer/store. Self-consistent hashes
alone do not authenticate origin against a compromised producer or replacement trust anchor.

## Minimal remote capabilities and publication

test-support/synthetic-offsite-remote.js is a protected Git-external local filesystem
simulation. Construction and calls require the original synthetic admission. It exposes only
writer.putIfAbsent({objectId,bytes}) and reader.getExact({objectId,version}); no list/delete/
overwrite/policy capability. Versions are content SHA256 in THIS simulation, not claims about
real OSS/COS version IDs or ETags. B5-B must separately admit actual provider semantics.

Writes use exclusive pending creation/write/sync/close, exclusive link publication and own
pending unlink. Existing identical content is read/compared, never replaced. Conflicts reject
and may leave encrypted pending evidence. Linked/escaping/oversize paths reject. Directory
ACL checks reuse existing helpers; no recursive product cleanup or automatic orphan deletion.
Successful runtime sync/link is not proof of directory-entry durability after power loss.

The publisher records references before upload, uploads all four payloads, reads all four
through a separately constructed read-only capability without local material fallback,
checks exact sizes/hashes/versions and manifest/record/release bindings, publishes the
completion object last, then exact-reads it and all referenced materials again. Only after
successful operational recording does its return code become OFFSITE_VERIFIED.

Each remote call has a bounded deadline (1..60000ms; default5000). Timeout is uncertainty,
not cancellation: late immutable objects/markers can exist. Failure never advances the last
verified point. Reuse the original unit/locator; do not create a replacement snapshot/key.
Persisted candidateLocator and exact payload references permit read-only reconciliation.
A complete marker whose acknowledgement/read-back was lost remains unconfirmed locally
until independently read/verified; it must not be interpreted from object presence alone.
No implicit network retry, plaintext fallback or overwrite occurs.

## Existing operational store and time accounting

operations/offsite-state.js writes observations.offsite via the existing operational store
capability. The trusted synthetic bootstrap must already own its existing single-writer lock;
there is no second monitoring database, mailbox or runtime/scheduler hook. observations.backup
and its local-success meaning are untouched. The test fixture uses the real store and lock.

Per-unit facts distinguish LOCAL_VERIFIED, UPLOAD_UNCONFIRMED, OFFSITE_UNCONFIRMED and
OFFSITE_VERIFIED, preserve candidate/verified locators, exact object references, timestamps
and failure counts. A failed repeat does not erase a previously verified recovery reference.
An interrupted upload leaves the persisted unconfirmed fact. The minimal bounded store
retains up to128 unit references and fails closed on capacity; no implicit dropping/retention
cleanup. A future B3 policy must resolve retention/references under separate authorization.

The trusted synthetic clock capability returns {utcMs,uncertaintyMs}. Before calling the
original creator, capture utcMs-uncertaintyMs; retain it only if the after-clock is valid,
non-reversed, and it does not postdate the original manifest createdAt. This is conservative
because original manifest createdAt is obtained after snapshot start. Missing/inconsistent
clock evidence yields null/UNKNOWN, never a fabricated timestamp. No claim is made about
real Windows clock synchronization.

latestRecoveryPoint selects the greatest trusted snapshotNotBefore among fully independently
verified units with valid completion time. Reverify never updates that point's data time.
offsiteRpo returns current UTC upper bound minus that snapshot lower bound; unknown or reversed
time yields UNKNOWN. A valid age >3600000ms is OVERDUE. Local completion, upload completion,
verification time and B2's15min cadence cannot replace this data-age measure.

No alert transport/platform is implemented here. The separate facts/age are ready for later
authorized integration with existing incidents/alerts. Real monitoring routes, recipients,
latency, continuous failure behavior and <=60min RPO require deployment acceptance.

## Evidence and remaining boundaries

Focused commands/results: DEVELOPMENT_ENVIRONMENT.md. Tests use ephemeral RSA keys,
synthetic format1 only, protected disposable roots and a fixture-only S4 identity seam.
Separate-process retrieval performs no cloud calls and no production database restore.
Private test PEMs cross child stdin only, never argv, ordinary logs, Git or remote objects.

Synthetic storage is not geographically independent, protected cloud IAM, WORM or proof
against administrators deleting files. Real offsite registry/storage, delete protection,
private-key custody, independent recovery credentials, real cross-server restore and RPO/RTO
remain unimplemented/unverified. Public wrapping does not prevent a compromised producer
from destroying or forging backups. Existing plaintext staging/swap/dump/disk protection
risks and B4 residue requirements remain; no secure-erasure guarantee is introduced.

Production offsite backup, encryption, scheduling and restore remain disabled. Stop after
the author candidate; no automatic independent acceptance, merge, push, deploy or B5-B.

## P2 parameter and capacity correction (2026-10-22)

Owner-reported independent acceptance of b43adc6 found two P2s (37/39 tests passed).
The repair stays on the same feature branch; it does not supersede those historical
failures with a new independent acceptance claim.

The producer maps releaseIdentity.identityEnv explicitly to readBackupIdentity's env
parameter. An explicit environment is preserved independently of process.env. Supplying
identityEnv: undefined retains S4's existing default behavior; the existing required
identity field shape is unchanged. No S4 deployment, trust, ACL or authorization rule changes.

The local state boundary throws the stable code OFFSITE_REFERENCE_LIMIT for a new unit at
128 references. The publisher preserves code OFFSITE_UNCONFIRMED and adds only
reason: OFFSITE_REFERENCE_LIMIT when that local boundary reports capacity. Remote errors
cannot supply this reason. Capacity stops before any upload; no historical reference,
latest recovery point, local-success result, retention limit or deletion policy is changed.
No cleanup or expansion is introduced. Other failures keep their original sanitized result.

Formal regression covers explicit/default/missing identity environment, exact capacity
reason, zero uploads, unchanged128 references/RPO and remote reason impersonation.
Author focused evidence is recorded in DEVELOPMENT_ENVIRONMENT.md; targeted independent
reacceptance is pending Owner authorization. Production offsite backup/readiness remain NO.
