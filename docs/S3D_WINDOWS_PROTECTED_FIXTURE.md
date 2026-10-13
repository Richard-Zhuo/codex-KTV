# S3-D Windows protected filesystem fixture

This TEST/DEVELOPMENT ONLY fixture addresses the D2 ownership/ACL environment precondition. It neither wires production orchestration nor issues ProductionPlanAuthority. No database, installed service, real ProgramData file or provider is involved. The production validator is unchanged.

## Actual contract

`recovery/production-authorization-context.js:validateRecoveryAcl` requires a protected DACL and actual current SID. Policy owner is SYSTEM (`S-1-5-18`) or Administrators (`S-1-5-32-544`). Private authorization owner may also be the approved operator. Allow rules are limited to the actual operator/SYSTEM/Administrators; the runtime SID is permitted only for explicitly shared objects, never private authorization. Deny rules are also rejected by this validator. File access needs effective read; directory access needs Modify (`197055`) and ObjectInherit. Elevated Administrators can provide that access, but this fixture gives the ordinary actual operator explicit access. SYSTEM/Administrators are permitted principals, not individually mandatory ACEs; the fixture gives them FullControl. `canonicalProtectedPath` checks regular canonical Git-external paths and rejects unsafe reparse aliases.

The fixture chooses Administrators ownership for policy, marker, authorization probe and protected directories. Root and fixed files give the ordinary operator read access; the journal/policy/secrets directories give Modify with ObjectInherit. No ordinary operator WriteDac/WriteOwner grant is added. This allows actual ACL inspection by the ordinary process, while existing protected probe files cannot have their DACL changed by that process. It does not promise that every object a writable directory's operator later creates automatically has safe ownership or ACL; every future object still requires validation.

**ACL validation is separate from operator authorization.** `validateRecoveryPolicy` also requires the actual operator token to be elevated. The non-elevated acceptance suite explicitly proves that this identity gate remains blocked. Successful filesystem setup is not permission to execute restore as a non-elevated process. This slice does not solve or bypass later production authority admission.

## Prepare, bootstrap, validate

1. In the normal development process run `node test-support/protected-windows-fixture.js prepare`. It generates a lowercase 32-hex fixture ID and prints commands; it creates no fixture or authorization.
2. Manually open an elevated PowerShell **under the same Windows account**. Execute the printed Bootstrap command using `pwsh.exe` (PowerShell 7). This machine's Windows PowerShell 5.1 blocks `.ps1`, whereas PowerShell 7 allows local scripts under its existing RemoteSigned policy. Do not change execution policy or use a bypass flag. No UAC automation is included.
3. Exit that elevated process. In the original non-elevated process run the printed Verify command. It invokes `node --test --test-isolation=none --test-reporter=tap` with the explicit `test-support/protected-windows-fixture.acceptance.js` file. No fake token, owner, ACL result or elevated=true override is accepted.

The bootstrap only accepts `-FixtureId <32 lowercase hex>` and `-Action Bootstrap|Cleanup`. It derives the current account's LocalAppData/Temp from the OS profile, ignoring caller TEMP/TMP redirection. Its only root is `<OS_PROFILE>/AppData/Local/Temp/ktv-s3d-protected-<id>`. It rejects an existing Bootstrap root, reparse/Git ancestors, production environment selectors and arbitrary root/SID/credential parameters. It resolves the actual JbhhKtv virtual-service SID with Windows `sc showsid` (identity calculation, not a service state query or action). Files contain synthetic ACL probes and a fixture-local policy reference, not a runnable runtime config, immutable recovery plan or authorization grant.

The root has an Administrators-owned, protected, read-only owned marker bound to the exact ID and actual operator SID. Bootstrap uses CreateNew file handles, applies ACL before writing bytes, and pins canonical non-reparse directories without delete-sharing while preparing the tree. Failure is fail closed; it never overwrites an existing fixture. A partially created marked fixture can be inspected and cleaned with the same ID.

Expected bootstrap output is JSON with `FIXTURE_BOOTSTRAP=CREATED`, the ID/root, owner `S-1-5-32-544`, `ACL_VERIFICATION=PENDING_NON_ELEVATED`, `PRODUCTION_TOUCHED=NO`, `DB=NOT_USED` and `SERVICE=NOT_USED`. It does not claim production-validator success.

Acceptance reads actual Windows ACLs and calls the unchanged production functions. It checks owners/protected inheritance/canonical paths, directory Modify/ObjectInherit, real wrong-owner/inheritance/runtime/Users variants, a real junction alias, failed ordinary owner manufacture, denied ordinary DACL modification and the preserved non-elevated policy identity rejection. Missing fixture or a mismatched actual SID fails; it is not skipped. The acceptance file is selected explicitly and is not registered as a success in a normal run without a manually bootstrapped fixture.

## Cleanup

After fixture use is finished, run the printed Cleanup command in an elevated PowerShell under the same account and with the same ID. The helper verifies the fixed root and protected owned marker before deletion. It pins directories, removes ordinary mutation access before enumerating children, verifies no-follow handles, and removes reparse entries only as links. It never accepts a target directory or follows a link recursively. Cleanup failure preserves evidence and requires inspection; it does not widen ACLs outside the owned root. Do not clean the fixture before its ordinary-process acceptance has completed.

## Evidence limit

Before manual bootstrap, only syntax/type compilation and unprivileged refusal tests can be claimed. Current evidence and the waiting state are in [CURRENT_STAGE](CURRENT_STAGE.md). The real Administrators-owner positive path and real negative ACL variants remain pending until ordinary-process acceptance runs after manual bootstrap. D2 product code and all production hard-disable boundaries remain unchanged by this fixture helper.
