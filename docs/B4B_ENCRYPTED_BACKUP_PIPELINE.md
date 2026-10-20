# B4-B: synthetic-only encrypted backup pipeline

## Scope and admission

Owner base main: 702a9c454f42e0f6f4a09d99a23b9bbfcb8f4ff0.
This composes the accepted B4-A component and existing backupDatabase / verifyArtifact.
The inner format1, original TEST restore, S4 identity reader and B2 executor/scheduler
are unchanged. No dependencies, cloud resources, production keys or service installation.
B4-B implementation is author evidence pending a separately authorized independent acceptance.

Encryption is default-disabled. An omitted policy or exactly {enabled:false} keeps the
original one-shot backup behavior. Explicit enablement requires exactly enabled, keyId
and an absolute stagingDirectory; unknown fields, including key material, are rejected.
No error in the enabled path retries or falls back to a plaintext success.

The encrypted path additionally requires a nonproduction environment, environment=test,
STAGE5E_RUN=synthetic-only and an exact LEDGER_MYSQL_TEST_URL match. Existing backupDatabase
identity/confirmation and original fixture admission still apply. CLI calls the unchanged
S4 reader first; it does not offer a synthetic S4 identity bypass. After admission the
lightweight policy rejects production before dynamically loading encrypted dependencies.
Disabled CLI calls the original backupDatabase directly, keeping its Git-free load boundary.
Positive synthetic tests use createConfiguredBackup with the real existing backupDatabase;
CLI admission has separate negative and existing Git-free positive regression evidence.
There is no successful production encrypted CLI or production scheduler route in this stage.

keyProvider.resolve is the existing B4-A in-memory interface. The optional in-process CLI
provider does not replace any admission authority. There is no key argv, key environment
variable, key configuration field, file provider, KMS or production key creation. Test keys
are random and ephemeral. B4-A still validates actual key length/ID/authentication. Key IDs
are nonsecret labels and must not contain secret material. Formal custody, rotation, old
keys and authorized cross-server retrieval remain B4-C, with production enablement prohibited.

## Creation, verification and publication

1. Validate dedicated external staging/output-parent directories. Canonical paths must
   equal real paths; reject symlinks/junctions and overlapping staging/publication paths.
   Windows uses existing protected-DACL readers and setters (current producer, SYSTEM and
   Administrators only); newly owned run/output directories receive the existing producer
   ACL. Other users must not be able to mutate the controlled parents. POSIX checks owner
   and excludes group/other writes; new run/source directories are private 0700.
2. Inspect the staging root read-only. Incomplete, corrupt or unrecognized entries block a
   new run for explicit review. Create a unique b4-run-UUID directory and durably write a
   CREATING record with plaintext=POSSIBLE before creating any source format1 files.
3. Call the existing backupDatabase into run/source, then the original verifyArtifact.
   B4-A encrypts the verified format1 with the in-memory provider; durableWrite creates
   ciphertext.tmp exclusively. Record both original manifest and encrypted-file checksums.
4. Read back the candidate, check its digest and call B4-A authenticated decryption plus
   original format1 validation in this run's protected temporary parent. B4-A does not
   release unauthenticated plaintext. Its authenticated validation scratch is still plaintext
   and is included in residue observation.
5. Only after validation, exclusively mkdir the output leaf and hard-link the already
   verified ciphertext inode to output/backup.b4. An existing directory or filename refuses
   publication. No overwrite, copy fallback, plaintext fallback or cross-volume fallback.
   Staging and publication must support hard links on the same volume. Read back the
   published file digest; a mismatch is UNKNOWN, never PUBLISHED/complete.
6. Persist CLEANING, then remove only the current run/source's known format1 files and
   its now-empty source directory. Validate the whole set before deleting anything; reject
   links, unknown entries and hard-linked source files. No recursive runtime deletion or
   automatic deletion of failed sources or published backups. After observing no source
   or B4-A validation scratch, unlink the candidate's own ciphertext link and durably record
   COMPLETE. This unlinks names; it does not claim secure erasure.

Source, ciphertext candidate and publication failures preserve protected evidence and
return fixed phase-specific error codes rather than raw exceptions. An empty output directory
can remain after publication failure; it is never reported as a valid complete backup.
Published valid ciphertext is retained if source cleanup or final result recording fails.
Source failures are retained rather than risking deletion of a unique usable snapshot.

## Facts, interruption and review

Tiny append-only state-NNNN.json records are pipeline operation metadata, not a new backup
format or second ledger. They use the existing canonical/durableWrite helpers (exclusive
create and file sync). A record contains request ID, bounded phase/code, original/encrypted
checksums and time, plus ciphertext / plaintext / complete facts; no DB URL, credentials,
keys or backup rows. Existing CLI result mailbox success is true only for full completion;
a false/incomplete result yields exit1. The private journal preserves the distinct facts
that the older boolean mailbox cannot express. Failure to persist is resultRecorded=false.

ciphertext=VERIFIED is not publication. PUBLISHED means published bytes passed the check;
plaintext=ABSENT means observed pathname absence, not erased disk blocks. complete=true
also requires the final durable result record. Thus a usable published cipher and retained
plaintext can coexist with complete=false. Later modification is not continuously monitored.

inspectEncryptedBackupResidues(stagingDirectory) only reads bounded, validated sequential
records and directly observes owned source / b4-auth directories. Missing, malformed,
unrecognized or linked entries return UNKNOWN/incomplete. It never follows a link, deletes
files or infers process liveness: an incomplete run can still be active. A real child-process
kill test demonstrates detection of a CREATING record and retained source with no published
success. A crash between mkdir and the first record is discoverable as an unknown run.

Before any future retry, an authorized reviewer must establish that the old process has
stopped, inspect the private journal and observed residue, independently validate any
published backup and decide how to preserve/recover the retained source. This stage does
not provide a generic cleanup service, automatic repair, retention policy or bulk deletion.

## Remaining plaintext and production risks

- Default-disabled legacy backup creation intentionally still produces original plaintext.
  Only the explicitly selected synthetic encrypted path confines source to this staging root.
- A failed or killed process can leave source, authenticated-decryption scratch and buffers.
  Read-only inspection makes filesystem residue visible; it does not repair it. A live OS,
  private ACLs and an available staging root are prerequisites for inspection.
- Normal unlink, memory buffer zeroing and fixture teardown are not secure erasure guarantees.
  Disk encryption, paging/crash dumps, caches, backups of the staging disk, power-loss and
  directory-entry durability, capacity and peak-memory budgets need deployment validation.
- Protected paths assume the producer identity/host is trusted. This is not containment of
  a hostile administrator or another process already running as the same producer.
- File sync and exclusive hard-link publication are not evidence of power-loss durability
  on the eventual Windows cloud disk. Cross-volume publication fails closed.
- Production encryption, formal key management, real server-loss restore, offsite upload,
  automatic backup enablement and RPO/RTO attainment remain unimplemented/unverified.
  Before future production enablement, validate the complete packaged encrypted dependency
  closure; this stage deliberately does not load it on the disabled/production-rejected path.

PRODUCTION KEY MANAGEMENT=NOT IMPLEMENTED; PRODUCTION ENCRYPTION ENABLED=NO;
PRODUCTION RESTORE ENABLED=NO; PRODUCTION READY=NO.
B4-B synthetic pipeline completion does not complete the production encrypted backup chain.

Current source evidence: [CURRENT_STAGE](CURRENT_STAGE.md).
Focused commands: [DEVELOPMENT_ENVIRONMENT](DEVELOPMENT_ENVIRONMENT.md).
[Node fs hard links](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromiseslinkexistingpath-newpath).
