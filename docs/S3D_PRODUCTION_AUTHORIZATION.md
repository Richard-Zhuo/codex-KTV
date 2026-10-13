# S3-D D1 production plan authorization

D1 adds authorization only. S3-A/B/C are accepted on main; D1 is a local candidate. No production freeze, restore, C1/C2/C3, service cutover or resume can execute through this layer. D2 must connect authority admission to the existing trusted core and service adapters; it must not create another restore state machine.

## Trust and configuration

`loadRecoveryContext` obtains the actual SID and elevated membership from the current Windows access token. It accepts no caller-supplied identity, dependency injection or policy location. The fixed protected policy file is `C:\ProgramData\JbhhKtv\private\recovery-policy.json`:

```json
{
  "policyVersion": 1,
  "approvedOperatorSid": "<APPROVED_ELEVATED_HUMAN_WINDOWS_SID>",
  "runtimeServiceSid": "<NT_SERVICE_JbhhKtv_SID>",
  "runtimeConfigFile": "<ABSOLUTE_PROTECTED_RUNTIME_CONFIG>"
}
```

The policy owner must be SYSTEM or Administrators. Its approved operator must match the actual elevated Windows token and differ from the runtime SID. SYSTEM and Windows administrators remain trusted machine administrators. Policy, config, secrets and roots must be canonical, regular/Git-external protected paths. Symlink/junction aliases fail closed. The CLI config path must equal the policy's canonical config path; the runtime SID must match the existing runtime configuration.

The existing runtime schema, external secret reader, TLS validation and configuration materialization are reused. `loadRuntimeConfig` still requires its configured service SID and unchanged Stage 5C ACL rules. Recovery uses a separate operator ACL context: shared config/secrets/backup/plan/journal may include the configured runtime SID; authorization records and the operator metadata credential file must exclude it. Private ACLs disable inheritance and allow only the approved operator, SYSTEM and Administrators, with a trusted owner. The operator must have effective file read and directory Modify/ObjectInherit (directly or through its elevated Administrators token).

`recovery.operatorDbSecretsFile` retains its existing exact `{ "databaseUrl": "<PROTECTED_METADATA_CREDENTIAL>" }` schema. D1 reads it under the human recovery context, not the service loader: no runtime Allow ACE is accepted on this file. The URL must identify the same MySQL host/port with no database selected. It is never accepted as a CLI argument or persisted in authorization. Existing S3-A service-context planning remains separate; this D1 operator loader does not relax that loader's ACL. D1 checks metadata only and does not add database privileges. No protected production setup is created by automated tests.

The `authorization` subdirectory of the configured recovery journal must already exist with the private ACL. Unsafe/missing policy, directories, files or credentials block before authority issuance. D1 accepts only a valid v2 PREPARED plan, no execution journal, NORMAL source and nonexistent target. Stage-aware authorization after execution starts is deferred to D2.

## Artifact and history

Storage is `<recovery.journalDirectory>/authorization/authorization-event-00000001.json` and subsequent monotonic revisions. There is no overwritten active authorization file. Each event contains `version`, `revision`, `previousDigest`, `lastObservedAt`, the current `active` record and a safe `event` (type, actual actor SID, timestamp, result/reason and authorizationId). The last validated event selects the active grant; prior files preserve issuance, revocation, expiry observation, rejection and reissue history. Hash links detect content drift relative to this protected journal; they are not signatures or protection against trusted administrators deleting/replacing evidence.

The active record binds `recordVersion`, `authorizationId`, `previousAuthorizationId`, `recoveryOperationId`, `planDigest`, `backupSha256`, `storeId`, `ledgerId`, `sourceDatabase`, `targetDatabase`, `serverHost`, `serverPort`, `serverUuid`, `environment=production`, `applicationCommit`, `schemaMigration`, `schemaDigest`, `authorizedOperatorSid`, `issuedBySid`, `runtimeServiceSid`, `deploymentConfigFingerprint`, `issuedAt`, `expiresAt` and `state`. Revision belongs to the outer event envelope and safe result. The plan digest additionally binds backup ID/locator and all immutable plan content.

