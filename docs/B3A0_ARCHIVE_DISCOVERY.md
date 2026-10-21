# B3-A0: synthetic archive entry discovery

## Admission and trust source

This is a separate synthetic-only discovery boundary. B5-A/B5-B1 putIfAbsent/getExact,
B4 encryption/format1, S4 identity and operational-state/128-reference policy are unchanged.
There is no slot release, retention policy, physical deletion, production entry or OSS list API.

An isolated OFFLINE synthetic custodian generates an ephemeral Ed25519 signing key. Its
public trust file pins version1, directoryId, storeId, ledgerId, algorithm and public key.
The custodian separately hands the expected SHA256 of that file to the recovery controller.
That pin must be pretrusted out of band, never read from a remote list/object or from the
trust file's own claim. Replacing both file and an untrusted self-declared pin would not
establish trust. The production Owner approval/distribution/custody mechanism is NOT built.

loadSyntheticArchiveBootstrap validates the independently supplied pin against a protected,
Git-external regular file, then validates its public key and scope. It returns a privately
branded capability; plain/copied remote objects are not bootstraps. New processes load the
same independently retained public file/pin; no original process cache, operational-state,
per-backup locatorFile or repository-published test key is used as the trust source.
The test controller is the modeled trusted custodian. No new S4 authorization bypass exists.

## Untrusted discovery and authenticated entries

A separate enumerator.listPage({prefix,cursor,limit}) returns candidate objectId/version/size
and nextCursor. Neither that metadata, its hashes nor end-of-list authenticate anything.
The prefix derives from the pinned directoryId. Existing getExact fetches each candidate;
the consumer recomputes SHA256/size and verifies an Ed25519 signature with the pinned key.
Node24.19 crypto.sign/verify(null,...) is used, not a custom cryptographic algorithm:
https://nodejs.org/download/release/v24.19.0/docs/api/crypto.html#cryptoverifyalgorithm-data-key-signature

Signed canonical metadata has an explicit archive domain/version/algorithm/directoryId,
the exact B5 completion locator and complete original completion metadata. Thus it retains
unitId/keyId, backupId, store/ledger/manifest binding, wrapping-key version, application
commit, original snapshotNotBefore and all ciphertext/envelope/manifest/release references.
The objectId is archive.<directoryId>.<SHA256(unitId)>; directory/key/unit substitutions reject.
The isolated test issuer signs only controller-approved producer references. It is not a
production signing/authorization service; its private key stays in memory and is never
used as a DEK/recovery private key or written to Git, remote objects, ordinary logs or argv.

After signature/scope checks the unchanged retrieveSyntheticOffsiteUnit reads the completion
and all four recovery payloads and checks original sizes/hashes/versions/bindings/release.
Its returned completion must exactly match the authenticated entry. No release code is
executed or database restored. Discovery returns verified references only, without changing
local backup/offsite success, operational facts, snapshot times, latest point or RPO.

## Failure and evidence limits

Pages have16 candidates, at most64 pages and512 distinct entries per call; the filesystem
model refuses more than1024 candidate filenames. Limits reject rather than silently truncate.
Identical duplicates are deduplicated, conflicting duplicates/cursor cycles/out-of-prefix
keys/malformed pages reject. Missing, tampered, unknown, timeout or inaccessible entries and
materials reject the entire call without exposing a partial verified result or raw errors.
Filesystem enumeration uses the existing protected Git-external synthetic directory and
create-only writer/exact reader. No overwrite/delete capability or second state store exists.

Successful calls return ARCHIVE_ENTRIES_VERIFIED and ALWAYS:
directoryCompleteness=NOT_VERIFIED, rollbackProtection=NOT_VERIFIED,
readyForSlotRelease=false. An empty/omitted list or replayed valid historical entry cannot
prove completeness or freshness. End-of-pagination, signatures and a remote's own digest
cannot replace an independently trusted current checkpoint/inventory. Those guarantees are
not implemented or accepted here; B3-A slot release remains prohibited.

## Focused evidence boundary

Fast unit tests mock only the existing B5 retrieval seam to test discovery ordering and
failure handling. Separate integration uses a genuine C1/B4/B5 synthetic unit and a fresh
process with real B5 retrieval. It moves the owned original-server fixture out of its old
path (without deleting its materials), passes only public offline trust plus remote root,
and verifies discovery. No per-backup locatorFile/private material is supplied to the child.
Remote filenames and operational state are unchanged by discovery. Ordinary disposal of
owned temporary test fixtures is not a product retention/deletion operation.
Commands/current results live in DEVELOPMENT_ENVIRONMENT.md; acceptance status in CURRENT_STAGE.

Real OSS discovery/WORM/IAM, production signing trust distribution, complete/fresh directory
proof and disaster recovery remain unverified. No automatic B3-A continuation or deployment.
