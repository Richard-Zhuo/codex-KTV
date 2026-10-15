# S4 Git-free backup release identity

## Scope and trust

The only version identity remains applicationCommit. Backup format1 and exact-version production restore comparison are unchanged. No installed receipt, second version scheme, signing key, PKI, deployment, S5 operation or production restore enablement is introduced.

packageAccepted still validates the build-time accepted commit and packages its files. Retain that exact controlled artifact outside Git. Its SHA-256 must come from the trusted packageAccepted result / reviewed release record, not from an untrusted replacement at backup time.

The existing fixed Windows service registration created by deployment/register-service.ps1 is the deployment authority: JbhhKtv, account NT SERVICE\JbhhKtv, with registered host, Node, production entry and runtime-config paths. Backup reads only this SCM registration and the OS-resolved account SID; it does not query writer proof, start/stop services or enter recovery. The registered Node and entry must match the executing installation. The system PowerShell executable is fixed at C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe; caller PATH cannot substitute the registration or ACL reader. The registration query explicitly loads the system CimCmdlets module by absolute path and uses its qualified command rather than caller module search paths. Other Windows installation locations fail closed.

The backup operator configuration is fixed to backup.json beside the SCM-registered runtime config. Both backup.json and its parent must have protected ACLs, SYSTEM/Administrators ownership, the existing narrow trusted-principal rules and service read access without service write, delete, delete-child, ownership or DACL-changing grants. The caller's --config-file must equal this canonical path. Administrative deployment approval writes the retained artifact path and its independently reviewed digest there. A caller-owned, self-consistent alternate config/artifact/runtime set cannot select this authority.

This uses the existing protected Windows deployment boundary. It does not authenticate a publisher cryptographically against an authorized administrator who replaces machine trust anchors. The existing deployment review must keep service registration, parent-directory replacement rights and installed application contents under administrator control. directoryAclReviewed remains an attestation of that review, not automatic proof of every ancestor ACL.

The installed application must contain exactly the controlled extraction, including dependencies. Do not place extra dependencies, logs/config/evidence or modified files in it. Service identity receives read/execute access rather than installation replacement rights.

## Existing backup config extension

The Git-external backup operator JSON retains databaseUrl, environment, storeId, ledgerId, serverUuid and optional operationalDirectory. Its backup action additionally requires:

- runtimeConfigFile: must equal the canonical SCM-registered runtime config path.
- releaseArtifactFile: canonical absolute path of the retained controlled artifact.
- releaseArtifactChecksum: independently reviewed 64-character lowercase SHA-256 of that artifact.

The runtime config holds applicationCommit and serviceAccountSid. It does not hold the artifact digest. backup.json holds the artifact path/digest and runtime path reference; it adds no second commit field. SCM holds the non-caller-selected deployment/service/path binding. These are not backup manifest fields and are not accepted by the restore action.

The backup action requires the existing production selectors and pinned Node version. Run under the registered service SID, which must match the runtime config SID. Runtime config and artifact retain the existing protected-file/current-service-SID checks. Backup loads no runtime DB/TLS/provider secret bundle; its own existing backup database configuration is still necessary.

## Identity admission

1. Read fixed SCM registration; validate canonical registered paths, executing Node/entry binding and administrator-protected private directory/backup.json.
2. Reject caller config or runtime paths outside that binding. Read runtime config through readRuntimeConfig, check its SID against the OS-resolved registered account, and reread the approved backup config to reject drift.
3. Validate the retained artifact's path and existing ACL. readAcceptedArtifact checks the independently pinned digest and runtime applicationCommit. The same validator serves unpackAccepted; there is no second artifact validator.
4. Verify exact installed file contents/inventory, reject links and unlisted files, and require the backup/identity/deployment/schema entry files. The installed root comes from the executing module.
5. Recheck SCM/anchor facts, runtime identity and backup config drift. Only then call the existing backupDatabase with applicationCommit.

Missing/malformed identity, absent/wrong registration, path/ACL failure, digest mismatch, installed drift or commit/SID mismatch yields BACKUP_RELEASE_IDENTITY_REJECTED before backupDatabase and before creating a backup directory. No Git/HEAD/environment/CLI/version/latest fallback exists. A safe operational failure report can still be published when operationalDirectory was supplied; identity rejection does not promise zero filesystem side effects. Failure reporting itself is unchanged. Secret values, arbitrary exception text and artifact contents are not printed.

loadRuntimeConfig retains its config/SID/ACL/secret checks and materialization semantics. The ACL reader additionally supports directory observation and uses the fixed system executable; there is no broader SID/ACL allowance.

## Contract preservation and evidence

Backup still writes data.json, manifest.json and manifest.sha256 with backupFormatVersion=1 and the same manifest.applicationCommit, canonical checksums and schema/migration validation.

Production restore preflight still requires backup manifest.applicationCommit === loaded runtime config.applicationCommit and rejects PRODUCTION_RESTORE_APPLICATION_INCOMPATIBLE. verifyArtifact, restoreDatabase, production planning and execution guards are unchanged.

production/backup-deployment.test.js covers fixed registration and administrator-owned read-only anchor rules. shared/release-artifact.test.js covers shared validation and installed corruption/links/extra files.

backup/identity.integration.test.js builds an owned synthetic accepted package, extracts without .git and executes the actual packaged CLI with Git unavailable, then with an unrelated Git HEAD. It proves that a caller-owned runtime/config/artifact/digest with legal false commit, real acceptable Windows file ACLs and exact installed bytes passes the old internal consistency checks but is rejected by deployment binding without backup output.

For that CLI test, test-support/s4-os-observation.fixture.js substitutes only the SCM registration and the two administrator-anchor ACL observations. It requires the existing owned disposable MySQL root/endpoint/UUID proof before enabling interception. It is an explicit test --import outside the package, not a production selector or override. Runtime/artifact Windows ACL checks, package validation, CLI backup, format verification and read-only restore preflight are real operations on owned disposable resources. These tests are not evidence of an installed production service or real administrator ACL provisioning.

Current results and limitations belong to CURRENT_STAGE.md; commands and fixture prerequisites belong to DEVELOPMENT_ENVIRONMENT.md.
