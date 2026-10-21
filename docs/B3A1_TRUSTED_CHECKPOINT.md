# B3-A1: synthetic independent latest checkpoint

## Scope and trust assumptions

This candidate models an independent Owner custodian. It does not release active slots,
change the128-reference limit, delete recovery materials, modify B5 success/RPO, enable a
production route or connect to OSS. B3-A0 list discovery retains its original limitations.

The isolated test controller initializes a protected Git-external anchor directory,
separate from producer state and remote objects. It independently retains anchorId,
the public archive trust file and its out-of-band pin, and scoped read/custodian credentials.
Only credential hashes are persisted. Tokens travel to test children through stdin, never
argv, Git, logs or recovery objects. A role string or producer-supplied credential cannot
mint authority. Opening an existing anchor cannot initialize or replace its policy.

The anchor policy binds one store/ledger/directory scope and the exact archive verification
public key. Each root belongs to one scope. Read credentials cannot CAS, even on retries.
Trusted bootstrap/client construction is a test-controller responsibility. This is not
production IAM, a network custodian service, filesystem isolation from administrators or
proof that the anchor itself cannot be rolled back. Losing/copying/replaying the whole
anchor root is outside the simulated guarantee; real independent custody is NOT IMPLEMENTED.

## Cumulative checkpoint and exact recovery

backup/archive-checkpoint.js reuses canonical encoding, the B3-A0 pinned Ed25519 signature
and entry/material verification, and B5 getExact/full recovery-unit checks. Payload v1 fixes
domain/algorithm/scope, sequence, previous checkpoint SHA256 and sorted cumulative entry
references (unitId, objectId, content-SHA256 version, size). Signed archive entries retain
the original completion/manifest/snapshot/DEK-envelope/release dependencies unchanged.

No member may be omitted, replaced or rewritten. Duplicate/noncanonical/unknown-version
data rejects. At most512 members and1MiB per checkpoint,4096 anchor commits: exhaustion
rejects without truncating any history. These bounds do not replace or increase the128
active-reference cap. No cleanup or retention policy is introduced.

Publish verifies cumulative entry/material references, signs, creates the immutable
checkpoint with putIfAbsent, independently reads/verifies it, then requests custodian CAS.
The custodian independently validates the current and proposed signed checkpoints and all
materials, verifies extension and expected predecessor, and exclusively appends its decision.
The publisher reads latest again and performs exact recovery verification before reporting
SYNTHETIC_CHECKPOINT_VERIFIED. An acknowledgement alone is never completion evidence.

CAS uses the existing process writer lock on the independent root. Wrong predecessor,
sequence gaps, fork/rollback, unauthorized updates and conflicts reject. Exactly repeated
confirmed values may be verified/reused; old values cannot replace a newer point. Pending
record bytes are synced and closed BEFORE exclusive link publication. Only the writer's
temporary link is removed, never recovery materials. Unknown or failed writes can retain
pending evidence; any pending/unexpected record blocks latest reads and further commits.
There is no automatic removal/reconciliation of uncertain pending records in this phase.
Successful sync/link/readback is runtime evidence, not proof of real power-loss durability.

All remote/anchor calls in checkpoint orchestration have bounded deadlines. A timeout does
not cancel a late operation. CAS uncertainty can succeed only after an independent latest
read equals the exact intended point and full verification succeeds. Otherwise reject;
retain the same point/unit for reconciliation. Restart does not assume an interrupted CAS
failed. No result exposes SDK errors, credentials, DEKs, recovery private keys or raw causes.

Recovery opens the independently retained anchor and public trust in a new process, gets
its latest exact pointer, verifies the checkpoint and all cumulative references, then checks
latest again. It needs no producer state/cache/locatorFile/private key or remote list. Remote
directory/checkpoint rollback fails while the independent anchor retains the newer pointer.
This proves coverage of checkpoint members relative to that anchor, not global directory
completeness or real cloud durability. Anchor unavailability/uncertainty rejects.

Every success retains directoryCompleteness=NOT_VERIFIED,
rollbackProtection=EXTERNAL_SYNTHETIC_ANCHOR_ASSUMPTION, readyForSlotRelease=false,
activitySlotsReleased=0 and physicalDeletion=false. No local OFFSITE_VERIFIED/RPO facts change.
Actual synthetic test fixture disposal is not a product retention/deletion operation.

## Evidence and remaining work

Focused tests include isolated authorization/CAS/failure models and genuine B5 material
retrieval in a new process after moving the owned original-server directory away. Another
child abruptly exits with a synced pending record: reopening detects uncertainty and blocks.
Tests do not restore a database or prove real cross-server recovery. Current commands and
author results are in DEVELOPMENT_ENVIRONMENT.md and CURRENT_STAGE.md. Independent acceptance
requires Owner authorization. Real OSS WORM/IAM, anchor custody/anti-rollback, production
retention, B3 slot release and production offsite backup remain unimplemented/unverified.