Exclusive local `authorization.lock` serializes commands and admission. A crashed lock is blocking evidence; there is no automatic stale-lock reclaim. Each new unique temporary file is ACL hardened before bytes, synced, renamed to a fresh revision, ACL checked and read back. Previous files are never rewritten. Filesystem evidence and future MySQL mutations are not one transaction. Unsafe/corrupt storage blocks; a rejection cannot be safely appended when the audit store itself is unavailable. No password, connection string, provider secret or token is stored.

## Lifecycle and replay

- AUTHORIZED permits authority issuance only after current facts, identity, ACL, time and binding revalidation.
- IN_PROGRESS denotes an admitted atomic stage. D1 exercises admission only through an owned test helper.
- CONSUMED is terminal and inspectable, with no new mutation authority. D1 has only an owned test transition; production terminal orchestration belongs to D2.
- REVOKED blocks all subsequent admission. An already admitted atomic stage may finish; revocation does not undo committed data.
- EXPIRED is the effective state at or after `expiresAt`. TTL is fixed at four hours, with no config/env/CLI override or automatic renewal.

Observed wall-clock rollback fails closed, including against the durable high-water mark on restart. The host Windows clock and trusted administrators remain the clock trust boundary; this is not an external secure-time service.

A retry of the same still-active grant returns the same authorizationId and expiry, including response loss. `reauthorize` generates a new ID linked to the old record only after it is revoked/expired and the same plan is revalidated and confirmed. Replaying `reauthorize` against that new active record also returns the existing ID. A different operation conflicts; CONSUMED cannot be renewed. No command extends an active deadline.

## Commands and boundaries

```text
node recovery/production-restore-cli.js authorize --config-file ABSOLUTE_PROTECTED_RUNTIME_CONFIG
node recovery/production-restore-cli.js reauthorize --config-file ABSOLUTE_PROTECTED_RUNTIME_CONFIG
node recovery/production-restore-cli.js inspect-authorization --config-file ABSOLUTE_PROTECTED_RUNTIME_CONFIG
node recovery/production-restore-cli.js revoke-authorization --config-file ABSOLUTE_PROTECTED_RUNTIME_CONFIG
```

These are command contracts, not approval to operate on real production. The existing production environment/version requirements still apply. Authorization requires an interactive TTY and the exact `AUTHORIZE <operation-short-id> <plan-digest-suffix>` response after displaying trusted identity, backup timestamp/current age, loss window and stage. Technical failures cannot be overridden by confirmation. Plan/context/backup/server/target facts are read again after confirmation; drift writes no new grant. Inspect writes a safe audit observation but no database mutation.

ProductionPlanAuthority lives in a private WeakMap and can only be issued through the real Windows/protected production loader. Each use reopens current authorization and deployment/plan checks. A plain object is not authority. The owned harness requires the existing verified disposable MySQL/root capability before callbacks and restricts its artifact directory to that owned root. Its tokens have a separate private kind and cannot pass the production guard. No test/env/port/synthetic flag issues production authority.

D1 deliberately does not admit production tokens into the existing S3 core. The ordinary production CLI still rejects freeze-plan, restore-candidate, inspect-candidate, verify-candidate, cutover, prepare-resume and resume with RESTORE_PRODUCTION_DISABLED before destructive work, even if authorization exists. The independent generic recovery freeze is unchanged. D1 cannot override recovery state, freeze binding, single-writer or startup gates.

## Evidence and stopping point

Focused tests cover policy/SID/ACL/path, malformed/missing grants, all bound identity drift, expiry/observed rollback, replay/history, independent-process concurrency, revocation/admission serialization, consumed records and authority isolation. A real Windows private ACL roundtrip runs only in the owned disposable artifact root; actual Windows token lookup is tested. Existing S3 plan/capability and production runtime regressions are included. No real protected deployment, production credentials/backup/database or provider is accessed. Current counts and evidence are in [CURRENT_STAGE](CURRENT_STAGE.md); commands are in [DEVELOPMENT_ENVIRONMENT](DEVELOPMENT_ENVIRONMENT.md).

No migration, production dependency, production orchestration, SCM adapter or full regression is included in D1. Full regression belongs to D2/final acceptance. PRODUCTION RESTORE remains DISABLED; S3 software remains incomplete.
