# S4 Git-free backup release identity

## Scope and trust

The only version identity remains applicationCommit. Backup format1 and exact-version production restore comparison are unchanged. No installed receipt, second version scheme, signing key, PKI, deployment, S5 operation or production restore enablement is introduced.

packageAccepted still validates the build-time accepted commit and packages its files. Retain that exact controlled artifact outside Git. Its SHA-256 must be taken from the trusted packageAccepted result / reviewed release record, not recomputed from an untrusted replacement at backup time. Protected deployment approval binds that digest and the accepted commit in the existing runtime configuration. This is an ACL/deployment trust boundary, not cryptographic publisher authentication against a compromised authorized administrator.

The application directory must be an immutable controlled extraction with exactly the packaged files, including dependencies. Do not install extra dependencies, place logs/config/evidence in it, or modify files after extraction. Existing directoryAclReviewed attests the operator's parent-directory and application ACL review; S4 does not replace it with an automated claim. Runtime/service identity must have read/execute access, not application or protected-config replacement rights.

## Existing backup config extension

The existing Git-external backup operator JSON retains databaseUrl, environment, storeId, ledgerId, serverUuid and optional operationalDirectory. Its backup action additionally requires:

- runtimeConfigFile: canonical absolute path of the existing protected runtime config.
- releaseArtifactFile: canonical absolute path of the retained controlled artifact.
- releaseArtifactChecksum: the independently retained 64-character lowercase SHA-256 of that artifact.

These are backup operator configuration, not new backup manifest fields. They are not accepted by the restore action. No commit argument or identity environment variable is accepted.

The backup action uses the same explicit production selectors and pinned Node version as the runtime config validator. Run under the existing configured service SID; an ordinary interactive backup operator receives no new read access to runtime secrets. The config, backup operator JSON and artifact must satisfy the unchanged protected-file/current-service-SID ACL rule. Parent ACLs and replacement rights remain part of the existing deployment review.

## Identity admission

1. Read and validate runtime config plus its current-service-SID ACL through readRuntimeConfig. It does not load the DB/TLS/provider secret bundle.
2. Validate canonical external backup-config and artifact paths and their ACLs using the existing rules; reread backup config to reject drift.
3. readAcceptedArtifact checks the retained artifact against the independently pinned digest and runtime applicationCommit. The same validator serves unpackAccepted; there is no second artifact validator.
4. Verify every installed file against that artifact, reject links and unlisted files, and require the packaged backup/identity/schema entry files. The installed root comes from the executing module, never config/argv/environment.
5. Recheck runtime identity and operator-config drift. Only then call the existing backupDatabase with applicationCommit.

Missing/malformed/invalid metadata, path/ACL failure, digest mismatch, installed-content drift or commit mismatch yields BACKUP_RELEASE_IDENTITY_REJECTED before backupDatabase is called and before a backup directory is created. No Git/HEAD/environment/CLI/version/latest fallback exists. Secret values, arbitrary exception text and artifact contents are not printed.

loadRuntimeConfig still uses the same runtime-config/SID/ACL checks and then loads/protects its original secret bundle. Normal runtime startup and restore preflight keep their existing security semantics.

## Contract preservation and evidence

Backup continues to write data.json, manifest.json and manifest.sha256 with backupFormatVersion=1 and the same manifest.applicationCommit. Canonical manifest/data checksums and schema/migration validation are unchanged.

Production restore preflight still compares backup manifest.applicationCommit with loaded runtime config.applicationCommit and rejects PRODUCTION_RESTORE_APPLICATION_INCOMPATIBLE. verifyArtifact, restoreDatabase, production restore planning and execution guards are not changed.

shared/release-artifact.test.js covers shared artifact validation, independently expected digest/commit, missing/malformed identity and installed alterations/links/extra files. backup/identity.integration.test.js uses only the existing owned disposable MySQL fixture, builds a synthetic accepted candidate snapshot, extracts it without .git and runs the actual packaged CLI with Git unavailable. It also covers Git present with unrelated HEAD, identity/ACL/path rejection, absence of runtime secret-bundle reads, original format validation and read-only production restore inspection. The synthetic candidate commit identifies that test snapshot, not a human-accepted production release.

Current results and limitations belong to CURRENT_STAGE.md. Commands and owned-fixture prerequisites belong to DEVELOPMENT_ENVIRONMENT.md.
