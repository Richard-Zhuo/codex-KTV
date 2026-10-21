# B3-A2: synthetic safe archive handoff

## Dedicated isolation boundary

This is a test-support entry only, not a CLI/runtime/environment configuration option.
createSyntheticHandoffStore creates a NEW protected, Git-external direct-child temp root
with a random operational scope and controller token. It uses the original operational
store/writer lock, not another state implementation. The marker binds scope, token hash
and the existing archive public trust/scope. It contains no production credential or key.

Only a privately branded capability for that store can call handoffSyntheticUnit. A plain,
copied or injected store cannot authorize release. Reopening requires the retained token,
the protected marker/root and matching synthetic store scope/trust; existing production
state cannot be adopted. Actual process production selectors are checked as well as args:
args.env cannot hide a production host. There is no production import/enablement route.
Fixture tokens cross test child stdin only, never argv/Git/recovery objects/ordinary logs.
These controls model isolated test resources, not production OS isolation from administrators.

## Existing state and publication fence

observations.offsite.attempts retains its128 active-reference cap. New handoffs in the SAME
state record retain original facts, immutable archive descriptor and checkpoint evidence:
INTENT -> ARCHIVE_VERIFIED -> CHECKPOINT_CONFIRMED -> RELEASED. At most512 receipts are
retained, consistent with A1's cumulative member bound; exhaustion rejects, never truncates.

Only stable OFFSITE_VERIFIED with matching candidate/verified/current locators is eligible.
Historical verifiedLocator alone cannot make a LOCAL/UPLOAD/OFFSITE_UNCONFIRMED attempt safe.
The original B5 full retrieval must match backupId, unitId, objects and original snapshot.
The intent update compares the exact active fact again; an intervening publisher prevents it.

recordOffsiteFact now rejects ANY fact for a unit with a durable handoff intent/receipt,
including a late in-flight publisher result. The public synthetic store additionally rejects
active-reference removal, receipt alteration and re-adding checkpoint members. Update callback
objects are copied after validation, preventing retained references from mutating stored data.
Original OFFSITE_REFERENCE_LIMIT and new OFFSITE_HANDOFF_FENCED remain distinguishable.
B5's upload/readback/completion/OFFSITE_VERIFIED gates are unchanged.

## Ordered release and recovery

Persist intent; exclusively publish the original signed A0 archive entry; independently
verify entry and all B5 materials; publish/verify the A1 cumulative checkpoint; authorized
anchor CAS and fresh latest/full coverage verification; persist checkpoint confirmation;
freshly confirm coverage again; conditionally remove ONLY that unit's active reference and
retain its RELEASED receipt. Unconditional public deletion is unavailable.

LatestRecoveryPoint (including its exact locator), lastAttempt history and original
snapshotNotBefore/verifiedAt remain unchanged. A lastAttempt referring to an archived unit
still has its full fact in handoffs. Archive time never refreshes data time/RPO. Repeating a
released unit validates current coverage and returns alreadyReleased, without a second release.

Handoffs/reconciliation serialize in the owned session, and all state writes use the original
store serialization/process ownership. Different processes cannot own the same writer. An
intent fences other publishers immediately; receipts retain that fence permanently. A1 CAS
handles checkpoint conflicts; no new distributed lock/transaction platform is introduced.

Failure/timeout/unknown remote results return UNCONFIRMED with the active reference retained.
Late remote calls can finish but cannot release locally. An uncertain local state write
blocks further publication/capacity admission until reload plus fresh checkpoint verification.
A release write may have committed despite a lost response: never guess; reopen/reconcile,
then recognize the durable receipt idempotently. Existing signed entries are reused on retry.
Before checkpoint confirmation, the original authorized synthetic issuer/custodian must be
available again; never replace the trust source to bypass its unavailability.

Crash before release leaves intent/evidence and the active reference. Crash after committed
release leaves its receipt. New workers reopen the synthetic scope under the existing lock,
verify independently retained checkpoint coverage and resume. Successful runtime sync/readback
is not proof of real power-loss durability. No recovery material is modified or deleted;
owned test fixture disposal and existing temporary state/lock cleanup are not retention deletion.

## Evidence and limits

Focused unit cases use an explicit B5 retrieval seam; genuine B4/B5 integration separately
uses original encrypted materials, a child dying before release, another child resuming,
and checkpoint discovery after both producer and local state roots become unavailable.
No child uses original caches, a locatorFile or recovery private key to discover history.
Commands/current author evidence: DEVELOPMENT_ENVIRONMENT.md and CURRENT_STAGE.md.

A1's global-directory-completeness limitation and external synthetic anchor anti-rollback
assumption remain. Real independent custody/OSS/WORM/IAM, production slot release, retention
deletion and production offsite backup/readiness are NOT implemented/verified. No automatic
B3 continuation, production enablement, merge/push or deployment is authorized by this code.
