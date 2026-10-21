# B4-C2: synthetic offline RSA envelope adapter

## Scope and exact reuse

Owner base main is 18b454a994c2f58e06efe2994720aef633b86e29. This candidate only
adds replaceable synthetic adapters; the offline-key production route is not approved.
No production keys/custody, remote registry, IAM, offsite upload, backup enablement or
production restore. B4-A AES-GCM, format1, B4-B publication/journals, C1 sessions and
S4/B2 implementations are unchanged. No new dependency.

The actual sequence is original format1 create -> original verifyArtifact -> C1's
registeredSession inside the encrypt boundary. Therefore the real manifest checksum is
available BEFORE generate(binding). No placeholder, preselected/fabricated backupId or
second snapshot is needed. The existing binding covers keyId/storeId/ledgerId/checksum;
the checksum covers the exact format1 manifest and its backupId. C1 confirms exact,
create-only envelope registration before it releases the current-session provider to
B4-A. B4-B uses that in-memory DEK for authenticated pre-publication validation. It never
needs the offline private key and retains its pending/residue/fail-closed behavior.

## Trusted public-key loading

loadSyntheticPublicKeyGenerator first applies the existing synthetic admission, then calls
the unmodified readBackupIdentity using its actual fixed S4 deployment/SCM/ACL boundary.
It snapshots configuration and re-reads the accepted artifact using the independently
anchored digest and returned commit. Public key AND fingerprint are parsed as bounded data
from the artifact's fixed backup/offline-public-key-policy.js entry, never from caller key
fields or an arbitrary policy path. No eval, product identity port or trust bypass is added.

The shipped policy has no approved keys: all versions reject by default. A future approved
public policy must be packaged into an accepted release under S4's existing administrative
approval. Ordinary runtime configuration cannot authorize a replacement public key together
with its self-asserted fingerprint. Algorithm/version, unique wrappingKeyIds, SHA256 of
canonical DER-SPKI and exact RSA parameters are checked. S4 still trusts its protected
administrator deployment root; this cannot resist an administrator who replaces that root
and application code. No real public key or production approval was created here.

## Envelope and capability contract

The adapter implements the existing generate(binding) response: keyId, fresh random 32-byte
key Buffer, wrappingKeyId and opaque wrappedKey string. It returns only generate capability;
there is no private-key input, decrypt method or historical-key read on the backup object.
C1 still generates a unique random per-backup keyId and owns/disposes the current DEK.

Only RSA modulus3072/publicExponent65537, RSA_PKCS1_OAEP_PADDING and oaepHash=sha256 are
supported. No default SHA1, algorithm negotiation or fallback. wrappedKey is the existing
canonical encoder's JSON string {version:1,algorithm:'RSA-OAEP-SHA256',ciphertext:<base64>}.
OAEP label is canonical {domain:'ktv-backup-dek',version:1,algorithm,binding,wrappingKeyId,
fingerprint}. Thus the entire original binding, recipient version/fingerprint and codec
parameters must match before OAEP releases the DEK. Record/envelope extra fields, unknown
versions/algorithms, noncanonical encodings, wrong keys, changes and wrong context reject.
This is adapter-owned key metadata inside C1's opaque field, not a new backup format.

The simulation registry now validates C1's generic nonempty wrappedKey <=8192 characters,
plus its unchanged exact record/binding/ID rules. It refuses canonical serialized records
above its existing 12000-byte read cap BEFORE writing/acknowledging them. The AES mock's
own recover retains its exact 80-character format check. Exclusive pending/sync/close/link,
nonoverwrite, authorization/expiry and path checks are unchanged.

## Isolated recovery and history

createSyntheticOfflineRecovery is supplied private material only by the trusted isolated
recovery fixture and an existing authorized C1 registry client. It re-reads the exact
registered record before unwrap and before returning the DEK. Scope, expiry, missing or
denied grants remain enforced by that client; cached encrypted records do not bypass it.
There is no second authorization system. Root construction/bootstrap capabilities and
private material are never given to daily backup clients. Denial after unwrap zeros the
owned DEK. Raw errors, PEMs and DEKs are not logged.

Recovery keys are selected by retained wrappingKeyId; the private key's derived public
fingerprint participates in the OAEP label. Switching the approved generation policy to v2
does not rewrite v1 records. A recovery process holding the matching retained v1 and v2
private materials can read both histories. Wrong versions/keys fail. This local simulation
is not real Owner authentication, cloud IAM or authorization audit. Once transferred, a DEK
cannot be recalled from arbitrary caller memory merely because an authorization expires.

The test-only child receives runtime-generated private PEMs through stdin, not argv/env or
files. It uses C1 withHistoricalBackupKey, B4-A and original format1 verification. Tests
copy retained ciphertext/registry records into a new owned directory after destroying the
original backup fixture; recovery uses no original service cache or machine secret. Private
KeyObjects/PEM strings may persist in process/OS memory until release; buffer zeroing and
process exit are not secure-erasure guarantees. Owner custody, unlock availability, disk /
swap / dump protection and RTO <=240min still require separate production decisions.

## Evidence and stop point

Focused commands/results are in DEVELOPMENT_ENVIRONMENT.md. The positive S4 unit seam
mocks only the existing readBackupIdentity result using an independent fixture approval
map; artifact hash verification and policy parsing remain real. No product injection point
was added. These tests do NOT prove real installed SCM/SID/ACL deployment or production
public-key approval. Existing S4 accepted evidence is reused, not re-audited or relabeled.

B5 offsite registry/ciphertext storage and B6 real cross-server restore remain absent. A
lost private key can make its history unrecoverable; a leaked long-term key exposes every
retained envelope under it. Public wrapping does not authenticate backup origin or stop a
compromised backup server from corrupting/deleting/forging backups. Future KMS can implement
the same interface; existing RSA histories still require their old adapter/private keys.
Independent C2 acceptance is separately Owner-gated. No merge/push/deploy or next phase.
